import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyHeroDataBundle } from './generate-hero-data.mjs';
import { sha256 } from '../src/provider-records.mjs';

const ORIGIN = 'https://www.dota2.com';
export function heroSourcePath(hero, { legacy = false } = {}) {
    const key = hero.key ?? hero.heroKey?.slice('npc_dota_hero_'.length);
    if (typeof key !== 'string' || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(key) || hero.heroKey !== 'npc_dota_hero_' + key) throw new Error('Invalid provider hero key.');
    return 'sources/heroes/' + (legacy ? hero.heroId : key) + '.json';
}
const VERSION = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const ID = /^[1-9]\d{0,5}$/;
const NAME = /^npc_dota_hero_[a-z0-9_]+$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const integer = value => Number.isSafeInteger(value) && value > 0;
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : object(value)
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const equal = (first, second) => stable(first) === stable(second);
const limitations = [
    'Official website declarations and descriptions are source evidence, not an exhaustive engine interaction proof.',
    'The website response has no installed-build identifier. Numeric agreement verifies only the compared declarations.',
    'Unlisted helper abilities, implicit defaults, upgrade formulas and behavior enums remain unresolved unless separately reviewed.',
];

function validateHeroes(payload, requested = null) {
    const heroes = payload?.result?.data?.heroes;
    if (payload?.result?.status !== undefined && payload.result.status !== 1
        || !Array.isArray(heroes) || !heroes.length || heroes.length > 512) throw new Error('Malformed Valve hero response.');
    const seen = new Set();
    for (const hero of heroes) {
        if (!object(hero) || !integer(hero.id) || !NAME.test(hero.name || '') || seen.has(hero.id)) throw new Error('Invalid or duplicate official hero identity.');
        seen.add(hero.id);
        if (!requested) continue;
        if (heroes.length !== 1 || String(hero.id) !== requested.heroId || hero.name !== requested.heroKey) throw new Error('Official hero identity conflicts with installed hero.');
        for (const collection of ['abilities', 'talents']) {
            if (!Array.isArray(hero[collection]) || hero[collection].length > 256) throw new Error('Malformed official ability collection.');
            const abilityIds = new Set();
            const abilityNames = new Set();
            for (const ability of hero[collection]) {
                if (!object(ability) || !integer(ability.id) || !/^[a-z][a-z0-9_]+$/.test(ability.name || '')
                    || abilityIds.has(ability.id) || abilityNames.has(ability.name) || !Array.isArray(ability.special_values)
                    || ability.special_values.length > 256 || typeof ability.desc_loc !== 'string') throw new Error('Malformed or duplicate official ability.');
                abilityIds.add(ability.id); abilityNames.add(ability.name);
                for (const key of ['cast_ranges', 'cast_points', 'channel_times', 'cooldowns', 'durations', 'damages', 'mana_costs']) {
                    if (!Array.isArray(ability[key]) || ability[key].length > 32 || ability[key].some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Malformed official numeric array.');
                }
                const specials = new Set();
                for (const value of ability.special_values) {
                    if (!object(value) || typeof value.name !== 'string' || specials.has(value.name) || !Array.isArray(value.values_float)
                        || value.values_float.length > 32 || value.values_float.some(number => typeof number !== 'number' || !Number.isFinite(number))) throw new Error('Malformed official special value.');
                    specials.add(value.name);
                }
            }
        }
        if (hero.facets !== undefined && !Array.isArray(hero.facets) || hero.facet_abilities !== undefined && !Array.isArray(hero.facet_abilities)) throw new Error('Malformed official facets.');
    }
    return heroes;
}

async function fetchBytes(url, { fetchImpl, timeoutMs, maxResponseBytes }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reader;
    try {
        const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Official source HTTP ${response.status}.`);
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)) throw new Error('Official response exceeds byte limit.');
        if (!response.body) throw new Error('Official response body unavailable.');
        reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            bytes += result.value.byteLength;
            if (bytes > maxResponseBytes) throw new Error('Official response exceeds byte limit.');
            chunks.push(Buffer.from(result.value));
        }
        return Buffer.concat(chunks, bytes);
    }
    catch (error) {
        controller.abort();
        if (reader) await reader.cancel().catch(() => {});
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new Error('Official source request timed out.', { cause: error });
        // Keep remote response bodies and transport details out of durable failure metadata.
        if (/^Official /.test(error?.message || '')) throw error;
        throw new Error('Official source network request failed.', { cause: error });
    }
    finally {
        clearTimeout(timer);
        reader?.releaseLock();
    }
}

const numericDeclaration = value => typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?(?:\s+-?\d+(?:\.\d+)?)*\s*$/.test(value)
    ? value.trim().split(/\s+/).map(Number) : null;
const equivalent = (local, official) => local.length === official.length && local.every((value, index) => Math.abs(value - official[index]) <= 0.00001)
    || local.length > 0 && official.length > 0 && local.every(value => Math.abs(value - local[0]) <= 0.00001)
        && official.every(value => Math.abs(value - local[0]) <= 0.00001);

/** Compare direct declarations only; textual mechanics and enum interpretations are retained for review. */
export function compareValveHero(native, official) {
    const nativeAbilities = new Map((native.abilities || []).map(row => [row.abilityId, row]));
    const returned = [...official.abilities, ...official.talents];
    const comparisons = returned.map((ability, index) => {
        const collection = index < official.abilities.length ? 'abilities' : 'talents';
        const sourcePointer = `/result/data/heroes/0/${collection}/${collection === 'abilities' ? index : index - official.abilities.length}`;
        const declaration = nativeAbilities.get(ability.name);
        const matches = [];
        const differences = [];
        const notCompared = [];
        const add = (field, nativeValue, officialValue, same, nativePath, officialPath) => {
            const record = { field, nativeValue, officialValue, nativePath, officialPointer: `${sourcePointer}/${officialPath}` };
            if (Array.isArray(officialValue) && !officialValue.length) notCompared.push({ ...record, reason: 'official-base-value-not-reported' });
            else (same ? matches : differences).push(record);
        };
        if (declaration) {
            for (const [field, key] of [['AbilityManaCost', 'mana_costs'], ['AbilityCooldown', 'cooldowns'], ['AbilityCastRange', 'cast_ranges'],
                ['AbilityCastPoint', 'cast_points'], ['AbilityChannelTime', 'channel_times'], ['AbilityDuration', 'durations'], ['AbilityDamage', 'damages']]) {
                const value = numericDeclaration(declaration.raw?.[field]);
                if (value) add(field, value, ability[key], equivalent(value, ability[key]), `${declaration.sourcePath}.${field}`, key);
            }
            for (const [field, key] of [['HasShardUpgrade', 'ability_has_shard'], ['HasScepterUpgrade', 'ability_has_scepter'],
                ['IsGrantedByShard', 'ability_is_granted_by_shard'], ['IsGrantedByScepter', 'ability_is_granted_by_scepter'], ['Innate', 'ability_is_innate']]) {
                const value = declaration.raw?.[field];
                if (['0', '1'].includes(value) && typeof ability[key] === 'boolean') add(field, value === '1', ability[key], (value === '1') === ability[key], `${declaration.sourcePath}.${field}`, key);
            }
            for (const [specialIndex, special] of ability.special_values.entries()) {
                const raw = declaration.raw?.AbilityValues?.[special.name];
                const value = numericDeclaration(object(raw) ? raw.value : raw);
                if (value) add(`AbilityValues.${special.name}`, value, special.values_float, equivalent(value, special.values_float),
                    `${declaration.sourcePath}.AbilityValues.${special.name}`, `special_values/${specialIndex}/values_float`);
            }
        }
        return { abilityId: ability.name, officialId: ability.id, sourcePointer, nativeSourceResource: declaration?.sourceResource ?? null,
            state: !declaration ? 'native-declaration-unmatched' : differences.length ? 'declaration-conflict' : matches.length ? 'compared-declarations-agree' : 'uncompared',
            matches, differences, notCompared, mechanicsVerified: false,
            unverified: ['description-semantics', 'engine-interactions', 'behavior-and-immunity-enum-mapping', 'upgrade-and-talent-formulas'] };
    });
    const missing = [...nativeAbilities.keys()].filter(name => !returned.some(row => row.name === name));
    return { comparisons, nativeAbilitiesNotListed: missing, coverage: { officialAbilities: official.abilities.length, officialTalents: official.talents.length,
        nativeAbilities: nativeAbilities.size, matchedAbilities: comparisons.filter(row => row.nativeSourceResource).length,
        comparedFields: comparisons.reduce((sum, row) => sum + row.matches.length + row.differences.length, 0),
        conflictingFields: comparisons.reduce((sum, row) => sum + row.differences.length, 0), completeMechanics: false } };
}

export async function collectValveHeroData({ bundle, output, version, fetchImpl = fetch, concurrency = 4,
    timeoutMs = 15000, maxResponseBytes = 2 * 1024 * 1024, now = () => new Date().toISOString() } = {}) {
    if (!VERSION.test(version || '') || !bundle || typeof fetchImpl !== 'function' || !integer(concurrency) || concurrency > 8
        || !integer(timeoutMs) || timeoutMs > 60000 || !integer(maxResponseBytes) || maxResponseBytes > 8 * 1024 * 1024) throw new Error('Invalid official collection options.');
    const destination = path.resolve(output ?? path.join('test-results', 'hero-data-official', version));
    if (fs.existsSync(destination)) throw new Error('Official data version already exists; choose a new output directory.');
    const sourceManifest = verifyHeroDataBundle(bundle);
    const native = JSON.parse(fs.readFileSync(path.join(bundle, 'hero_data.json'), 'utf8'));
    const heroes = native.heroes?.filter(hero => hero.enabled === true);
    if (!Array.isArray(heroes) || !heroes.length || heroes.length > 512 || heroes.some(hero => !ID.test(hero.heroId) || !NAME.test(hero.heroKey))
        || new Set(heroes.map(hero => hero.heroId)).size !== heroes.length || native.sourceHash !== sourceManifest.sourceHash) throw new Error('Invalid verified native roster.');
    const createdAt = now();
    if (!validDate(createdAt)) throw new Error('Invalid collection clock.');
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true });
    const staging = fs.mkdtempSync(path.join(parent, '.valve-hero-data-'));
    const files = [];
    const sources = [];
    const record = (name, bytes, metadata = {}) => {
        fs.mkdirSync(path.dirname(path.join(staging, name)), { recursive: true });
        fs.writeFileSync(path.join(staging, name), bytes);
        const file = { name, sha256: sha256(bytes), bytes: bytes.length, ...metadata };
        files.push(file);
        return file;
    };
    const acquire = async (name, url, requested) => {
        const source = { name, url, status: 'unavailable', retrievedAt: null };
        try {
            const bytes = await fetchBytes(url, { fetchImpl, timeoutMs, maxResponseBytes });
            source.retrievedAt = now();
            if (!validDate(source.retrievedAt)) throw new Error('Invalid collection clock.');
            let payload;
            try {
                payload = JSON.parse(bytes.toString('utf8'));
            }
            catch {
                throw new Error('Malformed Valve JSON response.');
            }
            const values = validateHeroes(payload, requested);
            Object.assign(source, record(name, bytes, { url, retrievedAt: source.retrievedAt }), { status: 'available' });
            return { source, values };
        }
        catch (error) {
            source.error = error.message; return { source, values: [] };
        }
        finally {
            sources.push(source);
        }
    };
    try {
        const list = await acquire('sources/herolist.json', `${ORIGIN}/datafeed/herolist?language=english`);
        const identities = new Map(list.values.map(hero => [String(hero.id), hero.name]));
        const results = new Array(heroes.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(concurrency, heroes.length) }, async () => {
            while (next < heroes.length) {
                const index = next;
                next += 1;
                const hero = heroes[index];
                const base = { heroId: hero.heroId, heroKey: hero.heroKey, key: hero.key, status: 'unavailable', sourceFile: null };
                if (identities.get(hero.heroId) !== hero.heroKey) {
                    results[index] = { ...base, reason: list.source.status !== 'available' ? 'official-roster-unavailable'
                        : identities.has(hero.heroId) ? 'official-roster-identity-conflict' : 'official-roster-hero-missing' };
                    continue;
                }
                const name = heroSourcePath(hero);
                const acquired = await acquire(name, `${ORIGIN}/datafeed/herodata?language=english&hero_id=${hero.heroId}`, hero);
                results[index] = acquired.source.status === 'available' ? { ...base, status: 'available', sourceFile: name,
                    ...compareValveHero(hero, acquired.values[0]) } : { ...base, reason: acquired.source.error };
            }
        }));
        const available = results.filter(row => row.status === 'available').length;
        const index = { schemaVersion: 1, collectorVersion: 'valve-hero-data-3', version, createdAt, nativeBuild: native.build, nativeSourceHash: sourceManifest.sourceHash,
            heroes: results, coverage: { state: available === heroes.length ? 'complete-acquisition' : 'partial-acquisition',
                expectedHeroes: heroes.length, availableHeroes: available, unavailableHeroes: heroes.length - available, completeMechanics: false }, limitations };
        record('valve_hero_data.json', Buffer.from(json(index)));
        const manifest = { schemaVersion: 1, version, createdAt, nativeSourceHash: sourceManifest.sourceHash,
            sourceBundle: { version: sourceManifest.version, manifestSha256: sha256(fs.readFileSync(path.join(bundle, 'hero_data_manifest.json'))),
                heroDataSha256: sourceManifest.files.find(file => file.name === 'hero_data.json').sha256 },
            coverage: index.coverage, files: files.sort((a, b) => a.name.localeCompare(b.name)), sources: sources.sort((a, b) => a.name.localeCompare(b.name)) };
        fs.writeFileSync(path.join(staging, 'valve_hero_data_manifest.json'), json(manifest));
        fs.renameSync(staging, destination);
        return manifest;
    }
    finally {
        if (fs.existsSync(staging) && path.dirname(path.resolve(staging)) === parent && path.basename(staging).startsWith('.valve-hero-data-')) fs.rmSync(staging, { recursive: true });
    }
}

export function verifyValveHeroDataBundle(directory, { nativeCatalog } = {}) {
    const root = fs.realpathSync(directory);
    const read = (name, bound) => {
        const filename = path.join(root, name);
        const resolved = fs.realpathSync(filename);
        if (path.relative(root, resolved).startsWith('..') || path.isAbsolute(path.relative(root, resolved))
            || !fs.lstatSync(filename).isFile() || fs.statSync(filename).size > bound) throw new Error('Invalid official bundle file.');
        return fs.readFileSync(filename);
    };
    const manifest = JSON.parse(read('valve_hero_data_manifest.json', 1024 * 1024));
    if (manifest.schemaVersion !== 1 || !VERSION.test(manifest.version || '') || !/^[a-f0-9]{64}$/.test(manifest.nativeSourceHash || '')
        || !validDate(manifest.createdAt) || !VERSION.test(manifest.sourceBundle?.version || '')
        || !/^[a-f0-9]{64}$/.test(manifest.sourceBundle?.manifestSha256 || '') || !/^[a-f0-9]{64}$/.test(manifest.sourceBundle?.heroDataSha256 || '')
        || !Array.isArray(manifest.files) || manifest.files.length > 514 || new Set(manifest.files.map(file => file.name)).size !== manifest.files.length) throw new Error('Invalid official data manifest.');
    for (const file of manifest.files) {
        if (!/^(valve_hero_data\.json|sources\/herolist\.json|sources\/heroes\/[a-z0-9_]+\.json)$/.test(file.name || '')
            || !/^[a-f0-9]{64}$/.test(file.sha256 || '') || !integer(file.bytes)) throw new Error('Invalid official source identity.');
        const bytes = read(file.name, file.name === 'valve_hero_data.json' ? 64 * 1024 * 1024 : 8 * 1024 * 1024);
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Official bundle checksum mismatch: ${file.name}`);
    }
    if (!manifest.files.some(file => file.name === 'valve_hero_data.json')) throw new Error('Official index is not verified.');
    const index = JSON.parse(read('valve_hero_data.json', 64 * 1024 * 1024));
    if (index.schemaVersion !== 1 || index.version !== manifest.version || index.nativeSourceHash !== manifest.nativeSourceHash
        || index.createdAt !== manifest.createdAt || !object(index.nativeBuild)
        || !Array.isArray(index.heroes) || !index.heroes.length || index.heroes.length > 512
        || new Set(index.heroes.map(hero => hero.heroId)).size !== index.heroes.length) throw new Error('Invalid official hero index.');
    const sourcePath = hero => heroSourcePath(hero, { legacy: index.collectorVersion !== 'valve-hero-data-3' });
    const available = index.heroes.filter(hero => hero.status === 'available').length;
    const coverage = { state: available === index.heroes.length ? 'complete-acquisition' : 'partial-acquisition',
        expectedHeroes: index.heroes.length, availableHeroes: available, unavailableHeroes: index.heroes.length - available, completeMechanics: false };
    if (!equal(index.coverage, coverage) || !equal(manifest.coverage, coverage)) throw new Error('Official acquisition coverage is inconsistent.');
    if (!Array.isArray(manifest.sources) || manifest.sources.length > 513
        || new Set(manifest.sources.map(source => source.name)).size !== manifest.sources.length) throw new Error('Invalid official source registry.');
    const sourceFiles = new Map(manifest.files.filter(file => file.name.startsWith('sources/')).map(file => [file.name, file]));
    for (const source of manifest.sources) {
        const sourceHero = index.heroes.find(hero => sourcePath(hero) === source.name);
        const expectedUrl = source.name === 'sources/herolist.json' ? `${ORIGIN}/datafeed/herolist?language=english`
            : sourceHero ? `${ORIGIN}/datafeed/herodata?language=english&hero_id=${sourceHero.heroId}` : null;
        const file = sourceFiles.get(source.name);
        if (!expectedUrl || source.url !== expectedUrl || !['available', 'unavailable'].includes(source.status)
            || source.status === 'available' && (!file || !validDate(source.retrievedAt)
                || ['sha256', 'bytes', 'retrievedAt', 'url'].some(key => source[key] !== file[key]))
            || source.status === 'unavailable' && file) throw new Error('Official source provenance is inconsistent.');
        sourceFiles.delete(source.name);
    }
    if (sourceFiles.size || !manifest.sources.some(source => source.name === 'sources/herolist.json')) throw new Error('Official source registry is incomplete.');
    const rosterSource = manifest.sources.find(source => source.name === 'sources/herolist.json');
    const roster = rosterSource.status === 'available' ? validateHeroes(JSON.parse(read(rosterSource.name, 8 * 1024 * 1024))) : [];
    const rosterIds = new Map(roster.map(hero => [String(hero.id), hero.name]));
    const nativeHeroes = nativeCatalog?.heroes?.filter(hero => hero.enabled === true);
    if (nativeCatalog && (nativeCatalog.sourceHash !== manifest.nativeSourceHash || !equal(nativeCatalog.build, index.nativeBuild)
        || !Array.isArray(nativeHeroes) || new Set(nativeHeroes.map(hero => hero.heroId)).size !== nativeHeroes.length
        || nativeHeroes.length !== index.heroes.length || nativeHeroes.some(hero => !index.heroes.some(row => row.heroId === hero.heroId && row.heroKey === hero.heroKey)))) {
        throw new Error('Official snapshot does not match the supplied native catalog.');
    }
    const responses = new Map();
    for (const hero of index.heroes) {
        if (!ID.test(hero.heroId) || !NAME.test(hero.heroKey) || !['available', 'unavailable'].includes(hero.status)) throw new Error('Invalid official hero index identity.');
        if (hero.status === 'available') {
            if (hero.sourceFile !== sourcePath(hero) || !manifest.files.some(file => file.name === hero.sourceFile)
                || !manifest.sources.some(source => source.name === hero.sourceFile && source.status === 'available')
                || rosterIds.get(hero.heroId) !== hero.heroKey) throw new Error('Unverified official hero source.');
            const payload = JSON.parse(read(hero.sourceFile, 8 * 1024 * 1024));
            const official = validateHeroes(payload, hero)[0];
            responses.set(hero.heroId, official);
            const abilities = [...official.abilities, ...official.talents];
            if (!Array.isArray(hero.comparisons) || hero.comparisons.length !== abilities.length || hero.coverage?.completeMechanics !== false
                || hero.mechanicsVerified === true || hero.engineVerified === true) throw new Error('Invalid official comparison coverage.');
            for (const [position, comparison] of hero.comparisons.entries()) {
                const ability = abilities[position];
                const collection = position < official.abilities.length ? 'abilities' : 'talents';
                const offset = collection === 'abilities' ? position : position - official.abilities.length;
                const expectedPointer = `/result/data/heroes/0/${collection}/${offset}`;
                if (comparison.abilityId !== ability.name || comparison.officialId !== ability.id || comparison.sourcePointer !== expectedPointer
                    || comparison.mechanicsVerified !== false || !Array.isArray(comparison.matches) || !Array.isArray(comparison.differences)
                    || comparison.notCompared !== undefined && !Array.isArray(comparison.notCompared)) throw new Error('Invalid official comparison identity.');
                for (const field of [...comparison.matches, ...comparison.differences, ...(comparison.notCompared || [])]) {
                    if (typeof field.officialPointer !== 'string' || !field.officialPointer.startsWith(`${expectedPointer}/`)
                        || !equal(field.officialPointer.split('/').slice(1).reduce((value, key) => value?.[key], payload), field.officialValue)) {
                        throw new Error('Official comparison does not match its retained response.');
                    }
                }
            }
            const computed = { ...hero.coverage, officialAbilities: official.abilities.length, officialTalents: official.talents.length,
                matchedAbilities: hero.comparisons.filter(row => row.nativeSourceResource).length,
                comparedFields: hero.comparisons.reduce((sum, row) => sum + row.matches.length + row.differences.length, 0),
                conflictingFields: hero.comparisons.reduce((sum, row) => sum + row.differences.length, 0), completeMechanics: false };
            if (!equal(hero.coverage, computed)) throw new Error('Official comparison counts are inconsistent.');
        }
        else if (hero.sourceFile !== null || manifest.files.some(file => file.name === sourcePath(hero))) throw new Error('Unavailable official hero has an inconsistent source.');
    }
    if (manifest.sources.some(source => source.name !== 'sources/herolist.json'
        && !index.heroes.some(hero => source.name === sourcePath(hero)))) throw new Error('Official source hero is absent from the index.');
    // Preserve legacy comparison rows verbatim; optional trusted native input creates a separate current comparison.
    const reconciledIndex = nativeCatalog ? { ...index, collectorVersion: index.collectorVersion === 'valve-hero-data-3' ? index.collectorVersion : 'valve-hero-data-2', heroes: index.heroes.map(hero => hero.status === 'available'
        ? { ...hero, ...compareValveHero(nativeHeroes.find(native => native.heroId === hero.heroId), responses.get(hero.heroId)) } : hero) } : null;
    return { manifest, index, reconciledIndex, verification: { nativeCatalogMatched: Boolean(nativeCatalog),
        comparisonsRecomputed: Boolean(nativeCatalog), engineMechanicsVerified: false } };
}

export async function main(argv = process.argv.slice(2)) {
    const { values } = parseArgs({ args: argv, options: { bundle: { type: 'string' }, output: { type: 'string' }, version: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) {
        console.log('node scripts/collect-valve-hero-data.mjs --bundle VERIFIED-HERO-BUNDLE --version NEW-VERSION [--output NEW-DIR]');
        return;
    }
    const manifest = await collectValveHeroData(values);
    console.log(JSON.stringify({ version: manifest.version, ...manifest.coverage, files: manifest.files.length }));
    if (manifest.coverage.unavailableHeroes) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message); process.exitCode = 1;
    });
}

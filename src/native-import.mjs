import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openVpk, resolveGameDirectory } from './node/game-files.mjs';
import { decodeMechanicsValue, MECHANICS_VALUE_DECODER_VERSION } from './mechanics-values.mjs';
export { MECHANICS_VALUE_DECODER_VERSION, resolveMechanicsValue } from './mechanics-values.mjs';

export const MECHANICS_IMPORT_VERSION = 'hero-mechanics-import-4';
export const MECHANICS_REFRESH_VERSION = 'hero-mechanics-refresh-2';
export const HERO_MECHANICS_MAX_BYTES = 192 * 1024 * 1024;
export const MECHANICS_REFRESH_LIMITS = Object.freeze({ heroes: 256, effects: 8192, resources: 512, jobs: 4096 });
const hash = value => createHash('sha256').update(value).digest('hex');
const statPattern = /^(Attribute|Attack|BaseAttack|ProjectileSpeed|Movement|ArmorPhysical|MagicalResistance|Status|Vision)/;
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
// Ignore only derived value interpretation, retaining its raw input and exact source binding.
const declarationProjection = value => {
    if (Array.isArray(value)) return value.map(declarationProjection);
    if (!value || typeof value !== 'object') return value;
    if (Object.hasOwn(value, 'raw') && typeof value.state === 'string' && value.sourceResource && !value.abilityId && !value.unitKey) {
        return { raw: value.raw, sourceResource: value.sourceResource, sourcePath: value.sourcePath };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, declarationProjection(child)]));
};

/** Identical duplicate declarations are redundant; conflicting alternatives remain ambiguous. */
export function parseMechanicsDefinitions(text, { duplicateDeclarations = null, resource = null } = {}) {
    const tokens = text.match(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|[{}]|[^\s{}"]+/g) || [];
    let cursor = 0;
    const next = () => {
        while (tokens[cursor]?.startsWith('//')) cursor += 1;
        const token = tokens[cursor];
        cursor += 1;
        return token?.startsWith('"') ? token.slice(1, -1).replace(/\\(["\\])/g, '$1') : token;
    };
    const object = (nested = false, prefix = '') => {
        const result = Object.create(null);
        while (cursor < tokens.length) {
            const key = next();
            if (key === undefined) break;
            if (key === '}' && nested) return result;
            if (key === '{' || key === '}') throw new Error('Unexpected mechanics declaration brace.');
            const value = next();
            if (value === undefined || value === '}') throw new Error('Missing mechanics declaration value.');
            const fieldPath = prefix ? `${prefix}.${key}` : key;
            const parsed = value === '{' ? object(true, fieldPath) : value;
            if (Object.hasOwn(result, key)) {
                if (!duplicateDeclarations) throw new Error(`Duplicate mechanics declaration: ${key}`);
                const equivalent = stable(result[key]) === stable(parsed);
                duplicateDeclarations.push({ resource, path: fieldPath, state: equivalent ? 'equivalent-duplicate' : 'unsupported',
                    first: result[key], alternative: parsed });
            }
            else result[key] = parsed;
        }
        if (nested) throw new Error('Unclosed mechanics declaration object.');
        return result;
    };
    return object();
}

/** Decode declarations without resolving unknown conditions or claiming engine behavior. */
export function normalizeMechanicsValue(raw, source = {}) {
    return decodeMechanicsValue(raw, source);
}

/** Import a complete declared roster without a fixed hero count, or publish nothing. */
export function readHeroMechanics(read, { build, version, extractedAt = new Date().toISOString() } = {}) {
    if (!build?.clientVersion || !version) throw new Error('Build identity and mechanics version are required.');
    const sources = new Map();
    const definitions = new Map();
    const active = new Set();
    const dependencyGraph = [];
    const declarationAmbiguities = [];
    const parse = (text, resource) => parseMechanicsDefinitions(text, { duplicateDeclarations: declarationAmbiguities, resource });
    const load = resource => {
        if (!/^scripts\/npc\/[a-zA-Z0-9_./-]+\.txt$|^resource\/localization\/abilities_english\.txt$/.test(resource)
            || resource.includes('..')) throw new Error('Invalid mechanics resource path.');
        if (!sources.has(resource)) {
            const bytes = Buffer.from(read(resource));
            if (bytes.length > 16 * 1024 * 1024) throw new Error('Mechanics resource exceeds import bound.');
            sources.set(resource, { resource, sha256: hash(bytes), bytes: bytes.length, text: bytes.toString('utf8') });
        }
        return sources.get(resource);
    };
    const visit = resource => {
        if (active.has(resource)) throw new Error('Cyclic hero include.');
        if (definitions.has(resource)) return definitions.get(resource);
        active.add(resource);
        const source = load(resource);
        const heroes = {};
        for (const match of source.text.matchAll(/^\s*#base\s+"([^"]+)"/gm)) {
            const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(resource), match[1]));
            dependencyGraph.push({ from: resource, to: dependency, kind: 'base-include' });
            for (const [key, record] of Object.entries(visit(dependency))) {
                if (Object.hasOwn(heroes, key)) throw new Error(`Duplicate hero definition: ${key}`);
                heroes[key] = record;
            }
        }
        const local = parse(source.text.replace(/^\s*#base\s+"[^"]+"/gm, ''), resource).DOTAHeroes;
        for (const [key, value] of Object.entries(local || {})) {
            if (Object.hasOwn(heroes, key)) throw new Error(`Duplicate hero definition: ${key}`);
            heroes[key] = { raw: value, resource };
        }
        active.delete(resource);
        definitions.set(resource, heroes);
        return heroes;
    };
    const discovered = visit('scripts/npc/npc_heroes.txt');
    const base = discovered.npc_dota_hero_base;
    if (!base) throw new Error('Missing hero base definition.');
    const abilityResource = 'scripts/npc/npc_abilities.txt';
    const shared = parse(load(abilityResource).text, abilityResource).DOTAAbilities;
    if (!shared) throw new Error('Missing shared ability definitions.');
    const unitResource = 'scripts/npc/npc_units.txt';
    const units = parse(load(unitResource).text, unitResource).DOTAUnits;
    if (!units) throw new Error('Missing unit definitions.');
    const localizationResource = 'resource/localization/abilities_english.txt';
    const localization = parse(load(localizationResource).text, localizationResource).lang?.Tokens;
    if (!localization) throw new Error('Missing ability localization.');
    const ids = new Set();
    const heroes = [];
    for (const [heroKey, record] of Object.entries(discovered)) {
        if (heroKey === 'npc_dota_hero_base') continue;
        if (!heroKey.startsWith('npc_dota_hero_')) continue;
        const { raw, resource } = record;
        const heroId = String(raw.HeroID ?? '');
        if (!/^[1-9]\d{0,4}$/.test(heroId)) throw new Error(`Invalid hero identity: ${heroKey}`);
        if (ids.has(heroId)) throw new Error(`Duplicate hero identity: ${heroId}`);
        ids.add(heroId);
        const stats = Object.fromEntries([...new Set([...Object.keys(base.raw), ...Object.keys(raw)])]
            .filter(key => statPattern.test(key)).sort().map(field => {
                const local = Object.hasOwn(raw, field);
                return [field, normalizeMechanicsValue(local ? raw[field] : base.raw[field], {
                    sourceResource: local ? resource : base.resource,
                    sourcePath: `DOTAHeroes.${local ? heroKey : 'npc_dota_hero_base'}.${field}`,
                })];
            }));
        const slots = Object.entries({ ...base.raw, ...raw }).filter(([field, name]) => /^Ability\d+$/.test(field)
            && typeof name === 'string' && name.length > 0).sort(([a], [b]) => Number(a.slice(7)) - Number(b.slice(7)));
        const abilityNames = [...new Set([...slots.map(([, name]) => name), ...Object.keys(raw.AbilityDefinitions || {})])];
        const abilities = abilityNames.map(abilityId => {
            const local = Object.hasOwn(raw.AbilityDefinitions || {}, abilityId);
            const abilityRaw = local ? raw.AbilityDefinitions[abilityId] : shared[abilityId];
            const sourceResource = local ? resource : abilityResource;
            const sourcePath = local ? `DOTAHeroes.${heroKey}.AbilityDefinitions.${abilityId}` : `DOTAAbilities.${abilityId}`;
            dependencyGraph.push({ from: heroKey, to: abilityId, kind: 'ability', sourceResource });
            const tokens = Object.fromEntries(Object.entries(localization).filter(([key]) =>
                key.startsWith(`DOTA_Tooltip_ability_${abilityId}_`) && /Description|Note\d*$|description/.test(key)));
            return { abilityId, owner: heroKey, state: abilityRaw ? 'known' : 'unknown', sourceResource, sourcePath,
                raw: abilityRaw ?? null, values: Object.fromEntries(Object.entries(abilityRaw?.AbilityValues || {})
                    .map(([key, value]) => [key, normalizeMechanicsValue(value, { sourceResource, sourcePath: `${sourcePath}.AbilityValues.${key}` })])),
                localization: { state: Object.keys(tokens).length ? 'known' : 'unknown', sourceResource: localizationResource, tokens },
                interpretation: { state: 'unknown', reason: 'Effect semantics require reviewed annotations.' } };
        });
        const unitNames = new Set(JSON.stringify(raw).match(/npc_dota_[a-z0-9_]+/g) || []);
        const unitDependencies = [...unitNames].filter(key => key !== heroKey).map(key => ({ unitKey: key,
            state: Object.hasOwn(units, key) ? 'known' : 'unknown', sourceResource: unitResource, raw: units[key] ?? null }));
        heroes.push({ heroId, heroKey, key: heroKey.replace(/^npc_dota_hero_/, ''), name: raw.workshop_guide_name || heroKey,
            enabled: raw.Enabled === '1', cmEnabled: raw.CMEnabled === '1', sourceResource: resource,
            nativeStats: stats, abilitySlots: slots.map(([slot, abilityId]) => ({ slot, abilityId })), abilities,
            facets: raw.Facets || {}, raw, unitDependencies,
            dependencyCoverage: { state: 'partial', reason: 'Implicit engine-owned units, forms and runtime relationships require review.' },
            coverage: { rawDefinitions: 'known', mechanics: 'unknown', reviewedEffects: 0 } });
    }
    if (!heroes.some(hero => hero.enabled)) throw new Error('No enabled heroes imported.');
    heroes.sort((a, b) => Number(a.heroId) - Number(b.heroId));
    const manifestSources = [...sources.values()].sort((a, b) => a.resource.localeCompare(b.resource))
        .map(({ resource, sha256, bytes }) => ({ resource, sha256, bytes }));
    const sourceHash = hash(JSON.stringify({ build, sources: manifestSources }));
    return { schemaVersion: 1, version, importerVersion: MECHANICS_IMPORT_VERSION, valueDecoderVersion: MECHANICS_VALUE_DECODER_VERSION, extractedAt,
        evidenceKind: 'installed-valve-declarations', build, sourceHash, sources: manifestSources,
        dependencyGraph, declarationAmbiguities, heroes,
        abilityDefaults: { sourceResource: abilityResource, sourcePath: 'DOTAAbilities.ability_base', raw: shared.ability_base ?? null },
        coverage: { rosterComplete: true, definitionComplete: false, enabled: heroes.filter(hero => hero.enabled).length,
            disabled: heroes.filter(hero => !hero.enabled).length, reviewedEffects: 0 },
        limitations: ['Declarations are not final attribute-modified HUD values or controlled engine tests.',
            'Typed declaration syntax and raw conditional branches are preserved; effective values need explicit context and precedence.',
            'Unreviewed mechanics and implicit runtime dependencies remain unknown.',
            'Installed build compatibility does not establish a remote match build.'] };
}

/** Select review work; unchanged declarations are never automatically promoted across source versions. */
export function planHeroMechanicsRefresh(previous, next, { annotations = null, maxJobs = MECHANICS_REFRESH_LIMITS.jobs,
    previousRulesVersion = null, nextRulesVersion = null } = {}) {
    if (![previous, next].every(value => value?.schemaVersion === 1 && Array.isArray(value.heroes) && Array.isArray(value.sources))) {
        throw new Error('Refresh requires two versioned raw mechanics catalogs.');
    }
    if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > MECHANICS_REFRESH_LIMITS.jobs) throw new Error('Invalid mechanics refresh job bound.');
    if ([previousRulesVersion, nextRulesVersion].some(value => value !== null && (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}$/.test(value)))
        || (previousRulesVersion === null) !== (nextRulesVersion === null)) throw new Error('Refresh rules versions must be supplied as a bounded pair.');
    for (const value of [previous, next]) {
        if (value.heroes.length > MECHANICS_REFRESH_LIMITS.heroes || value.sources.length > MECHANICS_REFRESH_LIMITS.resources
            || value.heroes.some(hero => (hero.abilities?.length || 0) > 128)
            || new Set(value.heroes.map(hero => hero.heroId)).size !== value.heroes.length) throw new Error('Mechanics refresh catalog exceeds bounds or has duplicate identities.');
    }
    if ((annotations?.effects?.length || 0) > MECHANICS_REFRESH_LIMITS.effects) throw new Error('Mechanics refresh effects exceed bounds.');
    const beforeSources = new Map(previous.sources.map(source => [source.resource, source.sha256]));
    const afterSources = new Map(next.sources.map(source => [source.resource, source.sha256]));
    const resources = [...new Set([...beforeSources.keys(), ...afterSources.keys()])].sort().flatMap(resource => {
        if (beforeSources.get(resource) === afterSources.get(resource)) return [];
        return [{ resource, before: beforeSources.get(resource) ?? null, after: afterSources.get(resource) ?? null,
            change: !beforeSources.has(resource) ? 'added' : !afterSources.has(resource) ? 'removed' : 'changed' }];
    });
    const changedResources = new Set(resources.map(row => row.resource));
    const buildChanged = JSON.stringify(previous.build) !== JSON.stringify(next.build);
    const decoderChanged = previous.importerVersion !== next.importerVersion || previous.valueDecoderVersion !== next.valueDecoderVersion;
    for (const value of [previous, next]) for (const key of ['importerVersion', 'valueDecoderVersion']) {
        if (value[key] !== undefined && (typeof value[key] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}$/.test(value[key]))) {
            throw new Error('Invalid mechanics decoder identity.');
        }
    }
    const rulesChanged = previousRulesVersion !== nextRulesVersion;
    const priorHeroes = new Map(previous.heroes.map(hero => [hero.heroId, hero]));
    const nextHeroes = new Map(next.heroes.map(hero => [hero.heroId, hero]));
    const jobs = [];
    const affectedHeroes = [];
    const dependencies = hero => [...new Set([hero.sourceResource, ...Object.values(hero.nativeStats || {}).map(value => value.sourceResource),
        ...(hero.abilities || []).flatMap(ability => [ability.sourceResource, ability.localization?.sourceResource]),
        ...(hero.unitDependencies || []).map(value => value.sourceResource)].filter(Boolean))].sort();
    for (const heroId of [...new Set([...priorHeroes.keys(), ...nextHeroes.keys()])].sort((a, b) => Number(a) - Number(b))) {
        const before = priorHeroes.get(heroId);
        const after = nextHeroes.get(heroId);
        const changedDependencies = [...new Set([...dependencies(before || {}), ...dependencies(after || {})])].filter(resource => changedResources.has(resource));
        const declarationChanged = hash(JSON.stringify(before || null)) !== hash(JSON.stringify(after || null));
        if (declarationChanged && !buildChanged && !changedResources.size && previous.sourceHash === next.sourceHash) {
            if (!decoderChanged || stable(declarationProjection(before || null)) !== stable(declarationProjection(after || null))) {
                throw new Error('Mechanics declarations changed without a changed source identity.');
            }
        }
        if (!buildChanged && !decoderChanged && !declarationChanged && !changedDependencies.length) continue;
        const reasons = [...(buildChanged ? ['build-identity-changed'] : []), ...(decoderChanged ? ['value-decoder-changed'] : []), ...(!before ? ['hero-added'] : !after ? ['hero-removed']
            : declarationChanged ? ['hero-declarations-changed'] : []), ...(changedDependencies.length ? ['source-dependency-changed'] : [])];
        affectedHeroes.push({ heroId, reasons, changedResources: changedDependencies });
        const abilityIds = [...new Set([...(before?.abilities || []).map(ability => ability.abilityId), ...(after?.abilities || []).map(ability => ability.abilityId)])].sort();
        for (const abilityId of abilityIds.length ? abilityIds : [null]) {
            const prior = before?.abilities?.find(ability => ability.abilityId === abilityId) ?? null;
            const current = after?.abilities?.find(ability => ability.abilityId === abilityId) ?? null;
            const refs = dependencies(after || before);
            jobs.push({ jobId: hash(JSON.stringify([heroId, abilityId, next.sourceHash, next.importerVersion, next.valueDecoderVersion])), heroId, abilityId,
                state: after ? 'proposal-review-required' : 'owner-removed', reasons,
                beforeDeclarationHash: prior ? hash(JSON.stringify(prior)) : null,
                afterDeclarationHash: current ? hash(JSON.stringify(current)) : null,
                inputHash: hash(JSON.stringify({ heroId, abilityId, build: next.build, importerVersion: next.importerVersion,
                    valueDecoderVersion: next.valueDecoderVersion, hero: after?.raw ?? null, ability: current,
                    sources: refs.map(resource => ({ resource, sha256: afterSources.get(resource) ?? null })) })),
                sourceRefs: refs.map(resource => ({ resource, sha256: afterSources.get(resource) ?? null })) });
        }
    }
    const affectedIds = new Set(affectedHeroes.map(hero => hero.heroId));
    const effects = (annotations?.effects || []).filter(effect => buildChanged || affectedIds.has(String(effect.heroId))
        || (effect.sourceRefs || []).some(ref => changedResources.has(ref.resource)))
        .map(effect => ({ effectId: effect.effectId ?? null, heroId: String(effect.heroId), abilityId: effect.abilityId ?? null,
            state: 'review-required', reasons: [...(buildChanged ? ['build-identity-changed'] : []),
                ...(affectedIds.has(String(effect.heroId)) ? ['owner-declarations-or-dependencies-changed'] : []),
                ...(!nextHeroes.has(String(effect.heroId)) ? ['owner-removed'] : []),
                ...((effect.sourceRefs || []).some(ref => changedResources.has(ref.resource)) ? ['source-dependency-changed'] : [])] }));
    const selected = jobs.slice(0, maxJobs);
    return { schemaVersion: 1, version: MECHANICS_REFRESH_VERSION,
        previous: { version: previous.version, sourceHash: previous.sourceHash, build: previous.build,
            importerVersion: previous.importerVersion ?? null, valueDecoderVersion: previous.valueDecoderVersion ?? null },
        next: { version: next.version, sourceHash: next.sourceHash, build: next.build,
            importerVersion: next.importerVersion ?? null, valueDecoderVersion: next.valueDecoderVersion ?? null }, buildChanged, decoderChanged, resources,
        rules: { previousVersion: previousRulesVersion, nextVersion: nextRulesVersion, changed: rulesChanged },
        derivedInvalidation: { profiles: buildChanged || decoderChanged || previous.sourceHash !== next.sourceHash || rulesChanged,
            interactions: buildChanged || decoderChanged || previous.sourceHash !== next.sourceHash || rulesChanged,
            advice: buildChanged || decoderChanged || previous.sourceHash !== next.sourceHash || rulesChanged },
        affectedHeroes, invalidatedEffects: effects, jobs: selected,
        coverage: { requiredJobs: jobs.length, selectedJobs: selected.length, remainingJobs: jobs.length - selected.length,
            completeSelection: selected.length === jobs.length, limit: maxJobs, promotedEffects: 0 },
        annotationPolicy: 'Review selection only. Exact build, source hash, dependency pointers and reviewed status remain required by catalog compilation.',
        limitations: ['Resource-level dependency changes conservatively select dependent abilities, including unchanged declarations.',
            'Unchanged resource text does not prove unchanged engine behavior.', 'No AI, network request or automatic annotation approval is performed.'] };
}

/** Publish a new immutable bundle. A failed refresh cannot overwrite a prior version. */
export function writeHeroMechanicsBundle(directory, catalog, annotations = null, refreshPlan = null, { compileBrowserCatalog } = {}) {
    if (fs.existsSync(directory)) throw new Error('Mechanics version already exists; publish a new version.');
    if (refreshPlan && (refreshPlan.schemaVersion !== 1 || refreshPlan.next?.sourceHash !== catalog.sourceHash || refreshPlan.next?.version !== catalog.version)) {
        throw new Error('Mechanics refresh plan does not describe this catalog version.');
    }
    const approved = annotations || { schemaVersion: 1, version: `${catalog.version}-annotations-0`,
        build: catalog.build, sourceHash: catalog.sourceHash, effects: [], coverage: { complete: false, reason: 'No reviewed effects.' } };
    if (typeof compileBrowserCatalog !== 'function') {
        throw new Error('The compatibility browser catalog is application-owned; supply its compiler explicitly.');
    }
    const data = { 'hero_mechanics.json': catalog, 'hero_mechanics_annotations.json': approved,
        'hero_mechanics_browser.json': compileBrowserCatalog(catalog, approved) };
    if (refreshPlan) data['hero_mechanics_refresh.json'] = refreshPlan;
    const serialized = Object.entries(data).map(([name, value]) => [name, `${JSON.stringify(value, null, 2)}\n`]);
    for (const [name, bytes] of serialized) if (Buffer.byteLength(bytes) > HERO_MECHANICS_MAX_BYTES) {
        throw new Error(`Mechanics file exceeds the configured ${HERO_MECHANICS_MAX_BYTES}-byte limit: ${name}`);
    }
    const parent = path.dirname(directory);
    fs.mkdirSync(parent, { recursive: true });
    const staging = fs.mkdtempSync(path.join(parent, '.hero-mechanics-'));
    const files = [];
    for (const [name, bytes] of serialized) {
        fs.writeFileSync(path.join(staging, name), bytes);
        files.push({ name, sha256: hash(bytes) });
    }
    fs.writeFileSync(path.join(staging, 'hero_mechanics_manifest.json'), `${JSON.stringify({ schemaVersion: 1,
        version: catalog.version, build: catalog.build, sourceHash: catalog.sourceHash, coverage: catalog.coverage,
        roster: catalog.heroes.map(({ heroId, key, enabled }) => ({ heroId, key, enabled })), files }, null, 2)}\n`);
    fs.renameSync(staging, directory);
    return { directory, heroes: catalog.heroes.length, coverage: catalog.coverage, sourceHash: catalog.sourceHash };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { values } = parseArgs({ options: { version: { type: 'string' }, game: { type: 'string' }, output: { type: 'string' },
        previous: { type: 'string' }, annotations: { type: 'string' }, 'max-jobs': { type: 'string' },
        'previous-rules-version': { type: 'string' }, 'rules-version': { type: 'string' } } });
    const game = resolveGameDirectory(values.game);
    const metadata = Object.fromEntries(fs.readFileSync(path.join(game, 'dota/steam.inf'), 'utf8').trim().split(/\r?\n/)
        .map(line => line.split('=')));
    const build = { clientVersion: metadata.ClientVersion, serverVersion: metadata.ServerVersion,
        sourceRevision: metadata.SourceRevision, publicPatchLabel: null };
    const version = values.version || `mechanics-${build.clientVersion}-1`;
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(version)) throw new Error('Invalid mechanics version.');
    const archive = openVpk(path.join(game, 'dota/pak01_dir.vpk'));
    const catalog = readHeroMechanics(resource => archive.read(resource), { build, version });
    const boundedRead = filename => {
        if (fs.statSync(filename).size > HERO_MECHANICS_MAX_BYTES) throw new Error('Mechanics refresh input exceeds file bound.');
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
    };
    let refreshPlan = null;
    if (values.previous) {
        const priorPath = path.resolve(values.previous);
        const previousFile = fs.statSync(priorPath).isDirectory() ? path.join(priorPath, 'hero_mechanics.json') : priorPath;
        const priorAnnotationsFile = path.join(path.dirname(previousFile), 'hero_mechanics_annotations.json');
        refreshPlan = planHeroMechanicsRefresh(boundedRead(previousFile), catalog, {
            annotations: fs.existsSync(priorAnnotationsFile) ? boundedRead(priorAnnotationsFile) : null,
            maxJobs: values['max-jobs'] ? Number(values['max-jobs']) : MECHANICS_REFRESH_LIMITS.jobs,
            previousRulesVersion: values['previous-rules-version'] ?? null, nextRulesVersion: values['rules-version'] ?? null,
        });
    }
    else if (values['max-jobs'] || values['previous-rules-version'] || values['rules-version']) throw new Error('Refresh job/rules options require --previous.');
    const annotations = values.annotations ? boundedRead(path.resolve(values.annotations)) : null;
    throw new Error('The library CLI imports source declarations only. Use the application compatibility wrapper to compile its evaluator catalog.');
}

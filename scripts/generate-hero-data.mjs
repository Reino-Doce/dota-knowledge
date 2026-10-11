import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openVpk, resolveGameDirectory } from '../src/node/game-files.mjs';
import { readHeroMechanics, planHeroMechanicsRefresh } from '../src/native-import.mjs';
import { enrichNativeHeroData } from '../src/native-enrichment.mjs';
import { EXTERNAL_SOURCES, buildExternalEvidence, collectExternalSources, sha256, validateExternalPayload } from '../src/provider-records.mjs';

export const HERO_DATA_VERSION = 'hero-data-generator-1';
export const HERO_DATA_MAX_BYTES = 192 * 1024 * 1024;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const boundedRead = filename => {
    if (fs.statSync(filename).size > HERO_DATA_MAX_BYTES) throw new Error('Hero data input exceeds file bound.');
    return fs.readFileSync(filename);
};
const readJson = filename => JSON.parse(boundedRead(filename).toString('utf8'));

export function selectExternalSources(value = 'all') {
    if (value === 'none') return [];
    if (value === 'all') return [...EXTERNAL_SOURCES];
    const requested = value.split(',');
    if (new Set(requested).size !== requested.length || requested.some(id => !EXTERNAL_SOURCES.some(source => source.id === id))) {
        throw new Error('Unknown or repeated external source; see --help.');
    }
    return EXTERNAL_SOURCES.filter(source => requested.includes(source.id));
}

/** A bundle can only reference its own regular files, never arbitrary local files. */
export function verifyHeroDataBundle(directory) {
    const root = fs.realpathSync(directory);
    const manifest = readJson(path.join(root, 'hero_data_manifest.json'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 32
        || new Set(manifest.files.map(file => file.name)).size !== manifest.files.length) throw new Error('Invalid hero data manifest.');
    for (const file of manifest.files) {
        if (!/^(hero_(data|mechanics)(_[a-z]+)?\.json|sources\/[a-z0-9-]+\.json)$/.test(file.name)
            || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid bundle file identity.');
        const resolved = fs.realpathSync(path.join(root, file.name));
        const relative = path.relative(root, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Bundle file escapes its root.');
        if (sha256(boundedRead(resolved)) !== file.sha256) throw new Error(`Bundle checksum mismatch: ${file.name}`);
    }
    for (const name of ['hero_mechanics.json', 'hero_data.json', 'hero_data_external.json']) {
        if (!manifest.files.some(file => file.name === name)) throw new Error(`Bundle is missing ${name}`);
    }
    return manifest;
}

export function reuseExternalSources(directory, selected) {
    const manifest = verifyHeroDataBundle(directory);
    const previous = readJson(path.join(directory, 'hero_data_external.json'));
    if (previous.schemaVersion !== 1 || !Array.isArray(previous.sources)) throw new Error('Invalid external bundle.');
    return selected.map(descriptor => {
        const source = previous.sources.find(row => row.id === descriptor.id);
        if (!source || source.status !== 'available') return { ...descriptor, status: 'unavailable', error: 'Source unavailable in reused bundle.' };
        if (source.repo !== descriptor.repo || source.resource !== descriptor.resource || !/^[a-f0-9]{40}$/.test(source.commit)) {
            throw new Error('Reused source identity mismatch.');
        }
        const name = `sources/${descriptor.id}.json`;
        if (!manifest.files.some(file => file.name === name && file.sha256 === source.sha256)) throw new Error('Reused source checksum not registered.');
        const rawBytes = boundedRead(path.join(directory, name));
        if (sha256(rawBytes) !== source.sha256) throw new Error('Reused source checksum mismatch.');
        const payload = JSON.parse(rawBytes.toString('utf8'));
        validateExternalPayload(descriptor, payload);
        return { ...descriptor, commit: source.commit, commitDate: source.commitDate, retrievedAt: source.retrievedAt,
            url: `https://raw.githubusercontent.com/${descriptor.repo}/${source.commit}/${descriptor.resource}`,
            status: 'available', acquisition: 'reused-verified-snapshot', sha256: source.sha256,
            bytes: rawBytes.length, rawFile: name, rawBytes, payload };
    });
}

export function planHeroDataRefresh(previous, next) {
    const before = new Map(previous.native.heroes.map(hero => [hero.heroId, hero]));
    const after = new Map(next.native.heroes.map(hero => [hero.heroId, hero]));
    const changedHeroes = [];
    for (const heroId of new Set([...before.keys(), ...after.keys()])) {
        const left = before.get(heroId) ?? {};
        const right = after.get(heroId) ?? {};
        const changedFields = [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(key => key !== 'externalEvidence'
            && sha256(JSON.stringify(left[key] ?? null)) !== sha256(JSON.stringify(right[key] ?? null)));
        if (changedFields.length) changedHeroes.push({ heroId, changedFields, state: 'review-required' });
    }
    const priorSources = new Map(previous.external.sources.map(source => [source.id, source]));
    const nextSources = new Map(next.external.sources.map(source => [source.id, source]));
    const externalChanges = [...new Set([...priorSources.keys(), ...nextSources.keys()])].flatMap(id => {
        const left = priorSources.get(id);
        const right = nextSources.get(id);
        const interpretation = value => JSON.stringify(value ? { kind: value.kind, rows: value.rows, semantics: value.semantics,
            cohort: value.cohort, metadata: value.metadata, evidenceUse: value.evidenceUse, compatibility: value.compatibility } : null);
        const interpretationChanged = interpretation(left) !== interpretation(right);
        if (left?.sha256 === right?.sha256 && left?.status === right?.status && left?.commit === right?.commit && !interpretationChanged) return [];
        return [{ sourceId: id, before: left ? { sha256: left.sha256 ?? null, commit: left.commit ?? null, status: left.status } : null,
            after: right ? { sha256: right.sha256 ?? null, commit: right.commit ?? null, status: right.status } : null,
            interpretationChanged, state: 'cohort-and-semantics-review-required' }];
    });
    const nativeChanged = previous.native.sourceHash !== next.native.sourceHash || changedHeroes.length > 0;
    const externalAdapterChanged = previous.external.version !== next.external.version;
    const changedExternalHeroes = [...new Set([...Object.keys(previous.external.heroes ?? {}), ...Object.keys(next.external.heroes ?? {})])]
        .filter(heroId => sha256(JSON.stringify(previous.external.heroes?.[heroId] ?? null)) !== sha256(JSON.stringify(next.external.heroes?.[heroId] ?? null)));
    const externalChanged = externalChanges.length > 0 || externalAdapterChanged || changedExternalHeroes.length > 0;
    return { schemaVersion: 1, generatorVersion: HERO_DATA_VERSION,
        previousVersion: previous.native.version, nextVersion: next.native.version,
        mechanics: planHeroMechanicsRefresh(previous.mechanics, next.mechanics),
        nativeChanged, changedHeroes, externalChanges, externalAdapterChanged, changedExternalHeroes,
        derivedInvalidation: { mechanicsReview: nativeChanged, externalEvidenceReview: externalChanged,
            profilesAndAdvice: nativeChanged || externalChanged },
        promotedEffects: 0,
        policy: 'Changed raw/localized/dependency data and external observations require review of affected derived claims; this bundle does not change the active catalog.' };
}

export function writeHeroDataBundle(directory, { mechanics, native, external, snapshots, refresh = null }) {
    const destination = path.resolve(directory);
    if (fs.existsSync(destination)) throw new Error('Hero data version already exists; choose a new output directory.');
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true });
    const staging = fs.mkdtempSync(path.join(parent, '.hero-data-'));
    try {
        const files = [];
        const write = (name, bytes) => {
            const target = path.join(staging, name);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, bytes);
            files.push({ name, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) });
        };
        write('hero_mechanics.json', json(mechanics));
        write('hero_data.json', json(native));
        write('hero_data_external.json', json(external));
        if (refresh) write('hero_data_refresh.json', json(refresh));
        for (const snapshot of snapshots.filter(source => source.status === 'available')) {
            if (!EXTERNAL_SOURCES.some(source => source.id === snapshot.id) || sha256(snapshot.rawBytes) !== snapshot.sha256) {
                throw new Error('Snapshot identity or checksum mismatch.');
            }
            write(`sources/${snapshot.id}.json`, snapshot.rawBytes);
        }
        write('hero_data_manifest.json', json({ schemaVersion: 1, generatorVersion: HERO_DATA_VERSION, version: native.version,
            build: native.build, createdAt: native.extractedAt, sourceHash: native.sourceHash,
            coverage: { native: native.coverage, external: external.coverage },
            roster: native.heroes.map(({ heroId, key, enabled }) => ({ heroId, key, enabled })), files: [...files],
            publication: 'Local generated research bundle. Review each dataset right before redistribution; no runtime catalog selection is changed.' }));
        verifyHeroDataBundle(staging);
        fs.renameSync(staging, destination);
    }
    finally {
        // Only remove the fresh tool-owned staging directory, never the published bundle.
        if (fs.existsSync(staging) && path.dirname(path.resolve(staging)) === parent && path.basename(staging).startsWith('.hero-data-')) {
            fs.rmSync(staging, { recursive: true });
        }
    }
    return verifyHeroDataBundle(destination);
}

const help = `Generate an immutable, source-qualified hero research bundle from installed game files.

node scripts/generate-hero-data.mjs --version hero-data-<build>-<revision> [options]
  --game DIR               Dota game directory (otherwise use existing installation discovery)
  --output NEW-DIR         Default: test-results/hero-data/<version>
  --external all|none|IDs   Default all; comma-separated source IDs below
  --reuse-external DIR     Use checksummed snapshots from a prior bundle without network requests
  --previous DIR           Compare native definitions, dependencies and external source versions
  --strict-external        Fail publication when any selected external source is unavailable
  --help                   Show this help

Sources: ${EXTERNAL_SOURCES.map(source => source.id).join(', ')}
External observations and hypotheses remain separate from native mechanics. No live service or active catalog is modified.`;

export async function main(argv = process.argv.slice(2)) {
    const { values } = parseArgs({ args: argv, options: { version: { type: 'string' }, game: { type: 'string' },
        output: { type: 'string' }, previous: { type: 'string' }, external: { type: 'string' },
        'reuse-external': { type: 'string' }, 'strict-external': { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) {
        console.log(help); return;
    }
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(values.version ?? '')) throw new Error('Supply a new --version (see --help).');
    const selected = selectExternalSources(values.external);
    const directory = path.resolve(values.output || `test-results/hero-data/${values.version}`);
    if (fs.existsSync(directory)) throw new Error('Hero data version already exists; choose a new output directory.');
    let previous = null;
    if (values.previous) {
        verifyHeroDataBundle(values.previous);
        previous = { mechanics: readJson(path.join(values.previous, 'hero_mechanics.json')),
            native: readJson(path.join(values.previous, 'hero_data.json')), external: readJson(path.join(values.previous, 'hero_data_external.json')) };
    }
    const game = resolveGameDirectory(values.game);
    const buildFile = path.join(game, 'dota/steam.inf');
    const buildBytes = fs.readFileSync(buildFile);
    const metadata = Object.fromEntries(buildBytes.toString('utf8').trim().split(/\r?\n/).map(line => line.split('=')));
    const build = { clientVersion: metadata.ClientVersion, serverVersion: metadata.ServerVersion, sourceRevision: metadata.SourceRevision, publicPatchLabel: null };
    const archive = openVpk(path.join(game, 'dota/pak01_dir.vpk'));
    const read = resource => archive.read(resource);
    const mechanics = readHeroMechanics(read, { build, version: values.version });
    const native = enrichNativeHeroData(mechanics, read);
    if (!buildBytes.equals(fs.readFileSync(buildFile))) throw new Error('Installed build changed during extraction; retry after the game update finishes.');
    console.error(`Native roster: ${native.heroes.length} declared heroes; acquiring ${selected.length} external sources.`);
    const snapshots = values['reuse-external'] ? reuseExternalSources(values['reuse-external'], selected)
        : await collectExternalSources(selected, { onProgress: id => console.error(`Reading ${id}...`) });
    if (values['strict-external'] && snapshots.some(source => source.status !== 'available')) throw new Error('Selected external source unavailable; no bundle published.');
    const external = buildExternalEvidence(snapshots, native);
    for (const hero of native.heroes) hero.externalEvidence = { file: 'hero_data_external.json', pointer: `/heroes/${hero.heroId}`,
        observations: external.heroes[hero.heroId].observations.length, coverage: external.heroes[hero.heroId].coverage };
    const refresh = previous ? planHeroDataRefresh(previous, { mechanics, native, external }) : null;
    const manifest = writeHeroDataBundle(directory, { mechanics, native, external, snapshots, refresh });
    console.log(JSON.stringify({ directory, version: manifest.version, build: manifest.build, coverage: manifest.coverage,
        files: manifest.files.length, refresh: refresh ? { changedHeroes: refresh.changedHeroes.length, externalChanges: refresh.externalChanges.length } : null }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message); process.exitCode = 1;
    });
}

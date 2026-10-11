import fs from 'node:fs/promises';
import path from 'node:path';
import { hash, semanticHash, stable } from '../canonical-model.mjs';
import { SCHEMA_VERSION, COMPILER_VERSION, safePath, normalizeAlias, validateProfile, subjectHeroIds } from '../record-contracts.mjs';
import { loadKnowledgeDirectory } from '../node.mjs';
import { isImageFile } from '../image-contracts.mjs';

export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function within(root, name) {
    if (!safePath(name)) throw new Error('Unsafe dataset path: ' + name);
    const result = path.resolve(root, ...name.split('/'));
    if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error('Dataset path escapes root.');
    return result;
}
export async function regularBytes(root, name) {
    const filename = within(root, name);
    let cursor = path.resolve(root);
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Dataset root cannot be a link.');
    for (const part of name.split('/')) {
        cursor = path.join(cursor, part);
        if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Dataset paths cannot contain links.');
    }
    if (!(await fs.lstat(filename)).isFile()) throw new Error('Dataset artifact is not a regular file.');
    return fs.readFile(filename);
}
export const readJson = async (root, name) => JSON.parse(await regularBytes(root, name));
export async function verifyManifest(root) {
    const manifest = await readJson(root, 'manifest.json');
    const seen = new Set();
    if (manifest.schemaVersion !== 2 || manifest.compilerVersion !== COMPILER_VERSION || !Array.isArray(manifest.sourceFiles)) throw new Error('Unsupported canonical schema.');
    for (const descriptor of manifest.sourceFiles) {
        if (seen.has(descriptor.name)) throw new Error('Duplicate artifact path: ' + descriptor.name);
        seen.add(descriptor.name);
        const bytes = await regularBytes(root, descriptor.name);
        if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256) throw new Error('Artifact integrity mismatch: ' + descriptor.name);
    }
    return manifest;
}

function validateGraph(graph) {
    const ids = new Set();
    const keys = new Set();
    for (const hero of graph.entities.heroes) {
        validateProfile(hero);
        if (ids.has(hero.id) || keys.has(hero.key)) throw new Error('Duplicate hero ID/key mapping.');
        ids.add(hero.id); keys.add(hero.key);
    }
    if (graph.heroIndex.length !== ids.size) throw new Error('Hero index roster mismatch.');
    const indexIds = new Set();
    const slugs = new Set();
    for (const row of graph.heroIndex) {
        const hero = graph.entities.heroes.find(hero => hero.id === row.id);
        if (!hero || indexIds.has(row.id) || row.key !== hero.key || row.sourceKey !== hero.sourceKey
            || row.providerSlug !== null && (typeof row.providerSlug !== 'string' || slugs.has(row.providerSlug))) throw new Error('Inconsistent hero index identity.');
        indexIds.add(row.id); if (row.providerSlug) slugs.add(row.providerSlug);
        for (const [field, suffix] of Object.entries({ profile: 'profile.json', abilities: 'abilities.json', mechanics: 'mechanics.json', guide: 'guides/details.json' })) {
            if (row[field] !== `heroes/${hero.key}/${suffix}`) throw new Error('Invalid hero record location.');
        }
    }
    const expected = new Map();
    for (const hero of graph.entities.heroes) for (const alias of hero.aliases) {
        const key = normalizeAlias(alias);
        if (!expected.has(key)) expected.set(key, new Set());
        expected.get(key).add(hero.key);
    }
    const actual = new Set();
    for (const row of graph.aliases) {
        if (actual.has(row.alias) || !expected.has(row.alias)
            || stable([...expected.get(row.alias)].sort()) !== stable(row.keys)) throw new Error('Invalid alias candidate index.');
        actual.add(row.alias);
    }
    if (actual.size !== expected.size) throw new Error('Incomplete alias index.');
    const observationIds = new Set();
    for (const row of graph.observations) {
        if (observationIds.has(row.id) || !ids.has(row.heroId)) throw new Error('Duplicate or unowned observation: ' + row.id);
        observationIds.add(row.id);
    }
    for (const [id, projection] of graph.runtimeProjection) {
        if (!observationIds.has(id) || !graph.projections[projection]) throw new Error('Unbound observation projection: ' + id);
    }
    const subjects = new Map(Object.values(graph.entities).flat().map(row => [row.id, row]));
    const sourceIds = new Set(graph.sources.map(row => row.id));
    const claims = new Map(graph.claims.map(row => [row.id, row]));
    const bindingIds = new Set();
    for (const binding of graph.bindings) {
        const identity = binding.subjectId + '#' + binding.field;
        const subject = subjects.get(binding.subjectId);
        if (!subject || bindingIds.has(identity) || typeof binding.field !== 'string' || !/^\/(?:[^/~]|~[01]|\/)+$/.test(binding.field)
            || !Object.hasOwn(binding, 'value')) throw new Error('Invalid canonical review binding: ' + identity);
        bindingIds.add(identity);
        const parts = binding.field.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
        const field = parts.pop();
        if (!parts.reduce((value, part) => value?.[part], subject)) throw new Error('Review binding has no canonical field parent: ' + identity);
        if (field === 'sourceIds' && (!Array.isArray(binding.value) || binding.value.some(id => !sourceIds.has(id)))
            || field === 'sourceId' && !sourceIds.has(binding.value)
            || field === 'claimId' && !claims.has(binding.value)
            || field === 'claimIds' && (!Array.isArray(binding.value) || !binding.value.length || binding.value.some(id => claims.get(id)?.subjectId !== binding.subjectId))
            || field === 'sourceIdentity' && !Object.values(graph.metadata.sourceIdentities).includes(binding.value)) {
            throw new Error('Unbound canonical review attribution: ' + identity);
        }
    }
    const historyIds = new Set();
    for (const history of graph.history) {
        if (!ids.has(history.heroId) || historyIds.has(history.heroId)
            || history.sourceIdentities?.mechanics !== graph.metadata.sourceIdentities.mechanics
            || history.sourceIdentities?.enrichedNative !== graph.metadata.sourceIdentities.enrichedNative
            || !Array.isArray(history.historicalObservationIds)
            || new Set(history.historicalObservationIds).size !== history.historicalObservationIds.length
            || history.historicalObservationIds.some(id => !observationIds.has(id)
                || !graph.observations.some(row => row.id === id && row.heroId === history.heroId))) throw new Error('Unbound profile history.');
        historyIds.add(history.heroId);
    }
    if (historyIds.size !== ids.size) throw new Error('Incomplete profile history.');
    return graph;
}

export async function readCanonical(root, { verify = true } = {}) {
    const manifestBytes = await regularBytes(root, 'manifest.json');
    const inputManifest = { name: 'manifest.json', bytes: manifestBytes.length, sha256: hash(manifestBytes) };
    const metadata = verify ? await verifyManifest(root) : await readJson(root, 'manifest.json');
    if (metadata.schemaVersion !== 2) throw new Error('Canonical compilation requires schema version 2.');
    const index = await readJson(root, 'heroes/index.json');
    const aliases = await readJson(root, 'heroes/aliases.json');
    const reference = await readJson(root, 'mechanics/reference.json');
    const entities = { heroes: [], abilities: [], activations: [], effects: [], conditions: [], ...reference.entities };
    const guides = new Map();
    for (const row of index.heroes) {
        entities.heroes.push(await readJson(root, row.profile));
        const abilities = await readJson(root, row.abilities);
        const mechanics = await readJson(root, row.mechanics);
        for (const kind of ['abilities', 'activations']) entities[kind].push(...abilities[kind]);
        for (const kind of ['effects', 'conditions']) entities[kind].push(...mechanics[kind]);
        guides.set(row.id, await readJson(root, row.guide));
    }
    const observationIndex = await readJson(root, 'observations/index.json');
    const files = new Map();
    const observations = [];
    const runtimeProjection = new Map();
    const used = new Set();
    for (const entry of observationIndex.entries) {
        if (!files.has(entry.record)) files.set(entry.record, (await readJson(root, entry.record)).observations);
        const row = files.get(entry.record)[entry.offset];
        const location = entry.record + '#' + entry.offset;
        if (!row || row.id !== entry.id || used.has(location)) throw new Error('Broken observation index: ' + entry.id);
        used.add(location); observations.push(row);
        if (entry.projection !== undefined) runtimeProjection.set(row.id, entry.projection);
    }
    for (const [name, rows] of files) if (rows.some((_, offset) => !used.has(name + '#' + offset))) throw new Error('Unindexed observation: ' + name);
    const extras = new Map();
    for (const descriptor of metadata.sourceFiles ?? []) {
        if (descriptor.name.startsWith('reviews/reconciliation/') || isImageFile(descriptor.name)) extras.set(descriptor.name, await regularBytes(root, descriptor.name));
    }
    return validateGraph({ inputManifest, metadata, entities, sources: await readJson(root, 'observations/sources.json'),
        claims: (await readJson(root, 'reviews/claims.json')).claims,
        bindings: (await readJson(root, 'reviews/bindings.json')).bindings,
        history: (await readJson(root, 'reviews/profiles.json')).profiles,
        guides, observations, runtimeProjection, projections: observationIndex.projections,
        heroIndex: index.heroes, aliases: aliases.entries, reconciliation: metadata.consolidation, extras });
}

export function observationFile(row, heroes) {
    const hero = heroes.get(row.heroId);
    if (!hero) throw new Error('Unowned observation: ' + row.id);
    const leaf = row.kind === 'synergy' ? 'matchups/synergies.json'
        : ['matchup', 'population-matchup'].includes(row.kind) ? 'matchups/counters.json' : 'statistics.json';
    return `heroes/${hero.key}/${leaf}`;
}

export async function writeCanonical(root, graph) {
    validateGraph(graph);
    const descriptors = [];
    const write = async (name, value, raw = false) => {
        const bytes = raw ? value : jsonBytes(value);
        const filename = within(root, name);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, bytes, { flag: 'wx' });
        const descriptor = { name, bytes: bytes.length, sha256: hash(bytes) };
        descriptors.push(descriptor);
        return descriptor;
    };
    const heroes = new Map(graph.entities.heroes.map(hero => [hero.id, hero]));
    const { sourceFiles: _files, consolidation: _oldConsolidation, ...metadata } = graph.metadata;
    metadata.schemaVersion = SCHEMA_VERSION;
    metadata.compilerVersion = COMPILER_VERSION;
    metadata.inputSignature ??= semanticHash({ entities: graph.entities, sources: graph.sources, claims: graph.claims, observations: graph.observations });
    await write('heroes/index.json', { schemaVersion: 2, heroes: graph.heroIndex });
    await write('heroes/aliases.json', { schemaVersion: 2, normalization: 'trim + lowercase + collapsed whitespace', entries: graph.aliases });
    for (const entry of graph.heroIndex) {
        await write(entry.profile, heroes.get(entry.id));
        await write(entry.abilities, { schemaVersion: 2,
            abilities: graph.entities.abilities.filter(row => row.heroId === entry.id),
            activations: graph.entities.activations.filter(row => row.heroId === entry.id) });
        const effects = graph.entities.effects.filter(row => row.heroId === entry.id);
        const owned = new Set(effects.map(row => row.id));
        await write(entry.mechanics, { schemaVersion: 2, effects, conditions: graph.entities.conditions.filter(row => owned.has(row.ownerId)) });
        await write(entry.guide, graph.guides.get(entry.id));
    }
    await write('mechanics/reference.json', { schemaVersion: 2, entities: Object.fromEntries(['modifiers', 'rules', 'units', 'upgrades'].map(kind => [kind, graph.entities[kind]])) });
    await write('observations/sources.json', graph.sources);
    await write('reviews/claims.json', { schemaVersion: 2, claims: graph.claims });
    await write('reviews/bindings.json', { schemaVersion: 2, bindings: graph.bindings });
    await write('reviews/profiles.json', { schemaVersion: 2, profiles: graph.history });
    const partitions = new Map();
    const entries = [];
    const observationsById = new Map();
    for (const row of graph.observations) {
        const record = observationFile(row, heroes);
        if (!partitions.has(record)) partitions.set(record, []);
        const rows = partitions.get(record);
        entries.push({ id: row.id, record, offset: rows.length,
            ...(graph.runtimeProjection.has(row.id) ? { projection: graph.runtimeProjection.get(row.id) } : {}) });
        rows.push(row); observationsById.set(row.id, row);
    }
    for (const [name, observations] of partitions) await write(name, { schemaVersion: 2, observations });
    await write('observations/index.json', { schemaVersion: 2, projections: graph.projections, entries });
    for (const [name, bytes] of graph.extras) await write(name, bytes, true);
    const compiledEntities = structuredClone(graph.entities);
    const strip = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['id', 'ownerId', 'field'].includes(key)));
    for (const activation of compiledEntities.activations) for (const field of ['manaCost', 'cooldown', 'charges']) activation[field] = strip(activation[field]);
    for (const effect of compiledEntities.effects) effect.values = Object.fromEntries(Object.entries(effect.values).map(([field, value]) => [field, strip(value)]));
    const coreClaims = graph.claims.map(claim => {
        const { review, sourceRefs: _refs, sourceRecord: _source, detailsRef: _details, ...summary } = claim;
        return { ...summary, ...(review ? { review: Object.fromEntries(Object.entries(review).filter(([key]) => ['status', 'version', 'evidenceKind', 'engineVerification', 'complete'].includes(key))) } : {}),
            detailsRef: `heroes/${heroes.get(claim.heroId).key}/guide.json#claims/${claim.id}` };
    });
    const runtimeBindings = graph.bindings.filter(row => !['/evidence', '/detailRecord', '/heroId', '/heroKey', '/sourceIdentity'].includes(row.field));
    const subjects = new Map(Object.values(graph.entities).flat().map(row => [row.id, row]));
    const core = { ...metadata, entities: compiledEntities, sources: graph.sources, claims: coreClaims,
        reviewBindings: runtimeBindings,
        observations: [...graph.runtimeProjection].map(([id, projection]) => {
            const row = observationsById.get(id);
            return Object.fromEntries(graph.projections[projection].map(field => [field, row[field]]));
        }) };
    const coreDescriptor = await write('runtime/core.json', core);
    const guideDescriptors = {};
    const observationShards = [];
    for (const hero of graph.entities.heroes) {
        const guide = { ...graph.guides.get(hero.id), schemaVersion: 2, version: metadata.version, createdAt: metadata.createdAt,
            heroId: hero.id, coreSha256: coreDescriptor.sha256, claims: graph.claims.filter(row => row.heroId === hero.id),
            reviewBindings: runtimeBindings.filter(row => subjectHeroIds(subjects.get(row.subjectId), subjects).includes(hero.id)),
            profileHistory: graph.history.find(row => row.heroId === hero.id) };
        const descriptor = await write(`runtime/heroes/${hero.key}/guide.json`, guide);
        guideDescriptors[hero.id] = { ...descriptor, name: descriptor.name.slice(8) };
        const observations = graph.observations.filter(row => row.heroId === hero.id);
        if (!observations.length) continue;
        const shard = await write(`runtime/heroes/${hero.key}/observations.json`, { schemaVersion: 2, version: metadata.version, coreSha256: coreDescriptor.sha256, observations });
        const values = field => [...new Set(observations.map(row => row[field]).filter(Boolean))].sort();
        observationShards.push({ ...shard, name: shard.name.slice(8), heroIds: [hero.id], otherHeroIds: values('otherHeroId'),
            allyHeroIds: values('allyHeroId'), opponentHeroIds: values('opponentHeroId'), cohortIds: values('cohortId'), kinds: values('kind'), sourceIds: values('sourceId') });
    }
    await write('runtime/manifest.json', { schemaVersion: 2, version: metadata.version, createdAt: metadata.createdAt,
        sourceIdentities: metadata.sourceIdentities, core: { ...coreDescriptor, name: 'core.json' }, guides: guideDescriptors, observationShards });
    const manifest = { ...metadata, consolidation: graph.reconciliation,
        sourceFiles: descriptors.sort((left, right) => left.name.localeCompare(right.name)) };
    await write('manifest.json', manifest);
    return manifest;
}

export async function validateRuntime(root) {
    const store = await loadKnowledgeDirectory(path.join(root, 'runtime/manifest.json'));
    try {
        for (const hero of store.heroes()) {
            await store.loadHeroEvidence(hero.id);
            await store.loadObservations({ heroId: hero.id });
        }
    }
    finally { store.retire(); }
}

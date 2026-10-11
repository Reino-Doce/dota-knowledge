import { gunzipSync } from 'node:zlib';
import { hash, semanticHash } from '../../src/canonical-model.mjs';
import { regularBytes } from '../../src/node/canonical.mjs';
import { historicalSource, historicalObservationId, validatePreservationReference } from '../../src/historical-records.mjs';

export const IDENTITY_LEDGER = 'reviews/reconciliation/identities.json';
export const RECONCILIATION_INDEX = 'reviews/reconciliation/index.json';
const parse = bytes => JSON.parse(Buffer.from(bytes));

/** Deterministic signature of the historical migration inputs, excluding generated headers. */
export function historicalInputSignature(graph) {
    return semanticHash({ entities: graph.entities, sources: graph.sources, claims: graph.claims,
        observations: graph.observations, bindings: graph.bindings, history: graph.history, guides: [...graph.guides],
        runtimeProjection: [...graph.runtimeProjection], projections: graph.projections,
        extras: [...graph.extras].sort(([a], [b]) => a === IDENTITY_LEDGER ? 1 : b === IDENTITY_LEDGER ? -1 : a.localeCompare(b))
            .map(([name, bytes]) => ({ name, sha256: hash(bytes) })) });
}

export function pointer(value, location = '') {
    if (!location) return value;
    if (!location.startsWith('/')) throw new Error('Invalid archive pointer.');
    return location.slice(1).split('/').reduce((current, part) => {
        const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
        if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) throw new Error('Unresolved archive pointer: ' + location);
        return current[key];
    }, value);
}

export async function readPreservedBytes(repository, ref) {
    validatePreservationReference(ref);
    const bytes = await regularBytes(repository, ref.path);
    if (hash(bytes) !== ref.sha256 || bytes.length !== ref.bytes) throw new Error('Preservation archive integrity mismatch: ' + ref.path);
    return bytes;
}

export async function readPreservedJson(repository, ref) {
    const bytes = await readPreservedBytes(repository, ref);
    return pointer(JSON.parse(ref.path.endsWith('.gz') ? gunzipSync(bytes) : bytes), ref.pointer);
}

/** Offline canonical validation needs the ledger and current records, never ignored evidence. */
export function verifyIdentityLedger(graph, preserved = new Map()) {
    const index = graph.extras.has(RECONCILIATION_INDEX) ? parse(graph.extras.get(RECONCILIATION_INDEX)) : null;
    if (!graph.extras.has(IDENTITY_LEDGER)) {
        if (index?.schemaVersion === 2) throw new Error('Missing historical identity ledger.');
        return null;
    }
    const ledger = parse(graph.extras.get(IDENTITY_LEDGER));
    if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.entries) || !ledger.entries.length) throw new Error('Invalid identity ledger.');
    validatePreservationReference(ledger.archive);
    validatePreservationReference(ledger.generation?.preservation);
    if (['createdAt', 'generatedAt'].some(field => !Number.isFinite(Date.parse(ledger.generation[field])))) throw new Error('Invalid historical generation clock.');
    if (index?.schemaVersion !== 2 || index.identityLedger !== IDENTITY_LEDGER
        || semanticHash(index.identityCoverage) !== semanticHash(ledger.entries.map(row => row.oldIdentitySha256))) {
        throw new Error('Incomplete historical identity mapping.');
    }
    const seen = new Set(); const destinations = new Set();
    const records = new Map([...graph.sources, ...graph.observations, ...preserved.values()].map(row => [row.id, row]));
    const activeDigests = new Set([...records.keys()].map(hash));
    for (const row of ledger.entries) {
        if (!['source', 'observation'].includes(row.kind)
            || [row.oldIdentitySha256, row.beforeSha256, row.afterSha256].some(value => !/^[a-f0-9]{64}$/.test(value ?? ''))
            || seen.has(row.oldIdentitySha256) || destinations.has(row.newId) || activeDigests.has(row.oldIdentitySha256)) {
            throw new Error('Reused or invalid historical identity.');
        }
        const record = records.get(row.newId);
        if (!record || semanticHash(record) !== row.afterSha256) throw new Error('Historical record is missing or altered: ' + row.newId);
        if (row.kind === 'source') {
            if (row.newId !== 'source:historical:' + record.sha256 || !/historical/.test(record.sourceKind ?? record.kind ?? '')) throw new Error('Invalid historical source.');
            validatePreservationReference(record.preservation);
        }
        else if (record.kind !== 'historical-profile' || record.originalField !== 'historicalProfile'
            || row.newId !== historicalObservationId(record.heroId, record.sourceId?.slice('source:historical:'.length))) throw new Error('Invalid historical observation.');
        seen.add(row.oldIdentitySha256); destinations.add(row.newId);
    }
    return ledger;
}

/** Read-only authorization: archive digests plus the exact allowed transformation. */
export async function verifiedIdentityMapping(graph, repository, preserved) {
    const ledger = verifyIdentityLedger(graph, preserved);
    if (!ledger) return { entries: [], ids: new Map(), sources: new Map(), observations: new Map() };
    const archive = await readPreservedJson(repository, ledger.archive);
    const generation = await readPreservedJson(repository, ledger.generation.preservation);
    for (const field of ['createdAt', 'generatedAt']) {
        if (!Number.isFinite(Date.parse(generation.before?.[field])) || generation.after?.[field] !== ledger.generation[field]) throw new Error('Unverified generation change.');
    }
    if (!/^[a-f0-9]{64}$/.test(generation.before.inputSignature ?? '')) throw new Error('Unverified original input signature.');
    if (!Array.isArray(archive.records) || archive.records.length !== ledger.entries.length) throw new Error('Incomplete archived identity mapping.');
    const byDigest = new Map(ledger.entries.map(row => [row.oldIdentitySha256, row]));
    const mapping = { entries: ledger.entries, ids: new Map(), sources: new Map(), observations: new Map(), generation };
    const active = new Map([...graph.sources, ...graph.observations, ...(preserved?.values() ?? [])].map(row => [row.id, row]));
    for (const { kind, before } of archive.records) {
        const entry = byDigest.get(hash(before.id));
        if (!entry || entry.kind !== kind || mapping.ids.has(before.id) || semanticHash(before) !== entry.beforeSha256) throw new Error('Unverified archived identity.');
        mapping.ids.set(before.id, entry.newId);
        if (kind === 'source') {
            const after = active.get(entry.newId);
            if (semanticHash(await readPreservedJson(repository, after.preservation)) !== semanticHash(before)
                || semanticHash(historicalSource(before, after.preservation)) !== entry.afterSha256) throw new Error('Unauthorized historical source change.');
            mapping.sources.set(before.id, { before, after });
        }
        else mapping.observations.set(before.id, { before, after: active.get(entry.newId) });
    }
    for (const { before, after } of mapping.observations.values()) {
        const source = mapping.sources.get(before.sourceId)?.after;
        if (!source || semanticHash({ ...before, id: historicalObservationId(before.heroId, source.sha256),
            sourceId: source.id, originalField: 'historicalProfile' }) !== semanticHash(after)) throw new Error('Unauthorized historical payload change.');
    }
    return mapping;
}

/** Apply a verified identity view without changing its input or any historical payload. */
export function reconcileValue(value, mapping) {
    if (typeof value === 'string') return mapping.ids.get(value) ?? value;
    if (Array.isArray(value)) return value.map(row => reconcileValue(row, mapping));
    if (!value || typeof value !== 'object') return value;
    const replacement = mapping.sources.get(value.id) ?? mapping.observations.get(value.id);
    if (replacement && semanticHash(value) === semanticHash(replacement.before)) return structuredClone(replacement.after);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, reconcileValue(child, mapping)]));
}

export async function historicalIndex(graph, repository) {
    const index = parse(graph.extras.get(RECONCILIATION_INDEX));
    if (index.schemaVersion === 1) return { index, maps: new Map() };
    if (index.schemaVersion !== 2) throw new Error('Unsupported reconciliation index.');
    const original = await readPreservedJson(repository, index.archivedIndex);
    if (original.schemaVersion !== 1 || semanticHash(original.coverage) !== semanticHash(index.coverage)
        || original.inputSignature !== index.inputSignature) throw new Error('Historical reconciliation coverage differs.');
    const maps = new Map();
    for (const row of index.archivedFieldMaps) {
        if (maps.has(row.name)) throw new Error('Duplicate archived field map.');
        maps.set(row.name, await readPreservedBytes(repository, row.preservation));
    }
    if (maps.size !== original.sourceBundles.length || original.sourceBundles.some(row => !maps.has(row.fieldFile))) throw new Error('Missing historical field map.');
    return { index: original, maps };
}

import { hash, semanticHash } from '../../src/canonical-model.mjs';
import { jsonBytes, observationFile, regularBytes } from '../../src/node/canonical.mjs';

export const LEDGER = 'reviews/reconciliation/population-replacements.json';
export const readLedger = graph => graph.extras.has(LEDGER) ? JSON.parse(graph.extras.get(LEDGER))
    : { schemaVersion: 1, artifacts: [], replacements: [], identities: {} };

/** Verify every retired historical identity against the retained original bytes. */
export function verifyReplacements(graph) {
    const ledger = readLedger(graph);
    if (!graph.extras.has(LEDGER) && [...graph.extras.keys()].some(name => name.startsWith('reviews/reconciliation/population-preserved/'))) throw new Error('Unbound preservation artifacts.');
    if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.artifacts) || !Array.isArray(ledger.replacements)) throw new Error('Invalid replacement reconciliation.');
    const active = new Map(graph.observations.map(row => [row.id, row]));
    const preserved = new Map(); const files = new Map();
    for (const artifact of ledger.artifacts) {
        const bytes = graph.extras.get(artifact.archive);
        if (!/^reviews\/reconciliation\/population-preserved\/[a-f0-9]{64}\.json$/.test(artifact.archive)
            || !bytes || hash(bytes) !== artifact.sha256 || bytes.length !== artifact.bytes) throw new Error('Replacement preservation artifact is not verified.');
        const document = JSON.parse(bytes);
        const rows = document.observations ?? [];
        if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Duplicate preserved identity.');
        files.set(artifact.archive, new Map(rows.map(row => [row.id, row])));
    }
    const authorized = new Set();
    for (const row of ledger.replacements) {
        if (!row.id || !row.scopeKey || !/^[a-f0-9]{64}$/.test(row.beforeSha256) || !row.logicalKey) throw new Error('Invalid replacement identity.');
        if (row.archive) {
            const original = files.get(row.archive)?.get(row.id);
            if (!original || semanticHash(original) !== row.beforeSha256) throw new Error('Replacement target does not resolve to its preservation record.');
            preserved.set(row.id, original); authorized.add(row.id + ':' + row.beforeSha256);
        }
        if (semanticHash(ledger.identities[row.id]) !== semanticHash(row.logicalKey)) throw new Error('Retired identity was reused for a different logical record.');
    }
    for (const artifact of ledger.artifacts) {
        for (const old of files.get(artifact.archive).values()) {
            if (semanticHash(active.get(old.id) ?? null) !== semanticHash(old) && !authorized.has(old.id + ':' + semanticHash(old))) throw new Error('Unexplained historical observation deletion or modification: ' + old.id);
        }
    }
    for (const [id, logical] of Object.entries(ledger.identities)) {
        if (active.get(id)?.logicalKey && semanticHash(active.get(id).logicalKey) !== semanticHash(logical)) throw new Error('Published identity conflicts with replacement ledger.');
    }
    return preserved;
}

const archiveIndexes = new WeakMap();
function archiveIndex(graph, ledger) {
    let index = archiveIndexes.get(ledger);
    if (!index) { index = { seen: new Set(), records: new Map(), files: new Map() }; archiveIndexes.set(ledger, index); }
    for (const artifact of ledger.artifacts) {
        if (index.seen.has(artifact.archive)) continue;
        const rows = JSON.parse(graph.extras.get(artifact.archive)).observations ?? [];
        if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Duplicate preserved identity.');
        for (const row of rows) {
            const key = row.id + ':' + semanticHash(row);
            if (!index.records.has(key)) index.records.set(key, artifact.archive);
        }
        index.files.set(artifact.file, artifact.archive); index.seen.add(artifact.archive);
    }
    return index;
}

export async function recordReplacement({ graph, dataset, removed, incoming, scopeKey, ledger, logical }) {
    const heroes = new Map(graph.entities.heroes.map(hero => [hero.id, hero]));
    const successors = new Map(incoming.map(row => [semanticHash(row.logicalKey), [row.id]]));
    let index = archiveIndex(graph, ledger);
    for (const old of removed) {
        const logicalKey = old.logicalKey ?? logical(old);
        if (ledger.identities[old.id] && semanticHash(ledger.identities[old.id]) !== semanticHash(logicalKey)) throw new Error('Retired identity conflict.');
        ledger.identities[old.id] = logicalKey;
        const beforeSha256 = semanticHash(old);
        let archive = index.records.get(old.id + ':' + beforeSha256) ?? null;
        // Only historical records need indefinite preservation. Ordinary acquisition is prunable.
        if (!archive && !old.population) {
            const file = observationFile(old, heroes);
            const bytes = await regularBytes(dataset, file);
            const sha256 = hash(bytes);
            archive = 'reviews/reconciliation/population-preserved/' + sha256 + '.json';
            if (!ledger.artifacts.some(row => row.archive === archive)) {
                ledger.artifacts.push({ file, archive, sha256, bytes: bytes.length }); graph.extras.set(archive, bytes);
                index = archiveIndex(graph, ledger);
            }
        }
        ledger.replacements.push({ id: old.id, logicalKey, scopeKey, beforeSha256, archive,
            successorIds: successors.get(semanticHash(logicalKey)) ?? [] });
    }
    graph.extras.set(LEDGER, jsonBytes(ledger));
}

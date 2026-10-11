import { gunzipSync } from 'node:zlib';
import { readJson, regularBytes, readCanonical } from '../../src/node/canonical.mjs';
import { semanticHash, hash } from '../../src/canonical-model.mjs';
import { leafCount } from './io.mjs';
import { readLedger, verifyReplacements } from '../population/reconciliation.mjs';
import { verifiedIdentityMapping, reconcileValue } from './identity-reconciliation.mjs';
import { fileURLToPath } from 'node:url';

function pointer(value, location = '') {
    if (location === '') return value;
    return location.slice(1).split('/').reduce((current, part) => {
        const field = part.replaceAll('~1', '/').replaceAll('~0', '~');
        if (!current || typeof current !== 'object' || !Object.hasOwn(current, field)) throw new Error('Unresolved reconciliation pointer: ' + location);
        return current[field];
    }, value);
}
function assertSubset(before, after, location) {
    if (before && typeof before === 'object') {
        if (!after || typeof after !== 'object' || Array.isArray(before) !== Array.isArray(after)
            || Array.isArray(before) && before.length !== after.length) throw new Error('Reconciliation shape differs: ' + location);
        for (const [key, value] of Object.entries(before)) {
            if (!Object.hasOwn(after, key)) throw new Error('Lost reconciliation field: ' + location + '/' + key);
            assertSubset(value, after[key], location + '/' + key);
        }
    }
    else if (before !== after) throw new Error('Reconciliation value differs: ' + location);
}

export async function verifyOverlay({ baseline, dataset, audit, repository = fileURLToPath(new URL('../..', import.meta.url)) }) {
    const graph = await readCanonical(dataset);
    const mapping = await verifiedIdentityMapping(graph, repository, verifyReplacements(graph));
    const archives = new Map();
    for (const artifact of readLedger(graph).artifacts) if (!archives.has(artifact.file)) archives.set(artifact.file, artifact.archive);
    const rows = gunzipSync(await regularBytes(dataset, 'reviews/reconciliation/phase-b-fields.jsonl.gz')).toString('utf8').trim().split('\n');
    const cache = new Map();
    const target = async name => {
        if (cache.has(name)) { const value = cache.get(name); cache.delete(name); cache.set(name, value); return value; }
        const value = await readJson(dataset, archives.get(name) ?? name); cache.set(name, value);
        if (cache.size > 24) cache.delete(cache.keys().next().value);
        return value;
    };
    const claims = new Map((await readJson(dataset, 'reviews/claims.json')).claims.map(row => [row.id, row]));
    let oldFile; let oldValue; let mappedLeaves = 0; let canonical = 0; let structural = 0; let retained = 0;
    const fileCoverage = new Map();
    for (const line of rows) {
        const row = JSON.parse(line);
        if (row.file !== oldFile) {
            oldFile = row.file;
            oldValue = oldFile.endsWith('.json') ? await readJson(baseline, oldFile) : hash(await regularBytes(baseline, oldFile));
        }
        const original = pointer(oldValue, row.pointer);
        if (semanticHash(original) !== row.semanticSha256) throw new Error('Overlay digest differs from Phase A: ' + row.file + '#' + row.pointer);
        if (row.file.endsWith('.json')) {
            const leaves = leafCount(original); mappedLeaves += leaves;
            fileCoverage.set(row.file, (fileCoverage.get(row.file) ?? 0) + leaves);
        }
        const destination = row.destination;
        if (row.disposition === 'retained-evidence') { retained += 1; continue; }
        const document = await target(destination.file);
        let selected = destination.identities ? destination.identities.map(id => {
            if (!claims.has(id)) throw new Error('Unbound reconciliation claim: ' + id); return claims.get(id);
        }) : pointer(document, destination.pointer ?? '/' + destination.field);
        if (row.disposition === 'structural') { structural += 1; continue; }
        if (row.reviewFields?.length) {
            selected = structuredClone(selected);
            for (const binding of row.reviewFields) {
                const last = binding.pointer.lastIndexOf('/');
                const parent = pointer(selected, binding.pointer.slice(0, last));
                parent[binding.pointer.slice(last + 1).replaceAll('~1', '/').replaceAll('~0', '~')] = pointer(await target(binding.target.file), binding.target.pointer);
            }
        }
        const generationField = destination.file === 'runtime/manifest.json' && ['/createdAt', '/generatedAt'].includes(destination.pointer)
            ? destination.pointer.slice(1) : null;
        const expected = generationField && mapping.generation && original === mapping.generation.before[generationField]
            ? mapping.generation.after[generationField] : reconcileValue(original, mapping);
        assertSubset(expected, selected, row.file + '#' + row.pointer);
        canonical += 1;
    }
    const coverage = await readJson(audit, 'coverage.json');
    let phaseAMappedLeaves = 0;
    for (const file of coverage.files) {
        const name = file.file.replace(/^data\/hero-knowledge\//, '');
        if (fileCoverage.get(name) !== file.leaves) throw new Error('Incomplete Phase B file coverage: ' + name);
        phaseAMappedLeaves += fileCoverage.get(name);
    }
    if (phaseAMappedLeaves !== coverage.mappedLeaves) throw new Error('Phase B overlay leaf coverage differs from Phase A.');
    return { mappings: rows.length, mappedLeaves, phaseAMappedLeaves, files: fileCoverage.size, canonical, structural, retained };
}

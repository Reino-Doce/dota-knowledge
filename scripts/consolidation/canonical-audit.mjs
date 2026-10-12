import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readCanonical, regularBytes } from '../../src/node/canonical.mjs';
import { validateDataset } from './validation.mjs';
import { reserveOutput, writeJson, hash } from './io.mjs';
import { semanticHash } from '../../src/canonical-model.mjs';
import { verifyIdentityLedger } from './identity-reconciliation.mjs';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
export async function captureCanonicalAudit({ repository = packageRoot, output, measure = true } = {}) {
    const dataset = path.join(repository, 'data');
    const counts = await validateDataset(dataset);
    const graph = await readCanonical(dataset);
    const startedAt = new Date().toISOString();
    output = await reserveOutput(repository, null, output ?? path.join(repository, 'evidence/consolidation/canonical-' + startedAt.replace(/[:.]/g, '-')));
    const files = [];
    for (const name of ['manifest.json', ...graph.metadata.sourceFiles.map(row => row.name)]) {
        const bytes = await regularBytes(dataset, name);
        files.push({ path: 'data/' + name, bytes: bytes.length, sha256: hash(bytes) });
    }
    await writeJson(output, 'files.json', files);
    await writeJson(output, 'heroes.json', graph.heroIndex);
    await writeJson(output, 'aliases.json', { entries: graph.aliases, collisions: graph.aliases.filter(row => row.keys.length > 1) });
    const identityLedger = verifyIdentityLedger(graph);
    await writeJson(output, 'identities.json', { entities: Object.fromEntries(Object.entries(graph.entities).map(([kind, rows]) => [kind, rows.map(row => row.id)])),
        claims: graph.claims.map(row => row.id), observations: graph.observations.map(row => row.id), semanticIdRenames: identityLedger?.entries ?? [],
        authorizedDataChanges: identityLedger?.statisticsRemoval ? [identityLedger.statisticsRemoval] : [] });
    const records = [...Object.entries(graph.entities).flatMap(([kind, rows]) => rows.map(row => ({ kind, id: row.id, sha256: semanticHash(row) }))),
        ...graph.claims.map(row => ({ kind: 'claim', id: row.id, sha256: semanticHash(row) })),
        ...graph.observations.map(row => ({ kind: 'observation', id: row.id, sha256: semanticHash(row) }))];
    await fs.writeFile(path.join(output, 'records.jsonl.gz'), gzipSync(records.map(row => JSON.stringify(row)).join('\n') + '\n'), { flag: 'wx' });
    if (measure) await writeJson(output, 'performance.json', JSON.parse(execFileSync(process.execPath,
        ['--expose-gc', path.join(packageRoot, 'scripts/consolidation/measure.mjs'), path.join(dataset, 'runtime/manifest.json')], { encoding: 'utf8', windowsHide: true })));
    for (const file of files) if (hash(await regularBytes(repository, file.path)) !== file.sha256) throw new Error('Concurrent selected-input edit during audit.');
    const report = { schemaVersion: 2, auditVersion: 'consolidation-canonical-2', phase: 'current', state: 'verified', startedAt,
        completedAt: new Date().toISOString(), counts, compilerVersion: graph.metadata.compilerVersion,
        manifest: files[0], artifacts: ['files.json', 'heroes.json', 'aliases.json', 'identities.json', 'records.jsonl.gz'],
        performance: measure ? 'performance.json' : { state: 'not measured' } };
    await writeJson(output, 'index.json', report);
    return { output, report };
}

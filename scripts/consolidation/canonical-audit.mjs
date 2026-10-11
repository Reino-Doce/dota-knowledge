import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readCanonical, regularBytes, readJson } from '../../src/node/canonical.mjs';
import { validateDataset } from './validation.mjs';
import { reserveOutput, writeJson, hash, git, within } from './io.mjs';
import { semanticHash } from '../../src/canonical-model.mjs';
import { withBaselineSnapshot } from './baseline-snapshot.mjs';

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
    await writeJson(output, 'identities.json', { entities: Object.fromEntries(Object.entries(graph.entities).map(([kind, rows]) => [kind, rows.map(row => row.id)])),
        claims: graph.claims.map(row => row.id), observations: graph.observations.map(row => row.id), semanticIdRenames: [] });
    const records = [...Object.entries(graph.entities).flatMap(([kind, rows]) => rows.map(row => ({ kind, id: row.id, sha256: semanticHash(row) }))),
        ...graph.claims.map(row => ({ kind: 'claim', id: row.id, sha256: semanticHash(row) })),
        ...graph.observations.map(row => ({ kind: 'observation', id: row.id, sha256: semanticHash(row) }))];
    await fs.writeFile(path.join(output, 'records.jsonl.gz'), gzipSync(records.map(row => JSON.stringify(row)).join('\n') + '\n'), { flag: 'wx' });
    if (measure) await writeJson(output, 'performance.json', JSON.parse(execFileSync(process.execPath,
        ['--expose-gc', path.join(packageRoot, 'scripts/consolidation/measure.mjs'), path.join(dataset, 'runtime/manifest.json')], { encoding: 'utf8', windowsHide: true })));
    for (const file of files) if (hash(await regularBytes(repository, file.path)) !== file.sha256) throw new Error('Concurrent selected-input edit during audit.');
    const report = { schemaVersion: 2, auditVersion: 'consolidation-canonical-2', phase: 'B', state: 'verified', startedAt,
        completedAt: new Date().toISOString(), counts, compilerVersion: graph.metadata.compilerVersion,
        manifest: files[0], artifacts: ['files.json', 'heroes.json', 'aliases.json', 'identities.json', 'records.jsonl.gz'],
        performance: measure ? 'performance.json' : { state: 'not measured' } };
    await writeJson(output, 'index.json', report);
    return { output, report };
}

export async function reproducePhaseA({ audit, repository = packageRoot, picker = path.resolve(repository, '../dotabuff-picker'), output, measure = true }) {
    const destination = path.resolve(output ?? path.join(repository, 'evidence/consolidation/phase-a-reproduced-' + new Date().toISOString().replace(/[:.]/g, '-')));
    return withBaselineSnapshot({ audit, repository, tooling: true, evidence: true, clone: true }, async snapshot => {
        const savedPicker = await readJson(audit, 'picker.json');
        const frozenPicker = path.join(path.dirname(snapshot), 'picker');
        execFileSync('git', ['clone', '--shared', '--no-checkout', '--quiet', path.resolve(picker), frozenPicker], { windowsHide: true, stdio: 'pipe' });
        git(frozenPicker, ['update-ref', 'HEAD', savedPicker.revision]);
        git(frozenPicker, ['read-tree', savedPicker.revision]);
        for (const file of savedPicker.entries) {
            const bytes = await regularBytes(audit, file.retainedFile);
            if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Saved Picker input differs: ' + file.path);
            const filename = within(frozenPicker, file.path);
            await fs.mkdir(path.dirname(filename), { recursive: true });
            await fs.writeFile(filename, bytes, { flag: 'wx' });
        }
        const args = ['scripts/audit-consolidation.mjs', '--picker', frozenPicker, '--output', destination];
        if (!measure) args.push('--skip-measurement');
        execFileSync(process.execPath, args, { cwd: snapshot, windowsHide: true, stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
        return { output: destination, report: JSON.parse(await fs.readFile(path.join(destination, 'index.json'))) };
    });
}

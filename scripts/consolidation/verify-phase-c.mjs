import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withBaselineSnapshot } from './baseline-snapshot.mjs';
import { verifyOverlay } from './preservation.mjs';
import { readJson, regularBytes, verifyManifest } from '../../src/node/canonical.mjs';
import { hash } from '../../src/canonical-model.mjs';
import { reserveOutput, writeJson } from './io.mjs';

const { values } = parseArgs({ options: { audit: { type: 'string' }, output: { type: 'string' }, picker: { type: 'string' } } });
if (!values.audit || !values.picker) throw new Error('Supply --audit and --picker.');
const root = fileURLToPath(new URL('../..', import.meta.url));
const audit = path.resolve(values.audit); const picker = path.resolve(values.picker);
const startedAt = new Date().toISOString();
const destination = await reserveOutput(root, null, path.resolve(values.output ?? path.join(root,
    'evidence/consolidation/phase-c-validation-' + startedAt.replace(/[:.]/g, '-'))));
const before = hash(await regularBytes(path.join(root, 'data'), 'manifest.json'));
if (before !== '90a2439e0b40204c6ca3b607de42a414cbdfca2e21236ed7764ce53164022158') throw new Error('Active Phase B manifest changed.');
await verifyManifest(path.join(root, 'data'));
const preservation = await withBaselineSnapshot({ audit, repository: root }, async (snapshot, recovery) => ({ recovery,
    overlay: await verifyOverlay({ baseline: path.join(snapshot, 'data/hero-knowledge'), dataset: path.join(root, 'data'), audit }) }));
const inventory = await readJson(audit, 'picker.json'); let preserved = 0; let unchanged = 0;
for (const row of inventory.entries) {
    const bytes = await regularBytes(audit, row.retainedFile);
    if (hash(bytes) !== row.sha256 || bytes.length !== row.bytes) throw new Error('Picker preservation differs: ' + row.path);
    preserved++;
    if (/^public\/(data|heroes)\//.test(row.path) || row.path === 'src/data/heroes.ts') {
        if (hash(await regularBytes(picker, row.path)) !== row.sha256) throw new Error('Picker snapshot or image changed: ' + row.path);
        unchanged++;
    }
}
const measurements = { baseline: [], population: [] };
for (let round = 0; round < 3; round++) for (const kind of round % 2 ? ['population', 'baseline'] : ['baseline', 'population']) {
    measurements[kind].push(JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--import', './tests/population/no-network.mjs',
        'scripts/consolidation/measure-population.mjs', '--audit', audit, '--kind', kind], { cwd: root, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, OPENDOTA_API_KEY: '' }, maxBuffer: 1024 * 1024 })));
}
const all = [...measurements.baseline, ...measurements.population];
for (const key of ['resultSha256', 'parserSha256']) if (new Set(all.map(row => row[key])).size !== 1) throw new Error('Frozen fixture parity mismatch: ' + key);
const median = rows => [...rows].sort((a,b) => a-b)[1];
const metrics = Object.fromEntries(['foldMs', 'parseMs', 'retainedHeapBytes', 'peakRssBytes'].map(key => {
    const baseline = median(measurements.baseline.map(row => row[key])); const population = median(measurements.population.map(row => row[key]));
    return [key, { baseline, population, changePercent: (population / baseline - 1) * 100 }];
}));
if (hash(await regularBytes(path.join(root, 'data'), 'manifest.json')) !== before) throw new Error('Verification mutated active data.');
await writeJson(destination, 'preservation.json', { ...preservation, activeManifestSha256: before, pickerPreservedFiles: preserved, pickerUnchangedSnapshotsAndPortraits: unchanged });
await writeJson(destination, 'parity-performance.json', { workload: '100000 deterministic five-hero team rows with position priors; 1000 frozen HTML parses; alternating dedicated processes.', metrics, measurements });
await writeJson(destination, 'index.json', { state: 'complete', startedAt, completedAt: new Date().toISOString(), activeManifestSha256: before,
    files: ['preservation.json', 'parity-performance.json'], boundary: 'Offline fixture/preservation validation only; no collection, publication or image acquisition against active data.' });
console.log(JSON.stringify({ output: path.relative(root, destination).replaceAll('\\', '/'), activeManifestSha256: before, preserved, unchanged, metrics }));

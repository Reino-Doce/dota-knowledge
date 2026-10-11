import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { withBaselineSnapshot } from './baseline-snapshot.mjs';
import { verifyOverlay } from './preservation.mjs';
import { readJson, readCanonical, verifyManifest } from '../../src/node/canonical.mjs';
import { readLegacyLayout } from './legacy-layout.mjs';
import { compareGraphs } from '../compare-current.mjs';
import { migrateCanonical } from '../migrate-canonical.mjs';
import { importDataset } from '../import-legacy-dataset.mjs';
import { regularFile, hash, reserveOutput, writeJson } from './io.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function run(cwd, args) {
    return (await execute(process.execPath, args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout;
}

/** Repeat the exact Phase A workload in isolated processes, with the archived reader. */
export async function verifyPhaseB({ audit, output, rounds = 3 }) {
    if (!audit || !Number.isInteger(rounds) || rounds < 3 || rounds > 9) throw new Error('Pass --audit and 3 to 9 measurement rounds.');
    const startedAt = new Date().toISOString();
    const destination = await reserveOutput(root, null, path.resolve(output ?? path.join(root,
        'evidence/consolidation/phase-b-validation-' + startedAt.replace(/[:.]/g, '-'))));
    const originalManifest = await regularFile(root, 'data/manifest.json');
    const result = await withBaselineSnapshot({ audit, repository: root, tooling: true }, async (snapshot, recovery) => {
        const restoredTests = await run(snapshot, ['--test', 'tests/semantic-diff.test.mjs', 'tests/population-import.test.mjs', 'tests/store.test.mjs']);
        await writeJson(destination, 'baseline-restoration.json', { ...recovery, state: 'verified', focusedTests: 'passed',
            tests: Number(/(?:# |ℹ )tests (\d+)/.exec(restoredTests)?.[1]) });
        const baseline = path.join(snapshot, 'data/hero-knowledge');
        await writeJson(destination, 'reconciliation.json', await verifyOverlay({ baseline, dataset: path.join(root, 'data'), audit }));
        const before = await readLegacyLayout(baseline, { crosswalk: await readJson(audit, 'heroes.json'),
            aliases: (await readJson(audit, 'aliases.json')).entries });
        before.layoutVersion = 1;
        const after = await readCanonical(path.join(root, 'data')); after.layoutVersion = 2;
        const comparison = compareGraphs(before, after);
        await writeJson(destination, 'comparison.json', comparison);
        if (!comparison.equivalent || comparison.counts.metadata) throw new Error('Phase B preservation differs from the archive.');
        const measurements = { baseline: [], canonical: [] };
        for (let round = 0; round < rounds; round += 1) {
            for (const kind of round % 2 ? ['canonical', 'baseline'] : ['baseline', 'canonical']) {
                const cwd = kind === 'baseline' ? snapshot : root;
                const manifest = kind === 'baseline' ? 'data/hero-knowledge/runtime/manifest.json' : 'data/runtime/manifest.json';
                measurements[kind].push(JSON.parse(await run(cwd, ['--expose-gc', 'scripts/consolidation/measure.mjs', manifest])));
            }
        }
        const metrics = {
            repeatedLoadMs: row => row.loadMs.repeated.median, queryBatchMs: row => row.queryBatchMs.median,
            lazyGuideMs: row => row.lazyGuideMs.median, lazyObservationsMs: row => row.lazyObservationsMs.median,
            retainedCoreBytes: row => row.memory.retainedCoreBytes, retainedLazyBytes: row => row.memory.retainedLazyBytes,
            peakRssBytes: row => row.memory.peakRssBytes,
        };
        const comparisonMetrics = Object.fromEntries(Object.entries(metrics).map(([name, select]) => {
            const baseline = median(measurements.baseline.map(select));
            const canonical = median(measurements.canonical.map(select));
            return [name, { baseline, canonical, changePercent: (canonical / baseline - 1) * 100,
                investigate: name.endsWith('Ms') ? canonical > baseline * 1.1 : name.startsWith('retained') && canonical > baseline }];
        }));
        await writeJson(destination, 'performance.json', { rounds, ordering: 'Alternating baseline/canonical dedicated processes; same host and Phase A workload.',
            metrics: comparisonMetrics, measurements });
        const cutover = await migrateCanonical({ dataset: baseline, output: path.join(snapshot, 'data'), audit });
        await writeJson(destination, 'nested-source-cutover.json', { ...cutover,
            scenario: 'Legacy source nested inside the output tree, exercising default first-cutover promotion and post-promotion validation.' });
        const reconciliation = JSON.parse(before.extras.get('reviews/reconciliation/index.json'));
        const sourceRoot = path.dirname(path.resolve(root, reconciliation.evidenceManifest));
        const imported = path.join(snapshot, 'imported');
        await importDataset({ mechanics: path.join(sourceRoot, 'mechanics'), evidence: path.join(sourceRoot, 'external'),
            output: imported, version: before.metadata.version, generatedAt: before.metadata.createdAt });
        const importComparison = compareGraphs(before, await readCanonical(imported));
        await writeJson(destination, 'legacy-import.json', importComparison);
        if (!importComparison.equivalent) throw new Error('Legacy bundle import differs from the normalized preservation baseline.');
        return { comparison: comparison.counts, metrics: comparisonMetrics, recovery };
    });
    // Ordinary canonical compilation must not need acquisition files or a provider checkout.
    const compilations = [];
    for (let pass = 0; pass < 2; pass += 1) {
        await run(root, ['--max-old-space-size=8192', 'scripts/compile-canonical.mjs']);
        await verifyManifest(path.join(root, 'data'));
        const current = await regularFile(root, 'data/manifest.json');
        if (!current.equals(originalManifest)) throw new Error('Identical canonical compilation changed artifact hashes or generation metadata.');
        compilations.push({ pass: pass + 1, manifestSha256: hash(current), state: 'byte-identical' });
    }
    await writeJson(destination, 'determinism.json', { compilations });
    const evidence = (await readJson(audit, 'evidence.json')).files;
    for (const file of evidence) {
        const bytes = await regularFile(root, file.path);
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Original evidence changed: ' + file.path);
    }
    const report = { schemaVersion: 2, startedAt, completedAt: new Date().toISOString(), state: 'verified', ...result,
        unchangedEvidenceFiles: evidence.length, determinism: 'Two byte-identical canonical compilations',
        performanceInvestigations: Object.entries(result.metrics).filter(([, row]) => row.investigate).map(([name]) => name) };
    await writeJson(destination, 'index.json', report);
    return { output: path.relative(root, destination).split(path.sep).join('/'), ...report };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const { values } = parseArgs({ options: { audit: { type: 'string' }, output: { type: 'string' }, rounds: { type: 'string', default: '3' } } });
    process.stdout.write(JSON.stringify(await verifyPhaseB({ ...values, rounds: Number(values.rounds) }), null, 2) + '\n');
}

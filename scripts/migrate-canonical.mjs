import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readJson, writeCanonical, verifyManifest } from '../src/node/canonical.mjs';
import { publishDataset, recoverPublication } from '../src/node/publish-dataset.mjs';
import { readLegacyLayout, verifyPhaseA, reconciliationOverlay } from './consolidation/legacy-layout.mjs';
import { validateDataset } from './consolidation/validation.mjs';
import { compareGraphs } from './compare-current.mjs';
import { withBaselineSnapshot } from './consolidation/baseline-snapshot.mjs';
import { verifyOverlay } from './consolidation/preservation.mjs';
import { hash } from '../src/canonical-model.mjs';
import { regularFile } from './consolidation/io.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
export async function migrateCanonical({ dataset = path.join(packageRoot, 'data/hero-knowledge'), output = path.join(packageRoot, 'data'), audit } = {}) {
    if (!audit) throw new Error('Pass the completed Phase A audit directory.');
    const baseline = await verifyPhaseA(dataset, audit);
    const graph = await readLegacyLayout(dataset, { crosswalk: await readJson(audit, 'heroes.json'), aliases: (await readJson(audit, 'aliases.json')).entries });
    const expected = { heroes: 128, abilities: 2335, activations: 2335, effects: 1760, claims: 8465, observations: 129139 };
    for (const [kind, count] of Object.entries(expected)) {
        if ((graph.entities[kind] ?? graph[kind]).length !== count) throw new Error('Preservation count mismatch: ' + kind);
    }
    if (graph.reconciliation.duplicateOccurrences !== 91265) throw new Error('Unexpected observation duplicate inventory.');
    await reconciliationOverlay(dataset, graph, baseline);
    const relative = path.relative(output, dataset).split(path.sep).join('/');
    let ownedFiles = baseline.files.map(row => row.path.replace(/^data\/hero-knowledge\//, relative ? relative + '/' : ''));
    const current = await readJson(output, 'manifest.json').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current) {
        await verifyManifest(output);
        ownedFiles = ['manifest.json', ...current.sourceFiles.map(row => row.name)];
    }
    let preservedManifest;
    const result = await publishDataset({ target: output, replace: true, ownedFiles,
        build: stage => writeCanonical(stage, graph), validate: async stage => {
            const counts = await validateDataset(stage);
            for (const [kind, count] of Object.entries(expected)) if (counts[kind] !== count) throw new Error('Staged preservation count mismatch: ' + kind);
            const { readCanonical } = await import('../src/node/canonical.mjs');
            const comparison = compareGraphs(graph, await readCanonical(stage));
            if (!comparison.equivalent || comparison.counts.metadata) throw new Error('Staged semantic preservation failed: ' + JSON.stringify(comparison.counts));
            const manifestHash = hash(await regularFile(stage, 'manifest.json'));
            if (preservedManifest !== manifestHash) {
                await verifyPhaseA(dataset, audit);
                await verifyOverlay({ baseline: dataset, dataset: stage, audit });
                preservedManifest = manifestHash;
            }
        } });
    return { ...result, counts: expected, observations: graph.reconciliation };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const { values } = parseArgs({ options: { dataset: { type: 'string' }, output: { type: 'string' }, audit: { type: 'string' }, recover: { type: 'boolean' }, 'from-archive': { type: 'boolean' } } });
    const result = values.recover ? await recoverPublication(values.output ?? path.join(packageRoot, 'data'), { validate: validateDataset })
        : values['from-archive'] ? await withBaselineSnapshot({ audit: values.audit, repository: packageRoot }, snapshot =>
            migrateCanonical({ ...values, dataset: path.join(snapshot, 'data/hero-knowledge') })) : await migrateCanonical(values);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

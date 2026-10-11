import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyOverlay } from './preservation.mjs';
import { readJson, regularBytes, verifyManifest } from '../../src/node/canonical.mjs';
import { hash, semanticHash } from '../../src/canonical-model.mjs';
import { reserveOutput, writeJson, git, filesUnder, regularFile } from './io.mjs';
import { loadImageDirectory } from '../../src/node/images.mjs';
import { createImageStorage, verifiedRun } from '../images/collect.mjs';

const { values } = parseArgs({ options: { audit: { type: 'string' }, output: { type: 'string' }, picker: { type: 'string' },
    baseline: { type: 'string' }, run: { type: 'string' } } });
if (!values.audit || !values.picker || !values.baseline || !values.run) throw new Error('Supply --audit, --picker, --baseline and --run.');
const root = fileURLToPath(new URL('../..', import.meta.url)); const dataset = path.join(root, 'data');
const audit = path.resolve(values.audit); const picker = path.resolve(values.picker);
const startedAt = new Date().toISOString();
const output = await reserveOutput(root, null, path.resolve(values.output ?? path.join(root,
    'evidence/consolidation/phase-d-validation-' + startedAt.replace(/[:.]/g, '-'))));
const before = hash(await regularBytes(dataset, 'manifest.json'));
const baseline = JSON.parse(await fs.readFile(values.baseline));
const manifest = await verifyManifest(dataset);
for (const row of baseline.manifest.sourceFiles) {
    const bytes = await regularBytes(dataset, row.name);
    if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error('Gameplay/runtime bytes changed: ' + row.name);
}
const { sourceFiles: _oldFiles, ...oldMetadata } = baseline.manifest;
const { sourceFiles: _newFiles, ...metadata } = manifest;
if (semanticHash(oldMetadata) !== semanticHash(metadata)) throw new Error('Knowledge generation metadata changed.');
// The Phase A Git objects need not survive a transferred checkout. Its archive
// digest is independently pinned by the byte-preserved canonical Phase B record.
const recovery = await readJson(audit, 'recovery.json');
const phaseB = await readJson(dataset, 'reviews/reconciliation/phase-b.json');
const archiveBytes = await regularBytes(audit, 'baseline.tar.gz');
if (recovery.state !== 'verified' || phaseB.baselineRevision !== recovery.revision
    || phaseB.archiveSha256 !== recovery.archive.sha256 || hash(archiveBytes) !== recovery.archive.sha256
    || archiveBytes.length !== recovery.archive.bytes) throw new Error('Phase A preservation archive differs from its pinned digest.');
const restored = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-image-preservation-'));
let preservation;
try {
    execFileSync('tar', ['-xzf', path.join(audit, 'baseline.tar.gz'), '-C', restored], { windowsHide: true, stdio: 'pipe' });
    const names = await filesUnder(restored);
    if (names.length !== recovery.files) throw new Error('Restored archive file count differs.');
    let restoredBytes = 0;
    for (const name of names) restoredBytes += (await regularFile(restored, name)).length;
    if (restoredBytes !== recovery.bytes) throw new Error('Restored archive byte count differs.');
    const selected = await readJson(audit, 'files.json');
    for (const row of selected) {
        const bytes = await regularBytes(restored, row.retained.member);
        if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error('Restored canonical/runtime artifact differs.');
    }
    execFileSync(process.execPath, ['--test', ...recovery.tests], { cwd: restored, windowsHide: true, stdio: 'pipe' });
    preservation = { recovery: { revision: recovery.revision, files: names.length, selectedFiles: selected.length,
        archiveSha256: recovery.archive.sha256, focusedTests: 'passed',
        verification: 'Pinned archive SHA-256, restored file and byte counts, selected artifact hashes and original focused tests. Original Git object comparison was established by Phase A; not repeated here.' },
    overlay: await verifyOverlay({ baseline: path.join(restored, 'data/hero-knowledge'), dataset, audit }) };
}
finally {
    const resolved = await fs.realpath(restored);
    if (path.dirname(resolved) !== await fs.realpath(os.tmpdir()) || !path.basename(resolved).startsWith('knowledge-image-preservation-')) throw new Error('Unsafe preservation cleanup.');
    await fs.rm(resolved, { recursive: true });
}
let acquisitionFiles = 0;
for (const row of (await readJson(audit, 'evidence.json')).files) {
    const bytes = await regularBytes(root, row.path);
    if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error('Original acquisition evidence changed.');
    acquisitionFiles++;
}
const catalog = await loadImageDirectory(dataset);
const heroIndex = await readJson(dataset, 'heroes/index.json');
let retainedPicker = 0; let unchangedPicker = 0; let portraits = 0;
for (const row of (await readJson(audit, 'picker.json')).entries) {
    const bytes = await regularBytes(audit, row.retainedFile);
    if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error('Picker preservation differs.');
    retainedPicker++;
    if (/^public\/(data|heroes)\//.test(row.path) || row.path === 'src/data/heroes.ts') {
        if (hash(await regularBytes(picker, row.path)) !== row.sha256) throw new Error('Picker data or portrait changed.');
        unchangedPicker++;
    }
    if (row.path.startsWith('public/heroes/')) {
        const slug = path.basename(row.path, '.png');
        const hero = heroIndex.heroes.find(hero => hero.providerSlug === slug);
        if (!hero || catalog.image('hero', hero.id, 'profile')?.sha256 !== row.sha256) throw new Error('Imported portrait differs from its canonical crosswalk.');
        portraits++;
    }
}
await writeJson(output, 'preservation.json', { ...preservation, knowledgeManifestBefore: baseline.manifestSha256, manifestAfter: before,
    unchangedKnowledgeFiles: baseline.manifest.sourceFiles.length, unchangedKnowledgeMetadata: true, acquisitionFiles, retainedPicker, unchangedPicker, exactImportedPortraits: portraits });
console.log(JSON.stringify({ event: 'preservation-passed', output: path.relative(root, output).replaceAll('\\', '/') }));
const storage = await createImageStorage(path.join(root, 'evidence/images/acquisition'));
const run = await storage.read(`runs/${values.run}/manifest.json`); const normalized = await verifiedRun(storage, run);
if (catalog.manifest.inputSignature !== run.inputSignature || catalog.manifest.catalog.sha256 !== normalized.manifest.catalog.sha256) throw new Error('Published catalog differs from selected image evidence.');
const coverage = Object.fromEntries(['hero', 'ability', 'item'].map(kind => {
    const images = catalog.images(kind);
    return [kind, { entities: catalog.entities(kind).length, bindings: images.length, available: images.filter(row => row.state === 'available').length,
        unavailable: images.filter(row => row.state === 'unavailable').length }];
}));
await writeJson(output, 'coverage.json', { runId: run.runId, imageManifest: catalog.manifest, coverage, assets: normalized.catalog.assets.length,
    assetBytes: normalized.catalog.assets.reduce((sum, row) => sum + row.bytes, 0), excludedItems: catalog.exclusions().length,
    dimensions: Object.fromEntries([...new Set(normalized.catalog.assets.map(row => `${row.width}x${row.height}`))].map(size => [size,
        normalized.catalog.assets.filter(row => `${row.width}x${row.height}` === size).length])),
    unavailable: catalog.images().filter(row => row.state === 'unavailable'),
    sourceMappings: run.inventory.requests.map(row => ({ id: row.id, source: row.source ?? null, mapping: row.mapping ?? 'native-or-preserved-portrait' })) });
console.log(JSON.stringify({ event: 'coverage-passed', coverage }));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-image-measure-'));
try {
    const archive = path.join(temporary, 'baseline.tar');
    await fs.writeFile(archive, git(root, ['-c', 'core.autocrlf=false', 'archive', baseline.revision, 'src', 'scripts/consolidation/measure.mjs'], 'buffer'));
    execFileSync('tar', ['-xf', archive, '-C', temporary], { windowsHide: true, stdio: 'pipe' });
    const measurements = { baseline: [], images: [] };
    const measure = (cwd, script, argument) => JSON.parse(execFileSync(process.execPath, ['--expose-gc', script, argument],
        { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 }));
    for (let round = 0; round < 3; round++) for (const kind of round % 2 ? ['images', 'baseline'] : ['baseline', 'images']) {
        measurements[kind].push(measure(kind === 'baseline' ? temporary : root, 'scripts/consolidation/measure.mjs', path.join(dataset, 'runtime/manifest.json')));
        console.log(JSON.stringify({ event: 'core-measurement', round, kind }));
    }
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const metrics = Object.fromEntries([['coldLoadMs', row => row.loadMs.first], ['warmLoadMs', row => row.loadMs.repeated.median],
        ['queryMedianMs', row => row.queryBatchMs.median], ['queryP95Ms', row => row.queryBatchMs.p95],
        ['guideMedianMs', row => row.lazyGuideMs.median], ['observationMedianMs', row => row.lazyObservationsMs.median],
        ['retainedCoreBytes', row => row.memory.retainedCoreBytes], ['retainedLazyBytes', row => row.memory.retainedLazyBytes],
        ['peakRssBytes', row => row.memory.peakRssBytes]].map(([name, extract]) => {
        const old = median(measurements.baseline.map(extract)); const current = median(measurements.images.map(extract));
        return [name, { baseline: old, current, changePercent: (current / old - 1) * 100 }];
    }));
    const images = measure(root, 'scripts/consolidation/measure-images.mjs', dataset);
    let unchangedRuntimeImplementations = true;
    for (const name of ['src/index.mjs', 'src/node.mjs', 'src/record-contracts.mjs', 'src/sha256.mjs']) {
        if (hash(git(root, ['show', baseline.revision + ':' + name], 'buffer')) !== hash(await fs.readFile(path.join(root, name)))) unchangedRuntimeImplementations = false;
    }
    await writeJson(output, 'performance.json', { baselineRevision: baseline.revision, measurements, metrics, images,
        unchangedRuntimeImplementations });
    console.log(JSON.stringify({ event: 'performance-complete', metrics }));
}
finally {
    const resolved = await fs.realpath(temporary);
    if (path.dirname(resolved) !== await fs.realpath(os.tmpdir()) || !path.basename(resolved).startsWith('knowledge-image-measure-')) throw new Error('Unsafe measurement cleanup.');
    await fs.rm(resolved, { recursive: true });
}
if (hash(await regularBytes(dataset, 'manifest.json')) !== before) throw new Error('Verification mutated active data.');
await writeJson(output, 'index.json', { state: 'complete', startedAt, completedAt: new Date().toISOString(), manifestSha256: before,
    files: ['preservation.json', 'coverage.json', 'performance.json'], boundary: 'Read-only preservation, image provenance and runtime measurements. No acquisition or publication.' });
console.log(JSON.stringify({ state: 'complete', output: path.relative(root, output).replaceAll('\\', '/') }));

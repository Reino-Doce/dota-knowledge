import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { hash, semanticHash } from '../src/canonical-model.mjs';
import { historicalSource, historicalObservationId, validatePreservationReference } from '../src/historical-records.mjs';
import { jsonBytes, readCanonical, writeCanonical, readJson } from '../src/node/canonical.mjs';
import { publishDataset, recoverPublication, inventory } from '../src/node/publish-dataset.mjs';
import { importDataset } from '../scripts/import-bundle.mjs';
import { writeBundleFixture } from '../docs/examples/bundle-fixture.mjs';
import { graphFixture } from './fixtures/canonical-graph.mjs';
import { compareWithIdentities } from '../scripts/compare-current.mjs';
import { validateDataset, schemaValidators } from '../scripts/consolidation/validation.mjs';
import { scanReferences } from '../scripts/consolidation/reference-scan.mjs';
import { collectPopulation, applyPopulation, createFileStorage, recipeSettings, DEFAULT_LIMITS } from '../src/node/population.mjs';
import { IDENTITY_LEDGER, RECONCILIATION_INDEX, verifyIdentityLedger, verifiedIdentityMapping,
    reconcileValue, historicalIndex, historicalInputSignature } from '../scripts/consolidation/identity-reconciliation.mjs';

async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-historical-test-'));
    t.after(async () => {
        assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
        await fs.rm(root, { recursive: true });
    });
    return root;
}

async function archiveFixture(root) {
    const save = async (name, value) => {
        const bytes = jsonBytes(value); const file = 'evidence/' + name;
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await fs.writeFile(path.join(root, file), bytes);
        return { kind: 'archived-json', path: file, bytes: bytes.length, sha256: hash(bytes), pointer: '' };
    };
    const before = graphFixture();
    before.metadata.inputSignature = 'd'.repeat(64);
    before.sources[0].kind = 'historical-synthetic'; before.sources[0].sourceKind = 'historical-synthetic';
    before.sources[0].repo = 'retired-example/archive'; before.sources[0].url = 'https://example.invalid/old';
    before.sources[0].metadata = { items: [{ id: 1, name: 'preserved item' }], snapshotCommittedAt: '2024-01-01T00:00:00Z' };
    const source = before.sources[0]; const observation = before.observations.find(row => row.kind === 'historical-profile');
    observation.originalField = 'retiredProfile';
    before.guides.get('1').statObservationIds = [observation.id];
    const preservation = await save('source.json', source);
    const newSource = historicalSource(source, preservation);
    const newObservation = { ...observation, id: historicalObservationId(observation.heroId, source.sha256),
        sourceId: newSource.id, originalField: 'historicalProfile' };
    const mapping = { ids: new Map([[source.id, newSource.id], [observation.id, newObservation.id]]),
        sources: new Map([[source.id, { before: source, after: newSource }]]),
        observations: new Map([[observation.id, { before: observation, after: newObservation }]]) };
    const after = structuredClone(before);
    for (const key of ['entities', 'sources', 'observations', 'claims', 'bindings', 'history']) after[key] = reconcileValue(before[key], mapping);
    after.guides = new Map([...before.guides].map(([id, value]) => [id, reconcileValue(value, mapping)]));
    const records = [{ kind: 'source', before: source }, { kind: 'observation', before: observation }];
    const ledger = { schemaVersion: 1, archive: await save('identities.json', { records }), entries: records.map(({ kind, before: record }, i) => ({
        kind, oldIdentitySha256: hash(record.id), newId: [newSource, newObservation][i].id,
        beforeSha256: semanticHash(record), afterSha256: semanticHash([newSource, newObservation][i]) })) };
    const clocks = { createdAt: before.metadata.createdAt, generatedAt: before.metadata.generatedAt };
    const generated = { createdAt: '2026-10-02T00:00:00Z', generatedAt: '2026-10-02T00:00:00Z' };
    Object.assign(after.metadata, generated);
    ledger.generation = { ...generated, preservation: await save('generation.json', { before: { ...clocks, inputSignature: before.metadata.inputSignature }, after: generated }) };
    const coverage = { selectedFieldPaths: 1, selectedBundleFields: 1, reconciledClaims: 1, recoveredNativeSourceBytes: 0 };
    const archivedIndex = await save('index.json', { schemaVersion: 1, inputSignature: 'd'.repeat(64), coverage,
        sourceBundles: [{ fieldFile: 'reviews/reconciliation/fields/fixture.json.gz' }] });
    const map = await save('map.json', { retained: true });
    after.extras.set(IDENTITY_LEDGER, jsonBytes(ledger));
    after.extras.set(RECONCILIATION_INDEX, jsonBytes({ schemaVersion: 2, inputSignature: 'd'.repeat(64), coverage,
        identityLedger: IDENTITY_LEDGER, identityCoverage: ledger.entries.map(row => row.oldIdentitySha256), archivedIndex,
        archivedFieldMaps: [{ name: 'reviews/reconciliation/fields/fixture.json.gz', preservation: map }] }));
    after.metadata.inputSignature = historicalInputSignature(after);
    return { before, after, ledger, preservation, mapping };
}

test('neutral bundle import preserves historical values, native authority, references and generation on repetition', async t => {
    const root = await temporary(t); const options = await writeBundleFixture(root);
    const evidencePath = path.join(options.evidence, 'draft_evidence.json');
    const input = JSON.parse(await fs.readFile(evidencePath));
    input.heroes['1'].extraMetrics = { matches: '9007199254740993', order: [3, 1] };
    const inputBytes = jsonBytes(input); await fs.writeFile(evidencePath, inputBytes);
    const manifestPath = path.join(options.evidence, 'draft_evidence_manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath));
    Object.assign(manifest.files[0], { bytes: inputBytes.length, sha256: hash(inputBytes) }); await fs.writeFile(manifestPath, jsonBytes(manifest));
    await importDataset({ ...options, quiet: true });
    const graph = await readCanonical(options.output);
    const row = graph.observations.find(row => row.kind === 'historical-profile');
    assert.equal(row.id, historicalObservationId('1', options.historicalHash));
    assert.deepEqual(row.sourceRecord, options.profile);
    assert.deepEqual(graph.observations.find(row => row.kind === 'provider-record:extraMetrics').sourceRecord, input.heroes['1'].extraMetrics);
    assert.equal(graph.entities.heroes[0].complexity, 1);
    assert.equal(graph.history[0].historicalObservationIds[0], row.id);
    assert.ok(graph.guides.get('1').statObservationIds.includes(row.id));
    const previous = await inventory(options.output);
    const evidence = await inventory(path.join(root, 'evidence'));
    await importDataset({ ...options, quiet: true, generatedAt: '2026-10-02T00:00:00Z' });
    assert.deepEqual(await inventory(options.output), previous);
    assert.deepEqual(await inventory(path.join(root, 'evidence')), evidence);
});

test('bundle import rejects unsupported historical fields, collisions, missing sources and hash mismatches', async t => {
    const root = await temporary(t);
    const mutations = [
        value => { value.heroes['1'].historicalProfiles[0].ignored = true; },
        value => { value.heroes['1'].historicalProfiles[0].sourceRecord.futureField = 1; },
        value => { value.heroes['1'].retiredProfile = {}; },
        value => { value.heroes['1'].historicalProfiles = {}; },
        value => { value.heroes['1'].historicalProfiles.push(value.heroes['1'].historicalProfiles[0]); },
        value => { value.sources.push({ ...value.sources[0], id: 'another-source' }); value.heroes['1'].historicalProfiles.push({ ...value.heroes['1'].historicalProfiles[0], sourceId: 'source:another-source' }); },
        value => { value.heroes['1'].historicalProfiles[0].sourceId = 'source:missing'; },
        value => { value.sources[0].sha256 = '0'.repeat(64); },
    ];
    for (const [i, mutate] of mutations.entries()) {
        const options = await writeBundleFixture(path.join(root, String(i)));
        const file = path.join(options.evidence, 'draft_evidence.json'); const value = JSON.parse(await fs.readFile(file));
        mutate(value); const bytes = jsonBytes(value); await fs.writeFile(file, bytes);
        const manifestPath = path.join(options.evidence, 'draft_evidence_manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath));
        Object.assign(manifest.files[0], { bytes: bytes.length, sha256: hash(bytes) }); await fs.writeFile(manifestPath, jsonBytes(manifest));
        await assert.rejects(importDataset({ ...options, quiet: true }), /historical|Historical|Unsupported|collision/);
        await assert.rejects(fs.access(options.output), { code: 'ENOENT' });
    }
});

test('verified identities reconcile separately from raw differences and never authorize other changes', async t => {
    const root = await temporary(t); const { before, after } = await archiveFixture(root);
    const report = await compareWithIdentities(before, after, { repository: root });
    assert.equal(report.equivalent, true); assert.equal(report.identityChanges.length, 2);
    assert.ok(report.raw.counts.observations > 0); assert.equal(report.counts.observations, 0);
    for (const change of [
        graph => { graph.observations[0].matchCount = '9007199254740994'; },
        graph => { graph.claims[0].status = 'reviewed'; },
        graph => { graph.guides.get('1').newPayload = true; },
        graph => { graph.bindings[0].value = 'unbound'; },
        graph => { graph.metadata.generatedAt = '2026-10-03T00:00:00Z'; },
        graph => { graph.metadata.inputSignature = '0'.repeat(64); },
        graph => { graph.metadata.inputSignature = before.metadata.inputSignature; },
        graph => { graph.metadata.createdAt = before.metadata.createdAt; },
        graph => { graph.metadata.generatedAt = before.metadata.generatedAt; },
    ]) {
        const copy = structuredClone(after); change(copy);
        assert.equal((await compareWithIdentities(before, copy, { repository: root })).equivalent, false);
    }
    const corrupt = structuredClone(after); corrupt.metadata.inputSignature = '0'.repeat(64);
    assert.equal((await compareWithIdentities(after, corrupt, { repository: root })).equivalent, false);
    await writeCanonical(path.join(root, 'data'), after);
    await validateDataset(path.join(root, 'data'));
    const read = await readCanonical(path.join(root, 'data'));
    await verifiedIdentityMapping(read, root);
    const reference = after.sources[0].preservation;
    const schemas = await schemaValidators();
    assert.equal(schemas.get('preservation-reference')(reference), true);
    for (const ref of [{ ...reference, path: '../escape' }, { ...reference, path: 'evidence/../escape' },
        { ...reference, path: 'evidence//archive.json' }, { ...reference, path: 'evidence/archive.json/' },
        { ...reference, bytes: -1 }, { ...reference, pointer: '/~2' }]) {
        assert.throws(() => validatePreservationReference(ref));
        assert.equal(schemas.get('preservation-reference')(ref), false);
    }
});

test('missing, tampered and incomplete archives, mappings, deleted records and reused identities fail closed', async t => {
    const root = await temporary(t); const { after, ledger, preservation } = await archiveFixture(root);
    for (const mutation of [
        graph => { graph.observations.pop(); },
        graph => { graph.observations.at(-1).sourceRecord.complexity = 3; },
        graph => { graph.sources.push({ ...graph.sources[0], id: 'source:fixture' }); },
        graph => { graph.extras.delete(IDENTITY_LEDGER); },
        graph => { graph.extras.set(IDENTITY_LEDGER, jsonBytes({ ...ledger, entries: ledger.entries.slice(1) })); },
        graph => { graph.extras.set(IDENTITY_LEDGER, jsonBytes({ ...ledger, entries: [...ledger.entries, ledger.entries[0]] })); },
    ]) {
        const copy = structuredClone(after); mutation(copy);
        assert.throws(() => verifyIdentityLedger(copy));
    }
    const file = path.join(root, preservation.path); const original = await fs.readFile(file);
    await fs.writeFile(file, 'tampered'); await assert.rejects(verifiedIdentityMapping(after, root), /integrity/);
    await fs.unlink(file); await assert.rejects(verifiedIdentityMapping(after, root), { code: 'ENOENT' });
    await fs.writeFile(file, original);
    assert.equal((await historicalIndex(after, root)).maps.size, 1);
    const copy = structuredClone(after); const index = JSON.parse(Buffer.from(copy.extras.get(RECONCILIATION_INDEX)));
    index.archivedFieldMaps = []; copy.extras.set(RECONCILIATION_INDEX, jsonBytes(index));
    await assert.rejects(historicalIndex(copy, root), /Missing historical field map/);
    const archivePath = path.join(root, ledger.archive.path); const bytes = await fs.readFile(archivePath);
    await fs.writeFile(archivePath, '{}'); await assert.rejects(verifiedIdentityMapping(after, root), /integrity/);
    await fs.writeFile(archivePath, bytes);
});

test('later population publication retains the historical ledger without freezing dataset clocks', async t => {
    const root = await temporary(t); const { after } = await archiveFixture(root);
    after.heroIndex.find(row => row.id === '7').providerSlug = 'earthshaker';
    const dataset = path.join(root, 'data'); await writeCanonical(dataset, after);
    const evidence = await inventory(path.join(root, 'evidence'));
    const storage = await createFileStorage(path.join(root, 'population'));
    const clock = () => new Date('2026-10-12T12:00:00Z');
    const run = await collectPopulation({ runId: 'later', roster: after.heroIndex.map(row => ({ ...row, enabled: row.id !== '127' })),
        storage, clock, sleep: async () => {}, logger: () => {}, signal: new AbortController().signal,
        limits: { ...DEFAULT_LIMITS, retries: 0, spacingMs: 0 }, recipes: recipeSettings({ dotabuff: { minMatchupRows: 1, minRosterRows: 1 } }),
        priorInputs: { positionPriors: null }, steps: ['counters'], clients: { dotabuff: async request => new Response(request.operation === 'hero-stats'
            ? '<a href="/heroes/anti-mage">Anti-Mage</a><a href="/heroes/earthshaker">Earthshaker</a>'
            : '<table><tr><td><a href="/heroes/' + (request.slug === 'anti-mage' ? 'earthshaker' : 'anti-mage')
                + '">Name</a></td><td data-value="1">1</td><td data-value="52">52</td><td data-value="1000">1000</td></tr></table>') } });
    assert.equal(run.state, 'complete');
    assert.equal((await applyPopulation({ dataset, storage, runId: 'later', clock })).state, 'verified-promoted');
    const current = await readCanonical(dataset);
    assert.equal(current.metadata.generatedAt, clock().toISOString());
    assert.deepEqual(current.extras.get(IDENTITY_LEDGER), after.extras.get(IDENTITY_LEDGER));
    await verifiedIdentityMapping(current, root);
    assert.deepEqual(await inventory(path.join(root, 'evidence')), evidence);
    const published = await inventory(dataset);
    assert.equal((await applyPopulation({ dataset, storage, runId: 'later', clock })).state, 'unchanged');
    assert.deepEqual(await inventory(dataset), published);
});

test('identity publication failures, interrupted rollback and concurrent edits preserve prior data and evidence', async t => {
    const root = await temporary(t); const { before, after } = await archiveFixture(root);
    const evidence = await inventory(path.join(root, 'evidence')); const target = path.join(root, 'data');
    const manifest = await writeCanonical(target, before); const original = await inventory(target);
    const ownedFiles = ['manifest.json', ...manifest.sourceFiles.map(row => row.name)];
    await assert.rejects(publishDataset({ target, replace: true, ownedFiles, expectedFiles: original,
        build: stage => writeCanonical(stage, after), validate: async () => { throw new Error('Injected validation failure'); } }), /Injected/);
    assert.deepEqual(await inventory(target), original);
    await assert.rejects(publishDataset({ target, replace: true, ownedFiles, expectedFiles: original,
        build: stage => writeCanonical(stage, after), validate: validateDataset, interruptAt: 'prior-moved' }), /interrupted/);
    await assert.rejects(recoverPublication(target, { validate: validateDataset, interruptAt: 'restore-prepared' }), /interrupted/i);
    await recoverPublication(target, { validate: validateDataset });
    assert.deepEqual(await inventory(target), original);
    await assert.rejects(publishDataset({ target, replace: true, ownedFiles, expectedFiles: original,
        build: async stage => { await writeCanonical(stage, after); await fs.writeFile(path.join(target, 'concurrent.txt'), 'user edit'); }, validate: validateDataset }), /Concurrent/);
    assert.equal(await fs.readFile(path.join(target, 'concurrent.txt'), 'utf8'), 'user edit');
    assert.deepEqual(await inventory(path.join(root, 'evidence')), evidence);
});

test('reference scan checks names, decompressed content and exact documented exceptions', async t => {
    const root = await temporary(t); const policy = { schemaVersion: 1, terms: ['retired-example'], roots: ['.'], exceptions: [] };
    await fs.writeFile(path.join(root, 'retired-example.json'), '{}');
    await fs.writeFile(path.join(root, 'map.json.gz'), gzipSync('{"name":"Retired-Example"}'));
    assert.equal((await scanReferences({ root, policy })).hits.length, 2);
    policy.exceptions = [{ path: 'map.json.gz', reason: 'Required original attribution.', terms: policy.terms,
        sha256: hash(await fs.readFile(path.join(root, 'map.json.gz'))) }];
    const report = await scanReferences({ root, policy }); assert.equal(report.hits.length, 1); assert.equal(report.exceptions.length, 1);
    await fs.writeFile(path.join(root, 'map.json.gz'), gzipSync('changed'));
    await assert.rejects(scanReferences({ root, policy }), /stale/);
});

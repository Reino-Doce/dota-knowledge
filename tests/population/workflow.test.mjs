import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectPopulation, applyPopulation, recoverPopulation, prunePopulation, createFileStorage, recipeSettings, DEFAULT_LIMITS, parseResponseJson } from '../../src/node/population.mjs';
import { graphFixture } from '../fixtures/canonical-graph.mjs';
import { writeCanonical, readCanonical, regularBytes } from '../../src/node/canonical.mjs';
import { hash } from '../../src/canonical-model.mjs';
import { verifyReplacements } from '../../scripts/population/reconciliation.mjs';
import { completeWeeks, WEEK_SECONDS } from '../../scripts/population/weeks.mjs';
import { requestBytes } from '../../scripts/population/request.mjs';
import { compareIds } from '../../scripts/population/exact.mjs';

const html = slug => `<table><tr><td><a href="/heroes/${slug}">Name</a></td><td data-value="1.25">1.25</td><td data-value="52">52</td><td data-value="900719925474099312345">many</td></tr></table>`;
const rosterHtml = '<a href="/heroes/anti-mage">Provider renamed Magina</a><a href="/heroes/earthshaker">Earthshaker</a>';
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'population-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const graph = graphFixture();
    graph.heroIndex.find(row => row.id === '7').providerSlug = 'earthshaker';
    const dataset = path.join(root, 'data'); await writeCanonical(dataset, graph);
    const storage = await createFileStorage(path.join(root, 'evidence/population'));
    const options = { roster: graph.heroIndex.map(row => ({ ...row, enabled: row.id !== '127' })), storage,
        clock: () => new Date('2026-10-11T12:00:00Z'), sleep: async () => {}, logger: () => {}, signal: new AbortController().signal,
        limits: { ...DEFAULT_LIMITS, retries: 0, timeoutMs: 30, spacingMs: 0 }, recipes: recipeSettings({ dotabuff: { minMatchupRows: 1, minRosterRows: 1 } }),
        priorInputs: { positionPriors: null }, clients: { dotabuff: async request => new Response(request.operation === 'hero-stats' ? rosterHtml : html(request.slug === 'anti-mage' ? 'earthshaker' : 'anti-mage')) }, steps: ['counters'] };
    return { root, dataset, storage, options, graph };
}

test('response decoding preserves huge integers before JSON rounding', () => {
    const data = parseResponseJson(Buffer.from('{"match_id":18446744073709551615,"count":9007199254740993,"rate":1.25}'));
    assert.deepEqual(data, { match_id: '18446744073709551615', count: '9007199254740993', rate: 1.25 });
    assert.deepEqual(['100', '9007199254740993', '2', '9007199254740992', '0'].sort(compareIds), ['0', '2', '100', '9007199254740992', '9007199254740993']);
});

test('refresh is isolated; offline apply and repeated application preserve identities, native facts and review records', async t => {
    const f = await fixture(t); const before = await regularBytes(f.dataset, 'manifest.json');
    const run = await collectPopulation({ ...f.options, runId: 'first' });
    assert.equal(run.state, 'complete'); assert.deepEqual(await regularBytes(f.dataset, 'manifest.json'), before);
    const replay = await collectPopulation({ ...f.options, runId: 'first', offline: true, clients: {} });
    assert.deepEqual(Object.values(replay.scopes).map(s => s.normalized), Object.values(run.scopes).map(s => s.normalized));
    const result = await applyPopulation({ dataset: f.dataset, storage: f.storage, runId: 'first', clock: f.options.clock });
    assert.equal(result.state, 'verified-promoted');
    const after = await readCanonical(f.dataset);
    const expectedEntities = structuredClone(f.graph.entities);
    for (const hero of expectedEntities.heroes) hero.capabilities = {};
    assert.deepEqual(after.entities, expectedEntities); assert.deepEqual(after.claims, f.graph.claims); assert.deepEqual(after.bindings, f.graph.bindings);
    assert.equal(after.observations.find(row => row.kind === 'matchup').matchCount, '900719925474099312345');
    assert.equal(after.observations.find(row => row.kind === 'provider-profile' && row.heroId === '1').providerName, 'Provider renamed Magina');
    assert.deepEqual(after.observations.find(row => row.id === 'observation:pair'), f.graph.observations.find(row => row.id === 'observation:pair'));
    const bytes = await regularBytes(f.dataset, 'manifest.json');
    assert.equal((await applyPopulation({ dataset: f.dataset, storage: f.storage, runId: 'first', clock: () => new Date() })).state, 'unchanged');
    assert.deepEqual(await regularBytes(f.dataset, 'manifest.json'), bytes);
});

test('failed and unselected scopes retain exact prior observations and acquisition clocks', async t => {
    const f = await fixture(t);
    await collectPopulation({ ...f.options, runId: 'old' });
    await applyPopulation({ dataset: f.dataset, storage: f.storage, runId: 'old', clock: f.options.clock });
    const old = await readCanonical(f.dataset);
    const run = await collectPopulation({ ...f.options, runId: 'partial', clock: () => new Date('2026-10-12T12:00:00Z'),
        clients: { dotabuff: async req => req.slug === 'anti-mage' ? new Response('broken') : f.options.clients.dotabuff(req) } });
    assert.equal(run.state, 'partial');
    await applyPopulation({ dataset: f.dataset, storage: f.storage, runId: 'partial', clock: f.options.clock });
    const current = await readCanonical(f.dataset);
    assert.deepEqual(current.observations.find(row => row.kind === 'matchup' && row.heroId === '1'), old.observations.find(row => row.kind === 'matchup' && row.heroId === '1'));
    assert.equal(current.observations.find(row => row.kind === 'matchup' && row.heroId === '7').observedAt, '2026-10-12T12:00:00.000Z');
});

test('incompatible and stale checkpoints cannot combine inputs; unknown heroes block scopes', async t => {
    const f = await fixture(t);
    await collectPopulation({ ...f.options, runId: 'a' });
    await assert.rejects(collectPopulation({ ...f.options, runId: 'a', priorInputs: { positionPriors: {} } }), /Incompatible/);
    await assert.rejects(collectPopulation({ ...f.options, runId: 'a', fresh: true }), /new run/);
    const run = await collectPopulation({ ...f.options, runId: 'b', clients: { dotabuff: async () => new Response(html('unknown')) } });
    assert.equal(run.state, 'partial'); assert.equal(Object.values(run.scopes).some(s => s.state === 'complete'), false);
    await assert.rejects(collectPopulation({ ...f.options, runId: 'b', clock: () => new Date('2026-10-15T12:00:00Z') }), /Stale/);
    const tampered = await f.storage.read('runs/a/manifest.json');
    tampered.plan[0].cohort = { weeks: [1] };
    await f.storage.write('runs/a/manifest.json', tampered);
    await assert.rejects(collectPopulation({ ...f.options, runId: 'a' }), /Incompatible/);
});

test('rate limits retry with injected sleep; authentication, timeout and cancellation remain incomplete', async t => {
    const f = await fixture(t); let calls = 0; const waits = [];
    const run = await collectPopulation({ ...f.options, runId: 'retry', limits: { ...f.options.limits, retries: 1 }, sleep: async ms => waits.push(ms),
        clients: { dotabuff: async req => ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : f.options.clients.dotabuff(req) } });
    assert.equal(run.state, 'complete'); assert.ok(waits.includes(2000));
    calls = 0;
    const refused = await collectPopulation({ ...f.options, runId: 'auth', clients: { dotabuff: async () => { calls++; return new Response('secret', { status: 401 }); } } });
    assert.equal(calls, 1); assert.equal(refused.state, 'partial'); assert.doesNotMatch(JSON.stringify(refused), /secret/);
    const timeout = await collectPopulation({ ...f.options, runId: 'timeout', clients: { dotabuff: async () => new Promise(() => {}) } });
    assert.equal(timeout.state, 'partial'); assert.equal(Object.values(timeout.scopes)[0].code, 'timeout');
    const controller = new AbortController(); controller.abort();
    const cancelled = await collectPopulation({ ...f.options, runId: 'cancel', signal: controller.signal });
    assert.equal(cancelled.state, 'partial');
});

test('publication interruption retains evidence; recovery restores the old snapshot or verifies promotion', async t => {
    for (const phase of ['prepared', 'prior-moved', 'promoted']) {
        const f = await fixture(t); const before = hash(await regularBytes(f.dataset, 'manifest.json'));
        const run = await collectPopulation({ ...f.options, runId: 'r' });
        await assert.rejects(applyPopulation({ dataset: f.dataset, storage: f.storage, runId: 'r', clock: f.options.clock, interruptAt: phase }), /interrupted/);
        for (const entry of Object.values(run.requests)) await f.storage.bytes(entry.artifact);
        await recoverPopulation({ dataset: f.dataset, storage: f.storage });
        const current = hash(await regularBytes(f.dataset, 'manifest.json'));
        assert.equal(current === before, phase !== 'promoted');
    }
});

test('historical replacement ledger verifies deleted rows; unexplained removal still fails', async t => {
    const f = await fixture(t);
    const graph = await readCanonical(f.dataset);
    graph.sources.push({ id: 'source:picker-matchups' });
    graph.observations.push({ id: 'old:counter', kind: 'matchup', heroId: '1', otherHeroId: '127', sourceId: 'source:picker-matchups', direction: 'hero-vs-opponent', matchCount: '9' });
    const target = path.join(f.root, 'historical'); await writeCanonical(target, graph);
    await collectPopulation({ ...f.options, runId: 'replace' });
    await applyPopulation({ dataset: target, storage: f.storage, runId: 'replace', clock: f.options.clock });
    const next = await readCanonical(target);
    assert.equal(next.observations.some(row => row.id === 'old:counter'), false);
    assert.ok(verifyReplacements(next).has('old:counter'));
    next.extras.delete('reviews/reconciliation/population-replacements.json');
    // The historical missing-reference gate is independent of active projections.
    assert.throws(() => verifyReplacements(next), /Unbound preservation/);
});

test('completed scopes remove absent rows, stable logical records retain IDs, and interrupted pruning resumes safely', async t => {
    const f = await fixture(t);
    let thinner = false;
    const options = { ...f.options, clients: { dotabuff: async request => {
        if (request.operation === 'hero-stats') return new Response(thinner ? '<a href="/heroes/anti-mage">New provider name</a>' : rosterHtml);
        return f.options.clients.dotabuff(request);
    } } };
    const first = await collectPopulation({ ...options, runId: 'old' });
    await applyPopulation({ dataset: f.dataset, storage: f.storage, runId: 'old', clock: f.options.clock });
    const before = await readCanonical(f.dataset);
    const preserved = Object.values(first.requests).find(request => request.request.operation === 'hero-stats').artifact;
    await f.storage.write('protected.json', { artifacts: [preserved] });
    await fs.writeFile(path.join(f.storage.root, 'unrelated.txt'), 'untouched');
    thinner = true;
    const second = await collectPopulation({ ...options, runId: 'new', clock: () => new Date('2026-10-12T12:00:00Z') });
    await assert.rejects(applyPopulation({ dataset: f.dataset, storage: f.storage, runId: 'new', clock: f.options.clock, interruptAt: 'pruning' }), /pruning/);
    const after = await readCanonical(f.dataset);
    assert.equal(after.observations.filter(row => row.kind === 'provider-profile').length, 1);
    const match = after.observations.find(row => row.kind === 'matchup');
    assert.equal(match.id, before.observations.find(row => row.kind === 'matchup' && row.heroId === match.heroId).id);
    await recoverPopulation({ dataset: f.dataset, storage: f.storage });
    await f.storage.bytes(preserved);
    for (const request of Object.values(second.requests)) await f.storage.bytes(request.artifact);
    assert.equal(await fs.readFile(path.join(f.storage.root, 'unrelated.txt'), 'utf8'), 'untouched');
    assert.equal((await f.storage.read('cleanup.json')).state, 'complete');
    assert.ok((await f.storage.read('cleanup.json')).deleted.length > 0);
});

test('historical archives cannot excuse unrecorded deletion of neighboring records', async t => {
    const f = await fixture(t); const graph = await readCanonical(f.dataset);
    graph.sources.push({ id: 'source:picker-matchups' });
    const old = { id: 'old:one', kind: 'matchup', heroId: '1', otherHeroId: '7', sourceId: 'source:picker-matchups', direction: 'hero-vs-opponent', matchCount: '2' };
    const unrelated = { ...old, id: 'other:two', sourceId: 'source:fixture' };
    graph.observations.push(old, unrelated);
    const target = path.join(f.root, 'historical'); await writeCanonical(target, graph);
    await collectPopulation({ ...f.options, runId: 'r' });
    await applyPopulation({ dataset: target, storage: f.storage, runId: 'r', clock: f.options.clock });
    const current = await readCanonical(target); assert.ok(verifyReplacements(current).has(old.id));
    current.observations = current.observations.filter(row => row.id !== unrelated.id);
    assert.throws(() => verifyReplacements(current), /Unexplained/);
});

test('narrow position replacement preserves unselected rows, surviving legacy IDs and separate source clocks', async t => {
    const f = await fixture(t); const weeks = completeWeeks(f.options.clock().getTime(), 1);
    const graph = await readCanonical(f.dataset);
    graph.sources.push({ id: 'source:picker-positions', metadata: { weeks, gameModes: ['ALL_PICK_RANKED'], bands: { all: null } } });
    graph.observations.push({ id: 'old:position:all:1', kind: 'position-outcome', heroId: '1', position: 1, rankBand: 'all', sourceId: 'source:picker-positions', matchCount: '90' });
    graph.observations.push({ id: 'old:position:summary', kind: 'position-outcome', heroId: '1', sourceId: 'source:picker-positions', sourceRecord: { all: [[90, 40], [90, 40], [90, 40], [90, 40], [90, 40]] } });
    const dataset = path.join(f.root, 'positions'); await writeCanonical(dataset, graph);
    const options = { ...f.options, steps: ['positions'], clients: { ...f.options.clients, stratz: async request => new Response(JSON.stringify({ data: { heroStats: { winWeek:
        [{ heroId: '1', week: weeks[0] * WEEK_SECONDS, matchCount: 100 + request.position, winCount: 50 }] } } })) } };
    const recipes = positions => recipeSettings({ dotabuff: { minRosterRows: 1 }, positions: { positions, weeks: 1, bands: [{ key: 'all', brackets: null }] } });
    await collectPopulation({ ...options, recipes: recipes([1, 2]), runId: 'wide' });
    await applyPopulation({ dataset, storage: f.storage, runId: 'wide', clock: f.options.clock });
    const before = await readCanonical(dataset);
    assert.equal(before.observations.find(row => row.position === 1).id, 'old:position:all:1');
    const untouched = before.observations.find(row => row.position === 2);
    await collectPopulation({ ...options, recipes: recipes([1]), runId: 'narrow', clock: () => new Date('2026-10-12T12:00:00Z') });
    await applyPopulation({ dataset, storage: f.storage, runId: 'narrow', clock: f.options.clock });
    const after = await readCanonical(dataset);
    assert.equal(after.observations.filter(row => row.position === 1).length, 1);
    assert.equal(after.observations.find(row => row.position === 1).id, 'old:position:all:1');
    assert.deepEqual(after.observations.find(row => row.position === 2), untouched);
    const row = after.observations.find(row => row.position === 1);
    const source = after.sources.find(source => source.id === row.sourceId);
    assert.equal(source.retrievedAt, '2026-10-12T12:00:00.000Z');
    assert.equal(source.observedAt, '2026-10-07T23:59:59.999Z');
    assert.equal((await applyPopulation({ dataset, storage: f.storage, runId: 'wide', clock: f.options.clock })).state, 'verified-promoted');
    const restored = await readCanonical(dataset);
    assert.equal(restored.observations.find(row => row.position === 1).retrievedAt, '2026-10-11T12:00:00.000Z');
});

test('offline replay of published evidence retains pruning eligibility and pruning shares the publication lock', async t => {
    const f = await fixture(t);
    await collectPopulation({ ...f.options, runId: 'old' });
    await applyPopulation({ dataset: f.dataset, storage: f.storage, runId: 'old', clock: f.options.clock });
    const replay = await collectPopulation({ ...f.options, runId: 'old', offline: true, clients: {} });
    assert.ok(Object.values(replay.scopes).every(scope => scope.published));
    await applyPopulation({ dataset: f.dataset, storage: f.storage, runId: 'old', clock: f.options.clock });
    await f.storage.lock('population', async () => {
        await assert.rejects(prunePopulation({ dataset: f.dataset, storage: f.storage }), /lock|EEXIST/);
        for (const scope of Object.values(replay.scopes)) await f.storage.bytes(scope.normalized);
    });
    await collectPopulation({ ...f.options, runId: 'new', clock: () => new Date('2026-10-12T12:00:00Z') });
    await applyPopulation({ dataset: f.dataset, storage: f.storage, runId: 'new', clock: f.options.clock });
    for (const scope of Object.values(replay.scopes)) await assert.rejects(f.storage.bytes(scope.normalized), /ENOENT/);
    const current = await readCanonical(f.dataset);
    for (const scope of Object.values(replay.scopes)) assert.ok(!current.sources.some(source => source.id === 'source:population:' + scope.normalized.sha256));
});

test('discarded HTTP bodies are cancelled for authentication failures and every retry', async t => {
    const f = await fixture(t);
    for (const status of [401, 403, 404, 429, 500]) {
        let requests = 0; let cancelled = 0;
        const options = { ...f.options, limits: { ...f.options.limits, retries: 2 }, clients: { dotabuff: async () => {
            requests++;
            return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status });
        } } };
        await assert.rejects(requestBytes({ provider: 'dotabuff', operation: 'fixture', format: 'html' }, options));
        assert.equal(requests, status === 429 || status === 500 ? 3 : 1); assert.equal(cancelled, requests);
    }
});

test('rollback interrupted twice preserves the previous snapshot and both runs of evidence', async t => {
    const f = await fixture(t);
    const old = await collectPopulation({ ...f.options, runId: 'old' });
    await applyPopulation({ dataset: f.dataset, storage: f.storage, runId: 'old', clock: f.options.clock });
    const before = await regularBytes(f.dataset, 'manifest.json');
    const next = await collectPopulation({ ...f.options, runId: 'next', clock: () => new Date('2026-10-12T12:00:00Z') });
    await assert.rejects(applyPopulation({ dataset: f.dataset, storage: f.storage, runId: 'next', clock: f.options.clock, interruptAt: 'promoted' }), /interrupted/);
    await fs.writeFile(path.join(f.dataset, 'runtime/core.json'), 'broken promoted artifact');
    for (const interruptAt of ['restore-prepared', 'failed-moved']) {
        await assert.rejects(recoverPopulation({ dataset: f.dataset, storage: f.storage, interruptAt }), /Interrupted recovery/);
        for (const run of [old, next]) for (const scope of Object.values(run.scopes)) await f.storage.bytes(scope.normalized);
    }
    await recoverPopulation({ dataset: f.dataset, storage: f.storage });
    assert.deepEqual(await regularBytes(f.dataset, 'manifest.json'), before);
    assert.equal((await f.storage.read('publication.json')).state, 'rolled-back');
});

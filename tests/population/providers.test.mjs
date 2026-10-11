import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectPopulation, createFileStorage, createRoster, DEFAULT_LIMITS, recipeSettings, fitModel, positionPriorsFromCounts, bandForMinRank } from '../../src/node/population.mjs';
import { completeWeeks, WEEK_SECONDS } from '../../scripts/population/weeks.mjs';
import { loadCompletedScopes } from '../../scripts/population/apply.mjs';
import { normalizeScope } from '../../scripts/population/normalize.mjs';
import { parseMatchups, parseMatchupsExact } from '../../scripts/population/parse.mjs';

const now = new Date('2026-10-11T12:00:00Z');
const roster = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), key: 'hero' + (i + 1), sourceKey: 'npc_dota_hero_hero' + (i + 1), providerSlug: 'hero-' + (i + 1) }));
async function setup(t, overrides) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'population-provider-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { roster, storage: await createFileStorage(root), runId: 'fixture', clock: () => now, sleep: async () => {}, signal: new AbortController().signal,
        logger: () => {}, priorInputs: { positionPriors: null }, clients: {}, limits: { ...DEFAULT_LIMITS, retries: 0, spacingMs: 0 }, recipes: recipeSettings(), ...overrides };
}
const json = value => new Response(JSON.stringify(value));
const finished = async (options, run) => loadCompletedScopes({ storage: options.storage, run });

test('frozen HTML parser parity changes only exact-count representation', async () => {
    const html = await fs.readFile(new URL('./fixtures/matchups.html', import.meta.url), 'utf8');
    assert.deepEqual(parseMatchupsExact(html), parseMatchups(html).map(row => ({ ...row, matches: String(row.matches) })));
    const huge = html.replaceAll('90848', '18446744073709551615');
    assert.equal(parseMatchupsExact(huge).find(row => row.slug === 'slark').matches, '18446744073709551615');
});

test('provider identities join engine identities and reject ambiguous, incomplete and unknown heroes', async t => {
    const options = await setup(t, { steps: ['roster'], clients: { opendota: async () => json(roster.map(hero => ({ id: hero.id, name: hero.sourceKey, localized_name: 'A different provider name' }))) } });
    const run = await collectPopulation(options); assert.equal(run.state, 'complete');
    const [scope] = await finished(options, run); assert.equal(scope.value.rows[0].providerName, 'A different provider name');
    assert.throws(() => createRoster([...roster, { ...roster[0], id: '999' }]), /Ambiguous/);
    assert.throws(() => createRoster(roster).providerRows([{ id: '99', name: roster[0].sourceKey }], 'opendota'), /Ambiguous/);
    assert.throws(() => createRoster(roster).providerRows([{ id: '1', name: roster[0].sourceKey }], 'opendota'), /Incomplete/);
});

test('both lane directions, requested positions, rank filters and complete weeks survive huge aggregation', async t => {
    const asked = [];
    const options = await setup(t, { steps: ['lanes'], recipes: recipeSettings({ lanes: { weeks: 2, positions: [2, 4], brackets: ['DIVINE_IMMORTAL'] } }),
        clients: { stratz: async request => {
            asked.push(request);
            return json({ data: { heroStats: { laneOutcome: [{ heroId1: '1', heroId2: '2', matchCount: '9007199254740993', winCount: '4000000000000000',
                drawCount: '1000000000000000', lossCount: '3000000000000000', matchWinCount: '4500000000000000', stompWinCount: '2', stompLossCount: '3', position: 'POSITION_1' }] } } });
        } } });
    const run = await collectPopulation(options); assert.equal(run.state, 'complete'); assert.equal(asked.length, 8);
    const [scope] = await finished(options, run); const rows = scope.value.rows;
    assert.deepEqual(new Set(rows.map(r => r.direction)), new Set(['with', 'against']));
    assert.deepEqual(new Set(rows.map(r => r.position)), new Set([2, 4]));
    assert.equal(rows[0].matchCount, '18014398509481986'); assert.equal(rows[0].estimate.state, 'unavailable');
    assert.equal(rows[0].sourceRecord.stompWinCount, '4'); assert.equal(rows[0].cohort.modes, null);
    assert.equal(rows[0].observedAt, '2026-10-07T23:59:59.999Z'); assert.equal(rows[0].retrievedAt, now.toISOString());
    assert.ok(asked.every(r => r.variables.brackets[0] === 'DIVINE_IMMORTAL' && r.variables.week === r.week * WEEK_SECONDS));
});

test('frozen STRATZ fixture preserves the original lane counts and the requested position', async t => {
    const bytes = await fs.readFile(new URL('./fixtures/stratz-lane-outcome.json', import.meta.url));
    const heroes = [['1','antimage'], ['2','axe'], ['8','juggernaut'], ['48','luna'], ['54','life_stealer']]
        .map(([id, key]) => ({ id, key, sourceKey: 'npc_dota_hero_' + key }));
    const options = await setup(t, { roster: heroes, steps: ['lanes'], clock: () => new Date((2959 * WEEK_SECONDS + 3600) * 1000),
        recipes: recipeSettings({ lanes: { weeks: 1, positions: [3] } }), clients: { stratz: async () => new Response(bytes) } });
    const run = await collectPopulation(options); assert.equal(run.state, 'complete');
    const [scope] = await finished(options, run);
    for (const direction of ['against', 'with']) {
        const row = scope.value.rows.find(row => row.heroId === '2' && row.otherHeroId === '1' && row.direction === direction);
        assert.equal(row.position, 3); // The frozen provider rows incorrectly declare POSITION_1.
        assert.deepEqual([row.laneCount, row.winCount, row.drawCount, row.lossCount, row.gameWinCount], ['12078','3890','3229','3568','6774']);
        assert.equal(row.estimate.value, (3890 + 3229 / 2) / (3890 + 3229 + 3568));
        assert.ok(row.stompWinCount !== null && row.stompLossCount !== null);
    }
});

test('lane outage blocks the aggregate; resume collects only the missing response and rejects truncated saved scopes', async t => {
    let fail = true; let calls = 0;
    const options = await setup(t, { steps: ['lanes'], recipes: recipeSettings({ lanes: { weeks: 1, positions: [1] } }), clients: { stratz: async request => {
        calls++; if (fail && request.direction === 'with') return json({ data: { heroStats: { laneOutcome: [] } } });
        return json({ data: { heroStats: { laneOutcome: [{ heroId1: '1', heroId2: '2', matchCount: '100', winCount: '50', drawCount: '10', lossCount: '20' }] } } });
    } } });
    const run = await collectPopulation(options); assert.equal(run.state, 'partial');
    // Malformed responses are saved as evidence, never reused as success on a live resume.
    fail = false;
    const next = await collectPopulation(options); assert.equal(next.state, 'complete'); assert.ok(calls <= 4);
    const [scope] = await finished(options, next);
    const bad = structuredClone(scope.value); bad.requests.pop();
    next.scopes[scope.spec.key].normalized = await options.storage.artifact(Buffer.from(JSON.stringify(bad)), null, 'json');
    await assert.rejects(finished(options, next), /Incomplete lane/);
});

test('positions preserve bands, modes and week boundaries with paginated responses and exact counts', async t => {
    const weeks = completeWeeks(now.getTime(), 2); const asked = [];
    const options = await setup(t, { steps: ['positions'], recipes: recipeSettings({ positions: { weeks: 2, pageSize: 2, positions: [2], bands: [{ key: 'divine', brackets: ['DIVINE', 'IMMORTAL'] }] } }),
        clients: { stratz: async request => {
            asked.push(request);
            return json({ data: { heroStats: { winWeek: request.variables.skip === 0
                ? weeks.map(week => ({ week: String(week * WEEK_SECONDS), heroId: '1', matchCount: '9007199254740993', winCount: '4503599627370496' }))
                : [{ week: String((weeks[0] - 1) * WEEK_SECONDS), heroId: '999', matchCount: '10', winCount: '5' }] } } });
        }, dotabuff: async () => new Response('missing') } });
    const run = await collectPopulation(options); assert.equal(run.state, 'partial');
    const scopes = await finished(options, run); assert.equal(scopes.length, 1);
    const row = scopes[0].value.rows[0]; assert.equal(row.position, 2); assert.equal(row.matchCount, '18014398509481986');
    assert.deepEqual(asked.map(r => r.variables.skip), [0, 2]); assert.deepEqual(row.cohort.brackets, ['DIVINE', 'IMMORTAL']);
    assert.deepEqual(row.cohort.modes, ['ALL_PICK_RANKED']); assert.deepEqual(row.cohort.weeks, weeks);
});

test('a missing position week remains incomplete and live resume reacquires its invalid aggregate', async t => {
    let available = false; let calls = 0;
    const options = await setup(t, { steps: ['positions'], recipes: recipeSettings({ positions: { weeks: 1, positions: [1], bands: [{ key: 'all', brackets: null }] } }),
        clients: { dotabuff: async () => new Response('missing'), stratz: async request => {
            calls++;
            return json({ data: { heroStats: { winWeek: available ? [{ week: request.weeks[0] * WEEK_SECONDS, heroId: '1', matchCount: '10', winCount: '5' }] : [] } } });
        } } });
    const first = await collectPopulation(options);
    assert.equal(Object.values(first.scopes).find(scope => scope.spec.kind === 'positions').state, 'failed');
    available = true;
    const second = await collectPopulation(options);
    assert.equal(Object.values(second.scopes).find(scope => scope.spec.kind === 'positions').state, 'complete');
    assert.equal(calls, 2);
});

test('exact OpenDota windows preserve rank, full-team queries, orientation and unavailable huge duration estimates', async t => {
    const asked = []; const newest = '18446744073709551615';
    const options = await setup(t, { steps: ['synergies', 'timings'], recipes: recipeSettings({ synergies: { matches: '1', window: '60000', minGames: 1, minRank: 70 }, timings: { matches: '1', window: '60000', minGames: 1 } }),
        clients: { opendota: async request => {
            asked.push(request);
            if (request.operation === 'latest-match') return new Response('{"rows":[{"match_id":18446744073709551615}]}');
            if (request.operation === 'synergies') return json({ rows: [{ t: ['5','2','1','4','3'], w: true }, { t: ['6','7','8','9','10'], w: false }] });
            return new Response('{"rows":[{"hero":1,"bucket":0,"games":9007199254741000,"wins":4503599627370500}]}');
        } } });
    const run = await collectPopulation(options); assert.equal(run.state, 'complete');
    const scopes = await finished(options, run);
    const synergy = scopes.find(s => s.spec.kind === 'synergies');
    assert.deepEqual(synergy.value.rows.find(row => row.heroId === '1' && row.otherHeroId === '2').storedHeroIds, ['1', '2']);
    assert.equal(synergy.spec.matchIdRange[1], newest); assert.equal(synergy.spec.matchIdRange[0], (BigInt(newest) - 60000n).toString());
    assert.match(asked.find(r => r.operation === 'synergies').sql, /avg_rank_tier >= 70/);
    assert.equal(scopes.find(s => s.spec.kind === 'timings').value.rows[0].estimate.state, 'unavailable');
    assert.equal(scopes.find(s => s.spec.kind === 'timings').value.rows[0].publishable, true);
});

test('version-one position prior policy is explicit and huge counts remain unavailable', () => {
    assert.deepEqual([0,60,70,75,80].map(bandForMinRank), ['all','all','divine','divine','immortal']);
    const rows = [10,30,50,5,5].map((count, i) => ({ kind: 'position-outcome', heroId: '1', position: i + 1, cohort: { band: 'all' }, matchCount: String(count) }));
    assert.deepEqual(positionPriorsFromCounts(rows, { band: 'all' }).priors['1'], { 1: .1, 2: .3, 3: .5, 4: .05, 5: .05 });
    rows[0].matchCount = '18446744073709551615'; assert.equal(positionPriorsFromCounts(rows, { band: 'all' }).unavailable['1'].state, 'unavailable');
});

test('calibration requires adapter identity, exact parity folds, nonoverlapping match ranges and accepted fits', () => {
    const rows = []; let seed = 123;
    for (let i = 0; i < 6000; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const x = (i % 17) / 8 - 1;
        rows.push({ id: String(18446744073709000000n + BigInt(i)), r: ['1','2','3','4','5'], d: ['6','7','8','9','10'], w: seed / 2 ** 32 < 1 / (1 + Math.exp(-.3 * x)) });
    }
    const adapter = { id: 'fixture-logistic', version: '1', inputSignature: 'a'.repeat(64), keys: ['x'], constraints: { nonPositive: [] },
        acceptance: { minMatches: 100, minGain: 0, maxBinError: 1, minBinGames: 1, positive: [] },
        sample: match => ({ x: Number((BigInt(match.id) - 18446744073709000000n) % 17n) / 8 - 1 }), vectorize: sample => ({ x: sample.x }) };
    const context = { roster: createRoster(roster), priorInputs: { positionPriors: null, matchRanges: [['18446744073709500000','18446744073709551615']] }, adapter, recipe: recipeSettings().calibration };
    const result = fitModel(rows, context); assert.equal(result.matches, '6000'); assert.equal(result.matchIdRange[0], rows[0].id);
    assert.equal(result.holdoutSeparation, 'exact-match-id-parity'); assert.equal(typeof result.reliability[0][2], 'string');
    assert.throws(() => fitModel(rows, { ...context, adapter: null }), /adapter/);
    assert.throws(() => fitModel([...rows, rows[0]], context), /overlap/);
    assert.throws(() => fitModel([{ ...rows[0], id: context.priorInputs.matchRanges[0][0] }, ...rows.slice(1)], context), /overlap/);
});

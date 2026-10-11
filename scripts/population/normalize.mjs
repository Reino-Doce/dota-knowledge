import { semanticHash } from '../../src/canonical-model.mjs';
import { decimal, addCounts, counts, safeCount, unavailable, numericCounts, boundedInteger, compareIds } from './exact.mjs';
import { parseMatchupsExact, parseHeroNames, parseHeroAttributes, parseHeroStats, parseLaneTable, extractTables, extractRows, rowHeroSlug } from './parse.mjs';
import { derivePositions } from './roles.mjs';
import { assignPositions, cellOf } from './assign.mjs';
import { buildSynergies, CELLS } from './synergy-math.mjs';
import { buildTimings } from './timings-math.mjs';
import { recipeRecord } from './recipes.mjs';
import { WEEK_SECONDS } from './weeks.mjs';
import { fitModel } from './calibration.mjs';

const nonempty = value => {
    if (!Array.isArray(value) || !value.length) throw new Error('Missing or empty response rows.');
    return value;
};
const bodyData = body => body?.data ?? body;
const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
export function teamIds(value, roster) {
    const values = Array.isArray(value) ? value : typeof value === 'string' && /^\{[\d,]+\}$/.test(value) ? value.slice(1, -1).split(',') : [];
    if (values.length !== 5 || new Set(values.map(decimal)).size !== 5) throw new Error('Malformed team.');
    return values.map(id => roster.resolve('id', id).id);
}
export function wonFlag(value) {
    if ([true, 't', 1, '1'].includes(value)) return '1';
    if ([false, 'f', 0, '0'].includes(value)) return '0';
    throw new Error('Missing match outcome.');
}

export function normalizeScope(spec, responses, { roster, recipes, priorInputs, calibrationAdapter }) {
    if (!responses.length || responses.some(r => !r.artifact || !r.retrievedAt)) throw new Error('Incomplete scope.');
    const recipe = recipes[spec.recipe];
    const retrievedAt = responses.map(row => row.retrievedAt).sort().at(-1);
    const observedAt = spec.cohort.weeks?.length
        ? new Date((Math.max(...spec.cohort.weeks) + 1) * WEEK_SECONDS * 1000 - 1).toISOString() : retrievedAt;
    const cohort = { ...spec.cohort };
    if (spec.matchIdRange) cohort.matchIdRange = spec.matchIdRange;
    const cohortId = 'cohort:population:' + semanticHash(cohort);
    const input = { requests: responses.map(r => ({ request: r.request, artifact: r.artifact, retrievedAt: r.retrievedAt })), priorInputs };
    const provenance = recipeRecord(recipe, input);
    let rows = [];
    const put = row => rows.push({ ...row, provider: spec.provider, cohortId, cohort,
        observedAt, retrievedAt, recipe: provenance, scopeKey: spec.key });

    if (spec.kind === 'roster') {
        for (const entry of roster.providerRows(responses[0].body, 'opendota')) put({ ...entry, kind: 'provider-profile' });
    }
    else if (spec.kind === 'dotabuff-profile') {
        const html = responses[0].body;
        const names = parseHeroNames(html); const attributes = parseHeroAttributes(html); const stats = parseHeroStats(html);
        if (names.size < recipe.minRosterRows) throw new Error('Incomplete provider roster.');
        for (const [slug, name] of names) {
            const hero = roster.resolve('providerSlug', slug);
            put({ heroId: hero.id, heroKey: hero.key, kind: 'provider-profile', providerName: name,
                sourceRecord: { slug, name, attribute: attributes.get(slug) ?? null, statistics: stats.get(slug) ?? null } });
        }
    }
    else if (spec.kind === 'counters') {
        const hero = roster.resolve('key', spec.heroKey);
        const parsed = parseMatchupsExact(responses[0].body);
        if (parsed.length < recipe.minMatchupRows) throw new Error('Incomplete matchup table.');
        for (const row of parsed) {
            const other = roster.resolve('providerSlug', row.slug);
            if (hero.id === other.id) throw new Error('Self matchup.');
            put({ heroId: hero.id, otherHeroId: other.id, kind: 'matchup', matchCount: row.matches,
                disadvantagePercentagePoints: row.disadvantage, winRatePercent: row.winRate,
                direction: 'hero-vs-opponent', sourceRecord: row, unit: 'matches' });
        }
    }
    else if (spec.kind === 'roles') {
        const lanes = new Map(); let overall = new Map();
        for (const response of responses) {
            if (response.request.operation === 'hero-stats') {
                overall = new Map([...parseHeroStats(response.body)].map(([slug, row]) => [roster.resolve('providerSlug', slug).key, row.winRate]));
                continue;
            }
            const table = parseLaneTable(response.body);
            if (!table.size) throw new Error('Empty lane table.');
            const tableRows = extractTables(response.body).map(table => extractRows(table).filter(row => rowHeroSlug(row))).find(rows => rows.length);
            if (tableRows?.length !== table.size) throw new Error('Malformed lane table.');
            for (const [slug, value] of table) {
                const hero = roster.resolve('providerSlug', slug);
                if (!lanes.has(hero.key)) lanes.set(hero.key, {});
                lanes.get(hero.key)[response.request.lane] = value;
            }
        }
        for (const [key, derived] of derivePositions(lanes, overall)) put({ heroId: roster.resolve('key', key).id,
            kind: 'inferred-position', inference: derived, sourceRecord: { lanes: lanes.get(key), overallWinRate: overall.get(key) ?? null }, measurement: 'inferred' });
    }
    else if (spec.kind === 'positions') {
        const totals = new Map();
        for (const response of responses) {
            const list = bodyData(response.body)?.heroStats?.winWeek;
            if (!Array.isArray(list)) throw new Error('Missing winWeek rows.');
            for (const row of list) {
                const week = boundedInteger(row.week, 0, Number.MAX_SAFE_INTEGER);
                if (!spec.cohort.weeks.includes(week / WEEK_SECONDS)) continue;
                const heroId = roster.resolve('id', row.heroId).id;
                const position = response.request.position;
                const count = counts(row.matchCount, row.winCount);
                const key = heroId + ':' + position;
                const cell = totals.get(key) ?? { heroId, position, games: '0', wins: '0', weeks: {} };
                if (cell.weeks[week]) throw new Error('Duplicate position week.');
                cell.weeks[week] = count;
                cell.games = addCounts(cell.games, count.games); cell.wins = addCounts(cell.wins, count.wins);
                totals.set(key, cell);
            }
        }
        for (const position of spec.cohort.positions) for (const week of spec.cohort.weeks) {
            if (![...totals.values()].some(cell => cell.position === position && BigInt(cell.weeks[week * WEEK_SECONDS]?.games ?? '0') > 0n)) throw new Error('Missing requested position week.');
        }
        for (const cell of totals.values()) put({ heroId: cell.heroId, kind: 'position-outcome', position: cell.position,
            matchCount: cell.games, winCount: cell.wins, measurement: 'measured', sourceRecord: cell });
    }
    else if (spec.kind === 'lanes') {
        const totals = new Map();
        for (const response of responses) {
            const seen = new Set();
            for (const row of nonempty(bodyData(response.body)?.heroStats?.laneOutcome)) {
                const heroId = roster.resolve('id', row.heroId1).id; const otherHeroId = roster.resolve('id', row.heroId2).id;
                const { position, direction } = response.request;
                if (heroId === otherHeroId) throw new Error('Self lane pair.');
                const key = `${direction}:${position}:${heroId}:${otherHeroId}`;
                if (seen.has(key)) throw new Error('Duplicate lane pair.'); seen.add(key);
                const cell = totals.get(key) ?? { heroId, otherHeroId, position, direction,
                    matchCount: '0', winCount: '0', drawCount: '0', lossCount: '0', gameWinCount: '0', stompWinCount: '0', stompLossCount: '0' };
                counts(row.matchCount, row.winCount);
                if (BigInt(addCounts(row.winCount, row.drawCount, row.lossCount)) > BigInt(decimal(row.matchCount))) throw new Error('Lane outcomes exceed matches.');
                for (const field of ['matchCount', 'winCount', 'drawCount', 'lossCount', 'gameWinCount', 'stompWinCount', 'stompLossCount']) {
                    const value = row[field === 'gameWinCount' ? 'matchWinCount' : field];
                    // Missing extra measurements remain unknown, never fabricated zeros.
                    cell[field] = cell[field] === null || value === undefined || value === null ? null : addCounts(cell[field], decimal(value));
                }
                totals.set(key, cell);
            }
        }
        for (const cell of totals.values()) {
            const decided = addCounts(cell.winCount, cell.drawCount, cell.lossCount);
            const publishable = BigInt(decided) >= BigInt(recipe.minLanes);
            const n = safeCount(decided);
            const estimate = n === null ? unavailable() : { state: 'available', value: n ? (Number(cell.winCount) + Number(cell.drawCount) / 2) / n : null };
            put({ ...cell, kind: 'lane-outcome', laneCount: cell.matchCount, unit: 'lanes', publishable,
                measurement: 'measured', estimate, sourceRecord: cell,
                ...(cell.direction === 'with' ? { allyHeroId: cell.otherHeroId } : { opponentHeroId: cell.otherHeroId }) });
        }
    }
    else if (spec.kind === 'synergies') {
        const totals = foldSynergy(nonempty(responses.flatMap(r => r.body.rows)), roster, priorInputs.positionPriors);
        let estimates;
        try {
            const heroes = new Map([...totals.heroes].map(([id, row]) => [id, numericCounts(row)]));
            const pairs = new Map([...totals.pairs].map(([key, { a, b, ...row }]) => [key, { ...numericCounts(row), a, b }]));
            estimates = new Map(buildSynergies(heroes, pairs, recipe).pairs.map(row => [row.a + ':' + row.b, row]));
        }
        catch (error) { if (!/floating-point/.test(error.message)) throw error; }
        for (const [key, cell] of totals.pairs) {
            const estimate = estimates?.get(key);
            put({ heroId: cell.a, otherHeroId: cell.b, kind: 'synergy', matchCount: cell.games, winCount: cell.wins,
                storedHeroIds: [cell.a, cell.b], direction: 'stored-a-then-b', positionAssignment: 'inferred',
                sourceRecord: { ...cell, soloA: totals.heroes.get(cell.a), soloB: totals.heroes.get(cell.b), ambiguous: totals.ambiguous },
                estimate: !estimates ? unavailable() : estimate ? { state: 'available', synergy: round(estimate.synergy, 3), winRate: round(estimate.winRate, 2),
                    cells: estimate.cells ? Object.fromEntries(Object.entries(estimate.cells).map(([key, cell]) => [key, { synergy: round(cell.synergy, 3), matchCount: String(cell.games), confidence: cell.confidence }])) : null } : { state: 'unavailable', reason: 'Below minGames.' },
                publishable: BigInt(cell.games) >= BigInt(recipe.minGames) });
        }
    }
    else if (spec.kind === 'timings') {
        const totals = new Map();
        for (const row of nonempty(responses.flatMap(r => r.body.rows))) {
            const hero = roster.resolve('id', row.hero).id;
            const bucket = boundedInteger(row.bucket, 0, 3); const count = counts(row.games, row.wins);
            const key = hero + ':' + bucket; const cell = totals.get(key) ?? { hero, bucket, games: '0', wins: '0' };
            cell.games = addCounts(cell.games, count.games); cell.wins = addCounts(cell.wins, count.wins); totals.set(key, cell);
        }
        for (const hero of new Set([...totals.values()].map(cell => cell.hero))) {
            const cells = [...totals.values()].filter(cell => cell.hero === hero);
            const eligible = BigInt(addCounts(...cells.map(cell => cell.games))) >= BigInt(recipe.minGames);
            let estimate;
            try {
                const numeric = new Map(cells.map(cell => [cell.bucket, { ...numericCounts({ games: cell.games, wins: cell.wins }), hero, bucket: cell.bucket }]));
                if (safeCount(addCounts(...cells.map(cell => cell.games))) === null) throw new Error('floating-point');
                estimate = buildTimings(numeric, new Map([[hero, hero]]), recipe).table[hero];
            }
            catch (error) { if (!/floating-point/.test(error.message)) throw error; }
            for (const cell of cells) put({ heroId: hero, kind: 'duration-outcome', bucket: cell.bucket, bucketDefinition: recipe.buckets[cell.bucket],
                matchCount: cell.games, winCount: cell.wins, sourceRecord: cell,
                estimate: estimate ? { state: 'available', winRate: estimate[cell.bucket][1], skew: estimate[cell.bucket][2] }
                    : eligible ? unavailable() : { state: 'unavailable', reason: 'Below minGames.' },
                publishable: eligible });
        }
    }
    else if (spec.kind === 'calibration') {
        const result = fitModel(nonempty(responses.flatMap(r => r.body.rows)), { roster, priorInputs, adapter: calibrationAdapter, recipe });
        for (const hero of roster.heroes.filter(h => h.enabled !== false)) put({ heroId: hero.id, kind: 'model-calibration', sourceRecord: result, measurement: 'model-output' });
    }
    else throw new Error('Unknown population scope kind.');
    if (!rows.length) throw new Error('Empty normalized scope.');
    rows = rows.map(row => {
        const identity = logicalIdentity(row);
        return { ...row, logicalKey: identity, id: 'observation:population:' + semanticHash(identity) };
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Duplicate normalized record.');
    return { schemaVersion: 1, state: 'complete', spec, cohort, observedAt, retrievedAt, recipe: provenance, rows,
        requests: input.requests, inputFingerprint: semanticHash(input) };
}

export function logicalIdentity(row) {
    // Selection breadth is orchestration, not a property of an individual record.
    const { positions, directions, ...cohort } = row.cohort ?? {};
    return { provider: row.provider, kind: row.kind, heroId: row.heroId, otherHeroId: row.otherHeroId ?? null,
        direction: row.direction ?? null, position: row.position ?? null, bucket: row.bucket ?? null,
        cohort };
}
export function foldSynergy(rows, roster, positionPriors, previous) {
    const bigintCounts = value => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) =>
        [key, ['games', 'wins'].includes(key) ? BigInt(decimal(child)) : typeof child === 'object' ? bigintCounts(child) : child])) : value;
    const totals = { heroes: new Map([...(previous?.heroes ?? [])].map(([key, row]) => [key, bigintCounts(row)])),
        pairs: new Map([...(previous?.pairs ?? [])].map(([key, row]) => [key, bigintCounts(row)])), ambiguous: BigInt(previous?.ambiguous ?? 0) };
    const priors = positionPriors ? new Map(Object.entries(positionPriors)) : null;
    for (const row of rows) {
        const team = teamIds(row.t, roster); const won = BigInt(wonFlag(row.w));
        const assignment = priors ? assignPositions(team, priors) : null;
        if (assignment?.cellMargin < 0.5) totals.ambiguous++;
        for (const id of team) {
            const cell = totals.heroes.get(id) ?? { games: 0n, wins: 0n };
            cell.games++; cell.wins += won; totals.heroes.set(id, cell);
        }
        for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
            const [ai, bi] = compareIds(team[i], team[j]) < 0 ? [i, j] : [j, i];
            const a = team[ai]; const b = team[bi]; const key = a + ':' + b;
            const pair = totals.pairs.get(key) ?? { a, b, games: 0n, wins: 0n, cells: Object.fromEntries(CELLS.map(cell => [cell, { games: 0n, wins: 0n }])) };
            pair.games++; pair.wins += won;
            if (assignment) {
                const cell = pair.cells[cellOf(assignment.positions[ai], assignment.positions[bi])];
                cell.games++; cell.wins += won;
            }
            totals.pairs.set(key, pair);
        }
    }
    const serialize = value => JSON.parse(JSON.stringify(value, (_key, child) => typeof child === 'bigint' ? child.toString() : child));
    return { heroes: new Map([...totals.heroes].map(([key, row]) => [key, serialize(row)])),
        pairs: new Map([...totals.pairs].map(([key, row]) => [key, serialize(row)])), ambiguous: totals.ambiguous.toString() };
}

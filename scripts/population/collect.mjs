import { semanticHash } from '../../src/canonical-model.mjs';
import { jsonBytes } from '../../src/node/canonical.mjs';
import { parseResponseJson, decimal, boundedInteger, addCounts, counts } from './exact.mjs';
import { createRoster } from './identity.mjs';
import { RECIPES_V1, recipeSettings } from './recipes.mjs';
import { completeWeeks } from './weeks.mjs';
import { POSITIONS_QUERY, LANES_QUERY, laneVariables, synergySql, timingSql, calibrationSql } from './queries.mjs';
import { normalizeScope, teamIds, wonFlag } from './normalize.mjs';
import { parseMatchupsExact, parseHeroNames, parseLaneTable, extractRows, extractTables, rowHeroSlug } from './parse.mjs';
import { modelIdentity, calibrationBoundary } from './calibration.mjs';
import { checkSignal, PopulationError, requestBytes, timestamp } from './request.mjs';

export const DEFAULT_STEPS = Object.freeze(['roster', 'counters', 'positions', 'synergies', 'timings', 'lanes']);
export const DEFAULT_LIMITS = Object.freeze({ retries: 4, timeoutMs: 90000, maxBytes: 64 * 1024 * 1024,
    spacingMs: 1200, maxWaitMs: 60000, resumeAgeMs: 86400000, maxPages: 1000, maxWindows: 10000 });

function validateResponse(request, body, roster, recipes) {
    const data = body?.data ?? body;
    if (request.operation === 'heroes') roster.providerRows(body, 'opendota');
    if (request.operation === 'hero-stats') {
        const names = parseHeroNames(body);
        if (names.size < recipes.dotabuff.minRosterRows) throw new Error('Incomplete roster.');
        for (const slug of names.keys()) roster.resolve('providerSlug', slug);
    }
    if (request.operation === 'matchups') {
        const rows = parseMatchupsExact(body);
        if (rows.length < recipes.dotabuff.minMatchupRows) throw new Error('Incomplete matchups.');
        for (const row of rows) roster.resolve('providerSlug', row.slug);
    }
    if (request.operation === 'lane-table') {
        const rows = parseLaneTable(body);
        const table = extractTables(body).map(table => extractRows(table).filter(row => rowHeroSlug(row))).find(rows => rows.length);
        if (!rows.size || rows.size !== table?.length) throw new Error('Malformed lane table.');
        for (const slug of rows.keys()) roster.resolve('providerSlug', slug);
    }
    if (request.operation === 'positions') {
        const rows = data?.heroStats?.winWeek;
        if (!Array.isArray(rows)) throw new Error('Missing positions.');
        for (const row of rows) {
            const week = boundedInteger(row?.week, 0, Number.MAX_SAFE_INTEGER);
            if (request.weeks.includes(week / 604800)) { roster.resolve('id', row.heroId); counts(row.matchCount, row.winCount); }
        }
    }
    if (request.operation === 'lanes') {
        const rows = data?.heroStats?.laneOutcome;
        if (!Array.isArray(rows) || !rows.length) throw new Error('Missing lanes.');
        for (const row of rows) {
            roster.resolve('id', row.heroId1); roster.resolve('id', row.heroId2); counts(row.matchCount, row.winCount);
            if (BigInt(addCounts(row.winCount, row.drawCount, row.lossCount)) > BigInt(decimal(row.matchCount))) throw new Error('Malformed lane counts.');
        }
    }
    if (['timings', 'synergies', 'calibration'].includes(request.operation)) {
        if (!Array.isArray(body?.rows)) throw new Error('Missing explorer rows.');
        for (const row of body.rows) {
            if (request.operation === 'timings') { roster.resolve('id', row.hero); boundedInteger(row.bucket, 0, 3); counts(row.games, row.wins); }
            else if (request.operation === 'synergies') { teamIds(row.t, roster); wonFlag(row.w); }
            else { decimal(row.id); teamIds(row.r, roster); teamIds(row.d, roster); wonFlag(row.w); }
        }
    }
    if (request.operation === 'latest-match') decimal(body?.rows?.[0]?.match_id);
}

function validateSettings(recipes) {
    const mutable = {
        dotabuff: ['minMatchupRows', 'minRosterRows'], positions: ['weeks', 'pageSize', 'positions', 'bands', 'modes'],
        roles: [], synergies: ['matches', 'window', 'minGames', 'minRank'], timings: ['matches', 'window', 'minGames', 'minRank'],
        lanes: ['weeks', 'minLanes', 'positions', 'brackets'], calibration: ['matches', 'window', 'taus'],
    };
    for (const [key, settings] of Object.entries(recipes)) {
        for (const [field, value] of Object.entries(settings)) {
            if (!(field in RECIPES_V1[key]) || !mutable[key].includes(field) && semanticHash(value) !== semanticHash(RECIPES_V1[key][field])) throw new Error('Unsupported recipe parameter.');
        }
        for (const field of ['matches', 'window']) if (settings[field] !== undefined && BigInt(decimal(settings[field])) < 1n) throw new Error('Positive sampling settings required.');
        for (const field of ['minGames', 'minLanes', 'minMatchupRows', 'minRosterRows']) if (settings[field] !== undefined) boundedInteger(settings[field], field.startsWith('minM') || field === 'minRosterRows' ? 1 : 0, 100000000);
        if (settings.weeks !== undefined) boundedInteger(settings.weeks, 1, key === 'positions' ? 12 : 26);
        if (settings.minRank !== undefined) boundedInteger(settings.minRank, 0, 85);
        if (settings.positions && (!settings.positions.length || settings.positions.some(p => !Number.isInteger(p) || p < 1 || p > 5) || new Set(settings.positions).size !== settings.positions.length)) throw new Error('Invalid positions.');
    }
    boundedInteger(recipes.positions.pageSize, 1, 5000);
    if (!recipes.positions.bands.length || new Set(recipes.positions.bands.map(b => b.key)).size !== recipes.positions.bands.length) throw new Error('Invalid rank bands.');
    for (const band of recipes.positions.bands) if (!/^[a-z]+$/.test(band.key) || band.brackets !== null && (!Array.isArray(band.brackets) || band.brackets.some(b => !['HERALD','GUARDIAN','CRUSADER','ARCHON','LEGEND','ANCIENT','DIVINE','IMMORTAL','UNCALIBRATED'].includes(b)))) throw new Error('Invalid rank bracket.');
    if (!recipes.positions.modes.length || recipes.positions.modes.some(mode => mode !== 'ALL_PICK_RANKED')) throw new Error('Unsupported position game mode.');
    if (recipes.lanes.brackets.some(b => !['HERALD_GUARDIAN','CRUSADER_ARCHON','LEGEND_ANCIENT','DIVINE_IMMORTAL'].includes(b))) throw new Error('Invalid lane bracket.');
}

export function planPopulation({ roster, recipes, steps, now }) {
    const scopes = [];
    const scope = (kind, provider, recipe, cohort = {}, heroKey = null, step = kind) => {
        const replacement = { kind, provider, ...(heroKey ? { heroKey } : {}),
            ...Object.fromEntries(Object.entries(cohort).filter(([key]) => key !== 'weeks')) };
        scopes.push({ key: kind + ':' + semanticHash(replacement), kind, step, provider, recipe, cohort, heroKey, replacement });
    };
    for (const step of steps) {
        if (step === 'roster') scope('roster', 'opendota', 'dotabuff');
        if (step === 'counters') {
            scope('dotabuff-profile', 'dotabuff', 'dotabuff', {}, null, step);
            for (const hero of roster.heroes.filter(h => h.enabled !== false)) if (hero.providerSlug) scope('counters', 'dotabuff', 'dotabuff', {}, hero.key, step);
        }
        if (step === 'positions') {
            scope('roles', 'dotabuff', 'roles', {}, null, step);
            const settings = recipes.positions;
            for (const band of settings.bands) scope('positions', 'stratz', 'positions', {
                band: band.key, brackets: band.brackets, modes: settings.modes, positions: settings.positions,
                weeks: completeWeeks(now, settings.weeks),
            });
        }
        if (step === 'lanes') scope('lanes', 'stratz', 'lanes', { brackets: recipes.lanes.brackets, positions: recipes.lanes.positions,
            directions: ['against', 'with'], modes: null, weeks: completeWeeks(now, recipes.lanes.weeks) });
        if (['synergies', 'timings', 'calibration'].includes(step)) scope(step, 'opendota', step, {
            minRank: recipes[step].minRank, lobbyType: 7, gameMode: 22,
        });
    }
    return scopes;
}

/** Save artifacts and normalized scopes. This function never opens canonical data. */
export async function collectPopulation(options) {
    const { runId, clients, storage, clock, sleep, signal, logger, priorInputs, calibrationAdapter,
        offline = false, fresh = false, steps = DEFAULT_STEPS } = options;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(runId ?? '') || !clients || !storage || typeof clock !== 'function'
        || typeof sleep !== 'function' || !(signal instanceof AbortSignal) || typeof logger !== 'function' || !priorInputs
        || !options.limits || !options.recipes) throw new Error('Population collection requires all explicit dependencies.');
    if (!steps.length || new Set(steps).size !== steps.length || steps.some(step => ![...DEFAULT_STEPS, 'calibration'].includes(step))) throw new Error('Invalid collection steps.');
    if (offline && fresh) throw new Error('Offline replay cannot be fresh collection.');
    const limits = options.limits;
    for (const [key, value] of Object.entries(DEFAULT_LIMITS)) boundedInteger(limits[key], ['retries', 'spacingMs'].includes(key) ? 0 : 1, Math.max(value * 10, 100));
    const recipes = recipeSettings(options.recipes); validateSettings(recipes);
    const roster = createRoster(options.roster);
    const model = steps.includes('calibration') ? modelIdentity(calibrationAdapter) : null;
    const policy = { roster: roster.heroes, recipes, steps, priorInputs, model,
        queries: { POSITIONS_QUERY, LANES_QUERY, synergy: synergySql('1', '2', recipes.synergies), timings: timingSql('1', '2', recipes.timings), calibration: calibrationSql('1', '2') } };
    return storage.lock('population', async () => {
        const name = `runs/${runId}/manifest.json`;
        let run = await storage.read(name);
        const now = timestamp(clock);
        const startedAt = run?.startedAt ?? now;
        if (!Number.isFinite(Date.parse(startedAt))) throw new Error('Invalid checkpoint clock.');
        const plan = planPopulation({ roster, recipes, steps, now: Date.parse(startedAt) });
        const config = { ...policy, plan }; const fingerprint = semanticHash(config);
        if (fresh && run) throw new Error('Fresh collection requires a new run ID.');
        if (run && (run.fingerprint !== fingerprint || semanticHash(run.config) !== fingerprint || semanticHash(run.plan) !== semanticHash(plan))) throw new Error('Incompatible population checkpoint.');
        if (run && !offline && run.state !== 'complete' && Date.parse(now) - Date.parse(run.updatedAt) > limits.resumeAgeMs) throw new Error('Stale population checkpoint; start a fresh run.');
        if (!run && offline) throw new Error('Offline replay requires an existing run.');
        run ??= { schemaVersion: 1, id: runId, fingerprint, config, startedAt: now, updatedAt: now, state: 'collecting',
            plan, scopes: {}, requests: {}, artifacts: [] };
        const save = async () => { run.updatedAt = timestamp(clock); await storage.write(name, run); };
        await save();
        const request = async descriptor => {
            checkSignal(signal);
            const key = semanticHash(descriptor);
            let saved = run.requests[key];
            let bytes;
            if (saved?.state === 'complete') bytes = await storage.bytes(saved.artifact);
            else {
                if (offline) throw new PopulationError('offline-missing');
                const started = clock().getTime();
                const result = await requestBytes(descriptor, { clients, signal, clock, sleep, limits, logger });
                bytes = result.bytes;
                saved = { state: 'complete', request: descriptor, retrievedAt: result.retrievedAt,
                    elapsedMs: Math.max(0, clock().getTime() - started), artifact: await storage.artifact(bytes, descriptor.heroKey ?? null) };
                (run.artifacts ??= []).push(saved.artifact);
                run.requests[key] = saved; await save();
            }
            const body = descriptor.format === 'json' ? parseResponseJson(bytes) : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            try { validateResponse(descriptor, body, roster, recipes); }
            catch { saved.state = 'invalid'; run.requests[key] = saved; await save(); throw new PopulationError('malformed'); }
            return { ...saved, body };
        };
        for (const original of run.plan) {
            const spec = structuredClone(original);
            const previous = run.scopes[spec.key];
            if (previous?.state === 'complete' && !offline) { await storage.bytes(previous.normalized); continue; }
            const responses = [];
            try {
                const ask = async descriptor => { const response = await request({ provider: spec.provider, ...descriptor }); responses.push(response); return response; };
                if (spec.kind === 'roster') await ask({ operation: 'heroes', format: 'json' });
                if (spec.kind === 'dotabuff-profile') await ask({ operation: 'hero-stats', format: 'html' });
                if (spec.kind === 'counters') await ask({ operation: 'matchups', format: 'html', heroKey: spec.heroKey, slug: roster.resolve('key', spec.heroKey).providerSlug });
                if (spec.kind === 'roles') {
                    await ask({ operation: 'hero-stats', format: 'html' });
                    for (const lane of ['mid', 'safe', 'off', 'jungle', 'roaming']) await ask({ operation: 'lane-table', lane, format: 'html' });
                }
                if (spec.kind === 'positions') {
                    for (const position of spec.cohort.positions) {
                        let ended = false;
                        for (let page = 0; page < limits.maxPages; page++) {
                            const response = await ask({ operation: 'positions', format: 'json', query: POSITIONS_QUERY, position, weeks: spec.cohort.weeks,
                                variables: { positions: [`POSITION_${position}`], brackets: spec.cohort.brackets, modes: spec.cohort.modes, take: recipes.positions.pageSize, skip: page * recipes.positions.pageSize } });
                            const rows = (response.body.data ?? response.body)?.heroStats?.winWeek;
                            if (!Array.isArray(rows) || rows.length > recipes.positions.pageSize) throw new Error('Invalid winWeek page.');
                            if (rows.length < recipes.positions.pageSize) { ended = true; break; }
                        }
                        if (!ended) throw new Error('Position paging is incomplete.');
                    }
                }
                if (spec.kind === 'lanes') {
                    for (const week of spec.cohort.weeks) for (const position of spec.cohort.positions) for (const direction of spec.cohort.directions) {
                        const input = { week, position, direction, brackets: spec.cohort.brackets };
                        await ask({ operation: 'lanes', format: 'json', query: LANES_QUERY, ...input, variables: laneVariables(input) });
                    }
                }
                if (['synergies', 'timings', 'calibration'].includes(spec.kind)) {
                    const settings = recipes[spec.recipe];
                    let hi;
                    if (spec.kind === 'calibration') hi = (BigInt(calibrationBoundary(priorInputs)) - 1n).toString();
                    else {
                        const latest = await request({ provider: 'opendota', operation: 'latest-match', format: 'json', sql: 'SELECT match_id FROM public_matches ORDER BY match_id DESC LIMIT 1' });
                        hi = decimal(latest.body?.rows?.[0]?.match_id);
                    }
                    const newest = hi; let found = 0n; let width = BigInt(settings.window); let empty = 0;
                    for (let index = 0; index < limits.maxWindows && found < BigInt(settings.matches); index++) {
                        const lo = BigInt(hi) > width ? BigInt(hi) - width : 0n;
                        if (BigInt(hi) === 0n) throw new Error('Incomplete match sample.');
                        const sql = (spec.kind === 'synergies' ? synergySql : spec.kind === 'timings' ? timingSql : calibrationSql)(lo.toString(), hi, settings);
                        let response;
                        try { response = await ask({ operation: spec.kind, format: 'json', lo: lo.toString(), hi, sql }); }
                        catch (error) {
                            const floor = spec.kind === 'calibration' ? 20000n : 2000n;
                            if (error.fatal || !['timeout', 'transport', 'rate-or-server'].includes(error.code) || width <= floor || offline) throw error;
                            width = width / 2n < floor ? floor : width / 2n;
                            continue;
                        }
                        const rows = response.body?.rows;
                        if (!Array.isArray(rows)) throw new Error('Missing explorer rows.');
                        let matches = BigInt(rows.length);
                        if (spec.kind === 'synergies') { if (matches % 2n) throw new Error('Incomplete paired teams.'); matches /= 2n; }
                        if (spec.kind === 'timings') {
                            const games = BigInt(addCounts(...rows.map(row => row.games)));
                            if (games % 10n) throw new Error('Incomplete duration aggregate.'); matches = games / 10n;
                        }
                        if (spec.kind === 'calibration' && rows.some(row => BigInt(decimal(row.id)) <= lo || BigInt(decimal(row.id)) > BigInt(hi))) throw new Error('Match outside requested window.');
                        found += matches; hi = lo.toString(); empty = matches === 0n ? empty + 1 : 0;
                        if (empty >= 5) throw new Error('Incomplete empty match windows.');
                        const low = spec.kind === 'calibration' ? 5000 : 4000; const high = spec.kind === 'calibration' ? 30000 : 20000;
                        const max = spec.kind === 'calibration' ? 3000000n : 2000000n; const min = spec.kind === 'calibration' ? 20000n : 2000n;
                        if (response.elapsedMs < low) width = width * 2n > max ? max : width * 2n;
                        else if (response.elapsedMs > high) width = width / 2n < min ? min : width / 2n;
                    }
                    if (found < BigInt(settings.matches)) throw new Error('Incomplete match target.');
                    spec.matchIdRange = [hi, newest]; spec.matches = found.toString();
                }
                const normalized = normalizeScope(spec, responses, { roster, recipes, priorInputs, calibrationAdapter });
                const artifact = await storage.artifact(jsonBytes(normalized), spec.heroKey, 'json');
                run.scopes[spec.key] = { state: 'complete', spec, normalized: artifact,
                    ...(previous?.published && previous.normalized.sha256 === artifact.sha256 ? { published: true } : {}),
                    evidence: responses.map(r => r.artifact), observedAt: normalized.observedAt };
                logger({ event: 'scope-complete', scope: spec.key, rows: normalized.rows.length });
            }
            catch (error) {
                const code = error instanceof PopulationError ? error.code : 'invalid-scope';
                if (code === 'invalid-scope') for (const response of responses) {
                    // Individually valid pages can still form a truncated or contradictory aggregate.
                    // Retry that aggregate on live resume while retaining its original evidence bytes.
                    run.requests[semanticHash(response.request)].state = 'invalid';
                }
                run.scopes[spec.key] = { state: 'failed', spec, code };
                logger({ event: 'scope-failed', scope: spec.key, code });
                await save();
                if (error.fatal || signal.aborted) break;
            }
            await save();
        }
        run.state = run.plan.every(spec => run.scopes[spec.key]?.state === 'complete') ? 'complete' : 'partial';
        await save(); return run;
    });
}

import { createHash } from 'node:crypto';

export const EXTERNAL_VERSION = 'hero-data-external-3';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pointer = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const slug = value => String(value).toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[^a-z0-9]/g, '');
const picker = 'yarikleto/dotabuff-picker';
const d2 = 'baltrietis-dot/d2picker-2.0';
const source = (id, repo, resource, kind, rows, semantics) => Object.freeze({ id, repo, resource, kind, rows, semantics,
    reuse: repo === picker ? 'Code MIT; NOTICE excludes third-party datasets. Dataset redistribution rights unverified.'
            : 'No repository license found at initial research; dataset redistribution rights unverified.',
});

export const EXTERNAL_SOURCES = Object.freeze([
    source('picker-matchups', picker, 'public/data/matchups.json', 'observed-matchups', 'matchups',
        'A versus B: [disadvantage percentage points, win rate percent, games]. Positive disadvantage is adverse to A. Cohort dates/patch unknown.'),
    source('picker-positions', picker, 'public/data/positions.json', 'observed-positions', 'heroes',
        'Hero/band: five [games,wins] cells in positions 1..5. Preserve weeks, rank bands and gameModes.'),
    source('picker-lanes', picker, 'public/data/lanes.json', 'observed-lanes', 'against',
        'A/position/B: [lanes,wins,draws,losses,gameWins]. Lane share denominator is wins+draws+losses; opponent position unavailable.'),
    source('picker-synergies', picker, 'public/data/synergies.json', 'observed-synergies', 'synergies',
        'Pair stored once: [shrunk advantage percentage points,games,win rate percent,optional farm cells]. Farm cells retain stored A/B order; positions inferred.'),
    source('picker-timings', picker, 'public/data/timings.json', 'observed-duration', 'timings',
        'Hero/bucket: [games,win rate percent,shrunk deviation percentage points]. Duration association, not a power spike.'),
    source('picker-calibration', picker, 'public/data/calibration.json', 'upstream-model', null,
        'Model fitted to upstream features and samples; weights/calibration are not transferable to this draft evaluator.'),
    source('d2-heroes', d2, 'src/data/heroes.json', 'external-profile', '$array',
        'OpenDota heroStats snapshot: raw source attributes, aggregate statistics and provider role labels; native declarations take precedence.'),
    source('d2-matchups', d2, 'src/data/all_matchups.json', 'observed-matchups', '$root',
        'Hero A -> [{hero_id:B,games_played,wins}]. Unfiltered OpenDota aggregate; no demonstrated patch/mode/rank/window cohort.'),
    source('d2-durations', d2, 'src/data/hero_durations.json', 'observed-duration', '$root',
        'Hero/duration seconds -> {winRate,games}; winRate is a fraction in 0..1. Aggregate cohort unavailable.'),
    source('d2-builds', d2, 'src/data/hero_builds.json', 'observed-items', '$root',
        'Hero -> start/early/mid/late item {id,games} observations. No default build, causal effect or ownership inferred.'),
    source('d2-meta', d2, 'src/data/meta.json', 'source-metadata', null,
        'Refresh patch label does not establish that OpenDota queries were filtered to that patch.'),
    source('counterdraft-tags', 'naghim/counterdraft', 'internal/heroes/heroes.json', 'curated-hypotheses', '$array',
        'OpenDota identity/roles with hand-authored hero tags. Tags seed mechanic review, not verified effect predicates.'),
    source('aegis-matchups', 'adityamurarka14/aegis-pick', 'data/cm/matchup_scores_global_7.41.json', 'model-estimate', '$root',
        'Upstream gradient-boosting estimates, not observed win rates. CM/global/7.41 are filename labels; input cohort and sample sizes unavailable.'),
    source('dota-counters', 'ppraguez/dota-counters', 'data/heroData.json', 'mixed-hypotheses', '$numeric',
        'Counters are shrunk baseline deltas; synergies are role/attribute heuristics; item/ability reasons are curated/templates. Counts and cohort missing.'),
]);

/** Stream bounds apply even when Content-Length is absent or compressed. No caller URLs or credentials. */
export async function fetchPublicBytes(url, { fetchImpl = fetch, maxBytes = 12 * 1024 * 1024, timeoutMs = 30000 } = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['api.github.com', 'raw.githubusercontent.com'].includes(parsed.hostname)
        || parsed.username || parsed.password) throw new Error('External URL is outside the public source allowlist.');
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
        headers: { Accept: 'application/json', 'User-Agent': 'hero-data-importer' } });
    if (!response.ok) throw new Error(`Source HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new Error('Source exceeds byte bound.');
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
        length += chunk.length;
        if (length > maxBytes) throw new Error('Source exceeds byte bound.');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export async function collectExternalSources(selected, { fetchImpl = fetch, now = () => new Date().toISOString(), onProgress = () => {} } = {}) {
    const commits = new Map();
    const results = [];
    for (const descriptor of selected) {
        onProgress(descriptor.id);
        try {
            if (!commits.has(descriptor.repo)) {
                // Cache failures as well: one bounded commit request per repository/run.
                const resolution = (async () => {
                    const data = JSON.parse(await fetchPublicBytes(`https://api.github.com/repos/${descriptor.repo}/commits/HEAD`, { fetchImpl, maxBytes: 4 * 1024 * 1024 }));
                    if (!/^[a-f0-9]{40}$/.test(data.sha)) throw new Error('Missing immutable source revision.');
                    return { commit: data.sha, commitDate: data.commit?.committer?.date ?? null };
                })();
                commits.set(descriptor.repo, resolution);
            }
            const revision = await commits.get(descriptor.repo);
            const url = `https://raw.githubusercontent.com/${descriptor.repo}/${revision.commit}/${descriptor.resource}`;
            const bytes = await fetchPublicBytes(url, { fetchImpl });
            const payload = JSON.parse(bytes.toString('utf8'));
            validateExternalPayload(descriptor, payload);
            results.push({ ...descriptor, ...revision, url, retrievedAt: now(), status: 'available',
                sha256: sha256(bytes), bytes: bytes.length, rawFile: `sources/${descriptor.id}.json`, payload, rawBytes: bytes });
        }
        catch (error) {
            results.push({ ...descriptor, status: 'unavailable', attemptedAt: now(), error: error instanceof SyntaxError
                ? 'Invalid source JSON.' : /^(Source HTTP \d+\.|Source exceeds byte bound\.|Missing immutable source revision\.|Invalid source schema\.)$/.test(error.message)
                    ? error.message : 'Source acquisition failed or timed out.' });
        }
    }
    return results;
}

function rowsFor(descriptor, payload) {
    if (!descriptor.rows) return [];
    if (descriptor.rows === '$array') return payload.map((row, index) => ({ key: String(row.id), row, pointer: `/${index}` }));
    const records = descriptor.rows.startsWith('$') ? payload : payload[descriptor.rows];
    return Object.entries(records).filter(([key]) => descriptor.rows !== '$numeric' || /^[1-9]\d*$/.test(key))
        .map(([key, row]) => ({ key, row, pointer: `${descriptor.rows.startsWith('$') ? '' : `/${descriptor.rows}`}/${pointer(key)}` }));
}

export function validateExternalPayload(descriptor, payload) {
    const fail = () => {
        throw new Error('Invalid source schema.');
    };
    const count = value => Number.isSafeInteger(value) && value >= 0;
    const percent = value => Number.isFinite(value) && value >= 0 && value <= 100;
    const tuple = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
    if (descriptor.rows === '$array' ? !Array.isArray(payload) : !object(payload)) fail();
    if (descriptor.rows === '$array' && payload.some(row => !object(row))) fail();
    if (descriptor.rows && !descriptor.rows.startsWith('$') && !object(payload[descriptor.rows])) fail();
    const rows = rowsFor(descriptor, payload);
    if (descriptor.rows && (!rows.length || rows.length > 512)) fail();
    if (new Set(rows.map(row => row.key)).size !== rows.length) fail();
    for (const { key, row } of rows) {
        if (!key || key.length > 128 || row === null || typeof row !== 'object') fail();
        if (descriptor.rows === '$array' && (!Number.isSafeInteger(row.id) || row.id <= 0)) fail();
        if (descriptor.id === 'aegis-matchups' && (!object(row) || Object.values(row).some(value => !Number.isFinite(value) || value < 0 || value > 1))) fail();
        if (descriptor.id === 'd2-matchups' && (!Array.isArray(row) || row.some(pair => !object(pair) || !Number.isSafeInteger(pair.hero_id)
            || !Number.isSafeInteger(pair.games_played) || !Number.isSafeInteger(pair.wins) || pair.wins < 0 || pair.games_played < pair.wins))) fail();
        if (descriptor.id === 'picker-matchups' && (!object(row) || Object.values(row).some(value => !tuple(value, 3)
            || !percent(value[1]) || !count(value[2])))) fail();
        if (descriptor.id === 'picker-positions' && (!object(row) || Object.values(row).some(values => !Array.isArray(values)
            || values.length !== 5 || values.some(value => !tuple(value, 2) || !value.every(count) || value[1] > value[0])))) fail();
        if (descriptor.id === 'picker-lanes' && (!object(row) || Object.entries(row).some(([position, opponents]) => !/^[1-5]$/.test(position)
            || !object(opponents) || Object.values(opponents).some(value => !tuple(value, 5) || !value.every(count)
                || value[1] + value[2] + value[3] > value[0] || value[4] > value[0])))) fail();
        if (descriptor.id === 'picker-timings' && (!Array.isArray(payload.buckets) || !Array.isArray(row)
            || row.length !== payload.buckets.length || row.some(value => !tuple(value, 3) || !count(value[0]) || !percent(value[1])))) fail();
        if (descriptor.id === 'picker-synergies' && (!object(row) || Object.values(row).some(value => !Array.isArray(value)
            || ![3, 4].includes(value.length) || !Number.isFinite(value[0]) || !count(value[1]) || !percent(value[2])
            || (value.length === 4 && (!object(value[3]) || Object.entries(value[3]).some(([key, cell]) => !/^(cc|cs|sc|ss)$/.test(key)
                || !tuple(cell, 2) || !count(cell[1]))))))) fail();
        if (descriptor.id === 'd2-durations' && (!object(row) || Object.entries(row).some(([seconds, value]) => !/^\d+$/.test(seconds)
            || !object(value) || !count(value.games) || !percent(value.winRate) || value.winRate > 1))) fail();
        if (descriptor.id === 'd2-builds' && (!object(row) || Object.values(row).some(values => !Array.isArray(values)
            || values.some(value => !object(value) || !count(value.id) || !count(value.games))))) fail();
        if (descriptor.id === 'counterdraft-tags' && (!Array.isArray(row.tags) || !Array.isArray(row.roles)
            || [...row.tags, ...row.roles].some(value => typeof value !== 'string'))) fail();
        if (descriptor.id === 'dota-counters' && (!object(row) || ['countered_by', 'counters', 'synergies', 'item_counters', 'recommended_items', 'ability_counters']
            .some(field => !Array.isArray(row[field])))) fail();
    }
    return rows;
}

function identityResolver(heroes) {
    const ids = new Map(heroes.map(hero => [hero.heroId, hero]));
    const aliases = new Map();
    for (const hero of heroes) {
        const localizedNames = Object.entries(hero.localization?.tokens ?? {})
            .filter(([key, value]) => key.startsWith(hero.heroKey) && key.endsWith(':n') && typeof value === 'string')
            .map(([, value]) => value);
        for (const value of [hero.key, hero.heroKey, hero.name, ...localizedNames]) {
            const key = slug(value);
            if (!aliases.has(key)) aliases.set(key, new Set());
            aliases.get(key).add(hero.heroId);
        }
    }
    return key => {
        if (ids.has(String(key))) return String(key);
        const candidates = aliases.get(slug(key));
        return candidates?.size === 1 ? [...candidates][0] : null;
    };
}

/** Values remain in their source units; useful typed observations never become native fields. */
function normalizeRow(id, row, resolve) {
    const matchup = (key, value) => ({ opponentId: resolve(key), sourceOpponentKey: key, ...value });
    if (id === 'picker-matchups') return { matchups: Object.entries(row).map(([key, value]) =>
        matchup(key, { disadvantagePercentagePoints: value[0], winRatePercent: value[1], games: value[2] })) };
    if (id === 'd2-matchups') return { matchups: row.map(value => matchup(String(value.hero_id), {
        games: value.games_played, wins: value.wins, winRate: value.games_played > 0 ? value.wins / value.games_played : null,
    })) };
    if (id === 'picker-positions') return { positions: Object.entries(row).flatMap(([band, values]) => values.map(([games, wins], index) => ({
        position: index + 1, band, games, wins, winRate: games > 0 ? wins / games : null,
    }))) };
    if (id === 'picker-lanes') return { lanes: Object.entries(row).flatMap(([position, opponents]) => Object.entries(opponents)
        .map(([key, [lanes, wins, draws, losses, gameWins]]) => {
            const classified = wins + draws + losses;
            return matchup(key, { position: Number(position), opponentPosition: null, lanes, wins, draws, losses, gameWins,
                classified, unclassified: lanes - classified, laneShare: classified > 0 ? (wins + draws / 2) / classified : null });
        })) };
    if (id === 'picker-timings') return { durationBuckets: row.map(([games, winRatePercent, deviationPercentagePoints], bucketIndex) => ({
        bucketIndex, games, winRatePercent, deviationPercentagePoints,
    })) };
    if (id === 'd2-durations') return { durations: Object.entries(row).map(([seconds, value]) => ({ seconds: Number(seconds), ...value })) };
    if (id === 'aegis-matchups') return { modelEstimates: Object.entries(row).map(([key, score]) => matchup(key, { score, games: null })) };
    if (id === 'counterdraft-tags') return { hypotheses: { tags: row.tags ?? [], roles: row.roles ?? [] }, sourceIdentity: {
        id: row.id, name: row.name, localizedName: row.localized_name,
    }, providerProfile: { attr: row.attr, attackType: row.attack_type } };
    if (id === 'd2-builds') return { itemObservations: row };
    if (id === 'dota-counters') return { hypotheses: row };
    return { providerProfile: row };
}

export function buildExternalEvidence(snapshots, catalog) {
    const resolve = identityResolver(catalog.heroes);
    const heroes = Object.fromEntries(catalog.heroes.map(hero => [hero.heroId, { heroId: hero.heroId, observations: [] }]));
    const sources = [];
    for (const snapshot of snapshots) {
        const { payload } = snapshot;
        const metadata = { ...snapshot };
        delete metadata.payload;
        delete metadata.rawBytes;
        const entry = { ...metadata, compatibility: { nativeBuild: 'unverified', publicPatch: 'unverified',
            runtimeScoring: 'review-required' }, evidenceUse: snapshot.kind.includes('hypotheses') ? 'semantic-review-input'
            : snapshot.kind.includes('model') ? 'model-review-input' : 'source-qualified-observation' };
        if (snapshot.status !== 'available') {
            sources.push(entry); continue;
        }
        const rows = validateExternalPayload(snapshot, payload);
        const excludedKeys = new Set(['heroes', 'matchups', 'against', 'synergies', 'timings']);
        entry.metadata = snapshot.rows?.startsWith('$') ? (snapshot.id === 'dota-counters' ? { meta: payload.meta ?? null, roles_meta: payload.roles_meta ?? null } : {})
            : Object.fromEntries(Object.entries(payload).filter(([key]) => !excludedKeys.has(key)));
        if (snapshot.id === 'picker-matchups' && Array.isArray(payload.heroes)) entry.metadata.heroProfiles = payload.heroes;
        const reported = value => value === undefined || value === null ? { state: 'unknown' } : { state: 'reported', value };
        entry.cohort = { period: reported(payload.period), weeks: reported(payload.weeks),
            gameModes: reported(payload.gameModes), rankBands: reported(payload.bands ?? payload.brackets ?? payload.rankBand),
            matchIdRange: reported(payload.matchIdRange),
            patch: payload.patch || payload.meta?.patch ? { state: 'upstream-label-not-verified-filter', value: payload.patch ?? payload.meta.patch }
                : { state: 'unknown' },
            nativeBuildCompatibility: 'unverified' };
        entry.identityMap = {};
        entry.unresolvedIdentities = [];
        for (const { key, row, pointer: sourcePointer } of rows) {
            const heroId = resolve(key);
            if (!heroId || ((snapshot.rows === '$array' || snapshot.id === 'dota-counters') && row.name && resolve(row.name) !== heroId)) {
                entry.unresolvedIdentities.push({ key, pointer: sourcePointer, reason: heroId ? 'identity-name-conflict' : 'not-in-native-roster-or-ambiguous' });
                continue;
            }
            entry.identityMap[key] = heroId;
            if (snapshot.id === 'picker-synergies') {
                for (const [other, value] of Object.entries(row)) {
                    const otherId = resolve(other);
                    const observation = { sourceId: snapshot.id, kind: snapshot.kind, pointer: `${sourcePointer}/${pointer(other)}`,
                        pair: { storedHeroIds: [heroId, otherId], storedSourceKeys: [key, other], advantagePercentagePoints: value[0],
                            games: value[1], winRatePercent: value[2], farmCells: value[3] ?? null } };
                    heroes[heroId].observations.push(observation);
                    if (otherId && otherId !== heroId) heroes[otherId].observations.push(observation);
                    else if (!otherId) entry.unresolvedIdentities.push({ key: other, pointer: observation.pointer, reason: 'pair-target-unresolved' });
                }
            }
            else {
                const normalized = normalizeRow(snapshot.id, row, resolve);
                if (snapshot.id === 'picker-matchups' && Array.isArray(payload.heroes)) {
                    const index = payload.heroes.findIndex(profile => profile.slug === key);
                    if (index >= 0) normalized.providerProfile = { pointer: `/heroes/${index}`, value: payload.heroes[index] };
                }
                for (const value of [...(normalized.matchups ?? []), ...(normalized.lanes ?? []), ...(normalized.modelEstimates ?? [])]) {
                    if (!value.opponentId) entry.unresolvedIdentities.push({ key: value.sourceOpponentKey,
                        pointer: sourcePointer, reason: 'pair-target-unresolved' });
                    if (normalized.modelEstimates) value.selfPair = value.opponentId === heroId;
                }
                heroes[heroId].observations.push({ sourceId: snapshot.id, kind: snapshot.kind, pointer: sourcePointer, ...normalized });
            }
        }
        entry.coverage = { sourceRows: rows.length, resolvedRows: Object.keys(entry.identityMap).length,
            unresolvedRows: rows.length - Object.keys(entry.identityMap).length,
            unresolvedReferences: entry.unresolvedIdentities.length };
        sources.push(entry);
    }
    for (const hero of Object.values(heroes)) {
        hero.coverage = sources.filter(source => source.rows).map(source => ({ sourceId: source.id,
            state: hero.observations.some(row => row.sourceId === source.id) ? 'available' : source.status === 'available' ? 'not-observed' : 'unavailable' }));
    }
    return { schemaVersion: 1, version: EXTERNAL_VERSION, sources, heroes,
        coverage: { selectedSources: sources.length, availableSources: sources.filter(row => row.status === 'available').length,
            heroesWithEvidence: Object.values(heroes).filter(hero => hero.observations.length).length,
            reviewedMechanicsAdded: 0 },
        limitations: ['Source observations and curated/model hypotheses do not overwrite installed declarations.',
            'Retrieval/commit dates are not sample windows; labels are not cohort filters.',
            'Per-source metadata and original snapshots retain missing cohorts and source units.',
            'No external weights, tags, win rates or counter explanations are automatically promoted into runtime scoring.'] };
}

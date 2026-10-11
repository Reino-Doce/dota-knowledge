import path from 'node:path';
import { hash, semanticHash } from '../../src/canonical-model.mjs';
import { readCanonical, writeCanonical, verifyManifest, regularBytes } from '../../src/node/canonical.mjs';
import { publishDataset, recoverPublication } from '../../src/node/publish-dataset.mjs';
import { validateDataset } from '../consolidation/validation.mjs';
import { createRoster } from './identity.mjs';
import { normalizeScope, logicalIdentity } from './normalize.mjs';
import { parseResponseJson, addCounts } from './exact.mjs';
import { readLedger, verifyReplacements, recordReplacement } from './reconciliation.mjs';
import { timestamp } from './request.mjs';
import { planPopulation } from './collect.mjs';
import { POSITIONS_QUERY, LANES_QUERY, laneVariables, synergySql, timingSql, calibrationSql } from './queries.mjs';

function assertCoverage(value, run) {
    const planned = run.plan.find(row => row.key === value.spec.key);
    const { matchIdRange, matches, ...spec } = value.spec;
    if (semanticHash(planned) !== semanticHash(spec)) throw new Error('Scope differs from the collection plan.');
    const requests = value.requests.map(row => row.request);
    if (new Set(requests.map(semanticHash)).size !== requests.length) throw new Error('Duplicate contributing request.');
    const settings = run.config.recipes[spec.recipe];
    for (const request of requests) {
        let expected;
        const base = { provider: spec.provider, format: request.format };
        if (spec.kind === 'lanes') expected = { ...base, format: 'json', operation: 'lanes', query: LANES_QUERY,
            week: request.week, position: request.position, direction: request.direction, brackets: spec.cohort.brackets,
            variables: laneVariables({ week: request.week, position: request.position, direction: request.direction, brackets: spec.cohort.brackets }) };
        else if (spec.kind === 'positions') expected = { ...base, format: 'json', operation: 'positions', query: POSITIONS_QUERY,
            position: request.position, weeks: spec.cohort.weeks, variables: { positions: [`POSITION_${request.position}`],
                brackets: spec.cohort.brackets, modes: spec.cohort.modes, skip: request.variables.skip, take: settings.pageSize } };
        else if (['synergies', 'timings', 'calibration'].includes(spec.kind)) expected = { ...base, format: 'json', operation: spec.kind,
            lo: request.lo, hi: request.hi, sql: ({ synergies: synergySql, timings: timingSql, calibration: calibrationSql }[spec.kind])(request.lo, request.hi, settings) };
        else if (spec.kind === 'counters') expected = { ...base, format: 'html', operation: 'matchups', heroKey: spec.heroKey,
            slug: run.config.roster.find(hero => hero.key === spec.heroKey).providerSlug };
        else if (spec.kind === 'roles') expected = request.operation === 'hero-stats'
            ? { ...base, format: 'html', operation: 'hero-stats' } : { ...base, format: 'html', operation: 'lane-table', lane: request.lane };
        else expected = { ...base, format: spec.kind === 'roster' ? 'json' : 'html', operation: spec.kind === 'roster' ? 'heroes' : 'hero-stats' };
        if (semanticHash(expected) !== semanticHash(request)) throw new Error('Request does not match the selected scope.');
    }
    const has = predicate => requests.filter(predicate).length === 1;
    if (spec.kind === 'lanes') {
        if (requests.length !== spec.cohort.weeks.length * spec.cohort.positions.length * 2) throw new Error('Incomplete lane replacement scope.');
        for (const week of spec.cohort.weeks) for (const position of spec.cohort.positions) for (const direction of ['against', 'with']) {
            if (!has(row => row.week === week && row.position === position && row.direction === direction)) throw new Error('Missing lane request.');
        }
    }
    else if (spec.kind === 'roles') {
        if (requests.length !== 6 || !has(row => row.operation === 'hero-stats')
            || ['mid', 'safe', 'off', 'jungle', 'roaming'].some(lane => !has(row => row.lane === lane))) throw new Error('Incomplete lane inference scope.');
    }
    else if (spec.kind === 'positions') {
        for (const position of spec.cohort.positions) {
            const pages = requests.filter(row => row.position === position);
            if (!pages.length || pages.some((row, index) => row.variables.skip !== index * settings.pageSize
                || row.variables.take !== settings.pageSize || semanticHash(row.variables.brackets) !== semanticHash(spec.cohort.brackets)
                || semanticHash(row.variables.modes) !== semanticHash(spec.cohort.modes))) throw new Error('Incomplete position pages.');
        }
        if (requests.some(row => !spec.cohort.positions.includes(row.position))) throw new Error('Unexpected position page.');
    }
    else if (['synergies', 'timings', 'calibration'].includes(spec.kind)) {
        if (!matchIdRange || BigInt(matches) < BigInt(settings.matches) || !requests.length
            || requests[0].hi !== matchIdRange[1] || requests.at(-1).lo !== matchIdRange[0]
            || requests.some((row, index) => BigInt(row.lo) >= BigInt(row.hi) || index && row.hi !== requests[index - 1].lo)) throw new Error('Incomplete match windows.');
    }
    else if (requests.length !== 1) throw new Error('Incomplete table scope.');
    if (requests.some(row => row.provider !== spec.provider)) throw new Error('Unbound provider request.');
}

const legacySource = { counters: 'source:picker-matchups', positions: 'source:picker-positions', lanes: 'source:picker-lanes', synergies: 'source:picker-synergies', timings: 'source:picker-timings', calibration: 'source:picker-calibration' };
function belongs(row, scope, graph) {
    if (row.scopeKey) {
        if (row.scopeKey === scope.key) return true;
        if (!['positions', 'lanes'].includes(scope.kind) || row.provider !== scope.provider
            || row.kind !== (scope.kind === 'positions' ? 'position-outcome' : 'lane-outcome')
            || !scope.cohort.positions.includes(row.position)) return false;
        const dimension = cohort => Object.fromEntries(Object.entries(cohort).filter(([key]) => !['positions', 'directions', 'weeks'].includes(key)));
        return semanticHash(dimension(row.cohort)) === semanticHash(dimension(scope.cohort));
    }
    if (row.sourceId !== legacySource[scope.kind]) return false;
    const source = graph.sources.find(source => source.id === row.sourceId);
    const metadata = source?.metadata ?? {};
    if (scope.kind === 'counters') return row.kind === 'matchup' && graph.heroIndex.find(hero => hero.id === row.heroId)?.key === scope.heroKey;
    if (scope.kind === 'positions') return row.kind === 'position-outcome' && row.rankBand === scope.cohort.band && scope.cohort.positions.includes(row.position)
        && semanticHash(metadata.gameModes ?? ['ALL_PICK_RANKED']) === semanticHash(scope.cohort.modes)
        && semanticHash(metadata.bands?.[row.rankBand] ?? null) === semanticHash(scope.cohort.brackets);
    if (scope.kind === 'lanes') return row.kind === 'lane-outcome' && scope.cohort.positions.includes(row.position)
        && semanticHash(metadata.brackets ?? []) === semanticHash(scope.cohort.brackets);
    if (['synergies', 'timings'].includes(scope.kind)) return (metadata.minRank ?? 0) === scope.cohort.minRank;
    return scope.kind === 'calibration' && row.kind === 'model-calibration';
}
function legacyLogical(row, scope, graph) {
    const kind = scope.kind;
    const metadata = graph.sources.find(source => source.id === row.sourceId)?.metadata ?? {};
    const cohort = row.cohort ?? (kind === 'counters' ? {} : kind === 'positions' ? {
        band: row.rankBand, brackets: metadata.bands?.[row.rankBand] ?? null,
        modes: metadata.gameModes ?? ['ALL_PICK_RANKED'], weeks: metadata.weeks ?? [],
    } : kind === 'lanes' ? { brackets: metadata.brackets ?? [], modes: null, weeks: metadata.weeks ?? [] }
        : ['synergies', 'timings'].includes(kind) ? { minRank: metadata.minRank ?? 0, lobbyType: 7, gameMode: 22,
            ...(metadata.matchIdRange ? { matchIdRange: metadata.matchIdRange.map(String) } : {}) }
            : { historicalSource: row.sourceId });
    return logicalIdentity({ ...row, provider: scope.provider, cohort,
        direction: row.direction ?? (kind === 'lanes' ? 'against' : kind === 'synergies' ? 'stored-a-then-b' : kind === 'counters' ? 'hero-vs-opponent' : null),
        otherHeroId: row.otherHeroId ?? (kind === 'lanes' ? String(row.sourceRecord?.[0]) : null),
        bucket: row.bucket ?? (kind === 'timings' ? Number(row.id.split(':').at(-1)) : null) });
}

export async function loadCompletedScopes({ run, storage, selected, calibrationAdapter }) {
    if (!run || run.schemaVersion !== 1 || semanticHash(run.config) !== run.fingerprint) throw new Error('Invalid run manifest.');
    const roster = createRoster(run.config.roster);
    const expectedPlan = planPopulation({ roster, recipes: run.config.recipes, steps: run.config.steps, now: Date.parse(run.startedAt) });
    if (semanticHash(expectedPlan) !== semanticHash(run.plan) || semanticHash(run.config.plan) !== semanticHash(run.plan)) throw new Error('Run plan does not match its fingerprint.');
    const keys = selected ?? Object.keys(run.scopes).filter(key => run.scopes[key].state === 'complete');
    if (!keys.length || new Set(keys).size !== keys.length) throw new Error('Select at least one unique completed scope.');
    const scopes = [];
    for (const key of keys) {
        const entry = run.scopes[key];
        if (entry?.state !== 'complete' || !run.plan.some(spec => spec.key === key)) throw new Error('Selected scope is incomplete or unknown.');
        const saved = JSON.parse(await storage.bytes(entry.normalized));
        if (saved.spec.key !== key || saved.state !== 'complete') throw new Error('Normalized scope identity mismatch.');
        assertCoverage(saved, run);
        if (semanticHash(saved.spec) !== semanticHash(entry.spec) || semanticHash(entry.evidence) !== semanticHash(saved.requests.map(row => row.artifact))) throw new Error('Scope manifest differs from normalized evidence.');
        const responses = [];
        for (const request of saved.requests) {
            const tracked = run.requests[semanticHash(request.request)];
            if (!tracked || tracked.state !== 'complete' || semanticHash(tracked.artifact) !== semanticHash(request.artifact)
                || tracked.retrievedAt !== request.retrievedAt) throw new Error('Unbound response artifact.');
            const bytes = await storage.bytes(request.artifact);
            responses.push({ ...request, body: request.request.format === 'json' ? parseResponseJson(bytes) : new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
        }
        if (saved.spec.kind === 'positions') for (const position of saved.spec.cohort.positions) {
            const pages = responses.filter(row => row.request.position === position);
            if (pages.some((row, i) => {
                const rows = (row.body.data ?? row.body)?.heroStats?.winWeek;
                return !Array.isArray(rows) || (i === pages.length - 1 ? rows.length >= run.config.recipes.positions.pageSize : rows.length !== run.config.recipes.positions.pageSize);
            })) throw new Error('Incomplete terminal position page.');
        }
        if (['synergies', 'timings', 'calibration'].includes(saved.spec.kind)) {
            const kind = saved.spec.kind;
            let total = 0n;
            for (const response of responses) {
                const rows = response.body?.rows;
                if (!Array.isArray(rows)) throw new Error('Missing sample rows.');
                const divisor = kind === 'synergies' ? 2n : kind === 'timings' ? 10n : 1n;
                const count = kind === 'timings' ? BigInt(addCounts(...rows.map(row => row.games))) : BigInt(rows.length);
                if (count % divisor) throw new Error('Incomplete sampled match.');
                total += count / divisor;
                if (kind === 'calibration' && rows.some(row => BigInt(row.id) <= BigInt(response.request.lo) || BigInt(row.id) > BigInt(response.request.hi))) throw new Error('Match outside requested window.');
            }
            if (total.toString() !== saved.spec.matches || total < BigInt(run.config.recipes[saved.spec.recipe].matches)) throw new Error('Recorded sample size differs from response evidence.');
        }
        // Recompute normalizations offline; malformed or edited results cannot authorize deletion.
        const rebuilt = normalizeScope(saved.spec, responses, { roster, recipes: run.config.recipes, priorInputs: run.config.priorInputs, calibrationAdapter });
        if (semanticHash(rebuilt) !== semanticHash(saved)) throw new Error('Normalized scope differs from its response evidence.');
        scopes.push({ ...entry, value: rebuilt });
    }
    return scopes;
}

/** Offline replacement through the Phase B guarded publisher. */
export async function applyPopulation({ dataset, storage, runId, selected, clock, calibrationAdapter, interruptAt, prune = true }) {
    if (typeof clock !== 'function') throw new Error('Apply requires an injected clock.');
    dataset = path.resolve(dataset);
    return storage.lock('population', async () => {
        if ((await storage.read('publication.json'))?.state === 'publishing' || (await storage.read('cleanup.json'))?.state === 'pruning') throw new Error('Pending population recovery; run recover first.');
        const owner = await storage.read('dataset.json');
        if (owner && owner.target !== dataset) throw new Error('Population evidence belongs to another dataset.');
        await storage.write('dataset.json', { target: dataset });
        const run = await storage.read(`runs/${runId}/manifest.json`);
        const scopes = await loadCompletedScopes({ run, storage, selected, calibrationAdapter });
        const graph = await readCanonical(dataset);
        if (semanticHash(graph.heroIndex.map(({ id, key, sourceKey, providerSlug }) => ({ id, key, sourceKey, providerSlug })))
            !== semanticHash(run.config.roster.map(({ id, key, sourceKey, providerSlug }) => ({ id, key, sourceKey, providerSlug })))) throw new Error('Collection roster differs from canonical identities.');
        const publication = graph.metadata.population ?? { schemaVersion: 1, scopes: {} };
        const changed = scopes.filter(entry => {
            const active = graph.observations.filter(row => belongs(row, entry.spec, graph));
            return active.length !== entry.value.rows.length || active.some(row => row.population?.normalized?.sha256 !== entry.normalized.sha256);
        });
        if (!changed.length) {
            for (const entry of scopes) run.scopes[entry.spec.key].published = true;
            await storage.write(`runs/${runId}/manifest.json`, run);
            return { state: 'unchanged', manifestSha256: hash(await regularBytes(dataset, 'manifest.json')) };
        }
        const ledger = readLedger(graph);
        for (const entry of changed) {
            const scope = entry.spec;
            const sourceId = 'source:population:' + entry.normalized.sha256;
            const previous = graph.observations.filter(row => belongs(row, scope, graph));
            const byLogical = new Map(previous.map(row => [semanticHash(row.logicalKey ?? legacyLogical(row, scope, graph)), row]));
            const rows = entry.value.rows.map(row => {
                const old = byLogical.get(semanticHash(row.logicalKey));
                const id = old?.id ?? row.id;
                if (ledger.identities[id] && semanticHash(ledger.identities[id]) !== semanticHash(row.logicalKey)) throw new Error('Retired ID belongs to another logical record.');
                return { ...row, id, sourceId, population: { runId, normalized: entry.normalized, evidence: entry.evidence } };
            });
            await recordReplacement({ graph, dataset, removed: previous, incoming: rows, scopeKey: scope.key, ledger, logical: row => legacyLogical(row, scope, graph) });
            const removed = new Set(previous.map(row => row.id));
            graph.observations = graph.observations.filter(row => !removed.has(row.id));
            for (const id of removed) graph.runtimeProjection.delete(id);
            for (const row of rows) {
                if (graph.observations.some(other => other.id === row.id)) throw new Error('Population identity collision.');
                graph.observations.push(row);
                if (row.publishable !== false) {
                    const fields = Object.keys(row).filter(field => !['sourceRecord', 'population', 'logicalKey'].includes(field)).sort();
                    let projection = graph.projections.findIndex(other => semanticHash(other) === semanticHash(fields));
                    if (projection < 0) { projection = graph.projections.length; graph.projections.push(fields); }
                    graph.runtimeProjection.set(row.id, projection);
                }
            }
            const source = { id: sourceId, provider: scope.provider, resource: 'evidence/population/' + entry.normalized.name,
                sha256: entry.normalized.sha256, retrievedAt: entry.value.retrievedAt, observedAt: entry.observedAt, cohort: entry.value.cohort, recipe: entry.value.recipe };
            const existingSource = graph.sources.find(row => row.id === sourceId);
            if (existingSource && semanticHash(existingSource) !== semanticHash(source)) throw new Error('Population source identity conflict.');
            if (!existingSource) graph.sources.push(source);
            publication.scopes[scope.key] = { runId, normalized: entry.normalized, evidence: entry.evidence, observedAt: entry.observedAt };
        }
        // Legacy aggregate position summaries must not advertise stale selected bands.
        const legacyPositions = graph.sources.find(source => source.id === 'source:picker-positions')?.metadata ?? {};
        const bands = new Map(changed.filter(e => e.spec.kind === 'positions'
            && semanticHash(legacyPositions.bands?.[e.spec.cohort.band] ?? null) === semanticHash(e.spec.cohort.brackets)
            && semanticHash(legacyPositions.gameModes ?? ['ALL_PICK_RANKED']) === semanticHash(e.spec.cohort.modes))
            .map(e => [e.spec.cohort.band, e.spec.cohort.positions]));
        for (const row of [...graph.observations]) {
            if (row.sourceId !== 'source:picker-positions' || row.position !== undefined || !bands.size || !row.sourceRecord) continue;
            const remaining = Object.fromEntries(Object.entries(row.sourceRecord).map(([band, values]) =>
                [band, bands.has(band) ? values.map((value, i) => bands.get(band).includes(i + 1) ? null : value) : values])
                .filter(([, values]) => values.some(value => value !== null)));
            const next = Object.keys(remaining).length ? { ...row, sourceRecord: remaining, population: { runId, evidence: [] } } : null;
            await recordReplacement({ graph, dataset, removed: [row], incoming: [], scopeKey: 'positions:summary', ledger,
                logical: old => ({ kind: 'position-summary', heroId: old.heroId, sourceId: old.sourceId }) });
            if (next) graph.observations[graph.observations.indexOf(row)] = next;
            else { graph.observations.splice(graph.observations.indexOf(row), 1); graph.runtimeProjection.delete(row.id); }
        }
        const activeScopes = new Set(graph.observations.map(row => row.scopeKey));
        for (const key of Object.keys(publication.scopes)) if (!activeScopes.has(key)) delete publication.scopes[key];
        // Source metadata is active only while a record, review or preservation archive uses it.
        // Retiring it prevents a current registry entry from pointing at prunable acquisition bytes.
        const referencedSources = new Set();
        const visit = value => {
            if (typeof value === 'string' && value.startsWith('source:population:')) referencedSources.add(value);
            else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child);
        };
        for (const value of [graph.entities, graph.observations, graph.claims, graph.bindings, graph.history, ...graph.guides.values()]) visit(value);
        for (const artifact of ledger.artifacts) visit(JSON.parse(graph.extras.get(artifact.archive)));
        graph.sources = graph.sources.filter(source => !source.id.startsWith('source:population:') || referencedSources.has(source.id));
        graph.metadata.population = publication;
        graph.metadata.generatedAt = timestamp(clock); graph.metadata.createdAt = graph.metadata.generatedAt;
        graph.metadata.inputSignature = semanticHash({ prior: graph.metadata.inputSignature, scopes: publication.scopes });
        verifyReplacements(graph);
        const journal = { state: 'publishing', target: dataset, runId, selected: scopes.map(entry => entry.spec.key),
            normalized: Object.fromEntries(scopes.map(entry => [entry.spec.key, entry.normalized.sha256])) };
        await storage.write('publication.json', journal);
        const result = await publishDataset({ target: dataset, replace: true,
            ownedFiles: ['manifest.json', ...graph.metadata.sourceFiles.map(row => row.name)],
            build: output => writeCanonical(output, graph), validate: validateDataset, interruptAt });
        await finishPublication(storage, dataset, journal);
        if (prune) await pruneLocked({ dataset, storage, interruptAt });
        return result;
    });
}

async function finishPublication(storage, dataset, journal) {
    const manifest = await verifyManifest(dataset);
    for (const [key, digest] of Object.entries(journal.normalized)) if (manifest.population?.scopes[key]?.normalized.sha256 !== digest) throw new Error('Promoted manifest differs from selected inputs.');
    const run = await storage.read(`runs/${journal.runId}/manifest.json`);
    for (const key of journal.selected) run.scopes[key].published = true;
    await storage.write(`runs/${journal.runId}/manifest.json`, run);
    await storage.write('publication.json', { ...journal, state: 'verified', manifestSha256: hash(await regularBytes(dataset, 'manifest.json')) });
}

/** Content-addressed ordinary artifacts only; unknown files and preservation archives are never candidates. */
export async function prunePopulation({ dataset, storage, interruptAt }) {
    return storage.lock('population', () => pruneLocked({ dataset, storage, interruptAt }));
}
async function pruneLocked({ dataset, storage, interruptAt }) {
    const publication = await storage.read('publication.json');
    if (publication?.state !== 'verified' || publication.target !== path.resolve(dataset)) throw new Error('Pruning requires verified publication.');
    const manifest = await verifyManifest(dataset);
    if (hash(await regularBytes(dataset, 'manifest.json')) !== publication.manifestSha256) throw new Error('Dataset changed before cleanup.');
    const pinned = new Set();
    const pin = descriptor => { if (descriptor) pinned.add(descriptor.name); };
    for (const scope of Object.values(manifest.population?.scopes ?? {})) { pin(scope.normalized); scope.evidence.forEach(pin); }
    // Also honor active detailed records, incomplete runs and explicit preservation pins.
    const graph = await readCanonical(dataset);
    for (const row of graph.observations) { pin(row.population?.normalized); row.population?.evidence.forEach(pin); }
    for (const artifact of readLedger(graph).artifacts) {
        for (const row of JSON.parse(graph.extras.get(artifact.archive)).observations ?? []) {
            pin(row.population?.normalized); row.population?.evidence.forEach(pin);
        }
    }
    const pins = (await storage.read('protected.json'))?.artifacts ?? [];
    for (const descriptor of pins) { await storage.bytes(descriptor); pin(descriptor); }
    const known = new Map();
    for (const name of await storage.list('runs')) {
        if (!name.endsWith('/manifest.json')) continue;
        const run = await storage.read(name);
        for (const artifact of run.artifacts ?? []) known.set(artifact.name, artifact);
        for (const request of Object.values(run.requests ?? {})) if (request.artifact) known.set(request.artifact.name, request.artifact);
        for (const scope of Object.values(run.scopes ?? {})) if (scope.normalized) known.set(scope.normalized.name, scope.normalized);
        if (run.state !== 'complete' || Object.values(run.scopes ?? {}).some(scope => !scope.published)) {
            (run.artifacts ?? []).forEach(pin);
            Object.values(run.requests ?? {}).forEach(request => pin(request.artifact));
            Object.values(run.scopes ?? {}).forEach(scope => pin(scope.normalized));
        }
    }
    let cleanup = await storage.read('cleanup.json');
    if (!cleanup || cleanup.state === 'complete') cleanup = { state: 'pruning', manifestSha256: publication.manifestSha256,
        remaining: [...known.values()].filter(descriptor => !pinned.has(descriptor.name)), deleted: [] };
    if (cleanup.manifestSha256 !== publication.manifestSha256) throw new Error('Cleanup belongs to a different publication.');
    await storage.write('cleanup.json', cleanup);
    for (const descriptor of [...cleanup.remaining]) {
        if (!pinned.has(descriptor.name)) {
            await storage.removeArtifact(descriptor); cleanup.deleted.push(descriptor.name);
            if (interruptAt === 'pruning') throw new Error('Simulated interrupted pruning.');
        }
        cleanup.remaining = cleanup.remaining.filter(row => row.name !== descriptor.name);
        await storage.write('cleanup.json', cleanup);
    }
    cleanup.state = 'complete'; await storage.write('cleanup.json', cleanup); return cleanup;
}

export async function recoverPopulation({ dataset, storage, interruptAt }) {
    await storage.recoverLock('population');
    return storage.lock('population', async () => {
        let recovery;
        try { recovery = await recoverPublication(dataset, { validate: validateDataset, interruptAt }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const journal = await storage.read('publication.json');
        if (journal?.state === 'publishing') {
            const manifest = await verifyManifest(dataset);
            const promoted = Object.entries(journal.normalized).every(([key, digest]) => manifest.population?.scopes[key]?.normalized.sha256 === digest);
            if (promoted) await finishPublication(storage, dataset, journal);
            else { await storage.write('publication.json', { ...journal, state: 'rolled-back' }); return recovery ?? { state: 'restored' }; }
        }
        if ((await storage.read('publication.json'))?.state === 'verified') await pruneLocked({ dataset, storage, interruptAt });
        return recovery ?? { state: 'recovered' };
    });
}

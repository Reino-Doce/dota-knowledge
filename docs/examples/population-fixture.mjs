// Offline example: creates and removes its own temporary dataset. No provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPopulation, applyPopulation, createFileStorage, recipeSettings, DEFAULT_LIMITS } from '@reino-doce/dota-knowledge/node/population';
import { normalizeLegacyRecords } from '../../src/canonical-model.mjs';
import { writeCanonical, readCanonical, regularBytes } from '../../src/node/canonical.mjs';

export async function fixtureExample() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'population-example-'));
    try {
        const roster = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), key: 'hero' + (i + 1),
            sourceKey: 'npc_dota_hero_hero' + (i + 1), providerSlug: 'hero-' + (i + 1), enabled: true }));
        const sourceIdentities = { mechanics: 'a'.repeat(64), enrichedNative: 'b'.repeat(64) };
        const graph = normalizeLegacyRecords({ metadata: { schemaVersion: 1, version: 'fixture',
            createdAt: '2026-10-01T00:00:00Z', generatedAt: '2026-10-01T00:00:00Z', sourceIdentities, reviewVersion: 'fixture', build: { clientVersion: 'fixture' },
            patchLabel: { state: 'unknown', reason: 'Synthetic fixture.' }, runtimeObservations: [] },
        heroes: roster.map(hero => ({ hero: { ...hero, heroId: hero.id, heroKey: hero.sourceKey, name: hero.key,
            cmEnabled: true, abilityIds: [], effectIds: [], coverage: { complete: false } }, abilities: [], activations: [], effects: [], conditions: [] })),
        guides: new Map(roster.map(hero => [hero.id, { heroId: hero.id, sourceIdentities, native: { heroId: hero.id, key: hero.key,
            raw: { AttributePrimary: 'DOTA_ATTRIBUTE_AGILITY', AttackRange: '150', Complexity: '1', Role: 'Carry', Rolelevels: '1' }, nativeStats: {} } }])),
        sources: [], claims: [], observations: [], reference: {} }, { crosswalk: roster });
        const dataset = path.join(root, 'data'); await writeCanonical(dataset, graph);
        const storage = await createFileStorage(path.join(root, 'evidence/population'));
        const clock = () => new Date('2026-10-11T12:00:00Z');
        const json = value => new Response(JSON.stringify(value));
        const names = roster.map(hero => `<a href="/heroes/${hero.providerSlug}">${hero.key}</a>`).join('');
        const laneTable = '<table>' + roster.map(hero => `<tr><td><a href="/heroes/${hero.providerSlug}">${hero.key}</a></td>`
            + [20, 50, 3, 500, 600].map(number => `<td data-value="${number}">${number}</td>`).join('') + '</tr>').join('') + '</table>';
        const clients = {
            dotabuff: async request => new Response(request.operation === 'hero-stats' ? names : request.operation === 'lane-table' ? laneTable
                : '<table>' + roster.filter(hero => hero.key !== request.heroKey).map(hero => `<tr><td><a href="/heroes/${hero.providerSlug}">${hero.key}</a></td>`
                    + '<td data-value="1">1</td><td data-value="52">52</td><td data-value="1000">1000</td></tr>').join('') + '</table>'),
            stratz: async request => request.operation === 'positions'
                ? json({ data: { heroStats: { winWeek: request.weeks.map(week => ({ week: week * 604800, heroId: '1', matchCount: 100, winCount: 50 })) } } })
                : json({ data: { heroStats: { laneOutcome: [{ heroId1: '1', heroId2: '2', matchCount: 100, winCount: 50, drawCount: 10, lossCount: 30 }] } } }),
            opendota: async request => request.operation === 'heroes' ? json(roster.map(hero => ({ id: hero.id, name: hero.sourceKey, localized_name: hero.key })))
                : request.operation === 'latest-match' ? json({ rows: [{ match_id: '10000000000000000' }] })
                    : request.operation === 'synergies' ? json({ rows: [{ t: ['1','2','3','4','5'], w: true }, { t: ['6','7','8','9','10'], w: false }] })
                        : json({ rows: roster.map(hero => ({ hero: hero.id, bucket: 0, games: 1, wins: Number(hero.id) <= 5 ? 1 : 0 })) }),
        };
        const options = { runId: 'fixture', roster, storage, clock, clients, signal: new AbortController().signal,
            sleep: async () => {}, logger: () => {}, priorInputs: { positionPriors: null },
            limits: { ...DEFAULT_LIMITS, spacingMs: 0, retries: 0 }, recipes: recipeSettings({
                dotabuff: { minRosterRows: 1, minMatchupRows: 1 }, positions: { weeks: 1 }, lanes: { weeks: 1 },
                synergies: { matches: '1', minGames: 1 }, timings: { matches: '1', minGames: 1 },
            }) };
        const before = await regularBytes(dataset, 'manifest.json');
        const run = await collectPopulation(options); assert.equal(run.state, 'complete');
        assert.deepEqual(await regularBytes(dataset, 'manifest.json'), before);
        const replay = await collectPopulation({ ...options, offline: true, clients: {} });
        assert.deepEqual(Object.values(replay.scopes).map(row => row.normalized), Object.values(run.scopes).map(row => row.normalized));
        assert.equal((await applyPopulation({ dataset, storage, runId: 'fixture', clock })).state, 'verified-promoted');
        const published = await regularBytes(dataset, 'manifest.json');
        assert.equal((await applyPopulation({ dataset, storage, runId: 'fixture', clock })).state, 'unchanged');
        assert.deepEqual(await regularBytes(dataset, 'manifest.json'), published);
        const after = await readCanonical(dataset);
        assert.deepEqual(after.entities, graph.entities);
        assert.deepEqual(new Set(after.observations.filter(row => row.kind === 'lane-outcome').map(row => row.direction)), new Set(['with', 'against']));
        return { state: 'passed', steps: run.config.steps, completedScopes: Object.keys(run.scopes).length, observations: after.observations.length };
    }
    finally {
        if (path.dirname(await fs.realpath(root)) !== await fs.realpath(os.tmpdir()) || !path.basename(root).startsWith('population-example-')) throw new Error('Unsafe example cleanup.');
        await fs.rm(root, { recursive: true });
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await fixtureExample()));

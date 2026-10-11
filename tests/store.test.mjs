import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadKnowledgeStore } from '../src/index.mjs';
import { sha256Hex as browserSha256Hex } from '../src/sha256.mjs';

const bytes = value => new TextEncoder().encode(JSON.stringify(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function fixture() {
    const core = {
        schemaVersion: 2,
        version: 'fixture-1',
        createdAt: '2026-10-11T00:00:00.000Z',
        generatedAt: '2026-10-11T00:00:00.000Z',
        build: { clientVersion: 'fixture', serverVersion: 'fixture', publicPatchLabel: null },
        patchLabel: { state: 'unknown', reason: 'Fixture build has no public patch mapping.' },
        compilerVersion: 'dota-knowledge-compiler-3',
        reviewVersion: 'annotations-1',
        sourceIdentities: { mechanics: 'a'.repeat(64), knowledge: 'b'.repeat(64) },
        entities: {
            heroes: [
                { id: '1', key: 'fixture-one', name: 'Fixture One', enabled: true, cmEnabled: true,
                    abilityIds: ['ability:arcane-orb'], effectIds: ['effect:arcane-orb:damage'] },
                { id: '2', key: 'fixture-two', name: 'Fixture Two', enabled: true, cmEnabled: true, abilityIds: [], effectIds: [] },
                { id: '3', key: 'fixture-three', name: 'Fixture Three', enabled: true, cmEnabled: true, abilityIds: [], effectIds: [] },
            ],
            abilities: [{ id: 'ability:arcane-orb', heroId: '1', engineId: 'arcane_orb', activationId: 'activation:arcane-orb',
                order: 0, state: 'known', sourceIds: [] }],
            activations: [{ id: 'activation:arcane-orb', heroId: '1', abilityIds: ['ability:arcane-orb'],
                manaCost: { state: 'known', value: 0 }, cooldown: { state: 'unknown', reason: 'unavailable' },
                charges: { state: 'notApplicable', reason: 'not charged' },
                valueIds: ['value:activation:arcane-orb:manaCost', 'value:activation:arcane-orb:cooldown', 'value:activation:arcane-orb:charges'] }],
            effects: [{ id: 'effect:arcane-orb:damage', legacyEffectId: 'arcane-orb:damage', heroId: '1',
                abilityId: 'ability:arcane-orb', activationId: 'activation:arcane-orb', type: 'damage', subtype: 'magical', order: 0,
                modifierIds: [], ruleIds: [], conditionIds: [], valueIds: ['value:effect:arcane-orb:damage:damage'],
                claimIds: ['claim:fixture'],
                values: { damage: { id: 'value:effect:arcane-orb:damage:damage', ownerId: 'effect:arcane-orb:damage',
                    field: 'damage', state: 'unknown', reason: 'unreviewed' } } }],
            modifiers: [],
            rules: [],
            conditions: [],
            units: [],
            upgrades: [],
        },
        sources: [{ id: 'source:fixture', sha256: 'c'.repeat(64), retrievedAt: null }],
        claims: [{ id: 'claim:fixture', heroId: '1', subjectId: 'effect:arcane-orb:damage',
            sourceIds: ['source:fixture'], status: 'disputed', detailsRef: 'heroes/fixture-one/guide.json#claims/claim:fixture' }],
        observations: [{ id: 'observation:fixture', kind: 'matchup', heroId: '1', otherHeroId: '2',
            sourceId: 'source:fixture', cohortId: 'cohort:fixture', matchCount: '9007199254740993', unit: 'matches' }],
    };
    for (const hero of core.entities.heroes) Object.assign(hero, {
        sourceKey: 'npc_dota_hero_' + hero.key, aliases: [hero.name], primaryAttribute: 0, attackRange: 150, complexity: 1, roles: [],
        coverage: { fields: { primaryAttribute: { state: 'known' }, attackRange: { state: 'known' }, complexity: { state: 'known' }, roles: { state: 'unknown', reason: 'Fixture has no role declaration.' } } },
    });
    core.reviewBindings = core.entities.effects.map(effect => ({ subjectId: effect.id, field: '/claimIds', value: effect.claimIds }));
    for (const effect of core.entities.effects) delete effect.claimIds;
    for (const ability of core.entities.abilities) delete ability.sourceIds;
    const coreBytes = bytes(core);
    const claimDetail = { id: 'claim:fixture', heroId: '1', subjectId: 'effect:arcane-orb:damage',
        sourceIds: ['source:fixture'], status: 'disputed' };
    const guide = heroId => ({ schemaVersion: 2, version: 'fixture-1', createdAt: core.generatedAt, heroId,
        coreSha256: sha256(coreBytes), sourceIdentities: core.sourceIdentities, claims: heroId === '1' ? [claimDetail] : [],
        reviewBindings: heroId === '1' ? core.reviewBindings : [] });
    const guideBytes = bytes({ ...guide('1'), details: { raw: 'retained' } });
    const guide2Bytes = bytes(guide('2'));
    const guide3Bytes = bytes(guide('3'));
    const manifest = { schemaVersion: 2, version: 'fixture-1', createdAt: core.generatedAt,
        sourceIdentities: core.sourceIdentities,
        core: { name: 'core.json', bytes: coreBytes.length, sha256: sha256(coreBytes) },
        guides: {
            '1': { name: 'heroes/fixture-one/guide.json', bytes: guideBytes.length, sha256: sha256(guideBytes) },
            '2': { name: 'heroes/fixture-two/guide.json', bytes: guide2Bytes.length, sha256: sha256(guide2Bytes) },
            '3': { name: 'heroes/fixture-three/guide.json', bytes: guide3Bytes.length, sha256: sha256(guide3Bytes) },
        }, observationShards: [] };
    return { core, coreBytes, guideBytes, guide2Bytes, guide3Bytes, manifest };
}

test('loads ordered records and filters observations without coercing large counts', async () => {
    const data = fixture();
    const files = new Map([['core.json', data.coreBytes], ['heroes/fixture-one/guide.json', data.guideBytes],
        ['heroes/fixture-two/guide.json', data.guide2Bytes], ['heroes/fixture-three/guide.json', data.guide3Bytes]]);
    const store = await loadKnowledgeStore({ manifest: data.manifest,
        readArtifact: async artifact => files.get(artifact.name) });

    assert.deepEqual(store.heroes().map(hero => hero.id), ['1', '2', '3']);
    assert.deepEqual(store.effectsForHero('1').map(effect => effect.id), ['effect:arcane-orb:damage']);
    assert.equal(store.claim('claim:fixture').status, 'disputed');
    assert.equal(store.value('value:effect:arcane-orb:damage:damage').field, 'damage');
    assert.equal(store.value('value:effect:arcane-orb:damage:damage').state, 'unknown');
    assert.equal(store.observations({ sourceId: 'source:fixture', cohortId: 'cohort:fixture' })[0].matchCount,
        '9007199254740993');
    assert.equal(store.observations({ otherHeroId: '1' }).length, 0);
    assert.equal((await store.loadHeroEvidence('1')).details.raw, 'retained');
});

test('uses the same SHA-256 implementation in browsers without Node APIs', () => {
    assert.equal(browserSha256Hex(new TextEncoder().encode('abc')),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('preserves explicit conflict values with their source and claim identities', async () => {
    const data = fixture();
    const conflicted = structuredClone(data.core);
    conflicted.entities.effects[0].values.damage = {
        state: 'conflicted', conflicts: [
            { value: '100', claimId: 'claim:fixture', sourceId: 'source:fixture' },
            { value: '125', claimId: 'claim:fixture', sourceId: 'source:fixture' },
        ],
    };
    const conflictBytes = bytes(conflicted);
    const manifest = { ...data.manifest,
        core: { ...data.manifest.core, bytes: conflictBytes.length, sha256: sha256(conflictBytes) } };
    const files = new Map([['core.json', conflictBytes], ['heroes/fixture-one/guide.json', data.guideBytes],
        ['heroes/fixture-two/guide.json', data.guide2Bytes], ['heroes/fixture-three/guide.json', data.guide3Bytes]]);
    const store = await loadKnowledgeStore({ manifest, readArtifact: async artifact => files.get(artifact.name) });
    assert.deepEqual(store.value('value:effect:arcane-orb:damage:damage').conflicts.map(row => row.value), ['100', '125']);

    const invalid = structuredClone(conflicted);
    invalid.entities.effects[0].values.damage.conflicts[1].sourceId = 'source:missing';
    const invalidBytes = bytes(invalid);
    const invalidManifest = { ...manifest,
        core: { ...manifest.core, bytes: invalidBytes.length, sha256: sha256(invalidBytes) } };
    await assert.rejects(loadKnowledgeStore({ manifest: invalidManifest, readArtifact: async () => invalidBytes }),
        { code: 'UNKNOWN_REFERENCE' });
});

test('rejects unknown references and artifact integrity failures', async () => {
    const data = fixture();
    const invalid = structuredClone(data.core);
    invalid.entities.heroes[0].effectIds.push('effect:missing');
    const invalidBytes = bytes(invalid);
    const badManifest = { ...data.manifest,
        core: { ...data.manifest.core, bytes: invalidBytes.length, sha256: sha256(invalidBytes) } };
    await assert.rejects(loadKnowledgeStore({ manifest: badManifest,
        readArtifact: async () => invalidBytes }), { code: 'UNKNOWN_REFERENCE' });
    await assert.rejects(loadKnowledgeStore({ manifest: data.manifest,
        readArtifact: async () => data.coreBytes.slice(1) }), { code: 'ARTIFACT_INTEGRITY' });
});

test('loads only identity-matched observation shards and retains their source values', async () => {
    const data = fixture();
    const coreSha256 = data.manifest.core.sha256;
    const shardBytes = bytes({ schemaVersion: 2, version: data.manifest.version, coreSha256,
        observations: [{ id: 'observation:second', kind: 'matchup', heroId: '1', otherHeroId: '2',
            sourceId: 'source:fixture', cohortId: 'cohort:second', matchCount: '18446744073709551615',
            advantagePercentagePoints: -0.125, observedAt: null }] });
    const descriptor = { name: 'heroes/fixture-one/observations.json', bytes: shardBytes.length, sha256: sha256(shardBytes),
        heroIds: ['1', '2'], kinds: ['matchup'], sourceIds: ['source:fixture'] };
    const manifest = { ...data.manifest, observationShards: [descriptor] };
    const store = await loadKnowledgeStore({ manifest,
        readArtifact: async artifact => artifact.kind === 'core' ? data.coreBytes : shardBytes });

    const rows = await store.loadObservations({ heroId: '1', otherHeroId: '2' });
    assert.equal(rows.length, 2);
    const loaded = rows.find(row => row.id === 'observation:second');
    assert.equal(loaded.matchCount, '18446744073709551615');
    assert.equal(loaded.advantagePercentagePoints, -0.125);
    assert.equal(loaded.observedAt, null);
    assert.equal(store.observations().length, 1);
    assert.equal((await store.loadObservations({ heroId: '2', otherHeroId: '1' })).length, 0,
        'the observed pair direction stays distinct');
    assert.equal((await store.loadObservations({ cohortId: 'cohort:second' })).length, 1,
        'separate cohorts remain separately queryable');
});

test('rejects condition cycles and review decisions bound to another source revision', async () => {
    const data = fixture();
    const cyclic = structuredClone(data.core);
    cyclic.entities.conditions = [];
    cyclic.entities.conditions = [
        { id: 'condition:a', ownerId: 'effect:arcane-orb:damage', kind: 'all', predicate: {}, conditionIds: ['condition:b'] },
        { id: 'condition:b', ownerId: 'effect:arcane-orb:damage', kind: 'all', predicate: {}, conditionIds: ['condition:a'] },
    ];
    cyclic.entities.effects[0].conditionIds = ['condition:a'];
    const cyclicBytes = bytes(cyclic);
    const cyclicManifest = { ...data.manifest,
        core: { ...data.manifest.core, bytes: cyclicBytes.length, sha256: sha256(cyclicBytes) } };
    await assert.rejects(loadKnowledgeStore({ manifest: cyclicManifest, readArtifact: async () => cyclicBytes }),
        { code: 'REFERENCE_CYCLE' });

    const invalidReview = structuredClone(data.core);
    invalidReview.reviewVersion = 'annotations-1';
    invalidReview.entities.effects[0].claimIds = ['claim:fixture'];
    invalidReview.claims[0] = { id: 'claim:fixture', heroId: '1', subjectId: 'effect:arcane-orb:damage',
        status: 'reviewed', review: { status: 'reviewed' }, sourceIds: ['source:fixture'],
        compatibility: { sourceState: 'bound', nativeSourceHash: invalidReview.sourceIdentities.mechanics,
            annotationVersion: 'wrong-annotation-revision' } };
    const reviewBytes = bytes(invalidReview);
    const reviewManifest = { ...data.manifest,
        core: { ...data.manifest.core, bytes: reviewBytes.length, sha256: sha256(reviewBytes) } };
    await assert.rejects(loadKnowledgeStore({ manifest: reviewManifest, readArtifact: async () => reviewBytes }),
        { code: 'REVIEW_INTEGRITY' });
});

test('coalesces guide reads, evicts least recently used guides, and retries a failed read', async () => {
    const data = fixture();
    const guide2 = data.guide2Bytes;
    const guide3 = data.guide3Bytes;
    const manifest = { ...data.manifest, guides: {
        '1': data.manifest.guides['1'],
        '2': { name: 'heroes/fixture-two/guide.json', bytes: guide2.length, sha256: sha256(guide2) },
        '3': { name: 'heroes/fixture-three/guide.json', bytes: guide3.length, sha256: sha256(guide3) },
    } };
    const files = new Map([['core.json', data.coreBytes], ['heroes/fixture-one/guide.json', data.guideBytes],
        ['heroes/fixture-two/guide.json', guide2], ['heroes/fixture-three/guide.json', guide3]]);
    let reads = 0;
    const store = await loadKnowledgeStore({ manifest, guideCacheSize: 2,
        readArtifact: async artifact => {
            if (artifact.kind === 'guide') reads += 1;
            return files.get(artifact.name);
        } });

    const [first, concurrent] = await Promise.all([store.loadHeroEvidence('1'), store.loadHeroEvidence('1')]);
    assert.equal(first, concurrent);
    await store.loadHeroEvidence('2');
    await store.loadHeroEvidence('1');
    await store.loadHeroEvidence('3');
    await store.loadHeroEvidence('1');
    assert.equal(reads, 3);

    let attempts = 0;
    const retryStore = await loadKnowledgeStore({ manifest: data.manifest,
        readArtifact: async artifact => {
            if (artifact.kind === 'core') return data.coreBytes;
            attempts += 1;
            return attempts === 1 ? null : data.guideBytes;
        } });
    await assert.rejects(retryStore.loadHeroEvidence('1'), { code: 'ARTIFACT_UNAVAILABLE' });
    assert.equal((await retryStore.loadHeroEvidence('1')).heroId, '1');
    assert.equal(attempts, 2);
});

test('runtime rejects schema one and missing, changed or duplicate lazy review bindings', async () => {
    const data = fixture();
    await assert.rejects(loadKnowledgeStore({ manifest: { ...data.manifest, schemaVersion: 1 }, readArtifact: async () => data.coreBytes }),
        { code: 'MANIFEST_SCHEMA' });
    for (const change of [guide => { delete guide.reviewBindings; }, guide => { guide.reviewBindings = []; },
        guide => { guide.reviewBindings[0].value = ['claim:missing']; }, guide => { guide.reviewBindings.push(guide.reviewBindings[0]); }]) {
        const guide = JSON.parse(new TextDecoder().decode(data.guideBytes));
        change(guide);
        const content = bytes(guide);
        const manifest = { ...data.manifest, guides: { ...data.manifest.guides,
            '1': { ...data.manifest.guides['1'], bytes: content.length, sha256: sha256(content) } } };
        const store = await loadKnowledgeStore({ manifest, readArtifact: async artifact => artifact.kind === 'core' ? data.coreBytes : content });
        await assert.rejects(store.loadHeroEvidence('1'), { code: 'REVIEW_INTEGRITY' });
        assert.equal(store.getHeroEvidence('1'), undefined);
    }
});

test('retirement rejects pending guide and observation reads without populating caches', async () => {
    const data = fixture();
    const shard = bytes({ schemaVersion: 2, version: data.manifest.version, coreSha256: data.manifest.core.sha256,
        observations: data.core.observations });
    const manifest = { ...data.manifest, observationShards: [{ name: 'heroes/fixture-one/observations.json',
        bytes: shard.length, sha256: sha256(shard), heroIds: ['1'], kinds: ['matchup'], sourceIds: ['source:fixture'] }] };
    for (const kind of ['guide', 'observations']) {
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        const store = await loadKnowledgeStore({ manifest, readArtifact: artifact => artifact.kind === 'core' ? data.coreBytes : pending });
        const read = kind === 'guide' ? store.loadHeroEvidence('1') : store.loadObservations({ heroId: '1' });
        store.retire();
        release(kind === 'guide' ? data.guideBytes : shard);
        await assert.rejects(read, { code: 'STORE_RETIRED' });
        assert.equal(store.getHeroEvidence('1'), undefined);
        assert.equal(store.observations().length, 1);
    }
});

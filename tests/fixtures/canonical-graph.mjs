import { normalizeLegacyRecords } from '../../src/canonical-model.mjs';

export function graphFixture() {
    const sourceIdentities = { mechanics: 'a'.repeat(64), enrichedNative: 'b'.repeat(64) };
    const source = { id: 'source:fixture', sha256: 'c'.repeat(64), retrievedAt: '2026-10-01T00:00:00Z' };
    const stat = { id: 'observation:pair', kind: 'synergy', heroId: '1', otherHeroId: '7', sourceId: source.id,
        storedHeroIds: ['7', '1'], direction: 'stored-a-then-b', cohortId: 'cohort:old', cohort: { ranks: [7, 1] },
        matchCount: '9007199254740993', observedAt: '2026-09-01T00:00:00Z' };
    const heroes = [];
    const guides = new Map();
    const known = value => ({ state: 'known', value });
    const claim = { id: 'claim:fixture', subjectId: 'effect:one', heroId: '1', sourceIds: [source.id], status: 'proposed' };
    const claim2 = { ...claim, id: 'claim:two', subjectId: 'effect:two' };
    for (const [id, key, name] of [['1', 'antimage', 'Anti-Mage'], ['7', 'earthshaker', 'Earthshaker'], ['127', 'target_dummy', 'Target dummy']]) {
        const abilityIds = id === '1' ? ['ability:blink'] : [];
        const effectIds = id === '1' ? ['effect:one', 'effect:two'] : [];
        heroes.push({ hero: { id, heroId: id, heroKey: 'npc_dota_hero_' + key, key, name, enabled: id !== '127', cmEnabled: true,
            abilityIds, effectIds, coverage: { complete: false } },
        abilities: id === '1' ? [{ id: 'ability:blink', heroId: id, engineId: 'blink', activationId: 'activation:blink', order: 0, state: 'known', sourceIds: [source.id], tags: [] }] : [],
        activations: id === '1' ? [{ id: 'activation:blink', heroId: id, abilityIds, manaCost: known([60, 70]), cooldown: known([12, 9]),
            charges: { state: 'notApplicable', reason: 'No charges.' }, valueIds: ['manaCost', 'cooldown', 'charges'].map(field => 'value:activation:blink:' + field) }] : [],
        effects: effectIds.map((effectId, order) => ({ id: effectId, legacyEffectId: effectId, heroId: id, abilityId: 'ability:blink', activationId: 'activation:blink',
            order, type: 'mobility', subtype: 'blink', values: { range: { ...known([100, 200]), unit: 'units' } },
            valueIds: ['value:' + effectId + ':range'], conditionIds: [], modifierIds: [], ruleIds: [], claimIds: [order ? claim2.id : claim.id] })), conditions: [] });
        guides.set(id, { heroId: id, sourceIdentities, native: { heroId: id, key,
            raw: { AttributePrimary: 'DOTA_ATTRIBUTE_AGILITY', AttackRange: '150', ...(id === '127' ? {} : { Complexity: '1' }), Role: 'Carry,Escape', Rolelevels: '3,2', NameAliases: 'es;  AM  ' }, nativeStats: {} },
            officialHero: { primaryAttribute: 0 }, officialDataset: { createdAt: '2026-09-03T00:00:00Z' } });
    }
    return normalizeLegacyRecords({ metadata: { schemaVersion: 1, version: 'fixture-1', createdAt: '2026-10-01T00:00:00Z', generatedAt: '2026-10-01T00:00:00Z',
        build: { clientVersion: '1' }, patchLabel: { state: 'unknown', reason: 'Fixture.' }, sourceIdentities, reviewVersion: 'fixture-review', runtimeObservations: [stat] },
        heroes, guides, sources: [source], claims: [claim, claim2], reference: {}, observations: [stat, { ...stat, sourceRecord: ['7', '1', '9007199254740993'] },
            { id: 'observation:history', heroId: '1', kind: 'historical-profile', sourceId: source.id, sourceRecord: { name: 'Magina', aliases: ['mage'], primaryAttribute: 0, complexity: 1.5, ranks: [3, 1] } }] },
    { crosswalk: [{ id: '1', key: 'antimage', sourceKey: 'npc_dota_hero_antimage', providerSlug: 'anti-mage' }] });
}

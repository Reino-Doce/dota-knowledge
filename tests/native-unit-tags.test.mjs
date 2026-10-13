import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeMechanicsValue } from '../src/mechanics-values.mjs';
import { inferUnitTags } from '../src/tags/native-unit-tags.mjs';

function fixture(description = 'The sentinel strikes the ground, stunning and damaging targets. The sentinel becomes invulnerable and regains its health.') {
    const native = {
        abilityId: 'unseen_callback', state: 'known', sourceResource: 'ability-source', sourcePath: 'Abilities.unseen_callback',
        raw: { DependentOnAbility: 'unseen_creator' },
    };
    native.nativeDeclarations = { fields: { DependentOnAbility: decodeMechanicsValue(native.raw.DependentOnAbility,
        { sourceResource: native.sourceResource, sourcePath: native.sourcePath + '.DependentOnAbility' }) } };
    const unit = {
        unitKey: 'unseen_actor', state: 'known', sourceResource: 'unit-source', sourcePath: 'Units.unseen_actor',
        raw: { Ability3: native.abilityId, UnitToAbilityMap: native.raw.DependentOnAbility },
    };
    unit.nativeDeclarations = { fields: Object.fromEntries(Object.entries(unit.raw).map(([field, raw]) => [field,
        decodeMechanicsValue(raw, { sourceResource: unit.sourceResource, sourcePath: unit.sourcePath + '.' + field })])) };
    const bound = (record, node, relative) => ['ability-source', 'unit-source'].includes(node.sourceResource)
        && node.sourceResource === record.sourceResource && node.sourcePath === record.sourcePath + '.' + relative
        && record.raw[relative] === node.raw;
    return {
        native, units: [unit], fields: new Map([
            ['DependentOnAbility', native.raw.DependentOnAbility], ['stun_duration', [1, 2]], ['stun_damage', [50, 100]],
            ['hp_regen', { value: '100 150', CalculateSpellDamageTooltip: '1' }], ['AbilityUnitDamageType', 'DAMAGE_TYPE_MAGICAL'],
        ]),
        snippets: [{ suffix: 'Description', text: description }], effects: [{ targets: { teams: { state: 'known', value: ['enemy'] } } }],
        behavior: new Set(['DOTA_ABILITY_BEHAVIOR_NO_TARGET']), nativeTeams: [], isBound: bound,
    };
}

const tags = input => [...inferUnitTags(input)].sort();
const ownPayload = ['controlled_unit_damage_immunity', 'controlled_unit_health_regen', 'disable', 'magical', 'stun'];

test('a source-assigned NPC callback exposes local outgoing and controlled-unit defensive contributions', () => {
    const actual = tags(fixture());
    assert.deepEqual(actual, ownPayload);
    for (const forbidden of ['self_health_regen', 'self_heal', 'heal', 'damage_immunity', 'escape', 'summons']) assert.ok(!actual.includes(forbidden));
});

test('arbitrary source and actor identifiers are explicit joins, not gameplay rules', () => {
    const input = fixture('The ivory companion smashes the battlefield, stunning and damaging all targets. The ivory companion becomes invulnerable and will regain its health rapidly.');
    input.native.abilityId = 'different_action';
    input.units[0].raw.Ability3 = input.native.abilityId;
    Object.assign(input.units[0].nativeDeclarations.fields.Ability3, { raw: input.native.abilityId, decoded: input.native.abilityId });
    input.native.raw.DependentOnAbility = 'different_creation';
    Object.assign(input.native.nativeDeclarations.fields.DependentOnAbility, { raw: 'different_creation', decoded: 'different_creation' });
    input.fields.set('DependentOnAbility', 'different_creation');
    input.units[0].raw.UnitToAbilityMap = 'different_creation';
    Object.assign(input.units[0].nativeDeclarations.fields.UnitToAbilityMap, { raw: 'different_creation', decoded: 'different_creation' });
    assert.deepEqual(tags(input), ownPayload);
});

test('the callback requires source-bound slot and creator joins', async t => {
    const cases = [
        ['unknown native', x => { x.native.state = 'unknown'; }],
        ['unknown unit', x => { x.units[0].state = 'unknown'; }],
        ['no unit slot', x => { delete x.units[0].nativeDeclarations.fields.Ability3; }],
        ['other action in slot', x => {
            x.units[0].raw.Ability3 = 'other_action';
            Object.assign(x.units[0].nativeDeclarations.fields.Ability3, { raw: 'other_action', decoded: 'other_action' });
        }],
        ['slot interpretation mismatch', x => { x.units[0].nativeDeclarations.fields.Ability3.decoded = 'other_action'; }],
        ['creator interpretation mismatch', x => { x.units[0].nativeDeclarations.fields.UnitToAbilityMap.decoded = 'other_creator'; }],
        ['native dependency interpretation mismatch', x => { x.native.nativeDeclarations.fields.DependentOnAbility.decoded = 'other_creator'; }],
        ['native dependency field mismatch', x => { x.fields.set('DependentOnAbility', 'other_creator'); }],
        ['missing unit creator mapping', x => { delete x.units[0].nativeDeclarations.fields.UnitToAbilityMap; }],
        ['unbound unit slot', x => { x.units[0].nativeDeclarations.fields.Ability3.sourceResource = 'missing-source'; }],
        ['unbound native dependency', x => { x.native.nativeDeclarations.fields.DependentOnAbility.sourceResource = 'missing-source'; }],
        ['no binding callback', x => { delete x.isBound; }],
    ];
    for (const [name, mutate] of cases) await t.test(name, () => {
        const input = fixture(); mutate(input); assert.deepEqual(tags(input), []);
    });
});

test('a hero command endpoint with the same creator relationship is not an NPC callback', () => {
    const input = fixture('Orders the sentinel to strike enemies and become invulnerable.');
    input.native.abilityId = 'unseen_command';
    assert.deepEqual(tags(input), []);
});

test('own offensive statements require a proven enemy recipient and nonzero own base values', () => {
    const input = fixture('The sentinel stuns enemies and deals damage to them.');
    assert.deepEqual(tags(input), ['disable', 'magical', 'stun']);
    input.effects = [];
    assert.deepEqual(tags(input), []);
    input.nativeTeams = ['enemy'];
    input.fields.set('stun_duration', { value: '0', display_type: 1 });
    input.fields.set('stun_damage', { value: '0', special_bonus_condition: '+50', RequiresShard: 1 });
    assert.deepEqual(tags(input), []);
    input.fields.set('stun_duration', 'unknown'); input.fields.set('stun_damage', { RequiresShard: 1 });
    assert.deepEqual(tags(input), []);
});

test('formatted and mixed-rank unit payloads keep their positive ranks', () => {
    const input = fixture('The sentinel stuns enemies and deals damage to them.');
    input.fields.set('stun_duration', '+1.25 0%');
    input.fields.set('stun_damage', '0 15%');
    assert.deepEqual(tags(input), ['disable', 'magical', 'stun']);
});

test('damage typing belongs only to the local described outgoing payload', () => {
    const input = fixture('The sentinel deals damage to enemies.');
    assert.deepEqual(tags(input), ['magical']);
    input.fields.delete('stun_damage'); input.fields.set('damage_per_second', '30');
    input.fields.set('AbilityUnitDamageType', 'DAMAGE_TYPE_PHYSICAL');
    assert.deepEqual(tags(input), ['physical']);
    input.fields.delete('damage_per_second'); input.fields.set('damage_reflection', 50);
    assert.deepEqual(tags(input), []);
});

test('newly summoned subcreatures do not transfer their damage or defense to the local callback', () => {
    const input = fixture('The sentinel summons a dragon. The dragon stuns enemies and deals damage to them. The dragon becomes invulnerable and regenerates health.');
    assert.deepEqual(tags(input), []);
    input.snippets = [{ suffix: 'Description', text: 'Summons a creature that stuns enemies and deals damage. The creature becomes invulnerable.' }];
    assert.deepEqual(tags(input), []);
});

test('lore and unknown localized fields cannot declare unit callback capabilities', () => {
    const input = fixture();
    input.snippets[0].suffix = 'Lore';
    assert.deepEqual(tags(input), []);
    input.snippets[0].suffix = 'unknown_text_field';
    assert.deepEqual(tags(input), []);
});

test('returned incoming events and limited immunity do not become fixed outgoing damage or full immunity', () => {
    for (const text of [
        'The sentinel deals incoming damage back to enemies.',
        'The sentinel returns damage to its attacker.',
        'The sentinel gains physical damage immunity.',
        'The sentinel receives damage immunity against magical damage.',
    ]) assert.deepEqual(tags(fixture(text)), [], text);
});

test('own multi-target area and delayed payload qualify only source-proven outgoing operations', () => {
    const input = fixture('After a delay, the sentinel smashes the ground, stunning and damaging all targets in the area.');
    input.fields.set('stun_radius', 375); input.fields.set('stun_delay', 0.55);
    input.fields.set('SpellImmunityType', 'SPELL_IMMUNITY_ENEMIES_YES');
    assert.deepEqual(tags(input), ['aoe', 'bkb_pierce', 'delayed_damage', 'disable', 'magical', 'stun']);
    input.fields.delete('stun_radius'); input.fields.set('search_radius', 375);
    assert.ok(!tags(input).includes('aoe'));
    input.fields.set('stun_radius', 0); input.fields.set('stun_delay', 0);
    assert.ok(!tags(input).includes('delayed_damage'));
    assert.ok(!tags(input).includes('aoe'));
    input.fields.set('stun_duration', 0); input.fields.set('stun_damage', 0);
    assert.deepEqual(tags(input), []);
});

test('negation, prerequisite states, allied grants and caster costs do not become local contributions', () => {
    for (const text of [
        'The sentinel cannot stun enemies or deal damage. The sentinel is not invulnerable.',
        'When the sentinel is stunned and invulnerable, it waits.',
        'The sentinel grants allies invulnerability and health regeneration.',
        'The sentinel stuns friendly units and damages allies.',
        'The enemy becomes invulnerable and regains its health.',
        'The sentinel strikes the ground. Enemies become invulnerable and regain health.',
        'The attacker becomes invulnerable and regains its health.',
        'The sentinel deals damage to itself as a health cost.',
    ]) assert.deepEqual(tags(fixture(text)), [], text);
});

test('own local defense is limited to no-target callbacks and explicit regeneration payload', () => {
    const input = fixture('The sentinel becomes invulnerable and regains its health.');
    assert.deepEqual(tags(input), ['controlled_unit_damage_immunity', 'controlled_unit_health_regen']);
    input.behavior = new Set(['DOTA_ABILITY_BEHAVIOR_UNIT_TARGET']);
    assert.deepEqual(tags(input), []);
    input.behavior = new Set(['DOTA_ABILITY_BEHAVIOR_NO_TARGET']);
    input.fields.set('hp_regen', { value: 0, levelup_interval: 1 });
    input.fields.set('invulnerability_enabled', 0);
    assert.deepEqual(tags(input), []);
});

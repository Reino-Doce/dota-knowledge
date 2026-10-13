import assert from 'node:assert/strict';
import test from 'node:test';
import { inferLinkedBonusTags, inferStatBonusTags } from '../src/tags/native-stat-bonuses.mjs';

const ordered = tags => [...tags].sort();
const passive = new Set(['DOTA_ABILITY_BEHAVIOR_PASSIVE']);
const stat = (abilityLabel, value = 15, overrides = {}) => ordered(inferStatBonusTags({
    abilityLabel,
    fields: new Map([['AbilityType', 'ABILITY_TYPE_ATTRIBUTES'], ['value', { value, RequiresFacet: '0', CalculateSpellDamageTooltip: '1' }]]),
    behavior: passive,
    ...overrides,
}));
const linked = overrides => ordered(inferLinkedBonusTags({ field: 'AbilityCooldown', base: [24, 21, 18, 15], operations: [{ operator: 'subtract', operand: 6 }], ...overrides }));

const titles = [
    ['Agility', ['attribute_bonus']], ['All Attributes', ['attribute_bonus']], ['Armor', ['self_armor']],
    ['Attack Range', ['self_attack_range']], ['Attack Speed', ['self_attack_speed']], ['Base Damage', ['self_attack_damage']],
    ['Cast Range', ['cast_range']], ['Damage', ['self_attack_damage']], ['Health', ['self_max_health']],
    ['Health Regen', ['health_regen', 'self_health_regen']], ['Intelligence', ['attribute_bonus']], ['Mana', ['self_max_mana']],
    ['Mana Regen', ['self_mana_regen']], ['Movement Speed', ['self_movement_speed']], ['Night Vision', ['vision']],
    ['Spell Area of Effect', ['area_increase']], ['Strength', ['attribute_bonus']], ['% Cleave', ['cleave']],
    ['% Evasion', ['evasion']], ['% Lifesteal', ['lifesteal', 'self_lifesteal']], ['% Magic Resistance', ['magic_resistance']],
    ['% Manacost/Manaloss Reduction', ['mana_cost_reduction']], ['% Spell Lifesteal', ['spell_lifesteal']],
];

for (const [property, expected] of titles) test(`owned attribute stat title classifies ${property}`, () => {
    const title = '+{s:value}' + (property.startsWith('%') ? '' : ' ') + property;
    assert.deepEqual(stat(title), ['buff', ...expected].sort());
});

test('direct stat labels need attribute metadata, passive behavior and a nonzero owned value', () => {
    assert.deepEqual(stat('+{s:value} Armor', 0), []);
    assert.deepEqual(stat('+{s:value} Armor', 'unknown'), []);
    assert.deepEqual(stat('+{s:value} Armor', [10, 0]), []);
    assert.deepEqual(stat('+{s:value} Armor', [10, -1]), []);
    assert.deepEqual(stat('+{s:value} Armor', 15, { behavior: new Set() }), []);
    assert.deepEqual(stat('+{s:value} Armor', 15, { fields: new Map([['AbilityType', 'ABILITY_TYPE_BASIC'], ['value', 15]]) }), []);
    assert.deepEqual(stat('+{s:value} Armor', 15, { fields: new Map([['AbilityType', 'ABILITY_TYPE_ATTRIBUTES'], ['value', { RequiresFacet: 15 }]]) }), []);
    assert.deepEqual(stat('+{s:value} Armor', 15, { fields: new Map([['AbilityType', 'DOTA_ABILITY_TYPE_ATTRIBUTES'], ['value', '15']]) }), ['buff', 'self_armor']);
});

test('direct literal titles must bind to the entire numeric value and generic property', () => {
    assert.deepEqual(stat('+15 Armor'), ['buff', 'self_armor']);
    assert.deepEqual(stat('+15 Armor', [15, 20]), []);
    assert.deepEqual(stat('+10 Armor'), []);
    assert.deepEqual(stat('+{s:unknown} Armor'), []);
    assert.deepEqual(stat('Armor'), []);
    assert.deepEqual(stat('DAMAGE INTERVAL'), []);
    assert.deepEqual(stat('+{s:value} Fissure Damage'), []);
    assert.deepEqual(stat('+{s:value} Shallow Grave End Heal'), []);
    assert.deepEqual(stat('+{s:value} Bodyguard Lifesteal'), []);
    assert.deepEqual(stat('+{s:value} Armor and Attack Speed'), []);
});

test('linked cooldown changes do not inherit the parent control, damage type or shape', () => {
    assert.deepEqual(linked({ parentTags: ['stun', 'magical', 'aoe'], parentTeams: ['enemy'] }), ['buff', 'cooldown_reduction']);
    assert.deepEqual(linked({ field: 'AbilityChargeRestoreTime', base: 10, operations: [{ operator: 'multiply', operand: 0.8 }] }), ['buff', 'cooldown_reduction']);
    assert.deepEqual(linked({ field: 'AbilityManaCost', base: 100, operations: [{ operator: 'percent-subtract', operand: 25 }], parentTags: ['mana_burn'] }), ['buff', 'mana_cost_reduction']);
    assert.deepEqual(linked({ field: 'AbilityCastRange', base: 600, operations: [{ operator: 'add', operand: 100 }], parentTags: ['mobility', 'stun'] }), ['buff', 'cast_range']);
});

test('linked expression evaluation preserves rank and operation semantics', () => {
    assert.deepEqual(linked({ base: [20, 10], operations: [{ operator: 'subtract', operand: [5, 2] }] }), ['buff', 'cooldown_reduction']);
    assert.deepEqual(linked({ base: 10, operations: [{ operator: 'percent-add', operand: 50 }, { operator: 'divide', operand: 3 }] }), ['buff', 'cooldown_reduction']);
    assert.deepEqual(linked({ base: [10, 20], operations: [{ operator: 'replace', operand: [8, 16] }] }), ['buff', 'cooldown_reduction']);
    assert.deepEqual(linked({ base: [10, 20], operations: [{ operator: 'set', operand: 5 }] }), ['buff', 'cooldown_reduction']);
    assert.deepEqual(linked({ base: 10, operations: [{ operator: 'add', operand: 5 }, { operator: 'subtract', operand: 12 }] }), ['buff', 'cooldown_reduction']);
    assert.deepEqual(linked({ base: 10, operations: [{ operator: 'multiply', operand: 2 }, { operator: 'percent-subtract', operand: 40 }] }), []);
});

test('unknown, nonnumeric, no-op and mixed-direction branches remain untagged', () => {
    assert.deepEqual(linked({ base: undefined }), []);
    assert.deepEqual(linked({ base: '' }), []);
    assert.deepEqual(linked({ base: false }), []);
    assert.deepEqual(linked({ base: [] }), []);
    assert.deepEqual(linked({ operations: [{ operator: 'percent', operand: 50 }] }), []);
    assert.deepEqual(linked({ operations: [{ operator: 'divide', operand: 0 }] }), []);
    assert.deepEqual(linked({ operations: [{ operator: 'subtract', operand: 'unresolved' }] }), []);
    assert.deepEqual(linked({ operations: [{ operator: 'subtract', operand: 0 }] }), []);
    assert.deepEqual(linked({ base: [10, 20], operations: [{ operator: 'set', operand: 15 }] }), []);
    assert.deepEqual(linked({ base: [10, 20], operations: [{ operator: 'set', operand: [10, 15] }] }), []);
    assert.deepEqual(linked({ base: [10, 20], operations: [{ operator: 'subtract', operand: [1, 2, 3] }] }), []);
});

test('exact costs need a positive base and nonnegative effective value', () => {
    assert.deepEqual(linked({ base: 0, operations: [{ operator: 'subtract', operand: 1 }] }), []);
    assert.deepEqual(linked({ base: 5, operations: [{ operator: 'subtract', operand: 10 }] }), []);
    assert.deepEqual(linked({ field: 'AbilityManaCost', base: 0, operations: [{ operator: 'add', operand: 10 }] }), []);
    assert.deepEqual(linked({ field: 'enemy_mana_cost', base: 100, operations: [{ operator: 'subtract', operand: 10 }], parentTags: ['mana_burn'], parentTeams: ['enemy'] }), []);
    assert.deepEqual(linked({ field: 'health_cost', base: 100, operations: [{ operator: 'subtract', operand: 10 }], parentTags: ['health_cost'] }), []);
});

test('duration extension identifies only the modified effect property', () => {
    assert.deepEqual(linked({ field: 'AbilityDuration', base: 3, operations: [{ operator: 'add', operand: 1 }], parentTags: ['stun', 'magical'] }), ['duration_extension']);
    assert.deepEqual(linked({ field: 'stun_duration', base: 1, operations: [{ operator: 'add', operand: 0.5 }], parentTags: ['stun', 'magical', 'slow'] }), ['duration_extension', 'stun']);
    assert.deepEqual(linked({ field: 'root_duration', base: 2, operations: [{ operator: 'add', operand: 1 }], parentTags: ['stun'] }), ['duration_extension']);
    assert.deepEqual(linked({ field: 'AbilityChannelTime', base: 3, operations: [{ operator: 'add', operand: 1 }], parentTags: ['channeled', 'magical'] }), []);
});

test('area increase needs parent area delivery or a meaningful scope label', () => {
    const branch = { field: 'radius', base: 300, operations: [{ operator: 'add', operand: 100 }] };
    assert.deepEqual(linked({ ...branch, parentTags: ['aoe', 'stun', 'magical'] }), ['area_increase', 'buff']);
    assert.deepEqual(linked({ ...branch, parentEffects: [{ delivery: { kind: 'area' } }] }), ['area_increase', 'buff']);
    assert.deepEqual(linked({ ...branch, fieldLabel: 'EXPLOSION RADIUS' }), ['area_increase', 'buff']);
    assert.deepEqual(linked(branch), []);
    assert.deepEqual(linked({ ...branch, parentTags: ['aoe'], fieldLabel: 'TREE SEARCH RADIUS' }), []);
    assert.deepEqual(linked({ ...branch, field: 'spawn_radius', parentTags: ['aoe'] }), []);
});

test('outgoing damage bonus does not inherit typed damage or crowd control', () => {
    const branch = { field: 'damage', base: 100, operations: [{ operator: 'add', operand: 50 }] };
    assert.deepEqual(linked({ ...branch, parentTags: ['magical', 'stun'], parentTeams: ['enemy'] }), ['ability_damage_bonus', 'buff']);
    assert.deepEqual(linked({ ...branch, parentEffects: [{ type: 'damage', targets: { teams: { state: 'known', value: ['enemy'] } } }] }), ['ability_damage_bonus', 'buff']);
    assert.deepEqual(linked({ ...branch, parentTags: ['magical'], parentTeams: ['self'] }), []);
    assert.deepEqual(linked(branch), []);
    assert.deepEqual(linked({ ...branch, field: 'damage_reduction', parentTags: ['magical'] }), []);
    assert.deepEqual(linked({ ...branch, field: 'reflection_damage', parentTags: ['magical', 'damage_reflection'] }), []);
    assert.deepEqual(linked({ ...branch, field: 'damage_pct', fieldLabel: 'HEALTH COST', parentTags: ['magical'] }), []);
    assert.deepEqual(linked({ ...branch, field: 'damage_duration', parentTags: ['magical'] }), []);
});

test('attack stat bonuses preserve the supported recipient', () => {
    const branch = { field: 'bonus_attack_damage', base: 10, operations: [{ operator: 'add', operand: 5 }] };
    assert.deepEqual(linked({ ...branch, parentTags: ['self_attack_damage', 'magical'], parentTeams: ['self'] }), ['buff', 'self_attack_damage']);
    assert.deepEqual(linked({ ...branch, parentTags: ['ally_attack_damage', 'magical'], parentTeams: ['ally'] }), ['ally_attack_damage', 'buff']);
    assert.deepEqual(linked({ ...branch, parentTags: ['self_attack_damage', 'magical'], parentTeams: ['ally'] }), []);
    assert.deepEqual(linked({ ...branch, parentTags: ['self_attack_damage'], parentTeams: [] }), []);
    assert.deepEqual(linked({ field: 'bonus_armor', base: 5, operations: [{ operator: 'subtract', operand: 2 }], parentTags: ['self_armor'], parentTeams: ['self'] }), []);
});

test('linked health regeneration preserves recipient and shared category tags', () => {
    const branch = { field: 'hp_regen', base: 3, operations: [{ operator: 'add', operand: 1 }] };
    assert.deepEqual(linked({ ...branch, parentTags: ['self_health_regen'], parentTeams: ['self'] }),
        ['buff', 'health_regen', 'self_health_regen']);
    assert.deepEqual(linked({ ...branch, parentTags: ['ally_health_regen'], parentTeams: ['ally'] }),
        ['ally_health_regen', 'buff', 'health_regen']);
});

test('maximum-pool bonuses preserve ally and caster recipients without inferring restoration', () => {
    const branch = { field: 'bonus_hp', base: 100, operations: [{ operator: 'add', operand: 50 }] };
    assert.deepEqual(linked({ ...branch, parentTags: ['self_max_health', 'ally_max_health', 'aura'], parentTeams: ['self', 'ally'] }), ['ally_max_health', 'buff', 'self_max_health']);
    assert.deepEqual(linked({ ...branch, parentTags: ['self_max_health'], parentTeams: ['ally'] }), []);
    assert.deepEqual(linked({ ...branch, parentTags: ['ally_heal', 'ally_health_regen'], parentTeams: ['ally'] }), []);
    assert.deepEqual(linked({ ...branch, field: 'bonus_mana', parentTags: ['ally_max_mana'], parentTeams: ['ally'] }), ['ally_max_mana', 'buff']);
});

test('mixed attack-buff and hostile-damage parents require scoped bonus_damage semantics', () => {
    const branch = {
        field: 'bonus_damage', base: 20, operations: [{ operator: 'add', operand: 10 }],
        parentTags: ['self_attack_damage', 'magical'], parentTeams: ['self', 'enemy'],
        parentEffects: [{ type: 'damage', targets: { teams: { state: 'known', value: ['enemy'] } } }],
    };
    assert.deepEqual(linked(branch), []);
    assert.deepEqual(linked({ ...branch, fieldLabel: 'BONUS DAMAGE' }), []);
    assert.deepEqual(linked({ ...branch, fieldLabel: 'BONUS ATTACK DAMAGE' }), ['buff', 'self_attack_damage']);
    assert.deepEqual(linked({ ...branch, field: 'bonus_attack_damage' }), ['buff', 'self_attack_damage']);
    assert.deepEqual(linked({ ...branch, fieldLabel: 'BONUS SPELL DAMAGE' }), ['ability_damage_bonus', 'buff']);
    assert.deepEqual(linked({ ...branch, field: 'damage' }), ['ability_damage_bonus', 'buff']);
    assert.deepEqual(linked({ ...branch, parentEffects: [], field: 'damage' }), ['ability_damage_bonus', 'buff']);
});

test('controlled-unit damage never becomes caster attack damage or inherits a damage type', () => {
    const branch = { field: 'bonus_damage', base: 10, operations: [{ operator: 'add', operand: 5 }] };
    assert.deepEqual(linked({ ...branch, parentTags: ['controlled_unit_damage', 'summons', 'magical'] }), ['buff', 'controlled_unit_damage']);
    assert.deepEqual(linked({ ...branch, fieldLabel: 'SUMMONED UNIT ATTACK DAMAGE', parentTags: ['summons'] }), ['buff', 'controlled_unit_damage']);
    assert.deepEqual(linked({ ...branch, parentTags: ['summons', 'self_attack_damage'], parentTeams: ['self'] }), []);
    assert.deepEqual(linked({ ...branch, parentTags: ['summons', 'magical'] }), ['ability_damage_bonus', 'buff']);
});

test('hostile stat enhancements retain only their exact matching denial', () => {
    const branch = { base: 10, operations: [{ operator: 'add', operand: 5 }], parentTeams: ['enemy'] };
    assert.deepEqual(linked({ ...branch, field: 'movement_slow', parentTags: ['slow', 'magical', 'armor_reduction'] }), ['slow']);
    assert.deepEqual(linked({ ...branch, field: 'move_slow_min', parentTags: ['slow'] }), ['slow']);
    assert.deepEqual(linked({ ...branch, field: 'armor_reduction', base: -5, operations: [{ operator: 'subtract', operand: 2 }], parentTags: ['armor_reduction'] }), ['armor_reduction']);
    assert.deepEqual(linked({ ...branch, field: 'armor_reduction', base: -5, operations: [{ operator: 'add', operand: 2 }], parentTags: ['armor_reduction'] }), []);
    assert.deepEqual(linked({ ...branch, field: 'armor_reduction', parentTags: ['slow'] }), []);
    assert.deepEqual(linked({ ...branch, field: 'health_restoration_reduction', parentTags: ['anti_heal', 'stun'] }), ['anti_heal']);
    assert.deepEqual(linked({ ...branch, field: 'custom_enabled', parentTags: ['anti_heal', 'stun'] }), []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { inferFieldLabelTags } from '../src/tags/native-field-labels.mjs';

const known = value => ({ state: 'known', value });
function fixture(description, properties, labels, options = {}) {
    return {
        fields: new Map(Object.entries(properties)), fieldLabels: Object.entries(labels).map(([field, text]) => ({ field, text })),
        snippets: [{ suffix: 'Description', text: description }], effects: [{ type: 'modifier', targets: { teams: known(['self']) } }],
        behavior: new Set(['DOTA_ABILITY_BEHAVIOR_NO_TARGET']), nativeTeams: [], actorNames: ['Golden Regent'], ...options,
    };
}
const tags = input => [...inferFieldLabelTags(input)].sort();

test('a verified numeric Lifesteal label supplies property semantics for an opaque own field', () => {
    const input = fixture('Grants Golden Regent Lifesteal.', { opaque_parameter: { value: '20', hero_levelup: '+0.5', levelup_interval: '6' } }, { opaque_parameter: '%LIFESTEAL:' });
    assert.deepEqual(tags(input), ['buff', 'lifesteal', 'self_lifesteal']);
});

test('own ranged transformation and controlled illusion paragraphs retain separate beneficiaries', () => {
    const input = fixture('Golden Regent transforms into a powerful shape with a ranged attack. Any illusions of Golden Regent nearby are also transformed.',
        { opaque_boost: '20 40 60 80', opaque_reach: '450 500 550 600' }, { opaque_boost: 'BONUS DAMAGE:', opaque_reach: 'ATTACK RANGE:' });
    assert.deepEqual(tags(input), ['buff', 'self_attack_damage']);
    input.snippets[0].text = 'Illusions of Golden Regent are transformed into powerful shapes with ranged attacks.';
    assert.deepEqual(tags(input), []);
});

test('own tree weapon prose scopes damage, bonus reach, building amplification and attack splash labels', () => {
    const input = fixture('Grabs a tree and causes Golden Regent to have bonus range, damage, and a splashing attack for a limited number of attacks.',
        { p: { value: '10 20 30 40' }, q: '300', r: '30 40 50 60', s: '70 80 90 100' },
        { p: 'BONUS BASE DAMAGE:', q: 'ATTACK RANGE:', r: '%BONUS BUILDING DAMAGE:', s: '%SPLASH DAMAGE:' },
        { behavior: new Set(['DOTA_ABILITY_BEHAVIOR_UNIT_TARGET']), nativeTeams: [] });
    assert.deepEqual(tags(input), ['aoe', 'buff', 'building_attack_amplification', 'self_attack_damage', 'self_attack_range']);
});

test('caster-owned attack range benefits survive a separate hostile spill recipient', () => {
    const input = fixture("Golden Regent's blades slice through the attacked unit, damaging enemies behind it, while gaining bonus attack range.",
        { opaque_parameter: { value: '50 100 150 200' } }, { opaque_parameter: 'BONUS ATTACK RANGE:' },
        { effects: [{ type: 'passive', targets: { teams: known(['enemy']) } }], behavior: new Set(['DOTA_ABILITY_BEHAVIOR_PASSIVE']) });
    assert.deepEqual(tags(input), ['buff', 'self_attack_range']);
});

test('positive labels require affirmative property context, not a generic self modifier', () => {
    assert.deepEqual(tags(fixture('The caster has a modifier.', { p: 50 }, { p: 'BONUS DAMAGE:' })), []);
    assert.deepEqual(tags(fixture('The caster has an attack.', { p: 50 }, { p: 'DAMAGE:' })), []);
    assert.deepEqual(tags(fixture('The caster gains a ranged attack.', { p: 500 }, { p: 'ATTACK RANGE:' })), []);
    assert.deepEqual(tags(fixture('The caster has a buff.', { p: 20 }, { p: 'LIFESTEAL:' })), []);
});

test('spell damage and mixed modeled output do not become unscoped attack stat bonuses', () => {
    assert.deepEqual(tags(fixture('The caster gains bonus ability damage and makes attacks.', { p: 50 }, { p: 'BONUS DAMAGE:' })), []);
    const input = fixture('The caster transforms into a ranged attacker.', { p: 50 }, { p: 'BONUS DAMAGE:' });
    input.effects.push({ type: 'damage', targets: { teams: known(['enemy']) } });
    assert.deepEqual(tags(input), []);
});

test('recipient grants retain allies without granting the caster their attack stats', () => {
    const input = fixture('Grants allied heroes additional damage for their attacks.', { p: 30 }, { p: 'BONUS ATTACK DAMAGE:' },
        { effects: [{ type: 'modifier', targets: { teams: known(['ally']) } }], behavior: new Set(['DOTA_ABILITY_BEHAVIOR_UNIT_TARGET']), nativeTeams: ['self', 'ally'] });
    assert.deepEqual(tags(input), ['ally_attack_damage', 'buff']);
});

test('ally field-label recipients take precedence over possessive and spatial caster references', () => {
    const teams = [{ type: 'modifier', targets: { teams: known(['self', 'ally']) } }];
    const possessive = fixture('Increases your allies attack damage.', { p: '+25' }, { p: 'BONUS ATTACK DAMAGE:' }, { effects: teams });
    assert.deepEqual(tags(possessive), ['ally_attack_damage', 'buff']);
    const spatial = fixture('Increases attack range for your allies around the caster for their attacks.', { q: '15%' }, { q: 'BONUS ATTACK RANGE:' }, { effects: teams });
    assert.deepEqual(tags(spatial), ['ally_attack_range', 'buff']);
});

test('coordinated beneficiaries and independently granted properties preserve recipients', () => {
    const options = { effects: [{ type: 'modifier', targets: { teams: known(['self', 'ally']) } }] };
    assert.deepEqual(tags(fixture('The caster and allies gain bonus attack range.', { p: 50 }, { p: 'BONUS ATTACK RANGE:' }, options)),
        ['ally_attack_range', 'buff', 'self_attack_range']);
    assert.deepEqual(tags(fixture('The caster grants allies additional damage for attacks and the caster gains bonus attack range.',
        { p: 30, q: 50 }, { p: 'BONUS ATTACK DAMAGE:', q: 'BONUS ATTACK RANGE:' }, options)),
        ['ally_attack_damage', 'buff', 'self_attack_range']);
    assert.deepEqual(tags(fixture('The caster gains bonus attack range.', { p: 30, q: 50 }, { p: 'BONUS DAMAGE:', q: 'BONUS ATTACK RANGE:' })),
        ['buff', 'self_attack_range']);
});

test('controlled creature stats and formula inputs do not become hero attack benefits', () => {
    for (const text of [
        'The creature gains bonus attack damage equal to the caster attack damage.',
        'The caster gains strength based on attack damage.',
        'The caster summons a sentinel. The sentinel gains bonus damage for its attacks.',
        'The caster grants enemies additional damage for their attacks.',
    ]) assert.deepEqual(tags(fixture(text, { p: 30 }, { p: 'BONUS DAMAGE:' })), [], text);
});

test('zero, metadata-only, conditional-only and malformed numeric labels stay empty', () => {
    for (const value of [0, '0', 'unknown', '20 unknown', { value: 0, display_type: 1 }, { RequiresShard: 1 }, { special_bonus_condition: '+20' }, [10, 0]]) {
        assert.deepEqual(tags(fixture('The caster gains bonus damage for attacks.', { p: value }, { p: 'BONUS DAMAGE:' })), [], JSON.stringify(value));
    }
});

test('costs, reduction labels, negation and lore do not declare a positive attack contribution', () => {
    assert.deepEqual(tags(fixture('The caster consumes attack damage as a health cost.', { p: 50 }, { p: 'BONUS DAMAGE:' })), []);
    assert.deepEqual(tags(fixture('The caster does not gain bonus damage for attacks.', { p: 50 }, { p: 'BONUS DAMAGE:' })), []);
    assert.deepEqual(tags(fixture('The caster gains bonus damage for attacks.', { p: 50 }, { p: 'ATTACK DAMAGE REDUCTION:' })), []);
    const input = fixture('The caster gains bonus damage for attacks.', { p: 50 }, { p: 'BONUS DAMAGE:' });
    input.snippets[0].suffix = 'Lore';
    assert.deepEqual(tags(input), []);
});

test('spell lifesteal labels preserve their type and do not add attack lifesteal', () => {
    const input = fixture('Grants the caster spell-lifesteal.', { p: 20 }, { p: 'SPELL LIFESTEAL:' });
    assert.deepEqual(tags(input), ['buff', 'spell_lifesteal']);
    input.fieldLabels[0].text = 'LIFESTEAL:';
    assert.deepEqual(tags(input), ['buff', 'spell_lifesteal']);
});

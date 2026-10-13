import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validateProfile } from '../src/record-contracts.mjs';
import { abilityTagCatalog } from '../src/tags/catalog.mjs';
import { deriveHeroCapabilities, assertHeroCapabilities } from '../src/tags/hero-capabilities.mjs';

const hero = (id = '1') => ({
    id, key: 'hero_' + id, sourceKey: 'npc_dota_hero_hero_' + id, name: 'Hero ' + id,
    aliases: ['hero ' + id], primaryAttribute: 0, attackRange: 150, complexity: 1,
    roles: [], enabled: true, cmEnabled: true, abilityIds: [], effectIds: [],
    coverage: { fields: {
        primaryAttribute: { state: 'known' }, attackRange: { state: 'known' },
        complexity: { state: 'known' }, roles: { state: 'unknown', reason: 'No declared roles.' },
    } },
});
const ability = (id, heroId, tags) => ({ id, heroId, tags });

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
addFormats(ajv);
const schemaRoot = new URL('../schema/', import.meta.url);
for (const filename of fs.readdirSync(schemaRoot).filter(name => name.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(fs.readFileSync(new URL(filename, schemaRoot), 'utf8')));
}
const validateHeroSchema = ajv.getSchema('https://github.com/devilesk/dota-interactive-map/dota-knowledge/hero.schema.json');

test('capabilities sum tag categories across all owned ability records with sorted keys', () => {
    const result = deriveHeroCapabilities([hero()], [
        ability('skill', '1', ['stun', 'aoe', 'stun']),
        ability('innate', '1', ['buff', 'aoe']),
        ability('talent', '1', ['buff']),
        ability('bonus', '1', ['self_attack_damage']),
    ]);
    assert.deepEqual(result[0].capabilities, { buff: 3, control: 1, delivery: 2 });
    assert.deepEqual(Object.keys(result[0].capabilities), ['buff', 'control', 'delivery']);
});

test('each distinct tag in the same skill contributes to every category it belongs to', () => {
    const result = deriveHeroCapabilities([hero()], [
        ability('skill', '1', ['stun', 'disable', 'slow', 'stun', 'magical', 'damage_reflection', 'dispel']),
    ]);
    assert.deepEqual(result[0].capabilities, { control: 4, damage: 2, defense: 2, denial: 1 });
    assert.deepEqual(deriveHeroCapabilities([hero()], [ability('save', '1', ['self_armor', 'death_prevention'])])[0].capabilities,
        { buff: 1, defense: 2, save: 1 });
});

test('every catalog tag scores its exact forward and reverse category memberships', () => {
    assert.equal(new Set(abilityTagCatalog.categories.map(category => category.key)).size, abilityTagCatalog.categories.length);
    assert.equal(new Set(abilityTagCatalog.tags.map(tag => tag.key)).size, abilityTagCatalog.tags.length);
    const catalogTags = new Set(abilityTagCatalog.tags.map(tag => tag.key));
    for (const category of abilityTagCatalog.categories) {
        assert.equal(new Set(category.tags).size, category.tags.length);
        assert.ok(category.tags.every(tag => catalogTags.has(tag)));
    }
    for (const tag of abilityTagCatalog.tags) {
        const categories = abilityTagCatalog.categories.filter(category => category.tags.includes(tag.key)).map(category => category.key).sort();
        assert.ok(categories.length > 0, tag.key);
        assert.deepEqual([...tag.categories].sort(), categories, tag.key);
        const expected = Object.fromEntries(categories.map(category => [category, 1]));
        assert.deepEqual(deriveHeroCapabilities([hero()], [ability('skill', '1', [tag.key])])[0].capabilities, expected, tag.key);
    }
});

test('empty tag lists and heroes with no abilities have empty capabilities', () => {
    const result = deriveHeroCapabilities([hero(), hero('2')], [ability('slot', '1', [])]);
    assert.deepEqual(result.map(row => row.capabilities), [{}, {}]);
    assert.deepEqual(deriveHeroCapabilities([], []), []);
});

test('scores remain isolated by hero ownership even for shared engine ability names', () => {
    const result = deriveHeroCapabilities([hero(), hero('2')], [
        { ...ability('ability:1:common', '1', ['buff']), engineId: 'common' },
        { ...ability('ability:2:common', '2', ['stun', 'buff']), engineId: 'common' },
        ability('another', '2', ['stun']),
    ]);
    assert.deepEqual(result[0].capabilities, { buff: 1 });
    assert.deepEqual(result[1].capabilities, { buff: 1, control: 2 });
});

test('aggregation overwrites stale scores without mutating frozen inputs', () => {
    const heroes = Object.freeze([Object.freeze({ ...hero(), capabilities: Object.freeze({ stale: 999 }) })]);
    const abilities = Object.freeze([Object.freeze(ability('skill', '1', Object.freeze(['buff'])))]);
    const before = JSON.stringify({ heroes, abilities });
    const result = deriveHeroCapabilities(heroes, abilities);
    assert.deepEqual(result[0].capabilities, { buff: 1 });
    assert.notEqual(result, heroes);
    assert.notEqual(result[0], heroes[0]);
    assert.equal(JSON.stringify({ heroes, abilities }), before);
});

test('ability and hero iteration order does not change each hero score', () => {
    const heroes = [hero(), hero('2')];
    const abilities = [ability('first', '1', ['stun']), ability('second', '1', ['buff', 'stun']), ability('third', '2', ['buff'])];
    const scores = values => Object.fromEntries(values.map(row => [row.id, row.capabilities]));
    assert.deepEqual(scores(deriveHeroCapabilities(heroes, abilities)),
        scores(deriveHeroCapabilities([...heroes].reverse(), [...abilities].reverse())));
});

test('duplicate ability identities are rejected rather than inflating counts', () => {
    assert.throws(() => deriveHeroCapabilities([hero()], [ability('same', '1', ['buff']), ability('same', '1', ['buff'])]), /Duplicate capability ability/);
    assert.throws(() => deriveHeroCapabilities([hero(), hero('2')], [ability('same', '1', []), ability('same', '2', [])]), /Duplicate capability ability/);
});

test('orphan abilities and duplicate or malformed hero identities are rejected', () => {
    assert.throws(() => deriveHeroCapabilities([hero()], [ability('foreign', '2', ['buff'])]), /Orphan capability ability/);
    assert.throws(() => deriveHeroCapabilities([hero(), hero()], []), /Duplicate capability hero/);
    assert.throws(() => deriveHeroCapabilities([{ id: 1 }], []), /Invalid capability hero identity/);
    assert.throws(() => deriveHeroCapabilities([hero()], [{ heroId: '1', tags: [] }]), /Invalid capability ability identity/);
    assert.throws(() => deriveHeroCapabilities(null, []), /requires hero and ability arrays/);
    assert.throws(() => deriveHeroCapabilities([], null), /requires hero and ability arrays/);
});

test('missing, malformed and sparse tag arrays are rejected', () => {
    for (const tags of [undefined, null, 'buff', {}, [null], [1], ['Buff'], ['buff-damage'], [''], ['a'.repeat(65)], new Array(1)]) {
        assert.throws(() => deriveHeroCapabilities([hero()], [ability('skill', '1', tags)]), /Invalid capability ability tags/);
    }
});

test('unrecognized tags are rejected rather than silently dropping contributions', () => {
    for (const tags of [['unrecognized_tag'], ['buff', 'unrecognized_tag'], ['control'], ['__proto__'], ['constructor']]) {
        assert.throws(() => deriveHeroCapabilities([hero()], [ability('skill', '1', tags)]), /Unrecognized capability ability tag|Invalid capability ability tags/);
    }
});

test('present scores must equal category sums regardless of map key order', () => {
    const abilities = [ability('skill', '1', ['stun', 'disable', 'buff'])];
    assert.doesNotThrow(() => assertHeroCapabilities([{ ...hero(), capabilities: { control: 2, buff: 1 } }], abilities));
    for (const capabilities of [{}, { buff: 1 }, { buff: 1, control: 1 }, { buff: 1, control: 2, delivery: 1 }, { buff: '1', control: 2 }, { buff: 1, stun: 1, disable: 1 }]) {
        assert.throws(() => assertHeroCapabilities([{ ...hero(), capabilities }], abilities), /do not match ability tags/);
    }
});

test('legacy profiles without scores do not require legacy ability tags', () => {
    assert.doesNotThrow(() => assertHeroCapabilities([hero()], [{ id: 'legacy', heroId: '1' }]));
    assert.doesNotThrow(() => assertHeroCapabilities([hero(), { ...hero('2'), capabilities: { buff: 1 } }], [
        { id: 'legacy', heroId: '1' }, ability('new', '2', ['buff']),
    ]));
    assert.throws(() => assertHeroCapabilities([{ ...hero(), capabilities: {} }], [{ id: 'new', heroId: '1' }]), /Invalid capability ability tags/);
});

test('profile contracts and schema accept absent, empty and positive safe integer scores', () => {
    for (const row of [hero(), { ...hero(), capabilities: {} }, { ...hero(), capabilities: { control: 2, buff: 1, damage: Number.MAX_SAFE_INTEGER } }]) {
        assert.doesNotThrow(() => validateProfile(row));
        assert.equal(validateHeroSchema(row), true, JSON.stringify(validateHeroSchema.errors));
    }
});

test('profile contracts and schema reject invalid score maps', () => {
    for (const capabilities of [null, [], 1, 'buff', { buff: 0 }, { buff: -1 }, { buff: 1.5 }, { buff: '1' },
        { buff: Infinity }, { buff: NaN }, { buff: Number.MAX_SAFE_INTEGER + 1 }, { Buff: 1 }, { 'buff-damage': 1 }, { '': 1 }, { ['a'.repeat(65)]: 1 }]) {
        const row = { ...hero(), capabilities };
        assert.throws(() => validateProfile(row), /Malformed hero profile/);
        assert.equal(validateHeroSchema(row), false, JSON.stringify(capabilities));
    }
    assert.throws(() => validateProfile({ ...hero(), capabilities: undefined }), /Malformed hero profile/);
});

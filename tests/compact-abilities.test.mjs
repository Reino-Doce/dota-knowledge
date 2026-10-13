import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { graphFixture } from './fixtures/canonical-graph.mjs';
import { compactHeroAbilities, compactAbilityEntries, joinCompactHeroAbilities } from '../src/node/ability-view.mjs';
import { decodeMechanicsValue } from '../src/mechanics-values.mjs';
import { readCanonical, writeCanonical, readJson, jsonBytes } from '../src/node/canonical.mjs';
import { hash } from '../src/canonical-model.mjs';
import { validateDataset, schemaValidators } from '../scripts/consolidation/validation.mjs';
import { compileCanonical } from '../scripts/compile-canonical.mjs';

function presentationFixture() {
    const graph = graphFixture();
    const resource = 'scripts/npc/heroes/npc_dota_hero_fixture.txt';
    const baseResource = 'scripts/npc/heroes/npc_dota_hero_base.txt';
    graph.sources.push(...[resource, baseResource].map((resource, index) => ({ id: 'source:native:' + index,
        sourceKind: 'installed-game-resource', resource, sha256: String(index + 1).repeat(64), build: graph.metadata.build })));
    const field = (raw, resource, sourcePath, inherited = false) => ({ ...decodeMechanicsValue(raw, { sourceResource: resource, sourcePath }), inherited });
    const sourcePath = 'DOTAHeroes.npc_dota_hero_fixture';
    const rows = [
        ['spell', { AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_UNIT_TARGET', AbilityUnitTargetTeam: 'DOTA_UNIT_TARGET_TEAM_ENEMY', AbilityUnitTargetType: 'DOTA_UNIT_TARGET_HERO | DOTA_UNIT_TARGET_BASIC', AbilityManaCost: '70', AbilityCooldown: '30 24 18 0' }],
        ['trait', { Innate: '1', AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_PASSIVE' }],
        ['active_trait', { Innate: '1', AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_NO_TARGET', AbilityManaCost: '70', AbilityCooldown: '30 24 18 0' }],
        ['learned', { AbilityType: 'ABILITY_TYPE_ATTRIBUTES', AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_PASSIVE' }],
        ['unresolved', null],
        ['common', { AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_PASSIVE | DOTA_ABILITY_BEHAVIOR_HIDDEN', MaxLevel: '7', RequiredLevel: '2' }],
        ['unassigned', null],
    ];
    const abilities = rows.map(([engineId], order) => ({ id: 'ability:1:' + engineId, heroId: '1', engineId, order,
        activationId: 'activation:1:' + engineId, state: 'known', tags: [] }));
    graph.entities.abilities = abilities;
    graph.entities.activations = abilities.map(row => ({ id: row.activationId, heroId: '1', abilityIds: [row.id],
        manaCost: { state: 'known', value: [70, 70, 70, 70] }, cooldown: { state: 'known', value: [30, 24, 18, 0] } }));
    const raw = { Ability1: 'spell', Ability2: 'trait', Ability3: 'active_trait', Ability16: 'unresolved', AbilityTalentStart: '16' };
    const fields = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, field(value, resource, sourcePath + '.' + key)]));
    fields.Ability25 = { ...field('common', baseResource, 'DOTAHeroes.npc_dota_hero_base.Ability25', true), kind: 'reference', decoded: 'common' };
    const native = { sourceResource: resource, sourcePath, raw,
        abilitySlots: Object.entries({ Ability1: 'spell', Ability2: 'trait', Ability3: 'active_trait', Ability16: 'unresolved', Ability25: 'common' })
            .map(([slot, abilityId]) => ({ slot, abilityId })),
        talents: [{ abilityId: 'unresolved', slots: ['Ability16'] }],
        nativeDeclarations: { fields, base: { sourceResource: baseResource, sourcePath: 'DOTAHeroes.npc_dota_hero_base' },
            inheritance: { state: 'resolved' }, leafProvenance: { Ability25: fields.Ability25 } },
        abilities: rows.map(([abilityId, raw]) => raw ? { abilityId, state: 'known', raw, sourceResource: resource,
            sourcePath: sourcePath + '.AbilityDefinitions.' + abilityId,
            nativeDeclarations: { fields: Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, field(value, resource,
                sourcePath + '.AbilityDefinitions.' + abilityId + '.' + key)])) } } : { abilityId, state: 'unknown' }) };
    graph.guides.get('1').native = native;
    return graph;
}

function slotFixture(description, suffix = 'Description') {
    const graph = presentationFixture();
    const native = graph.guides.get('1').native.abilities[0];
    native.raw.AbilityBehavior = 'DOTA_ABILITY_BEHAVIOR_PASSIVE | DOTA_ABILITY_BEHAVIOR_NOT_LEARNABLE';
    native.raw.MaxLevel = '0';
    const resource = 'resource/localization/abilities_fixture_english.txt';
    graph.sources.push({ id: 'source:localization', sourceKind: 'installed-game-resource', resource, sha256: '3'.repeat(64), build: graph.metadata.build });
    const token = 'DOTA_Tooltip_ability_spell_' + suffix;
    native.localization = { state: 'known', tokens: { [token]: description }, conflictingTokens: [],
        tokenSources: { [token]: [{ state: 'known', raw: description, sourceResource: resource, sourcePath: 'lang.Tokens.' + token }] } };
    return graph;
}

function englishTitle(graph, engineId, text, resource = 'resource/localization/abilities_names_english.txt') {
    if (!graph.sources.some(row => row.resource === resource)) graph.sources.push({ id: 'source:name:' + graph.sources.length,
        sourceKind: 'installed-game-resource', resource, sha256: '5'.repeat(64), build: graph.metadata.build });
    const native = graph.guides.get('1').native.abilities.find(row => row.abilityId === engineId);
    const token = 'DOTA_Tooltip_ability_' + engineId;
    native.localization ??= { state: 'known', tokens: {}, tokenSources: {}, conflictingTokens: [] };
    native.localization.tokens[token] = text;
    native.localization.tokenSources[token] = [{ state: 'known', raw: text, sourceResource: resource, sourcePath: 'lang.Tokens.' + token }];
    return { native, token };
}

test('compact grouping uses native innate, attribute, talent slots and hero-base declarations without losing unknown records', () => {
    const graph = presentationFixture();
    const view = compactHeroAbilities(graph, '1');
    assert.deepEqual(view.innate, [{ id: 'trait', tags: [] }, { id: 'active_trait', type: 'self-target', manaCost: 70, cooldown: [30, 24, 18, 0], tags: [] }]);
    assert.deepEqual(view.skills, [{ id: 'spell', order: 0, type: 'target', target: ['enemy_hero', 'enemy_creep', 'neutral_creep'], manaCost: 70, cooldown: [30, 24, 18, 0], tags: [] },
        { id: 'unassigned', order: 6, type: 'unknown', tags: [] }]);
    assert.deepEqual(view.talents, [{ id: 'learned', tags: [] }, { id: 'unresolved', tags: [] }]);
    assert.deepEqual(view.bonus_attributes, { id: 'common', tags: [] });
    assert.equal(compactAbilityEntries(view).length, graph.entities.abilities.length);
});

test('casting modes use source behavior, with autocast as toggle and mixed point and unit targets retained', () => {
    const graph = presentationFixture();
    const native = graph.guides.get('1').native.abilities[0];
    for (const [raw, expected] of [
        ['DOTA_ABILITY_BEHAVIOR_UNIT_TARGET | DOTA_ABILITY_BEHAVIOR_AUTOCAST', 'toggle'],
        ['DOTA_ABILITY_BEHAVIOR_TOGGLE', 'toggle'], ['DOTA_ABILITY_BEHAVIOR_POINT', 'point'],
        ['DOTA_ABILITY_BEHAVIOR_POINT | DOTA_ABILITY_BEHAVIOR_VECTOR_TARGETING', 'vector'],
        ['DOTA_ABILITY_BEHAVIOR_POINT | DOTA_ABILITY_BEHAVIOR_UNIT_TARGET', 'target-or-point'],
        ['DOTA_ABILITY_BEHAVIOR_HIDDEN', 'unknown'],
    ]) {
        native.raw.AbilityBehavior = raw;
        assert.equal(compactHeroAbilities(graph, '1').skills[0].type, expected);
    }
});

test('acquired and invoked spell slot descriptions classify source-backed placeholders before passive behavior', () => {
    for (const description of ['This slot will be replaced with abilities acquired using a conversion spell.',
        'Casting an invocation will replace this slot with one of ten unique spells based on active buffs.',
        'Spells acquired with a copying ability will replace this slot.',
        'This slot will be filled with an acquired spell.']) {
        const graph = slotFixture(description);
        assert.deepEqual(compactHeroAbilities(graph, '1').skills[0], { id: 'spell', order: 0, type: 'placeholder', tags: [] });
    }
});

test('zero levels, fake items, negation, lore and unrelated slot descriptions do not establish placeholders', () => {
    for (const description of ['The caster stops casting abilities.', 'This slot cannot be replaced with abilities.',
        'Acquired spells never replace this slot.', 'Spells fill the enemy slot.', 'Abilities replace another slot.',
        'Gather souvenirs from kills and assists.']) {
        const graph = slotFixture(description);
        assert.equal(compactHeroAbilities(graph, '1').skills[0].type, 'passive');
    }
    const lore = slotFixture('Spells acquired with a copying ability will replace this slot.', 'Lore');
    assert.equal(compactHeroAbilities(lore, '1').skills[0].type, 'passive');
    const fake = slotFixture('Gather souvenirs from kills and assists.');
    const native = fake.guides.get('1').native.abilities[0];
    native.raw.AbilityBehavior += ' | DOTA_ABILITY_BEHAVIOR_IS_FAKE_ITEM';
    native.raw.MaxLevel = '1';
    assert.equal(compactHeroAbilities(fake, '1').skills[0].type, 'passive');
});

test('placeholder descriptions require the owning localization source and zero-level declaration', () => {
    const description = 'Spells acquired with a copying ability will replace this slot.';
    const graph = slotFixture(description);
    const native = graph.guides.get('1').native.abilities[0];
    const token = 'DOTA_Tooltip_ability_spell_Description';
    native.localization.tokenSources[token][0].sourceResource = 'resource/localization/unselected.txt';
    assert.equal(compactHeroAbilities(graph, '1').skills[0].type, 'passive');
    native.localization.tokenSources[token][0].sourceResource = 'resource/localization/abilities_fixture_english.txt';
    native.localization.tokens = { DOTA_Tooltip_ability_other_Description: description };
    assert.equal(compactHeroAbilities(graph, '1').skills[0].type, 'passive');
    native.localization.tokens = { [token]: description };
    native.raw.MaxLevel = '1';
    assert.equal(compactHeroAbilities(graph, '1').skills[0].type, 'passive');
    native.raw.MaxLevel = '0';
    native.raw.AbilityBehavior = 'DOTA_ABILITY_BEHAVIOR_NO_TARGET | DOTA_ABILITY_BEHAVIOR_NOT_LEARNABLE';
    assert.equal(compactHeroAbilities(graph, '1').skills[0].type, 'self-target');
});

test('source exclusions restrict targets and stale sources cannot classify unknown casting', () => {
    const graph = presentationFixture();
    const native = graph.guides.get('1').native.abilities[0];
    native.raw.AbilityUnitTargetFlags = 'DOTA_UNIT_TARGET_FLAG_NOT_NEUTRAL';
    assert.deepEqual(compactHeroAbilities(graph, '1').skills[0].target, ['enemy_hero', 'enemy_creep']);
    native.raw.AbilityUnitTargetTeam = 'DOTA_UNIT_TARGET_TEAM_FRIENDLY';
    native.raw.AbilityUnitTargetFlags = 'DOTA_UNIT_TARGET_FLAG_NOT_SELF';
    assert.deepEqual(compactHeroAbilities(graph, '1').skills[0].target, ['ally_hero', 'ally_creep']);
    graph.sources = graph.sources.map(source => ({ ...source, build: { clientVersion: 'stale' } }));
    assert.equal(compactHeroAbilities(graph, '1').skills[0].type, 'unknown');
    assert.equal(compactHeroAbilities(graph, '1').skills[0].manaCost, undefined);
});

test('orphaned native ownership cannot classify behavior from inherited field metadata', () => {
    const graph = presentationFixture();
    const native = graph.guides.get('1').native.abilities[0];
    native.sourceResource = 'scripts/npc/unselected.txt';
    assert.deepEqual(compactHeroAbilities(graph, '1').skills[0], { id: 'spell', order: 0, type: 'unknown', tags: [] });
    native.sourceResource = 'scripts/npc/heroes/npc_dota_hero_fixture.txt';
    delete native.raw;
    assert.deepEqual(compactHeroAbilities(graph, '1').skills[0], { id: 'spell', order: 0, type: 'unknown', tags: [] });
});

test('inherited hero-base commands need hidden passive progression before becoming common attribute bonuses', () => {
    for (const [field, raw] of [['AbilityBehavior', 'DOTA_ABILITY_BEHAVIOR_NO_TARGET | DOTA_ABILITY_BEHAVIOR_HIDDEN'],
        ['AbilityBehavior', 'DOTA_ABILITY_BEHAVIOR_PASSIVE'], ['MaxLevel', '0'], ['RequiredLevel', '0']]) {
        const graph = presentationFixture();
        const native = graph.guides.get('1').native.abilities.find(row => row.abilityId === 'common');
        native.raw[field] = raw;
        const view = compactHeroAbilities(graph, '1');
        assert.equal(view.bonus_attributes, null);
        assert.equal(view.skills.some(row => row.id === 'common' && row.order === 5), true);
    }
});

test('known scalar or rank base costs are compacted, while unknown, negative and conditional-only values stay omitted', () => {
    const graph = presentationFixture();
    const activation = graph.entities.activations[0];
    graph.guides.get('1').native.abilities[0].raw.AbilityManaCost = '0';
    activation.manaCost = { state: 'decoded', base: { state: 'known', value: [0, 0, 0] } };
    assert.equal(compactHeroAbilities(graph, '1').skills[0].manaCost, 0);
    for (const field of [{ state: 'unknown', value: 5 }, { state: 'known', value: -1 }, { state: 'decoded', branches: { upgrade: { value: 5 } } }]) {
        activation.manaCost = field;
        assert.equal(compactHeroAbilities(graph, '1').skills[0].manaCost, undefined);
    }
});

test('current gamefile base costs reject stale known activation quantities and unbound declarations', () => {
    const graph = presentationFixture();
    graph.entities.activations[0].manaCost = { state: 'known', value: 99 };
    assert.equal(compactHeroAbilities(graph, '1').skills[0].manaCost, undefined);
    assert.equal(compactHeroAbilities(graph, '1').skills[0].cooldown[0], 30);
    graph.entities.activations[0].manaCost = { state: 'known', value: 70 };
    graph.guides.get('1').native.abilities[0].nativeDeclarations.fields.AbilityManaCost.state = 'unknown';
    assert.equal(compactHeroAbilities(graph, '1').skills[0].manaCost, undefined);
});

test('singleton groups are objects and absent groups are consistently null', () => {
    const graph = presentationFixture();
    graph.entities.abilities = graph.entities.abilities.filter(row => row.engineId !== 'active_trait');
    assert.deepEqual(compactHeroAbilities(graph, '1').innate, { id: 'trait', tags: [] });
    assert.deepEqual(compactHeroAbilities(graph, '7'), { innate: null, skills: [], talents: [], bonus_attributes: null });
});

test('own English titles populate Name across skills, innates, talents and common bonuses independently of casting availability', () => {
    const graph = presentationFixture();
    for (const [id, name] of [['spell', 'Arcane Projectile'], ['trait', 'Natural Trait'], ['active_trait', 'Active Trait'],
        ['learned', 'Known Talent'], ['unresolved', 'Unavailable Declaration Talent'], ['common', 'Attribute Progression'], ['unassigned', 'Unavailable Spell']]) englishTitle(graph, id, name);
    const names = new Map(compactAbilityEntries(compactHeroAbilities(graph, '1')).map(row => [row.id, row.Name]));
    assert.equal(names.get('spell'), 'Arcane Projectile');
    assert.equal(names.get('trait'), 'Natural Trait');
    assert.equal(names.get('learned'), 'Known Talent');
    assert.equal(names.get('unresolved'), 'Unavailable Declaration Talent');
    assert.equal(names.get('common'), 'Attribute Progression');
    assert.equal(names.get('unassigned'), 'Unavailable Spell');
    const placeholder = slotFixture('Spells acquired with a copying ability will replace this slot.');
    englishTitle(placeholder, 'spell', 'Acquired Spell');
    assert.deepEqual(compactHeroAbilities(placeholder, '1').skills[0], { id: 'spell', Name: 'Acquired Spell', order: 0, type: 'placeholder', tags: [] });
});

test('English title arguments render only bound owned scalar or equal-rank base values, including zero', () => {
    const graph = presentationFixture();
    const { native } = englishTitle(graph, 'learned', '+{s:value} Strength');
    native.raw.AbilityValues = { value: { value: '0' } };
    assert.equal(compactHeroAbilities(graph, '1').talents[0].Name, '+0 Strength');
    native.raw.AbilityValues.value = { value: '15 15 15' };
    assert.equal(compactHeroAbilities(graph, '1').talents[0].Name, '+15 Strength');
    native.raw.AbilityValues.value = { value: '15 20 25' };
    assert.equal(compactHeroAbilities(graph, '1').talents[0].Name, undefined);
    englishTitle(graph, 'learned', '+{s:bonus_custom_amount}% Chance');
    native.raw.AbilityValues.custom_amount = '7.5';
    assert.equal(compactHeroAbilities(graph, '1').talents[0].Name, '+7.5% Chance');
    englishTitle(graph, 'learned', '+{s:custom_amount}% Chance');
    assert.equal(compactHeroAbilities(graph, '1').talents[0].Name, '+7.5% Chance');
    native.raw.AbilityValues.custom_amount = { condition: '+9' };
    assert.equal(compactHeroAbilities(graph, '1').talents[0].Name, undefined);
});

test('missing, foreign, conflicting, untranslated or unbound title tokens never generate invented Names', () => {
    const graph = presentationFixture();
    assert.equal(compactHeroAbilities(graph, '1').skills[0].Name, undefined);
    const { native, token } = englishTitle(graph, 'spell', 'Foreign Projectile', 'resource/localization/abilities_french.txt');
    assert.equal(compactHeroAbilities(graph, '1').skills[0].Name, undefined);
    englishTitle(graph, 'spell', 'Own Projectile');
    native.localization.tokenSources[token][0].sourcePath = 'lang.Tokens.ForeignToken';
    assert.equal(compactHeroAbilities(graph, '1').skills[0].Name, undefined);
    englishTitle(graph, 'spell', 'Own Projectile');
    native.localization.tokenSources[token][0].raw = 'Conflicting Projectile';
    assert.equal(compactHeroAbilities(graph, '1').skills[0].Name, undefined);
    englishTitle(graph, 'spell', 'Own Projectile');
    native.localization.conflictingTokens.push(token);
    assert.equal(compactHeroAbilities(graph, '1').skills[0].Name, undefined);
    native.localization.conflictingTokens = [];
    native.localization.tokens = { DOTA_Tooltip_ability_other: 'Borrowed Projectile' };
    assert.equal(compactHeroAbilities(graph, '1').skills[0].Name, undefined);
    englishTitle(graph, 'spell', 'Missing {s:missing_value} Projectile');
    assert.equal(compactHeroAbilities(graph, '1').skills[0].Name, undefined);
    englishTitle(graph, 'spell', 'Own Projectile');
    graph.sources = graph.sources.filter(row => !row.resource?.endsWith('_english.txt'));
    assert.equal(compactHeroAbilities(graph, '1').skills[0].Name, undefined);
});

test('compact join rejects omission, duplicate IDs, forged costs, and false grouping', async t => {
    const graph = presentationFixture();
    const records = graph.entities.abilities.map(({ tags: _tags, ...row }) => row);
    const expected = compactHeroAbilities(graph, '1');
    assert.deepEqual(joinCompactHeroAbilities(graph, '1', expected, records), graph.entities.abilities);
    for (const mutate of [view => view.skills.pop(), view => view.skills.push(view.skills[0]),
        view => { view.skills[0].manaCost = 1; }, view => { view.talents.push(view.skills.pop()); },
        view => { view.skills[0].type = 'passive'; }, view => { view.skills[0].heroId = '1'; }]) await t.test(String(mutate), () => {
        const view = structuredClone(expected); mutate(view);
        assert.throws(() => joinCompactHeroAbilities(graph, '1', view, records), /omit|repeated|projection/);
    });
});

test('recompilation join can discard stale presentation but never unknown IDs, omissions, duplicates or malformed tags', () => {
    const graph = presentationFixture();
    const records = graph.entities.abilities.map(({ tags: _tags, ...row }) => row);
    const expected = compactHeroAbilities(graph, '1');
    const stale = structuredClone(expected);
    stale.skills[0].manaCost = 999;
    stale.skills[0].type = 'passive';
    assert.deepEqual(joinCompactHeroAbilities(graph, '1', stale, records, { validateAbilityView: false }), graph.entities.abilities);
    for (const mutate of [view => view.skills.pop(), view => view.skills.push(view.skills[0]),
        view => { view.skills[0].id = 'unowned'; }, view => { view.skills[0].tags = ['not a tag']; },
        view => { delete view.skills[0].tags; }]) {
        const view = structuredClone(expected); mutate(view);
        assert.throws(() => joinCompactHeroAbilities(graph, '1', view, records, { validateAbilityView: false }), /omit|repeated|Unknown|tags/);
    }
});

test('compact schema and global metadata schema enforce distinct presentation and preservation records', async () => {
    const schemas = await schemaValidators();
    const view = compactHeroAbilities(presentationFixture(), '1');
    assert.equal(schemas.get('abilities')(view), true);
    view.skills[0].activationId = 'activation:private';
    assert.equal(schemas.get('abilities')(view), false);
    const graph = graphFixture();
    const metadata = { schemaVersion: 2, abilities: graph.entities.abilities.map(({ tags: _tags, ...row }) => row), activations: graph.entities.activations };
    assert.equal(schemas.get('ability-metadata')(metadata), true);
    metadata.abilities[0].tags = [];
    assert.equal(schemas.get('ability-metadata')(metadata), false);
});

test('canonical compact round trip preserves complete ability and activation records and reads legacy format', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dota-compact-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const graph = graphFixture();
    await writeCanonical(root, graph);
    const metadata = await readJson(root, 'mechanics/abilities.json');
    assert.deepEqual(metadata.abilities, graph.entities.abilities.map(({ tags: _tags, ...row }) => row));
    assert.deepEqual(metadata.activations, graph.entities.activations);
    const joined = await readCanonical(root);
    assert.deepEqual(joined.entities.abilities, graph.entities.abilities);
    assert.deepEqual(joined.entities.activations, graph.entities.activations);
    const result = await validateDataset(root);
    assert.equal(result.abilities, 1);
    const manifest = await readJson(root, 'manifest.json');
    manifest.sourceFiles = manifest.sourceFiles.filter(row => row.name !== 'mechanics/abilities.json');
    for (const hero of graph.heroIndex) {
        const old = { schemaVersion: 2, abilities: graph.entities.abilities.filter(row => row.heroId === hero.id),
            activations: graph.entities.activations.filter(row => row.heroId === hero.id) };
        const bytes = jsonBytes(old);
        await fs.writeFile(path.join(root, ...hero.abilities.split('/')), bytes);
        Object.assign(manifest.sourceFiles.find(row => row.name === hero.abilities), { bytes: bytes.length, sha256: hash(bytes) });
    }
    await fs.writeFile(path.join(root, 'manifest.json'), jsonBytes(manifest));
    const legacy = await readCanonical(root);
    assert.deepEqual(legacy.entities.abilities, graph.entities.abilities);
    assert.deepEqual(legacy.entities.activations, graph.entities.activations);
    assert.equal((await validateDataset(root)).abilities, 1);
});

test('compiler regenerates stale valid-hash compact casting and costs without changing authoritative metadata', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dota-compact-recompile-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const graph = graphFixture();
    const resource = 'scripts/npc/npc_abilities_fixture.txt';
    graph.sources.push({ id: 'source:native:ability', sourceKind: 'installed-game-resource', resource, sha256: '4'.repeat(64), build: graph.metadata.build });
    graph.guides.get('1').native.abilities = [{ abilityId: 'blink', state: 'known', sourceResource: resource, sourcePath: 'DOTAAbilities.blink',
        raw: { AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_NO_TARGET', AbilityManaCost: '60 70', AbilityCooldown: '12 9' } }];
    await writeCanonical(root, graph);
    const metadata = await readJson(root, 'mechanics/abilities.json');
    const file = graph.heroIndex.find(row => row.id === '1').abilities;
    const sourceView = await readJson(root, file);
    const stale = structuredClone(sourceView);
    stale.skills[0].manaCost = 999;
    stale.skills[0].type = 'passive';
    const bytes = jsonBytes(stale);
    await fs.writeFile(path.join(root, ...file.split('/')), bytes);
    const manifest = await readJson(root, 'manifest.json');
    Object.assign(manifest.sourceFiles.find(row => row.name === file), { bytes: bytes.length, sha256: hash(bytes) });
    await fs.writeFile(path.join(root, 'manifest.json'), jsonBytes(manifest));
    await assert.rejects(readCanonical(root), /projection does not match/);
    await compileCanonical({ dataset: root });
    assert.deepEqual(await readJson(root, file), sourceView);
    assert.deepEqual(await readJson(root, 'mechanics/abilities.json'), metadata);
    assert.deepEqual((await readCanonical(root)).entities.activations, graph.entities.activations);
    assert.equal((await validateDataset(root)).abilities, 1);
});

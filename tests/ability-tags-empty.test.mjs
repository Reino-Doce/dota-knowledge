import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAbilityTags } from '../src/tags/ability-tags.mjs';
import { inferNativeTags } from '../src/tags/native-semantics.mjs';

const build = { clientVersion: 'unrelated-101', serverVersion: 'unrelated-102', sourceRevision: 'unrelated-source' };
const nativeResource = 'scripts/npc/ability_fixture.txt';
const textResource = 'resource/localization/ability_fixture_english.txt';
const known = value => ({ state: 'known', value });
const ordered = tags => [...tags].sort();

function semantics(description, values, options = {}) {
    return ordered(inferNativeTags({
        snippets: [{ suffix: 'Description', text: description }],
        fields: new Map(Object.entries(values)),
        behavior: new Set(['DOTA_ABILITY_BEHAVIOR_PASSIVE']),
        nativeTeams: ['self'],
        ...options,
    }));
}

function nativeFixture(engineId = 'unrelated_action', raw = {}) {
    return {
        abilityId: engineId,
        state: 'known',
        sourceResource: nativeResource,
        sourcePath: 'DOTAAbilities.' + engineId,
        raw: { AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_PASSIVE', ...raw },
        localization: { state: 'known', tokens: {}, tokenSources: {}, conflictingTokens: [] },
    };
}

function graphFixture(rows) {
    return {
        metadata: { build },
        sources: [
            { sourceKind: 'installed-game-resource', resource: nativeResource, sha256: 'a'.repeat(64), build: { ...build } },
            { sourceKind: 'installed-game-resource', resource: textResource, sha256: 'b'.repeat(64), build: { ...build } },
        ],
        entities: {
            abilities: rows.map((native, order) => ({ id: 'ability:' + native.abilityId, heroId: 'hero:unrelated', engineId: native.abilityId, order })),
            effects: [],
        },
        guides: new Map([['hero:unrelated', { native: { abilities: rows, unitDependencies: [] } }]]),
    };
}

function addText(native, suffix, text) {
    const token = 'DOTA_Tooltip_ability_' + native.abilityId + (suffix ? '_' + suffix : '');
    native.localization.tokens[token] = text;
    native.localization.tokenSources[token] = [{ state: 'known', raw: text, sourceResource: textResource, sourcePath: 'lang.Tokens.' + token }];
    return token;
}

const rowsFor = graph => graph.guides.get('hero:unrelated').native.abilities;
const tagsFor = (graph, engineId = graph.entities.abilities[0].engineId) => deriveAbilityTags(graph).abilities.find(row => row.engineId === engineId).tags;
const contains = (actual, expected) => {
    for (const tag of expected) assert.ok(actual.includes(tag), `${tag} missing from ${JSON.stringify(actual)}`);
};
const excludes = (actual, unexpected) => {
    for (const tag of unexpected) assert.ok(!actual.includes(tag), `${tag} incorrectly inferred from ${JSON.stringify(actual)}`);
};

test('proportional attribute and attack-speed grants classify their output instead of their formula input', () => {
    const strength = semantics('The caster gains Strength based on %armor_pct_as_strength%% of Armor.', { armor_pct_as_strength: '30' });
    contains(strength, ['buff', 'attribute_bonus']);
    excludes(strength, ['self_armor', 'ally_armor']);

    const speed = semantics('The caster gains %int_to_atkspd% Attack Speed from Intelligence.', { int_to_atkspd: '1' });
    contains(speed, ['buff', 'self_attack_speed']);
    excludes(speed, ['attribute_bonus']);
});

test('coordinated speed grants keep the caster recipient before their trailing trigger', () => {
    const tags = semantics('Grants bonus attack and movement speed each time the caster hits an enemy with a spell.', {
        attack_speed_bonus: '20', move_speed_bonus: '5',
    });
    contains(tags, ['buff', 'self_attack_speed', 'self_movement_speed']);
    excludes(tags, ['slow', 'enemy_attack_speed_reduction']);
});

test('calling forth a singular companion does not transfer its damage or control to the caster', () => {
    const tags = semantics('The caster calls forth a companion to aid in battle. The companion deals magical damage and slows enemies.', {
        companion_hp: '500', companion_duration: '30', companion_damage: '50', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL',
    });
    assert.deepEqual(tags, ['summons']);
});

test('mana and overheal conversion produce barriers without damage typing or immunity', () => {
    for (const [text, values] of [
        ['A portion of mana the caster spends is converted into a physical barrier.', { mana_multiplier: '1.2', barrier_duration: '3' }],
        ['Overheal received by the caster is converted into a magical barrier.', { absorb_per_damage: '50', barrier_duration: '3' }],
    ]) {
        const tags = semantics(text, values);
        contains(tags, ['buff', 'barrier']);
        excludes(tags, ['damage_immunity', 'physical', 'magical', 'pure']);
    }
});

test('preventing enemies from casting is silence regardless of its global wording', () => {
    const tags = semantics('Prevents all enemies on the map from casting spells for %duration% seconds.', { duration: '3' }, {
        nativeTeams: ['enemy'], behavior: new Set(['DOTA_ABILITY_BEHAVIOR_NO_TARGET']),
    });
    contains(tags, ['silence', 'disable']);
});

test('physical damage immunity retains its limited damage scope', () => {
    const tags = semantics('The caster is immune to physical damage.', { duration: '3' });
    contains(tags, ['physical_damage_immunity']);
    excludes(tags, ['damage_immunity', 'magical_damage_immunity', 'physical']);
});

test('evading attacks recognizes the evasion capability synonym', () => {
    contains(semantics('The caster can evade attacks.', { evasion: '25' }), ['evasion']);
});

test('immobilizing enemies recognizes the hostile root capability synonym', () => {
    const root = semantics('Immobilizes enemies for %immobilize_duration% seconds.', { immobilize_duration: '2' }, { nativeTeams: ['enemy'] });
    contains(root, ['root', 'disable']);
});

test('one passive can expose several independent contributions', () => {
    const tags = semantics('The caster gains bonus attack speed and can evade attacks. The caster takes less damage when hit on the sides or rear.', {
        attack_speed_bonus: '20', evasion: '25', side_damage_reduction: '20', back_damage_reduction: '40',
    });
    contains(tags, ['buff', 'self_attack_speed', 'evasion', 'damage_reduction']);
    excludes(tags, ['self_armor', 'physical_damage_immunity', 'damage_immunity']);
});

test('source-bound incoming spell-damage reflection is distinct from reflecting the targeted spell', () => {
    const tags = semantics('Reflects incoming spell damage.', { damage_reflect_pct: '20', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' });
    contains(tags, ['damage_reflection']);
    excludes(tags, ['spell_reflection', 'magical', 'physical', 'pure']);
});

test('semantic numeric grants fail closed for zero or unknown proportional inputs', () => {
    for (const value of ['0', 'unresolved']) {
        excludes(semantics('The caster gains Strength based on %armor_pct_as_strength%% of Armor.', { armor_pct_as_strength: value }), ['attribute_bonus']);
        excludes(semantics('The caster gains %int_to_atkspd% Attack Speed from Intelligence.', { int_to_atkspd: value }), ['self_attack_speed']);
    }
});

function talentFixture(title = '+{s:value} Armor', value = '15') {
    const talent = nativeFixture('unrelated_numeric_bonus', {
        AbilityType: 'ABILITY_TYPE_ATTRIBUTES', AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_PASSIVE', AbilityValues: { value: { value } },
    });
    addText(talent, '', title);
    return graphFixture([talent]);
}

test('exact bound root talent titles classify generic owned stat bonuses', () => {
    assert.deepEqual(tagsFor(talentFixture()), ['buff', 'self_armor']);
    assert.deepEqual(tagsFor(talentFixture('+{s:value}% Spell Lifesteal')), ['buff', 'spell_lifesteal']);
});

test('root talent classification requires source validity, owned values and generic whole titles', async t => {
    const cases = [
        ['zero value', graph => { rowsFor(graph)[0].raw.AbilityValues.value.value = '0'; }],
        ['unknown value', graph => { rowsFor(graph)[0].raw.AbilityValues.value.value = 'unresolved'; }],
        ['wrong ability type', graph => { rowsFor(graph)[0].raw.AbilityType = 'ABILITY_TYPE_BASIC'; }],
        ['active behavior', graph => { rowsFor(graph)[0].raw.AbilityBehavior = 'DOTA_ABILITY_BEHAVIOR_NO_TARGET'; }],
        ['unbound title', graph => {
            for (const rows of Object.values(rowsFor(graph)[0].localization.tokenSources)) rows[0].sourceResource = 'missing-source';
        }],
        ['conflicting title', graph => { rowsFor(graph)[0].localization.conflictingTokens = Object.keys(rowsFor(graph)[0].localization.tokens); }],
        ['wrong source build', graph => { graph.sources[1].build.sourceRevision = 'different-source'; }],
        ['unbound native field', graph => { rowsFor(graph)[0].sourceResource = 'missing-source'; }],
    ];
    for (const [name, mutate] of cases) await t.test(name, () => {
        const graph = talentFixture();
        mutate(graph);
        if (name === 'unbound native field') assert.throws(() => tagsFor(graph), /source does not match the graph build/);
        else assert.deepEqual(tagsFor(graph), []);
    });
    assert.deepEqual(tagsFor(talentFixture('+{s:value} Arc Damage')), []);
    assert.deepEqual(tagsFor(talentFixture('+{s:value} Protective Box End Heal')), []);
    assert.deepEqual(tagsFor(talentFixture('+10 Armor', '15')), []);
});

function inheritedFixture() {
    const base = nativeFixture('unrelated_base', { AbilityValues: { armor_grant: '0' } });
    addText(base, 'Description', 'The caster gains %armor_grant% armor.');
    const child = nativeFixture('unrelated_child', { _base: base.abilityId, AbilityValues: { armor_grant: '12' } });
    child.nativeDeclarations = { inheritance: { state: 'resolved', chain: [{
        parentId: base.abilityId, state: 'resolved', sourceResource: nativeResource, sourcePath: child.sourcePath + '._base',
        parent: { sourceResource: nativeResource, sourcePath: base.sourcePath },
    }] } };
    return graphFixture([child, base]);
}

test('explicit resolved inheritance uses the base gameplay description with the child payload', () => {
    const graph = inheritedFixture();
    assert.deepEqual(tagsFor(graph, 'unrelated_base'), []);
    assert.deepEqual(tagsFor(graph, 'unrelated_child'), ['buff', 'self_armor']);
});

test('inheritance does not borrow descriptions from unsupported or unbound parent links', async t => {
    const cases = [
        ['missing resolution', graph => { delete rowsFor(graph)[0].nativeDeclarations.inheritance; }],
        ['unresolved chain', graph => { rowsFor(graph)[0].nativeDeclarations.inheritance.chain[0].state = 'unresolved'; }],
        ['unbound reference', graph => { rowsFor(graph)[0].nativeDeclarations.inheritance.chain[0].sourceResource = 'missing-source'; }],
        ['unbound parent description', graph => {
            for (const rows of Object.values(rowsFor(graph)[1].localization.tokenSources)) rows[0].sourceResource = 'missing-source';
        }],
        ['unknown parent', graph => { rowsFor(graph)[1].state = 'unknown'; }],
        ['conflicting owned handler', graph => { rowsFor(graph)[0].raw.BaseClass = 'unrelated_handler'; }],
        ['zero child field', graph => { rowsFor(graph)[0].raw.AbilityValues.armor_grant = '0'; }],
    ];
    for (const [name, mutate] of cases) await t.test(name, () => {
        const graph = inheritedFixture();
        mutate(graph);
        assert.deepEqual(tagsFor(graph, 'unrelated_child'), []);
    });
});

test('explicit inheritance accepts the parent handler and a bound matching effective class', () => {
    const direct = inheritedFixture();
    rowsFor(direct)[0].raw.BaseClass = rowsFor(direct)[1].abilityId;
    assert.deepEqual(tagsFor(direct, 'unrelated_child'), ['buff', 'self_armor']);
    const handler = inheritedFixture();
    rowsFor(handler)[0].raw.BaseClass = 'shared_handler';
    rowsFor(handler)[1].raw.BaseClass = 'shared_handler';
    assert.deepEqual(tagsFor(handler, 'unrelated_child'), ['buff', 'self_armor']);
});

function linkedFixture() {
    const talentId = 'unrelated_upgrade';
    const cooldown = { value: '24 21 18 15', [talentId]: '-6' };
    const parent = nativeFixture('unrelated_hostile_action', {
        AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_UNIT_TARGET', AbilityUnitTargetTeam: 'DOTA_UNIT_TARGET_TEAM_ENEMY',
        AbilityValues: { AbilityCooldown: cooldown, stun_duration: '2' },
    });
    addText(parent, 'Description', 'Stuns the target enemy for %stun_duration% seconds.');
    const path = parent.sourcePath + '.AbilityValues.AbilityCooldown';
    parent.nativeDeclarations = { fields: { AbilityValues: { state: 'decoded', branches: { AbilityCooldown: {
        state: 'decoded', kind: 'conditional', raw: cooldown,
        base: { state: 'known', kind: 'rank-values', value: [24, 21, 18, 15], raw: cooldown.value, sourceResource: nativeResource, sourcePath: path + '.value' },
        branches: { [talentId]: { state: 'decoded', kind: 'expression', raw: '-6',
            branchKind: 'condition',
            expression: { operations: [{ operator: 'subtract', operand: 6 }], rankIndexed: false }, sourceResource: nativeResource, sourcePath: path + '.' + talentId,
        } },
    } } } } };
    const talent = { ...nativeFixture(talentId), state: 'unknown', raw: null };
    const graph = graphFixture([parent, talent]);
    graph.entities.effects.push({ id: 'effect:hostile', abilityId: 'ability:' + parent.abilityId, type: 'control', targets: { teams: known(['enemy']) } });
    return graph;
}

const cooldownNode = graph => rowsFor(graph)[0].nativeDeclarations.fields.AbilityValues.branches.AbilityCooldown;

test('an unknown upgrade uses a source-bound parent cooldown expression without inheriting the parent stun', () => {
    const graph = linkedFixture();
    contains(tagsFor(graph, 'unrelated_hostile_action'), ['stun', 'disable']);
    assert.deepEqual(tagsFor(graph, 'unrelated_upgrade'), ['buff', 'cooldown_reduction']);
    assert.ok(!tagsFor(graph, 'unrelated_hostile_action').includes('cooldown_reduction'));
});

test('an upgrade changing the spell own cooldown does not give the spell a cooldown reduction contribution', () => {
    const graph = linkedFixture();
    const parent = rowsFor(graph)[0];
    const node = cooldownNode(graph);
    const key = 'special_bonus_shard';
    parent.raw.AbilityValues.AbilityCooldown[key] = '-6';
    delete parent.raw.AbilityValues.AbilityCooldown.unrelated_upgrade;
    node.raw = parent.raw.AbilityValues.AbilityCooldown;
    node.branches[key] = { ...node.branches.unrelated_upgrade, sourcePath: parent.sourcePath + '.AbilityValues.AbilityCooldown.' + key };
    delete node.branches.unrelated_upgrade;
    contains(tagsFor(graph, parent.abilityId), ['stun', 'disable']);
    assert.ok(!tagsFor(graph, parent.abilityId).includes('cooldown_reduction'));
    assert.deepEqual(tagsFor(graph, 'unrelated_upgrade'), []);
    node.branches[key].expression.operations[0].operand = 0;
    excludes(tagsFor(graph, parent.abilityId), ['buff', 'cooldown_reduction']);
});

test('linked upgrades require decoded, bound and effective operations', async t => {
    const cases = [
        ['unknown expression', graph => { cooldownNode(graph).branches.unrelated_upgrade.state = 'unknown'; }],
        ['unbound expression', graph => { cooldownNode(graph).branches.unrelated_upgrade.sourceResource = 'missing-source'; }],
        ['unknown base', graph => { cooldownNode(graph).base.state = 'unknown'; }],
        ['unbound base', graph => { cooldownNode(graph).base.sourceResource = 'missing-source'; }],
        ['base interpretation disagrees with raw', graph => { cooldownNode(graph).base.value = [240, 210, 180, 150]; }],
        ['operator interpretation disagrees with raw', graph => { cooldownNode(graph).branches.unrelated_upgrade.expression.operations[0].operator = 'percent-subtract'; }],
        ['operand interpretation disagrees with raw', graph => { cooldownNode(graph).branches.unrelated_upgrade.expression.operations[0].operand = 3; }],
        ['rank interpretation disagrees with raw', graph => { cooldownNode(graph).branches.unrelated_upgrade.expression.rankIndexed = true; }],
        ['metadata branch matching an ability key', graph => { cooldownNode(graph).branches.unrelated_upgrade.branchKind = 'metadata'; }],
        ['field branch matching an ability key', graph => { cooldownNode(graph).branches.unrelated_upgrade.branchKind = 'field'; }],
        ['missing condition role', graph => { delete cooldownNode(graph).branches.unrelated_upgrade.branchKind; }],
        ['no-op expression', graph => {
            rowsFor(graph)[0].raw.AbilityValues.AbilityCooldown.unrelated_upgrade = '-0';
            cooldownNode(graph).branches.unrelated_upgrade.raw = '-0';
            cooldownNode(graph).branches.unrelated_upgrade.expression.operations[0].operand = 0;
        }],
        ['ambiguous bare numeric branch', graph => {
            rowsFor(graph)[0].raw.AbilityValues.AbilityCooldown.unrelated_upgrade = '6';
            Object.assign(cooldownNode(graph).branches.unrelated_upgrade, { state: 'known', kind: 'number', raw: '6', value: 6 });
            delete cooldownNode(graph).branches.unrelated_upgrade.expression;
        }],
        ['wrong source build', graph => { graph.sources[0].build.sourceRevision = 'other-source'; }],
    ];
    for (const [name, mutate] of cases) await t.test(name, () => {
        const graph = linkedFixture();
        mutate(graph);
        if (name === 'wrong source build') assert.throws(() => tagsFor(graph, 'unrelated_upgrade'), /source does not match the graph build/);
        else assert.deepEqual(tagsFor(graph, 'unrelated_upgrade'), []);
    });
});

test('a proven caster stat recipient survives hostile native targeting in linked upgrades', () => {
    const graph = linkedFixture();
    const parent = rowsFor(graph)[0];
    const branch = parent.raw.AbilityValues.AbilityCooldown;
    delete parent.raw.AbilityValues.AbilityCooldown;
    parent.raw.AbilityValues.bonus_attack_damage = branch;
    const node = cooldownNode(graph);
    delete parent.nativeDeclarations.fields.AbilityValues.branches.AbilityCooldown;
    parent.nativeDeclarations.fields.AbilityValues.branches.bonus_attack_damage = node;
    branch.value = '20';
    branch.unrelated_upgrade = '+10';
    Object.assign(node.base, { kind: 'number', raw: '20', value: 20, sourcePath: parent.sourcePath + '.AbilityValues.bonus_attack_damage.value' });
    Object.assign(node.branches.unrelated_upgrade, {
        raw: '+10', expression: { operations: [{ operator: 'add', operand: 10 }], rankIndexed: false },
        sourcePath: parent.sourcePath + '.AbilityValues.bonus_attack_damage.unrelated_upgrade',
    });
    addText(parent, 'Description', 'The caster gains %bonus_attack_damage% attack damage. Stuns the target enemy for %stun_duration% seconds.');
    contains(tagsFor(graph, 'unrelated_hostile_action'), ['self_attack_damage', 'stun']);
    assert.deepEqual(tagsFor(graph, 'unrelated_upgrade'), ['buff', 'self_attack_damage']);
});

test('nested condition wrappers remain traversable when the wrapper also owns an ability record', () => {
    const graph = linkedFixture();
    const parent = rowsFor(graph)[0];
    const node = cooldownNode(graph);
    const key = 'unrelated_condition';
    const raw = { value: '10', unrelated_upgrade: '-2' };
    const path = parent.sourcePath + '.AbilityValues.AbilityCooldown.' + key;
    parent.raw.AbilityValues.AbilityCooldown = { [key]: raw };
    node.raw = parent.raw.AbilityValues.AbilityCooldown;
    node.base = { state: 'unknown', kind: 'missing' };
    node.branches = { [key]: {
        state: 'decoded', kind: 'conditional-value', branchKind: 'condition', raw,
        sourceResource: nativeResource, sourcePath: path,
        base: { state: 'known', kind: 'number', raw: '10', value: 10, sourceResource: nativeResource, sourcePath: path + '.value' },
        branches: { unrelated_upgrade: {
            state: 'decoded', kind: 'expression', branchKind: 'condition', raw: '-2',
            expression: { operations: [{ operator: 'subtract', operand: 2 }], rankIndexed: false },
            sourceResource: nativeResource, sourcePath: path + '.unrelated_upgrade',
        } },
    } };
    rowsFor(graph).push({ ...nativeFixture(key), state: 'unknown', raw: null });
    graph.entities.abilities.push({ id: 'ability:' + key, heroId: 'hero:unrelated', engineId: key, order: 2 });
    assert.deepEqual(tagsFor(graph, key), []);
    assert.deepEqual(tagsFor(graph, 'unrelated_upgrade'), ['buff', 'cooldown_reduction']);
    delete raw.value;
    node.branches[key].base = { state: 'unknown', kind: 'missing' };
    assert.deepEqual(tagsFor(graph, 'unrelated_upgrade'), []);
});

test('linked bonuses use independent parent proof regardless of ability iteration order', () => {
    const parent = (id, target, description) => {
        const raw = { value: '20', [target]: '+10' };
        const native = nativeFixture(id, { AbilityUnitTargetTeam: 'DOTA_UNIT_TARGET_TEAM_FRIENDLY', AbilityValues: { bonus_attack_damage: raw } });
        const path = native.sourcePath + '.AbilityValues.bonus_attack_damage';
        native.nativeDeclarations = { fields: { AbilityValues: { state: 'decoded', branches: { bonus_attack_damage: {
            state: 'decoded', kind: 'conditional-value', raw,
            base: { state: 'known', kind: 'number', value: 20, raw: '20', sourceResource: nativeResource, sourcePath: path + '.value' },
            branches: { [target]: { state: 'decoded', kind: 'expression', branchKind: 'condition', raw: '+10',
                expression: { operations: [{ operator: 'add', operand: 10 }], rankIndexed: false },
                sourceResource: nativeResource, sourcePath: path + '.' + target,
            } },
        } } } } };
        addText(native, 'Description', description);
        return native;
    };
    const first = parent('first_action', 'second_action', 'The caster gains %bonus_attack_damage% attack damage.');
    const second = parent('second_action', 'third_action', 'This action coordinates an internal callback.');
    const third = { ...nativeFixture('third_action'), state: 'unknown', raw: null };
    const graph = graphFixture([first, second, third]);
    assert.deepEqual(tagsFor(graph, 'second_action'), ['buff', 'self_attack_damage']);
    assert.deepEqual(tagsFor(graph, 'third_action'), []);
    const expected = new Map(deriveAbilityTags(graph).abilities.map(ability => [ability.id, ability.tags]));
    graph.entities.abilities.reverse();
    assert.deepEqual(new Map(deriveAbilityTags(graph).abilities.map(ability => [ability.id, ability.tags])), expected);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAbilityTags } from '../src/tags/ability-tags.mjs';

const build = { clientVersion: 'fixture-101', serverVersion: 'fixture-102', sourceRevision: 'fixture-source' };
const abilityResource = 'scripts/npc/npc_abilities_fixture.txt';
const localizationResource = 'resource/localization/abilities_fixture_english.txt';
const escapeTags = ['disjoint', 'escape', 'untargetable'];

function graphFixture({
    engineId = 'unrelated_ability_name',
    abilityId = 'ability:arbitrary',
    heroId = 'hero:arbitrary',
    effectId = 'effect:arbitrary',
    subtype = 'unclassified',
    description = 'The caster becomes untargetable for %duration% seconds.',
    note = 'Disjoints projectiles on cast.',
    effects = true,
    teams = ['self'],
    raw = {},
} = {}) {
    const tokens = {
        ['DOTA_Tooltip_ability_' + engineId + '_Description']: description,
        ...(note ? { ['DOTA_Tooltip_ability_' + engineId + '_Note0']: note } : {}),
    };
    const native = {
        abilityId: engineId,
        state: 'known',
        sourceResource: abilityResource,
        sourcePath: 'DOTAAbilities.' + engineId,
        raw: {
            AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_NO_TARGET',
            AbilityUnitTargetTeam: 'DOTA_UNIT_TARGET_TEAM_FRIENDLY',
            AbilityValues: { duration: '3.5' },
            ...raw,
        },
        localization: {
            state: 'known',
            tokens,
            tokenSources: Object.fromEntries(Object.entries(tokens).map(([token, text]) => [token, [{
                state: 'known',
                raw: text,
                sourceResource: localizationResource,
                sourcePath: 'lang.Tokens.' + token,
            }]])),
            conflictingTokens: [],
        },
    };
    return {
        metadata: { build },
        sources: [
            { sourceKind: 'installed-game-resource', resource: abilityResource, sha256: 'a'.repeat(64), build: { ...build } },
            { sourceKind: 'installed-game-resource', resource: localizationResource, sha256: 'b'.repeat(64), build: { ...build } },
        ],
        entities: {
            abilities: [{ id: abilityId, heroId, engineId }],
            effects: effects ? [{
                id: effectId, abilityId, heroId,
                type: 'modifier', subtype,
                targets: { teams: { state: 'known', value: teams } },
            }] : [],
        },
        guides: new Map([[heroId, { native: { abilities: [native], unitDependencies: [] } }]]),
    };
}

const nativeFor = graph => graph.guides.get(graph.entities.abilities[0].heroId).native.abilities[0];
const addSnippet = (graph, suffix, text) => {
    const native = nativeFor(graph);
    const token = 'DOTA_Tooltip_ability_' + native.abilityId + '_' + suffix;
    native.localization.tokens[token] = text;
    native.localization.tokenSources[token] = [{
        state: 'known', raw: text, sourceResource: localizationResource, sourcePath: 'lang.Tokens.' + token,
    }];
};
const tagsFor = graph => deriveAbilityTags(graph).abilities[0].tags;
const assertEscape = tags => {
    for (const tag of escapeTags) assert.ok(tags.includes(tag), `${tag} missing from ${JSON.stringify(tags)}`);
    assert.ok(!tags.includes('damage_immunity'), 'Untargetability does not establish damage immunity.');
};

test('generic evasion inference does not depend on ability, hero or effect identities', () => {
    const fixtures = [
        {},
        { engineId: 'other_unrelated_action', abilityId: 'ability:other', heroId: 'hero:other', effectId: 'effect:other', subtype: 'opaque-review-term' },
    ];
    const baseline = tagsFor(graphFixture());
    for (const options of fixtures) {
        const graph = graphFixture(options);
        const tags = tagsFor(graph);
        assertEscape(tags);
        assert.deepEqual(tags, baseline);
        assert.deepEqual(tags, [...new Set(tags)].sort());
    }
});

test('matching native declarations keep their tags across unrelated valid builds', () => {
    const first = graphFixture();
    const second = graphFixture();
    const otherBuild = { clientVersion: 'new-client-901', serverVersion: 'new-server-902', sourceRevision: 'new-source' };
    second.metadata.build = otherBuild;
    for (const source of second.sources) source.build = { ...otherBuild };
    assertEscape(tagsFor(second));
    assert.deepEqual(tagsFor(second), tagsFor(first));
});

test('equivalent bound gameplay statements infer untargetability and disjoint', () => {
    const graph = graphFixture({
        description: 'For %duration% seconds, the caster cannot be targeted.',
        note: 'Incoming projectiles are disjointed when this ability is cast.',
    });
    assertEscape(tagsFor(graph));
});

test('native self cast and bound gameplay text work without modeled effects', () => {
    assertEscape(tagsFor(graphFixture({ effects: false })));
});

test('spell amplification and periodic health costs do not establish outgoing damage', () => {
    const graph = graphFixture({
        description: 'The caster deals more spell damage at the cost of a percentage of health per second.',
        note: null,
        effects: false,
        raw: { AbilityUnitDamageType: 'DAMAGE_TYPE_PURE', AbilityValues: { spell_amp: '25', damage_pct: '1.2', duration: '8' } },
    });
    const tags = tagsFor(graph);
    assert.ok(tags.includes('spell_amplification'));
    assert.ok(!tags.includes('pure'));
    assert.ok(!tags.includes('damage_over_time'));

    const cost = graphFixture({
        description: 'The caster sacrifices its own health to activate this ability.', note: null,
        raw: { AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL', AbilityValues: { damage: '30' } },
    });
    cost.entities.effects[0].type = 'damage';
    assert.ok(!tagsFor(cost).includes('magical'));
});

test('a separate attack payload keeps its damage type without inheriting periodic self costs', () => {
    const graph = graphFixture({
        description: 'The caster deals more spell damage at the cost of health per second. The next attack deals %damage% bonus pure damage to an enemy.',
        note: null,
        effects: false,
        raw: { AbilityUnitDamageType: 'DAMAGE_TYPE_PURE', AbilityValues: { spell_amp: '25', damage: '30', health_cost_pct: '1.2' } },
    });
    const tags = tagsFor(graph);
    assert.ok(tags.includes('pure'));
    assert.ok(tags.includes('spell_amplification'));
    assert.ok(!tags.includes('damage_over_time'));
});

test('gameplay formatting preserves action meaning while line breaks separate statements', () => {
    assertEscape(tagsFor(graphFixture({
        description: 'The caster becomes <b>untargetable</b> for %duration% seconds.<br>Shadows cloak the caster.',
        note: 'Disjoints <i>incoming projectiles</i> on cast.',
        effects: false,
    })));
});

test('negative, lore and enemy-only descriptions do not claim a self escape', () => {
    const negated = graphFixture({
        description: 'The caster does not become untargetable.',
        note: 'This ability does not disjoint projectiles.',
    });
    assert.deepEqual(tagsFor(negated), []);

    const lore = graphFixture({ description: 'A spell shrouded in mystery.', note: null });
    const loreNative = nativeFor(lore);
    const loreToken = 'DOTA_Tooltip_ability_unrelated_ability_name_Lore';
    const loreText = 'The caster becomes untargetable and disjoints projectiles.';
    loreNative.localization.tokens[loreToken] = loreText;
    loreNative.localization.tokenSources[loreToken] = [{
        state: 'known', raw: loreText, sourceResource: localizationResource, sourcePath: 'lang.Tokens.' + loreToken,
    }];
    assert.deepEqual(tagsFor(lore), []);

    const enemy = graphFixture({
        description: 'The target enemy becomes untargetable for %duration% seconds.',
        note: null,
        teams: ['enemy'],
        raw: { AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_UNIT_TARGET', AbilityUnitTargetTeam: 'DOTA_UNIT_TARGET_TEAM_ENEMY' },
    });
    assert.ok(!tagsFor(enemy).includes('escape'));
});

test('gameplay inference fails closed when native or localization evidence is not bound', async t => {
    const scenarios = [
        ['absent source', graph => { graph.sources = []; }],
        ['conflicting native source', graph => { graph.sources.push({ ...graph.sources[0], sha256: 'c'.repeat(64) }); }],
        ['conflicting localization source', graph => { graph.sources.push({ ...graph.sources[1], sha256: 'd'.repeat(64) }); }],
        ['unbound native resource', graph => { nativeFor(graph).sourceResource = 'missing-native-resource'; }],
        ['unbound localized token', graph => {
            for (const rows of Object.values(nativeFor(graph).localization.tokenSources)) rows[0].sourceResource = 'missing-localization-resource';
        }],
        ['localized source text mismatch', graph => {
            for (const rows of Object.values(nativeFor(graph).localization.tokenSources)) rows[0].raw = 'Different text.';
        }],
        ['unknown localized text', graph => { nativeFor(graph).localization.state = 'unknown'; }],
        ['conflicting localized tokens', graph => {
            nativeFor(graph).localization.conflictingTokens = Object.keys(nativeFor(graph).localization.tokens);
        }],
        ['wrong build native source', graph => { graph.sources[0].build.sourceRevision = 'other-source'; }],
        ['wrong build localization source', graph => { graph.sources[1].build.sourceRevision = 'other-source'; }],
    ];
    const sourceSelectionFailures = new Set(['absent source', 'conflicting native source', 'unbound native resource', 'wrong build native source']);
    for (const [name, mutate] of scenarios) {
        await t.test(name, () => {
            const graph = graphFixture();
            mutate(graph);
            if (sourceSelectionFailures.has(name)) assert.throws(() => tagsFor(graph), /source|build/i);
            else assert.deepEqual(tagsFor(graph), []);
        });
    }
});

test('an ability-wide damage enum does not claim damage dealt by summoned creatures', () => {
    for (const description of [
        'Summons two creatures to fight for the caster.',
        'Summons two creatures to fight for the caster. Their attacks deal magical damage.',
    ]) {
        const graph = graphFixture({
            description,
            note: null,
            raw: {
                AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL',
                AbilityValues: { summon_count: '2', summon_duration: '20' },
            },
        });
        graph.entities.effects[0].subtype = 'summon-creatures';
        assert.ok(!tagsFor(graph).some(tag => ['magical', 'physical', 'pure'].includes(tag)));
    }
});

test('references to existing states, projectile susceptibility and summoned units do not grant caster evasion', async t => {
    const cases = [
        {
            name: 'regeneration while already untargetable or invulnerable',
            description: 'The caster\'s health regeneration is increased while she is untargetable or invulnerable.',
            raw: { AbilityValues: { health_regen: '10' } },
            forbidden: ['untargetable', 'damage_immunity', 'escape'],
        },
        {
            name: 'a restoration trigger after disjointing',
            description: 'Whenever the caster disjoints an attack, restores mana.',
            raw: { AbilityValues: { mana_restore: '10' } },
            forbidden: ['disjoint', 'escape'],
        },
        {
            name: 'a projectile that cannot be disjointed',
            description: 'Fires a projectile. This projectile cannot be disjointed.',
            forbidden: ['disjoint', 'escape'],
        },
        {
            name: 'a projectile that can be disjointed',
            description: 'Fires a projectile. This projectile can be disjointed.',
            forbidden: ['disjoint', 'escape'],
        },
        {
            name: 'healing an already invulnerable ally',
            description: 'Can heal invulnerable allies.',
            teams: ['self', 'ally'],
            raw: { AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_UNIT_TARGET', AbilityValues: { heal: '100' } },
            forbidden: ['damage_immunity'],
        },
        {
            name: 'untargetability and invisibility applied to summons',
            description: 'Summons creatures. The creatures are invulnerable and untargetable and gain invisibility.',
            raw: { AbilityValues: { summon_count: '2', summon_duration: '20' } },
            forbidden: ['damage_immunity', 'untargetable', 'invisibility', 'escape'],
        },
    ];
    for (const { name, forbidden, ...options } of cases) {
        await t.test(name, () => {
            const tags = tagsFor(graphFixture({ ...options, note: null }));
            for (const tag of forbidden) assert.ok(!tags.includes(tag), `${tag} incorrectly inferred from ${JSON.stringify(tags)}`);
        });
    }
});

test('harmful states applied to the caster or allies do not become enemy disables', () => {
    for (const [description, teams] of [
        ['The caster becomes silenced, muted, and disarmed for %duration% seconds.', ['self']],
        ['The target ally is silenced, muted, and disarmed for %duration% seconds.', ['ally']],
    ]) {
        const tags = tagsFor(graphFixture({ description, teams, note: null }));
        for (const tag of ['disable', 'silence', 'mute', 'disarm']) assert.ok(!tags.includes(tag), `${tag} incorrectly inferred for ${teams}`);
    }
});

test('a zero fear duration does not turn figurative fear language into crowd control', () => {
    const tags = tagsFor(graphFixture({
        description: 'Strikes fear into enemies, reducing armor.',
        note: null,
        teams: ['enemy'],
        raw: {
            AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_UNIT_TARGET',
            AbilityUnitTargetTeam: 'DOTA_UNIT_TARGET_TEAM_ENEMY',
            AbilityValues: { fear_duration: '0', armor_reduction: '4' },
        },
    }));
    assert.ok(!tags.includes('fear'));
    assert.ok(!tags.includes('disable'));
});

test('zero-only capability fields do not grant aura, reflection or amplification', () => {
    const tags = tagsFor(graphFixture({
        description: 'The caster gains protection for %duration% seconds.',
        note: null,
        raw: {
            AbilityValues: { duration: '3.5', aura: '0', aura_radius: '0', does_reflect: '0', reflected_spell_amp: '0' },
        },
    }));
    for (const tag of ['aura', 'spell_reflection', 'spell_amplification']) assert.ok(!tags.includes(tag), `${tag} incorrectly inferred from zero`);
});

test('unrelated positive values do not activate disabled aura contributions', () => {
    const tags = tagsFor(graphFixture({
        description: 'The caster emits an aura within %aura_radius% range that increases spell damage by %aura_damage_pct%.',
        note: null,
        raw: { AbilityValues: { aura_radius: '0', aura_damage_pct: '0', attack_range_bonus: '600' } },
    }));
    for (const tag of ['aura', 'spell_amplification']) assert.ok(!tags.includes(tag), `${tag} incorrectly inferred from a disabled aura`);
});

test('nonlethal damage from an arbitrarily named ability does not prevent other deaths', () => {
    const tags = tagsFor(graphFixture({
        engineId: 'orchard_cut',
        description: 'The caster cannot die from Orchard Cut.',
        note: null,
        raw: { AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL', AbilityValues: { damage: '120' } },
    }));
    assert.ok(!tags.includes('death_prevention'));
});

test('a later pronoun can grant untargetability to boxed self and ally recipients', () => {
    const tags = tagsFor(graphFixture({
        description: 'Caster packs himself or an allied hero into a box. Boxed units are silenced, muted, and disarmed. They are also untargetable.',
        note: null,
        teams: ['self', 'ally'],
        raw: { AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_UNIT_TARGET' },
    }));
    assert.ok(tags.includes('untargetable'));
    assert.ok(tags.includes('escape'));
    for (const tag of ['disable', 'silence', 'mute', 'disarm']) assert.ok(!tags.includes(tag));
});

test('unfamiliar summoned unit names do not transfer restoration or evasion to the caster', () => {
    const fragments = tagsFor(graphFixture({
        description: 'Summons three fragments. These fragments have their health restored.',
        note: null,
        raw: { AbilityValues: { fragment_count: '3', fragment_duration: '20', health_restore: '120' } },
    }));
    assert.ok(fragments.includes('summons'));
    assert.ok(!fragments.includes('self_heal'));

    const motes = tagsFor(graphFixture({
        description: 'Summons two motes. The motes become invulnerable and untargetable.',
        note: null,
        raw: { AbilityValues: { mote_count: '2', mote_duration: '20' } },
    }));
    assert.ok(motes.includes('summons'));
    for (const tag of ['damage_immunity', 'untargetable', 'escape']) assert.ok(!motes.includes(tag));
});

test('a bound damage enum requires damage dealt by the ability even without modeled effects', () => {
    const raw = { AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL', AbilityValues: { damage: '200', summon_count: '3' } };
    const direct = tagsFor(graphFixture({
        description: 'The caster releases energy, dealing %damage% magical damage to nearby enemies.',
        note: null,
        effects: false,
        raw,
    }));
    assert.ok(direct.includes('magical'));

    const summons = tagsFor(graphFixture({
        description: 'Summons three creatures to fight for the caster.',
        note: null,
        effects: false,
        raw,
    }));
    assert.ok(summons.includes('summons'));
    assert.ok(!summons.includes('magical'));
});

test('item and forbidden-action references do not grant a repositioning capability', async t => {
    for (const note of [
        'Damage will not disable items like Blink Dagger.',
        'It does not activate the cooldown on Blink Dagger.',
        'Rooted units cannot use Blink abilities.',
    ]) {
        await t.test(note, () => {
            const tags = tagsFor(graphFixture({
                description: 'The caster launches a blast that deals %damage% damage to enemies.',
                note,
                raw: {
                    AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL',
                    AbilityValues: { damage: '150', cast_range: '600', movement_speed: '50', duration: '2' },
                },
            }));
            for (const tag of ['blink', 'mobility', 'escape']) assert.ok(!tags.includes(tag), `${tag} incorrectly inferred from ${note}`);
        });
    }
});

test('interruptions and alternate cast restrictions do not become hostile controls', async t => {
    for (const note of [
        'Movement is interrupted if the caster is stunned, hexed or banished.',
        'The melee attack may be disabled by setting the ability to Alt Cast.',
    ]) {
        await t.test(note, () => {
            const graph = graphFixture({
                description: 'Deals %damage% damage to enemies.',
                note,
                teams: ['enemy'],
                raw: {
                    AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_UNIT_TARGET',
                    AbilityUnitTargetTeam: 'DOTA_UNIT_TARGET_TEAM_ENEMY',
                    AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL',
                    AbilityValues: { damage: '150', duration: '2' },
                },
            });
            graph.entities.effects[0].type = 'damage';
            const tags = tagsFor(graph);
            assert.ok(tags.includes('magical'));
            for (const tag of ['hex', 'disable']) assert.ok(!tags.includes(tag), `${tag} incorrectly inferred from ${note}`);
        });
    }
});

test('summoned ownership persists into separate facet descriptions', () => {
    const graph = graphFixture({
        description: 'Summons three creatures to fight for the caster.',
        note: null,
        raw: {
            AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL',
            AbilityValues: { summon_count: '3', summon_duration: '20', root_duration: '2', damage: '100' },
        },
    });
    addSnippet(graph, 'Facet_creature_upgrade', 'The summoned creatures gain Hamstring, causing their attacks to root enemies.');
    const tags = tagsFor(graph);
    assert.ok(tags.includes('summons'));
    for (const tag of ['root', 'disable', 'magical', 'physical', 'pure']) assert.ok(!tags.includes(tag), `${tag} incorrectly inferred from ${JSON.stringify(tags)}`);
});

test('an active ward summon uses its bound duration without claiming the ward damage type', () => {
    const tags = tagsFor(graphFixture({
        description: 'Summons a ward to attack nearby enemies.',
        note: null,
        raw: { AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL', AbilityValues: { ward_duration: '30' } },
    }));
    assert.ok(tags.includes('summons'), `summons missing from ${JSON.stringify(tags)}`);
    for (const tag of ['magical', 'physical', 'pure']) assert.ok(!tags.includes(tag));
});

test('alternative self or ally recipients both receive a later movement benefit', () => {
    const tags = tagsFor(graphFixture({
        description: 'Caster packs himself or an allied hero into a box. Boxed units gain %movement_speed% movement speed.',
        note: null,
        teams: ['self', 'ally'],
        raw: { AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_UNIT_TARGET', AbilityValues: { movement_speed: '50' } },
    }));
    assert.ok(tags.includes('self_movement_speed'));
    assert.ok(tags.includes('ally_movement_speed'));
});

test('a zero percentage placeholder does not borrow the base ability cooldown as a reduction payload', () => {
    const tags = tagsFor(graphFixture({
        description: 'The cooldown is reduced by %other_cooldown_reduction_pct%%%.',
        note: null,
        raw: { AbilityCooldown: '17', AbilityValues: { other_cooldown_reduction_pct: '0' } },
    }));
    assert.ok(!tags.includes('cooldown_reduction'));
});

test('caster regeneration used as a summon damage formula does not grant caster regeneration', () => {
    const tags = tagsFor(graphFixture({
        description: 'Summons two creatures. Their damage is increased based on the caster\'s health and mana regeneration.',
        note: null,
        raw: {
            AbilityValues: { summon_count: '2', summon_duration: '20', health_regen: '5', mana_regen: '10', creature_damage_amp: '15' },
        },
    }));
    assert.ok(tags.includes('summons'));
    for (const tag of ['self_health_regen', 'self_mana_regen']) assert.ok(!tags.includes(tag));
});

test('generic damage reflection and hit negation are independent of identity and modeled effects', () => {
    for (const description of [
        'When activated while above ground, this ability reflects and negates damage dealt to the caster (max once per source), as well as stunning the source.',
        'Reflects incoming damage back to its source and prevents that hit from damaging the caster.',
        'Reflects incoming spell damage back to its source and negates damage dealt to the caster.',
    ]) {
        const tags = tagsFor(graphFixture({
            description,
            note: null,
            effects: false,
            raw: {
                AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL',
                AbilityValues: { damage_reflect_pct: '140', reflect_duration: '2' },
            },
        }));
        for (const tag of ['damage_reflection', 'damage_negation']) assert.ok(tags.includes(tag), `${tag} missing from ${JSON.stringify(tags)}`);
        for (const tag of ['spell_reflection', 'damage_immunity', 'magical', 'physical', 'pure']) assert.ok(!tags.includes(tag), `${tag} incorrectly inferred from event reflection`);
    }
});

test('reflecting an incoming damage event does not imply preventing that event', () => {
    for (const description of [
        'Returns incoming damage back to its source.',
        'Recoils incoming damage back to its source.',
        'Reflects incoming spell damage back to its source.',
    ]) {
        const tags = tagsFor(graphFixture({
            description,
            note: null,
            effects: false,
            raw: { AbilityValues: { damage_reflect_pct: '140', reflect_duration: '2' } },
        }));
        assert.ok(tags.includes('damage_reflection'), `damage_reflection missing from ${JSON.stringify(tags)}`);
        assert.ok(!tags.includes('damage_negation'));
        assert.ok(!tags.includes('damage_immunity'));
        assert.ok(!tags.includes('spell_reflection'));
    }
});

test('preventing an incoming hit does not imply reflecting it or general damage immunity', () => {
    const tags = tagsFor(graphFixture({
        description: 'Prevents an incoming damage event from damaging the caster.',
        note: null,
        effects: false,
        raw: { AbilityValues: { damage_negation: '1', duration: '2' } },
    }));
    assert.ok(tags.includes('damage_negation'), `damage_negation missing from ${JSON.stringify(tags)}`);
    for (const tag of ['damage_reflection', 'spell_reflection', 'damage_immunity']) assert.ok(!tags.includes(tag));
});

test('damage reflection restrictions and conditional mentions do not grant reflection or negation', async t => {
    for (const [name, description, note] of [
        ['susceptibility note', 'The caster guards against attacks.', 'Reflected damage cannot be reflected.'],
        ['negative reflection', 'This ability does not reflect damage.', null],
        ['negative prevention', 'This ability does not prevent damage.', null],
        ['negative coordinated operations', 'This ability does not reflect or prevent damage.', null],
        ['conditional reflection trigger', 'After damage is reflected, the caster gains %movement_speed% movement speed.', null],
    ]) {
        await t.test(name, () => {
            const tags = tagsFor(graphFixture({
                description, note, effects: false,
                raw: { AbilityValues: { damage_reflect_pct: '140', reflect_duration: '2', movement_speed: '30' } },
            }));
            for (const tag of ['damage_reflection', 'damage_negation']) assert.ok(!tags.includes(tag), `${tag} incorrectly inferred from ${JSON.stringify(tags)}`);
        });
    }
});

test('partial damage reduction is not complete hit negation', () => {
    const tags = tagsFor(graphFixture({
        description: 'Reduces incoming damage by %damage_reduction%%.',
        note: null,
        effects: false,
        raw: { AbilityValues: { damage_reduction: '30', duration: '2' } },
    }));
    assert.ok(tags.includes('damage_reduction'));
    for (const tag of ['damage_reflection', 'damage_negation', 'damage_immunity']) assert.ok(!tags.includes(tag));
});

test('damage reflection and negation granted to controlled units do not transfer to the caster', () => {
    const tags = tagsFor(graphFixture({
        description: 'Summons two reflections. The reflections return incoming damage to its source and negate the damage dealt to them.',
        note: null,
        effects: false,
        raw: { AbilityValues: { reflection_count: '2', reflection_duration: '20', damage_reflect_pct: '140' } },
    }));
    assert.ok(tags.includes('summons'));
    for (const tag of ['damage_reflection', 'damage_negation', 'damage_immunity', 'escape']) assert.ok(!tags.includes(tag));
});

test('a zero reflection percentage does not borrow unrelated positive damage', () => {
    const tags = tagsFor(graphFixture({
        description: 'Reflects incoming damage back to its source.',
        note: null,
        effects: false,
        raw: { AbilityValues: { damage_reflect_pct: '0', reflect_duration: '2', damage: '200' } },
    }));
    assert.ok(!tags.includes('damage_reflection'));
});

test('reflecting a targeted spell does not imply reflecting or negating its damage event', () => {
    const tags = tagsFor(graphFixture({
        description: 'Reflects targeted spells back to their caster.',
        note: null,
        effects: false,
        raw: { AbilityValues: { does_reflect: '1', reflect_duration: '2' } },
    }));
    assert.ok(tags.includes('spell_reflection'));
    for (const tag of ['damage_reflection', 'damage_negation']) assert.ok(!tags.includes(tag));
});

function stationaryDefenseFixture(options = {}) {
    const graph = graphFixture({
        description: 'Caster digs into ground. Once underground, Reactive Shell instantly stuns nearby enemies when cast, the range of Arc and Bolt is increased, and Bolt cooldown is decreased. While underground, caster is stationary, unable to attack, and invisible. Caster gains damage reduction from all damage sources.',
        note: null,
        effects: false,
        raw: {
            AbilityValues: { damage_reduction: '40', cast_range: '500', cooldown_reduction: '25', health_regen_rate: '1', mana_regen_rate: '1', stun_duration: '1' },
        },
        ...options,
    });
    addSnippet(graph, 'health_regen_rate', '%MAX HP REGEN:');
    addSnippet(graph, 'mana_regen_rate', '%MAX MANA REGEN:');
    return graph;
}

test('stationary defense and bound regeneration labels infer contributions without movement or identities', () => {
    const fixtures = [
        stationaryDefenseFixture(),
        stationaryDefenseFixture({ engineId: 'different_underground_action', heroId: 'hero:different', abilityId: 'ability:different', effects: true }),
    ];
    const otherBuild = { clientVersion: 'unrelated-client', serverVersion: 'unrelated-server', sourceRevision: 'unrelated-source' };
    fixtures[1].metadata.build = otherBuild;
    for (const source of fixtures[1].sources) source.build = { ...otherBuild };

    for (const graph of fixtures) {
        const tags = tagsFor(graph);
        for (const tag of ['buff', 'damage_reduction', 'invisibility', 'escape', 'cast_range', 'cooldown_reduction', 'self_health_regen', 'self_mana_regen']) {
            assert.ok(tags.includes(tag), `${tag} missing from ${JSON.stringify(tags)}`);
        }
        for (const tag of ['self_armor', 'ally_armor', 'mobility', 'self_reposition', 'self_attack_range']) assert.ok(!tags.includes(tag));
    }
    assert.deepEqual(tagsFor(fixtures[0]), tagsFor(fixtures[1]));
});

test('the native hidden behavior flag does not grant gameplay invisibility', () => {
    const tags = tagsFor(graphFixture({
        description: 'An internal action.',
        note: null,
        effects: false,
        raw: { AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_NO_TARGET | DOTA_ABILITY_BEHAVIOR_HIDDEN' },
    }));
    assert.ok(!tags.includes('invisibility'));
    assert.ok(!tags.includes('escape'));
});

test('regeneration labels require a matching nonzero field and trustworthy parameter text', async t => {
    const scenarios = [
        ['zero regeneration values', graph => {
            nativeFor(graph).raw.AbilityValues.health_regen_rate = '0';
            nativeFor(graph).raw.AbilityValues.mana_regen_rate = '0';
        }],
        ['unbound labels', graph => {
            for (const suffix of ['health_regen_rate', 'mana_regen_rate']) {
                const token = 'DOTA_Tooltip_ability_' + nativeFor(graph).abilityId + '_' + suffix;
                nativeFor(graph).localization.tokenSources[token][0].sourceResource = 'missing-parameter-label-source';
            }
        }],
        ['source text mismatches labels', graph => {
            for (const suffix of ['health_regen_rate', 'mana_regen_rate']) {
                const token = 'DOTA_Tooltip_ability_' + nativeFor(graph).abilityId + '_' + suffix;
                nativeFor(graph).localization.tokenSources[token][0].raw = 'Different source text.';
            }
        }],
        ['labels refer to different parameter fields', graph => {
            for (const suffix of ['health_regen_rate', 'mana_regen_rate']) {
                const token = 'DOTA_Tooltip_ability_' + nativeFor(graph).abilityId + '_' + suffix;
                delete nativeFor(graph).localization.tokens[token];
                delete nativeFor(graph).localization.tokenSources[token];
            }
            addSnippet(graph, 'other_health_regen_rate', '%MAX HP REGEN:');
            addSnippet(graph, 'other_mana_regen_rate', '%MAX MANA REGEN:');
        }],
    ];
    for (const [name, mutate] of scenarios) {
        await t.test(name, () => {
            const graph = stationaryDefenseFixture();
            mutate(graph);
            const tags = tagsFor(graph);
            for (const tag of ['self_health_regen', 'self_mana_regen']) assert.ok(!tags.includes(tag), `${tag} incorrectly inferred from ${name}`);
            assert.ok(tags.includes('damage_reduction'), 'Other bound contributions remain available.');
        });
    }
});

test('a summoned creature regeneration label does not describe caster regeneration', () => {
    const graph = graphFixture({
        description: 'Summons two creatures to fight for the caster.',
        note: null,
        effects: false,
        raw: { AbilityValues: { summon_count: '2', summon_duration: '20', health_regen_rate: '1', mana_regen_rate: '1' } },
    });
    addSnippet(graph, 'health_regen_rate', '%MAX HP REGEN:');
    addSnippet(graph, 'mana_regen_rate', '%MAX MANA REGEN:');
    const tags = tagsFor(graph);
    assert.ok(tags.includes('summons'));
    for (const tag of ['self_health_regen', 'self_mana_regen']) assert.ok(!tags.includes(tag));
});

test('the base native cast range alone is not a cast range enhancement', () => {
    const graph = graphFixture({
        description: 'The caster places a mark on an enemy target.',
        note: null,
        effects: false,
        teams: ['enemy'],
        raw: { AbilityBehavior: 'DOTA_ABILITY_BEHAVIOR_UNIT_TARGET', AbilityUnitTargetTeam: 'DOTA_UNIT_TARGET_TEAM_ENEMY', AbilityCastRange: '500' },
    });
    addSnippet(graph, 'AbilityCastRange', 'CAST RANGE:');
    assert.ok(!tagsFor(graph).includes('cast_range'));
});

test('incoming damage returned to enemies is reflection without a fixed owner damage type', () => {
    for (const [description, values] of [
        ['The caster disperses part of the damage dealt to her, reflecting it to all nearby enemies.', { damage_reflect_pct: '20' }],
        ['Whenever an enemy deals spell damage to the caster, she returns %spell_reflect_pct%%% of the damage dealt.', { spell_reflect_pct: '20' }],
    ]) {
        const tags = tagsFor(graphFixture({
            description,
            note: null,
            effects: false,
            raw: { AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL', AbilityValues: values },
        }));
        assert.ok(tags.includes('damage_reflection'), `damage_reflection missing from ${JSON.stringify(tags)}`);
        for (const tag of ['spell_reflection', 'damage_negation', 'magical', 'physical', 'pure']) assert.ok(!tags.includes(tag));
    }
});

test('outgoing spell damage reflected back as a caster cost is not incoming damage reflection', () => {
    const tags = tagsFor(graphFixture({
        description: 'The caster gains %spell_lifesteal%%% spell lifesteal, but takes %spell_reflect_pct%%% of the spell damage dealt reflected back to herself.',
        note: null,
        effects: false,
        raw: { AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL', AbilityValues: { spell_lifesteal: '15', spell_reflect_pct: '20' } },
    }));
    assert.ok(tags.includes('spell_lifesteal'));
    for (const tag of ['lifesteal', 'self_lifesteal', 'damage_reflection', 'damage_negation', 'magical', 'physical', 'pure']) assert.ok(!tags.includes(tag));
});

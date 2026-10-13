import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { deriveAbilityTags } from '../src/tags/ability-tags.mjs';

const dataRoot = path.resolve('data');
const index = JSON.parse(fs.readFileSync(path.join(dataRoot, 'tags/index.json'), 'utf8'));
const validTags = new Set(index.tags.map(row => row.key));
const abilitiesByEngineId = new Map();
const nativeByHero = new Map();
const records = value => value == null ? [] : Array.isArray(value) ? value : [value];

for (const hero of fs.readdirSync(path.join(dataRoot, 'heroes'))) {
    const folder = path.join(dataRoot, 'heroes', hero);
    if (!fs.existsSync(path.join(folder, 'abilities.json'))) continue;
    const view = JSON.parse(fs.readFileSync(path.join(folder, 'abilities.json'), 'utf8'));
    const abilities = view.abilities ?? [
        ...records(view.innate), ...records(view.skills), ...records(view.talents), ...records(view.bonus_attributes),
    ];
    const guide = JSON.parse(fs.readFileSync(path.join(folder, 'guides/details.json'), 'utf8'));
    nativeByHero.set(hero, guide.native);
    for (const ability of abilities) abilitiesByEngineId.set(ability.engineId ?? ability.id, {
        hero, ability: { ...ability, engineId: ability.engineId ?? ability.id },
    });
}

const tagsFor = engineId => abilitiesByEngineId.get(engineId)?.ability.tags;

test('every ability has a sorted tag list from the separate vocabulary index', () => {
    assert.equal(index.tags.find(row => row.key === 'magical')?.label, 'Magical damage');
    assert.equal(index.tags.find(row => row.key === 'physical')?.label, 'Physical damage');
    assert.equal(index.tags.find(row => row.key === 'pure')?.label, 'Pure damage');
    for (const tag of index.tags) for (const category of tag.categories) {
        assert.ok(index.categories.find(row => row.key === category)?.tags.includes(tag.key), `${tag.key}: ${category}`);
    }

    for (const { ability } of abilitiesByEngineId.values()) {
        assert.ok(Array.isArray(ability.tags), ability.engineId);
        assert.deepEqual(ability.tags, [...new Set(ability.tags)].sort(), ability.engineId);
        for (const tag of ability.tags) assert.ok(validTags.has(tag), `${ability.engineId}: ${tag}`);
    }
});

test('modifier and passive contributions use their native field and recipient', () => {
    assert.deepEqual(tagsFor('dazzle_shallow_grave'), [
        'ally_healing_amplification', 'buff', 'death_prevention', 'healing_amplification',
    ]);
    assert.deepEqual(tagsFor('abaddon_withering_mist'), ['anti_heal']);
    assert.ok(tagsFor('antimage_mana_break').includes('mana_burn'));
    assert.ok(!tagsFor('antimage_mana_break').includes('damage_over_time'));
    assert.ok(tagsFor('batrider_smoldering_resin').includes('damage_over_time'));
    assert.ok(tagsFor('faceless_void_distortion_field').includes('projectile_slow'));
    assert.ok(tagsFor('lycan_howl').includes('armor_reduction'));
    assert.ok(tagsFor('lycan_howl').includes('outgoing_damage_reduction'));
    assert.ok(!tagsFor('lycan_howl').includes('fear'));
    assert.ok(tagsFor('antimage_counterspell').includes('spell_reflection'));
    assert.ok(!tagsFor('antimage_counterspell').includes('self_attack_damage'));
    assert.ok(!tagsFor('antimage_counterspell').includes('spell_amplification'));
});

test('Shadow Realm exposes its source-supported evasion and escape contribution', () => {
    const core = JSON.parse(fs.readFileSync(path.join(dataRoot, 'runtime/core.json'), 'utf8'));
    const hero = core.entities.heroes.find(row => row.key === 'dark_willow');
    const ability = core.entities.abilities.find(row => row.engineId === 'dark_willow_shadow_realm');
    const effects = core.entities.effects.filter(row => row.abilityId === ability.id);
    const guide = JSON.parse(fs.readFileSync(path.join(dataRoot, 'runtime/heroes/dark_willow/guide.json'), 'utf8'));
    const derived = deriveAbilityTags({
        metadata: { build: core.build },
        entities: { abilities: [ability], effects },
        sources: core.sources,
        guides: new Map([[hero.id, guide]]),
    }).abilities[0];

    assert.ok(derived.tags.includes('untargetable'));
    assert.ok(derived.tags.includes('disjoint'));
    assert.ok(derived.tags.includes('escape'));
    assert.ok(derived.tags.includes('magical'));
    const renamedAbility = { ...ability, id: 'ability:unseen', engineId: 'unseen_action' };
    const renamedGuide = structuredClone(guide);
    const native = renamedGuide.native.abilities.find(row => row.abilityId === ability.engineId);
    native.abilityId = renamedAbility.engineId;
    const renameToken = token => token.replace('DOTA_Tooltip_ability_' + ability.engineId + '_', 'DOTA_Tooltip_ability_' + renamedAbility.engineId + '_');
    native.localization.tokens = Object.fromEntries(Object.entries(native.localization.tokens).map(([key, value]) => [renameToken(key), value]));
    native.localization.tokenSources = Object.fromEntries(Object.entries(native.localization.tokenSources).map(([key, value]) => [renameToken(key), value]));
    native.localization.conflictingTokens = native.localization.conflictingTokens?.map(renameToken);
    renamedGuide.native.abilities = [native];
    const renamed = deriveAbilityTags({
        metadata: { build: core.build },
        entities: { abilities: [renamedAbility], effects: effects.map((effect, i) => ({ ...effect, id: 'effect:unseen:' + i, abilityId: renamedAbility.id, subtype: 'unclassified' })) },
        sources: core.sources,
        guides: new Map([[hero.id, renamedGuide]]),
    }).abilities[0];
    assert.deepEqual(renamed.tags, derived.tags);
    assert.deepEqual(tagsFor('dark_willow_shadow_realm'), [
        'buff', 'disjoint', 'escape', 'magical', 'self_attack_range', 'untargetable',
    ]);
    assert.ok(tagsFor('antimage_blink').includes('escape'));
});

test('damage types agree with native declarations and do not leak from summoned units', () => {
    const enigma = tagsFor('enigma_demonic_conversion');
    assert.ok(enigma.includes('summons'));
    assert.ok(!enigma.some(tag => ['magical', 'physical', 'pure'].includes(tag)));
    assert.ok(!enigma.includes('self_attack_damage'));
    assert.ok(!enigma.includes('self_attack_range'));
    assert.ok(!enigma.includes('self_heal'));
    assert.ok(!enigma.includes('escape'));

    for (const { hero, ability } of abilitiesByEngineId.values()) {
        const native = nativeByHero.get(hero)?.abilities?.find(row => row.abilityId === ability.engineId);
        for (const type of ['magical', 'physical', 'pure']) if (ability.tags.includes(type)) {
            assert.equal(native?.raw?.AbilityUnitDamageType ?? native?.nativeDeclarations?.fields?.AbilityUnitDamageType?.raw,
                'DAMAGE_TYPE_' + type.toUpperCase(), ability.engineId);
        }
    }
});

test('real game-file conditions, projectile susceptibility and nonlethal costs do not grant avoidance', () => {
    for (const tag of ['untargetable', 'damage_immunity', 'escape']) assert.ok(!tagsFor('dark_willow_pixie_dust').includes(tag));
    assert.ok(!tagsFor('puck_puckish').includes('disjoint'));
    assert.ok(!tagsFor('centaur_double_edge').includes('death_prevention'));
    assert.ok(!tagsFor('terrorblade_reflection').includes('escape'));
    assert.ok(!tagsFor('lycan_summon_wolves').includes('escape'));
});

test('Spiked Carapace reflects and negates qualifying damage without claiming fixed damage types or immunity', () => {
    const tags = tagsFor('nyx_assassin_spiked_carapace');
    for (const tag of ['damage_reflection', 'damage_negation', 'stun', 'disable']) assert.ok(tags.includes(tag), tag);
    for (const tag of ['spell_reflection', 'damage_immunity', 'magical', 'physical', 'pure']) assert.ok(!tags.includes(tag), tag);
});

test('Burrow exposes native defense, invisibility, range, cooldown and regeneration buffs', () => {
    const tags = tagsFor('nyx_assassin_burrow');
    for (const tag of ['buff', 'damage_reduction', 'invisibility', 'escape', 'cast_range', 'cooldown_reduction', 'self_health_regen', 'self_mana_regen']) {
        assert.ok(tags.includes(tag), tag);
    }
    for (const tag of ['self_armor', 'ally_armor', 'self_attack_range', 'mobility', 'self_reposition']) assert.ok(!tags.includes(tag), tag);
});

test('previously empty native stat and talent contributions retain their exact property', () => {
    assert.ok(tagsFor('dark_seer_quick_wit').includes('self_attack_speed'));
    assert.ok(!tagsFor('dark_seer_quick_wit').includes('attribute_bonus'));
    assert.ok(tagsFor('keeper_of_the_light_bright_speed').includes('self_movement_speed'));
    assert.ok(!tagsFor('keeper_of_the_light_bright_speed').includes('attribute_bonus'));
    assert.deepEqual(tagsFor('special_bonus_hp_regen_3'), ['buff', 'health_regen', 'self_health_regen']);
    assert.deepEqual(tagsFor('special_bonus_hp_200'), ['buff', 'self_max_health']);
    assert.deepEqual(tagsFor('special_bonus_unique_antimage'), ['buff', 'cooldown_reduction']);
    assert.ok(!tagsFor('dazzle_shallow_grave').includes('cooldown_reduction'));
    assert.ok(!tagsFor('dark_willow_shadow_realm').includes('cooldown_reduction'));
});

test('native scoped immunity, transformations and spell lifesteal do not gain broader properties', () => {
    assert.ok(tagsFor('omniknight_guardian_angel').includes('physical_damage_immunity'));
    for (const tag of ['damage_immunity', 'magical_damage_immunity', 'physical']) assert.ok(!tagsFor('omniknight_guardian_angel').includes(tag));
    for (const tag of ['self_armor', 'self_attack_damage']) assert.ok(tagsFor('lone_druid_true_form').includes(tag));
    assert.ok(!tagsFor('lone_druid_true_form').includes('summons'));
    assert.ok(tagsFor('queenofpain_succubus').includes('spell_lifesteal'));
    for (const tag of ['lifesteal', 'self_lifesteal']) assert.ok(!tagsFor('queenofpain_succubus').includes(tag));
});

test('a source-assigned creature callback retains its own contributions without granting hero survival', () => {
    const tags = tagsFor('visage_summon_familiars_stone_form');
    for (const tag of ['aoe', 'controlled_unit_damage_immunity', 'controlled_unit_health_regen', 'delayed_damage', 'disable', 'magical', 'stun']) {
        assert.ok(tags.includes(tag), tag);
    }
    for (const tag of ['escape', 'damage_immunity', 'self_heal', 'self_health_regen', 'bkb_pierce']) assert.ok(!tags.includes(tag), tag);
    assert.deepEqual(tagsFor('visage_stone_form_self_cast'), []);
});

test('broader native rules preserve supported reflection, control, allied boosts and creation', () => {
    assert.ok(tagsFor('antimage_counterspell_ally').includes('spell_reflection'));
    for (const tag of ['stun', 'disable']) assert.ok(tagsFor('puck_dream_coil').includes(tag), tag);
    for (const tag of ['ally_attack_range', 'vision']) assert.ok(tagsFor('drow_ranger_glacier').includes(tag), tag);
    for (const tag of ['ally_attack_damage', 'summons']) assert.ok(!tagsFor('drow_ranger_glacier').includes(tag), tag);
    assert.ok(!tagsFor('puck_dream_coil').includes('summons'));
    assert.ok(tagsFor('furion_force_of_nature').includes('summons'));
    assert.ok(tagsFor('winter_wyvern_winters_curse').includes('bkb_pierce'));
    assert.ok(tagsFor('shadow_shaman_urnaconda').includes('bkb_pierce'));
    assert.ok(tagsFor('brewmaster_liquid_courage').includes('status_resistance'));
    for (const tag of ['self_max_health', 'heal', 'self_heal', 'ally_heal']) assert.ok(!tagsFor('brewmaster_liquid_courage').includes(tag), tag);
    assert.ok(tagsFor('grimstroke_spirit_walk').includes('damage_over_time'));
    for (const tag of ['self_attack_damage', 'ally_attack_damage']) assert.ok(!tagsFor('mars_arena_of_blood').includes(tag), tag);
    assert.ok(!tagsFor('mars_arena_of_blood').includes('vision_denial'));
    assert.ok(tagsFor('wisp_spirits').includes('creep_damage'));
    for (const tag of ['self_movement_speed', 'ally_movement_speed']) assert.ok(tagsFor('abyssal_underlord_raid_boss').includes(tag), tag);
    for (const tag of ['stun', 'disable']) assert.ok(!tagsFor('spirit_breaker_bull_rush').includes(tag), tag);
    for (const tag of ['silence', 'disable']) assert.ok(!tagsFor('silencer_curse_of_the_silent').includes(tag), tag);
});

test('precise restoration survives regeneration guards and retains the actual beneficiary', () => {
    for (const tag of ['heal', 'self_heal']) assert.ok(tagsFor('pudge_dismember').includes(tag), tag);
    for (const tag of ['heal', 'self_heal', 'self_max_health']) assert.ok(tagsFor('clinkz_death_pact').includes(tag), tag);
    assert.ok(!tagsFor('clinkz_death_pact').includes('ally_heal'));
    for (const tag of ['heal', 'ally_heal', 'self_heal']) assert.ok(tagsFor('oracle_rain_of_destiny').includes(tag), tag);
    for (const tag of ['pure', 'bkb_pierce']) assert.ok(tagsFor('meepo_ransack').includes(tag), tag);
    for (const tag of ['lifesteal', 'self_lifesteal', 'self_heal', 'ally_heal']) assert.ok(!tagsFor('meepo_ransack').includes(tag), tag);
    for (const id of ['slardar_seaborn_sentinel', 'meepo_geomancy']) {
        for (const tag of ['health_regen', 'self_health_regen']) assert.ok(tagsFor(id).includes(tag), id + ': ' + tag);
        for (const tag of ['heal', 'self_heal']) assert.ok(!tagsFor(id).includes(tag), id + ': ' + tag);
    }
});

test('attack and controlled-unit contributions remain source scoped in compact views', () => {
    assert.deepEqual(tagsFor('enchantress_impetus'), ['attack_modifier', 'damage_over_distance', 'pure']);
    assert.deepEqual(tagsFor('enchantress_rabblerouser'), ['aura', 'buff', 'controlled_unit_damage']);
});

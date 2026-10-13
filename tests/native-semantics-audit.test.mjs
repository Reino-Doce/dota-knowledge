import assert from 'node:assert/strict';
import test from 'node:test';
import { inferNativeTags } from '../src/tags/native-semantics.mjs';

function infer(description, raw = {}, extra = {}) {
    return inferNativeTags({ fields: new Map(Object.entries(raw)), snippets: [{ text: description }],
        behavior: new Set(['DOTA_ABILITY_BEHAVIOR_NO_TARGET']), nativeTeams: ['self'], ...extra });
}

test('negative copular immunity does not become a positive defense', () => {
    const tags = infer('The caster is not immune to magical damage.', { duration: '3' });
    assert.ok(!tags.has('magical_damage_immunity'));
    assert.ok(!tags.has('damage_immunity'));
});

test('additive attack bonuses do not become all-damage amplification', () => {
    const tags = infer('The caster gains %bonus_attack_damage% bonus attack damage.', { bonus_attack_damage: '50' });
    assert.ok(tags.has('self_attack_damage'));
    assert.ok(!tags.has('outgoing_damage_amplification'));
});

test('generic additional damage does not become attack damage', () => {
    for (const fields of [{ spell_damage: '100' }, { damage_per_second: '20' }, { damage: '20' }]) {
        const tags = infer('The caster gains additional damage.', fields);
        assert.ok(!tags.has('self_attack_damage'), JSON.stringify(fields));
    }
    const rangedAttack = infer('Her next attack has bonus attack range and deals bonus magic damage.', {
        attack_range_bonus: '600', damage: '120', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL',
    });
    assert.ok(!rangedAttack.has('self_attack_damage'));
});

test('forfeiting an existing bonus is not granting that bonus', () => {
    const tags = infer('The bonus damage is lost when the attack misses.', { bonus_damage: '50' });
    assert.ok(!tags.has('self_attack_damage'));
    assert.ok(!tags.has('outgoing_damage_amplification'));
});

test('numeric decoder metadata cannot activate zero stat payloads', () => {
    const tags = infer('The caster gains bonus attack damage and armor.', {
        bonus_attack_damage: { value: '0', display_type: 1, RequiresShard: 1 },
        armor: { value: '0', levelup_interval: '1', CalculateSpellDamageTooltip: '1' },
    });
    assert.ok(!tags.has('self_attack_damage'));
    assert.ok(!tags.has('self_armor'));
    assert.ok(!tags.has('buff'));
});

test('nested shard operands do not activate a zero base stat payload', () => {
    const tags = infer('The caster gains bonus attack damage.', { bonus_attack_damage: { value: '0', special_bonus_shard: '+20' } });
    assert.ok(!tags.has('self_attack_damage'));
    const ownValue = infer('The caster gains bonus attack damage.', { bonus_attack_damage: { value: '20', special_bonus_shard: '+20' } });
    assert.ok(ownValue.has('self_attack_damage'));
});

test('input attributes and inherited cast-range metadata are not attribute bonuses', () => {
    const tags = infer('The caster gains %int_to_atkspd% Attack Speed from each point of Intelligence.', {
        int_to_atkspd: '1', AbilityCastRangeBuffer: '250', ItemPermanent: '1',
    });
    assert.ok(tags.has('self_attack_speed'));
    assert.ok(!tags.has('attribute_bonus'));
});

test('ordinary damage waves and transformation prose do not create combat units', () => {
    const wave = infer('Summons a gush of water to damage an enemy unit.', { damage: '100', duration: '4' });
    assert.ok(!wave.has('summons'));
    const form = infer('The caster morphs himself into a bear, gaining bonus armor and bonus attack damage.', {
        bonus_hp: '500', bonus_armor: '10', bonus_attack_damage: '50', duration: '25',
    });
    assert.ok(!form.has('summons'));
    assert.ok(form.has('self_armor'));
    assert.ok(form.has('self_attack_damage'));
});

test('ordering an existing unit does not transfer its defense to the caster', () => {
    const tags = infer('Orders the companion closest to the caster to cast its ability. The companion becomes invulnerable.', { duration: '3' });
    for (const tag of ['damage_immunity', 'escape', 'summons']) assert.ok(!tags.has(tag));
    const ally = infer('Orders an allied hero to cast. That ally becomes invulnerable.', { duration: '3' });
    assert.ok(ally.has('damage_immunity'));
});

test('spell lifesteal variants do not become attack lifesteal', () => {
    for (const text of ['The caster gains spell lifesteal.', 'The caster gains spell-lifesteal.', 'The caster gains lifesteal from spells.']) {
        const tags = infer(text, { spell_lifesteal: '20' });
        assert.ok(tags.has('spell_lifesteal'), text);
        for (const tag of ['lifesteal', 'self_lifesteal']) assert.ok(!tags.has(tag), text);
    }
});

test('allied health regeneration is distinct from direct healing', () => {
    const tags = infer('The caster grants allies health regeneration.', { hp_regen: '25' }, { nativeTeams: ['ally'] });
    assert.ok(tags.has('ally_health_regen'));
    assert.ok(!tags.has('ally_heal'));
    assert.ok(!tags.has('heal'));
});

test('spatial and possessive allied grants retain their actual beneficiary', () => {
    for (const text of ['Grants allies around the caster 20 armor.', 'Grants your allies 20 armor.']) {
        const tags = infer(text, { bonus_armor: '20' });
        assert.ok(tags.has('ally_armor'), text);
        assert.ok(!tags.has('self_armor'), text);
    }
    const regeneration = infer('Provides their allies health regeneration.', { hp_regen: '25' });
    assert.ok(regeneration.has('ally_health_regen'));
    assert.ok(regeneration.has('health_regen'));
    assert.ok(!regeneration.has('self_health_regen'));
    const healing = infer('Heals allies near him.', { heal: '100' });
    assert.ok(healing.has('ally_heal'));
    assert.ok(!healing.has('self_heal'));
});

test('resistance names do not negate independent speed bonuses', () => {
    const tags = infer('The caster gains increased attack speed and slow resistance.', { attack_speed: '60', slow_resistance: '50' });
    assert.ok(tags.has('self_attack_speed'));
    assert.ok(tags.has('slow_resistance'));
});

test('comma separated stat grants retain their positive operation and recipient', () => {
    const tags = infer('The caster gains energy, gaining debuff immunity, %magic_resistance%%% magic resistance.', { duration: '3', magic_resistance: '60' });
    assert.ok(tags.has('debuff_immunity'));
    assert.ok(tags.has('magic_resistance'));
});

test('source-embedded literal stat amounts are independent grants', () => {
    const tags = infer('Grants the caster and allied heroes three charges. Provides 40 Attack Speed.', { charges: '3', duration: '12' });
    assert.ok(tags.has('self_attack_speed'));
    assert.ok(tags.has('ally_attack_speed'));
});

test('a genuine permanent consequent survives its preceding temporary trigger', () => {
    const tags = infer('Additionally every time the caster gains a charge he also gains %perma_mp_per_kill% Mana Regen permanently.', { perma_mp_per_kill: '0.1' });
    assert.ok(tags.has('self_mana_regen'));
    assert.ok(tags.has('earned_permanent_growth'));
});

test('named ability damage increases retain their local scope', () => {
    const tags = infer('Causes Example Ward to deal %shard_bonus_damage_pct%%% more damage.', { shard_bonus_damage_pct: '30' }, { abilityLabel: 'Example Ward' });
    assert.ok(tags.has('ability_damage_bonus'));
    assert.ok(!tags.has('outgoing_damage_amplification'));
});

test('a generic modifier does not establish building attack delivery', () => {
    const tags = infer('The caster deals more damage to buildings.', { bonus_building_damage: '20' }, {
        effects: [{ type: 'modifier', targets: { teams: { state: 'known', value: ['self'] } } }],
    });
    assert.ok(tags.has('building_damage'));
    assert.ok(!tags.has('building_attack_amplification'));
    assert.ok(!tags.has('outgoing_damage_amplification'));
});

test('an independently proved attack delivery retains building attack amplification', () => {
    const tags = infer('The caster deals more damage to buildings.', { bonus_building_damage: '20' }, {
        effects: [{ type: 'modifier', delivery: { kind: { state: 'known', value: 'attack' } } }],
    });
    assert.ok(tags.has('building_attack_amplification'));
});

test('an explicitly applied own control keeps the proved enemy recipient', () => {
    const tags = infer('The caster rolls away, applying a stun if enemies are in the way.', { stun_duration: '1' }, {
        effects: [{ type: 'control', targets: { teams: { state: 'known', value: ['enemy'] } } }],
    });
    assert.ok(tags.has('stun'));
    assert.ok(tags.has('disable'));
});

test('a reduction magnitude cannot establish a bonus attack claim', () => {
    const tags = infer('The caster deals more damage with his double attacks.', { attack_damage_reduction: '51' });
    assert.ok(!tags.has('self_attack_damage'));
    assert.ok(!tags.has('outgoing_damage_amplification'));
});

test('an output-local referenced amount establishes spell amplification', () => {
    const tags = infer('The caster receives %arbitrary_ratio%%% spell amplification per destroyed tower.', { arbitrary_ratio: '1.5' });
    assert.ok(tags.has('spell_amplification'));
    const disabled = infer('The caster receives %arbitrary_ratio%%% spell amplification per destroyed tower.', { arbitrary_ratio: '0', duration: '10' });
    assert.ok(!disabled.has('spell_amplification'));
});

test('owned movement speed floors are beneficial bounds, not enemy slows', () => {
    const tags = infer('The caster movement speed cannot be lower than %min_movespeed% and can reach %max_movespeed%.', { min_movespeed: '240', max_movespeed: '600' }, { nativeTeams: ['self', 'ally'] });
    assert.ok(tags.has('self_movement_speed'));
    assert.ok(!tags.has('ally_movement_speed'));
    assert.ok(!tags.has('slow'));
    const zero = infer('The caster movement speed cannot be lower than %min_movespeed% and can reach %max_movespeed%.', { min_movespeed: '0', max_movespeed: '600' });
    assert.ok(!zero.has('self_movement_speed'));
});

test('a plain copular hidden pronoun retains the caster beneficiary', () => {
    const tags = infer('Turns the caster into a turret briefly with reduced attack speed. He is hidden during this time.', { duration: '2.5', attack_speed_reduction: '45' });
    assert.ok(tags.has('concealment'));
    assert.ok(tags.has('escape'));
    assert.ok(!tags.has('self_attack_speed'));
});

test('riding a created vehicle is owning mobility, not a combat summon', () => {
    const tags = infer('<h1>Use: Mount Up</h1>Summons a speedy vehicle to ride around on for %mount_duration% seconds. Taking damage from enemies greater than %damage_threshold% dismounts the rider.', { mount_duration: '10', max_speed: '750', acceleration: '350', damage_threshold: '20', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' });
    assert.ok(tags.has('mobility'));
    assert.ok(tags.has('escape'));
    assert.ok(!tags.has('summons'));
    assert.ok(!tags.has('magical'));
    const controlled = infer('The summoned creatures summon a vehicle to ride around on.', { mount_duration: '10', max_speed: '750' });
    assert.ok(!controlled.has('mobility'));
});

test('passive dealt damage and a rooted object remain owning hostile actions', () => {
    const explosion = infer('Shortly after dying, a burst of magic damage is dealt to all enemies in a small area.', { explosion_damage: '100', explosion_delay: '0.3', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' });
    assert.ok(explosion.has('magical'));
    assert.ok(explosion.has('delayed_damage'));
    const dive = infer('Flies towards the target enemy, dealing damage and rooting it.', { damage: '100', root_duration: '2', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' }, { nativeTeams: ['enemy'] });
    for (const tag of ['magical', 'root', 'disable']) assert.ok(dive.has(tag), tag);
    assert.ok(!dive.has('mobility'));
});

test('an owning damaging wave can use an independently proved hostile recipient', () => {
    const tags = infer('The caster and all of her images hit nearby units with a damaging wave of water that caps their max movement speed.', { damage: '80 140 200 260', max_movement_speed: '230', duration: '3', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' }, { effects: [{ type: 'modifier', targets: { teams: { state: 'known', value: ['enemy'] } } }] });
    assert.ok(tags.has('magical'));
    assert.ok(tags.has('slow'));
    const unqualified = infer('The caster hits nearby units with a damaging wave that caps their max movement speed.', { damage: '80', max_movement_speed: '230', duration: '3', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' });
    assert.ok(unqualified.has('magical'));
    assert.ok(!unqualified.has('slow'));
});

test('shared damage and debuff-duration amplification retain both contributions', () => {
    const tags = infer('The caster has bonus damage and debuff duration amp against enemy heroes behind him.', { amp_pct: '4.5', AbilityUnitDamageType: 'DAMAGE_TYPE_PHYSICAL' });
    assert.ok(tags.has('outgoing_damage_amplification'));
    assert.ok(tags.has('duration_extension'));
    assert.ok(!tags.has('physical'));
});

test('attacks and abilities can establish owner-wide damage amplification', () => {
    const tags = infer('Attacks and abilities deal more damage.', { damage_amp: '15' });
    assert.ok(tags.has('outgoing_damage_amplification'));
});

test('own attack spill is typed damage and scales from the attack', () => {
    const tags = infer('The caster blades slice through the attacked unit, splitting and damaging enemy units directly behind it.', { attack_spill_pct: '70', AbilityUnitDamageType: 'DAMAGE_TYPE_PURE' });
    assert.ok(tags.has('pure'));
    assert.ok(tags.has('attack_damage_scaling'));
    assert.ok(!tags.has('detection'));
});

test('a source-backed enemy-health impact formula has no invented damage type', () => {
    const tags = infer('Enemies killed with the caster abilities are sent flying, dealing damage to enemies they hit.', { projectile_body_damage: '27', projectile_body_damage_additional_percent_health: '7' }, { fieldLabels: [{ field: 'projectile_body_damage_additional_percent_health', text: '%FLYING ENEMY MAX HEALTH AS DAMAGE:' }] });
    assert.ok(tags.has('immediate_damage'));
    assert.ok(tags.has('target_health_scaling'));
    for (const tag of ['magical', 'physical', 'pure']) assert.ok(!tags.has(tag));
});

test('a proportional maximum-pool parameter establishes capacity, not restoration', () => {
    const text = 'Example Actor gains an additional %bonus_max_mana_per_int% mana per point of Intelligence.';
    const tags = infer(text, { bonus_max_mana_per_int: { value: '2.5' } }, { actorNames: ['Example Actor'] });
    assert.ok(tags.has('self_max_mana'));
    assert.ok(!tags.has('self_mana_restore'));
    assert.ok(!tags.has('attribute_bonus'));
    const zero = infer(text, { bonus_max_mana_per_int: { value: '0', display_type: '1' }, duration: '10' }, { actorNames: ['Example Actor'] });
    assert.ok(!zero.has('self_max_mana'));
    const input = infer('The caster restores mana based on his maximum mana.', { max_mana: '500', mana_restore: '20' });
    assert.ok(!input.has('self_max_mana'));
    const controlled = infer('The summoned creatures gain additional %bonus_max_mana_per_int% mana per point of Intelligence.', { bonus_max_mana_per_int: '2.5' });
    assert.ok(!controlled.has('self_max_mana'));
});

test('a planted explosive has its own delayed damage without caster concealment', () => {
    const tags = infer('Plant an invisible explosive that will only detonate after a brief delay when triggered. Does not damage buildings.', { damage: { value: '300 450 600' }, detonate_delay: { value: '0.25' }, radius: '425', duration: '600', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' }, { behavior: new Set(['DOTA_ABILITY_BEHAVIOR_POINT']), nativeTeams: [] });
    for (const tag of ['trap', 'delayed_damage', 'magical']) assert.ok(tags.has(tag), tag);
    for (const tag of ['invisibility', 'concealment', 'escape', 'building_damage', 'summons']) assert.ok(!tags.has(tag), tag);
    const zero = infer('Plants an explosive that detonates after a delay.', { damage: { value: '0', display_type: '1' }, detonate_delay: '0.25', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' });
    assert.ok(!zero.has('magical'));
});

test('an owned lifetime label corroborates active creature spawning without a species match', () => {
    const text = 'Applies debuff on attack. If the debuffed unit dies, a larva will spawn.';
    const tags = infer(text, { unrelated_unit_duration: '40', buff_duration: '2' }, { fieldLabels: [{ field: 'unrelated_unit_duration', text: 'LIFETIME:' }] });
    assert.ok(tags.has('summons'));
    const zero = infer(text, { unrelated_unit_duration: { value: '0', levelup_interval: '1' }, buff_duration: '2' }, { fieldLabels: [{ field: 'unrelated_unit_duration', text: 'LIFETIME:' }] });
    assert.ok(!zero.has('summons'));
    const unbound = infer(text, { buff_duration: '2' }, { fieldLabels: [{ field: 'unrelated_unit_duration', text: 'LIFETIME:' }] });
    assert.ok(!unbound.has('summons'));
});

test('a literal count and living actor actions prove qualitative creature creation', () => {
    const tags = infer('Creates a companion based on the caster stance. The companion takes damage from enemies. If the companion dies, the ability goes on cooldown. Only one companion can exist at a time.', { cooldown_on_death: '70', cooldown_on_take_damage: '3' });
    assert.ok(tags.has('summons'));
    for (const noun of ['wall', 'projectile', 'barrier']) {
        const terrain = infer(`Creates a ${noun}. Only one ${noun} can exist at a time. The ${noun} takes damage.`, { count: '1', duration: '40' }, { fieldLabels: [{ field: 'duration', text: 'LIFETIME:' }] });
        assert.ok(!terrain.has('summons'), noun);
    }
});

test('healing converted to mana establishes conversion without recipient restoration', () => {
    const tags = infer('The caster heals also restore mana.', { restore_pct: '24' }, { fieldLabels: [{ field: 'restore_pct', text: '%HEALING CONVERTED TO MANA:' }] });
    assert.ok(tags.has('resource_conversion'));
    for (const tag of ['heal', 'self_heal', 'ally_heal', 'self_mana_restore', 'ally_mana_restore']) assert.ok(!tags.has(tag), tag);
    const zero = infer('The caster heals also restore mana.', { restore_pct: { value: '0', display_type: '1' }, duration: '5' }, { fieldLabels: [{ field: 'restore_pct', text: '%HEALING CONVERTED TO MANA:' }] });
    assert.ok(!zero.has('resource_conversion'));
});

test('a protected illusion damage floor is controlled damage, not caster offense', () => {
    const text = 'Whenever an illusion of the caster is created, its outgoing damage cannot go below a fixed value for %duration% seconds.';
    const tags = infer(text, { outgoing_floor: '17', duration: '3', AbilityUnitDamageType: 'DAMAGE_TYPE_PHYSICAL' }, { fieldLabels: [{ field: 'outgoing_floor', text: '%MIN DAMAGE:' }] });
    assert.ok(tags.has('buff'));
    assert.ok(tags.has('controlled_unit_damage'));
    for (const tag of ['self_attack_damage', 'outgoing_damage_amplification', 'physical', 'illusions', 'summons']) assert.ok(!tags.has(tag), tag);
    const zero = infer(text, { outgoing_floor: { value: '0', display_type: '1' }, duration: '3' }, { fieldLabels: [{ field: 'outgoing_floor', text: '%MIN DAMAGE:' }] });
    assert.ok(!zero.has('controlled_unit_damage'));
    const susceptible = infer('The illusion outgoing damage can fall below its normal value.', { outgoing_floor: '17', duration: '3' });
    assert.ok(!susceptible.has('controlled_unit_damage'));
});

test('an explicit mana-damage formula preserves offensive damage type', () => {
    const missing = infer('For each point of mana missing by the target unit, damage is dealt to it and surrounding enemies.', { arbitrary_damage_per_mana: '1', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' }, { nativeTeams: ['enemy'] });
    assert.ok(missing.has('magical'));
    const burned = infer('Deals damage for each point of mana drained.', { damage_per_mana_pct: '60', mana_burned: '100', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' });
    assert.ok(burned.has('magical'));
    const restore = infer('The caster regenerates mana based on each point of missing mana.', { mana_regen: '10', arbitrary_damage_per_mana: '1', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' });
    assert.ok(!restore.has('magical'));
});

test('an explicit absorption-to-damage formula establishes its outgoing burst', () => {
    const tags = infer('Creates a barrier that absorbs damage. When the barrier is destroyed it will burst and deal damage equal to the amount it could absorb to an area around it.', { damage_absorb: '120', duration: '12', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' }, { nativeTeams: ['self', 'ally'] });
    assert.ok(tags.has('magical'));
    assert.ok(!tags.has('summons'));
    const passive = infer('%absorb_to_damage%%% of absorbed damage is dealt to nearby enemies.', { damage_absorb: '120', absorb_to_damage: '75', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' });
    assert.ok(passive.has('magical'));
    const absorption = infer('Creates a barrier that absorbs incoming damage.', { damage_absorb: '120', duration: '12', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' });
    assert.ok(!absorption.has('magical'));
    const zero = infer('When the barrier is destroyed it deals damage equal to the amount it could absorb.', { damage_absorb: { value: '0', display_type: '1' }, duration: '12', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' });
    assert.ok(!zero.has('magical'));
});

test('a protective construction does not erase allied spell reflection', () => {
    const tags = infer('May be activated to create a protective shell around an allied hero that blocks and reflects any targeted spells. An illusion of the caster will be created next to the enemy.', { does_reflect: '1', duration: '1.2', duration_illusion: '4' }, { nativeTeams: ['self', 'ally'] });
    assert.ok(tags.has('spell_reflection'));
    assert.ok(!tags.has('summons'));
});

test('a terrain construction preserves distinct owner and allied grants', () => {
    const tags = infer('Orchard creates a hill beneath her, knocking away nearby enemies. Units on the hill gain flying vision and Orchard and her ranged allies gain bonus attack range. Orchard gains additional damage while on the hill.', { shard_count: '5', shard_duration: '8', attack_range_bonus: '200', damage_bonus: '25', radius: '150', knockback_distance: '225' }, { actorNames: ['Orchard Sage'], nativeTeams: ['enemy'] });
    assert.ok(tags.has('ally_attack_range'));
    assert.ok(tags.has('vision'));
    assert.ok(!tags.has('self_attack_damage'));
    assert.ok(!tags.has('ally_attack_damage'));
    assert.ok(!tags.has('summons'));
});

test('a volatile tether is hostile control rather than a summoned creature', () => {
    const tags = infer('Creates a coil of volatile magic that latches onto enemy heroes, damaging them. If the enemy stretches the coil, it snaps, stunning and dealing additional damage.', { coil_duration: '5', stun_duration: '0.5', coil_stun_duration: '1.5', coil_initial_damage: '175' }, { nativeTeams: ['enemy'], behavior: new Set(['DOTA_ABILITY_BEHAVIOR_POINT']) });
    assert.ok(tags.has('stun'));
    assert.ok(tags.has('disable'));
    assert.ok(!tags.has('summons'));
});

test('converting terrain into commanded creatures establishes creation', () => {
    const tags = infer('Converts an area of trees into guardians under the command of the caster.', { max_guardians: '2 3 4 5', guardian_duration: '50', guardian_health: '450' }, { behavior: new Set(['DOTA_ABILITY_BEHAVIOR_POINT']), nativeTeams: [] });
    assert.ok(tags.has('summons'));
    assert.ok(!tags.has('creep_conversion'));
    assert.ok(!tags.has('self_max_health'));
});

test('an independently proved hostile control retains native immunity piercing', () => {
    const tags = infer('Freezes an enemy in place. Will only pierce the spell immunity of the primary target.', { duration: '2', SpellImmunityType: 'SPELL_IMMUNITY_ENEMIES_YES' }, { nativeTeams: ['enemy'], effects: [{ type: 'control', targets: { teams: { state: 'known', value: ['enemy'] } } }] });
    assert.ok(tags.has('bkb_pierce'));
    const modifier = infer('Provides a friendly buff.', { duration: '2', SpellImmunityType: 'SPELL_IMMUNITY_ENEMIES_YES' }, { effects: [{ type: 'modifier', targets: { teams: { state: 'known', value: ['enemy'] } } }] });
    assert.ok(!modifier.has('bkb_pierce'));
});

test('nested shard operands do not activate zero base regen or turn it into capacity', () => {
    const tags = infer('When the caster drops below 50 Health he gains a Status Resistance buff.', { status_resist: '10' });
    assert.ok(tags.has('status_resistance'));
    const regen = infer('Grants %max_hp_regen%%% Max HP Regen per second.', { max_hp_regen: { value: '0', special_bonus_shard: '+3' }, min_health_threshold: '50', max_health_threshold: '20' }, { effects: [{ type: 'heal', targets: { teams: { state: 'known', value: ['self', 'ally'] } } }] });
    assert.ok(!regen.has('self_health_regen'));
    assert.ok(!regen.has('self_max_health'));
    for (const tag of ['heal', 'self_heal', 'ally_heal']) assert.ok(!regen.has(tag), tag);
});

test('passively damaged enemies preserve periodic delivery', () => {
    const tags = infer('Enemies in range of the allied unit are damaged with tendrils over time.', { damage_per_tick: '6', tick_rate: '0.2', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' }, { nativeTeams: ['self', 'ally'] });
    assert.ok(tags.has('damage_over_time'));
    assert.ok(tags.has('magical'));
});

test('a direct impact remains separate from later unit creation', () => {
    const tags = infer('Throw a jar, damaging all enemies and creating a massive guardian that has additional health for %guardian_duration% seconds.', { impact_damage: '275', guardian_duration: '15', SpellImmunityType: 'SPELL_IMMUNITY_ENEMIES_YES' }, { nativeTeams: ['enemy'], behavior: new Set(['DOTA_ABILITY_BEHAVIOR_POINT']) });
    assert.ok(tags.has('bkb_pierce'));
});

test('coordinated attack buffs retain all friendly beneficiaries', () => {
    const tags = infer('If an enemy is killed, the caster and all of his allies inside the arena restore health and get a %arena_kill_buff_damage_pct%%% attack damage buff.', { arena_kill_buff_damage_pct: { value: '15', special_bonus_scepter: '+35' }, arena_kill_buff_duration: '20', allied_reduction_pct: '100' }, { nativeTeams: ['enemy'] });
    assert.ok(tags.has('self_attack_damage'));
    assert.ok(tags.has('ally_attack_damage'));
});

test('creep contact damage is not a controlled actor benefit', () => {
    const tags = infer('Summon five particle spirits that dance in a circle. Creeps take minor damage from touching a particle spirit.', { creep_damage: '12', hero_damage: '30', spirit_amount: '5', spirit_duration: '15', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' }, { effects: [{ type: 'damage', targets: { teams: { state: 'known', value: ['enemy'] } } }] });
    assert.ok(tags.has('creep_damage'));
    assert.ok(!tags.has('summons'));
});

test('a friendly teleport consequent preserves proved shared speed recipients', () => {
    const tags = infer('After an allied hero teleports, they temporarily gain Damage Reduction and Movement Speed.', { bonus_ms: '9.5', damage_reduction: '3.7', buff_duration: '5' }, { behavior: new Set(['DOTA_ABILITY_BEHAVIOR_PASSIVE']), nativeTeams: [], effects: [{ type: 'save', targets: { teams: { state: 'known', value: ['self', 'ally'] } } }] });
    assert.ok(tags.has('self_movement_speed'));
    assert.ok(tags.has('ally_movement_speed'));
});

test('a disabled vision property cannot borrow another active radius', () => {
    const tags = infer('The area obscures vision from enemies.', { obscure_vision: { value: '0', display_type: '1' }, radius: '550', duration: '5.5' }, { nativeTeams: ['enemy'] });
    assert.ok(!tags.has('vision_denial'));
});

test('damage-linked restoration retains the proved caster recipient', () => {
    const tags = infer('The caster deals damage over time to an enemy. Damage is increased by the caster Strength and heals him for the total amount.', { pulse_damage: '80', strength_damage: '0.3', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' }, { nativeTeams: ['enemy'], fieldLabels: [{ field: 'pulse_damage', text: 'DAMAGE PER SECOND:' }], effects: [{ type: 'heal', targets: { teams: { state: 'known', value: ['self'] } } }] });
    for (const tag of ['heal', 'self_heal']) assert.ok(tags.has(tag), tag);
    assert.ok(!tags.has('ally_heal'));
    const zero = infer('Damage heals him for the total amount.', { pulse_damage: { value: '0', display_type: '1' } }, { effects: [{ type: 'heal', targets: { teams: { state: 'known', value: ['self'] } } }] });
    assert.ok(!zero.has('heal'));
});

test('consumption targets are distinct from owning restoration and capacity', () => {
    const tags = infer('The caster consumes the target enemy creep or friendly archer, healing and gaining max health. Increases the caster current and max HP.', { health_gain: '175' }, { nativeTeams: [], fieldLabels: [{ field: 'health_gain', text: 'BONUS HEALTH:' }], effects: [{ type: 'heal', targets: { teams: { state: 'known', value: ['self'] } } }] });
    for (const tag of ['heal', 'self_heal', 'self_max_health']) assert.ok(tags.has(tag), tag);
    assert.ok(!tags.has('ally_heal'));
});

test('a shared damage and healing amount establishes area restoration', () => {
    const tags = infer('Enemies in the area receive damage. Allies in the area heal and have increased incoming Heal Amplification.', { damage: '30', tick_rate: '1', heal_amp: '15' }, { behavior: new Set(['DOTA_ABILITY_BEHAVIOR_POINT']), nativeTeams: [], fieldLabels: [{ field: 'damage', text: 'DAMAGE/HEAL PER SECOND:' }], effects: [{ type: 'heal', values: { magnitude: { state: 'known', value: 30 } }, targets: { teams: { state: 'known', value: ['self', 'ally'] } } }] });
    for (const tag of ['heal', 'self_heal', 'ally_heal']) assert.ok(tags.has(tag), tag);
    const zero = infer('Allies in the area heal.', { damage: { value: '0', display_type: '1' }, heal_amp: '15' }, { fieldLabels: [{ field: 'damage', text: 'DAMAGE/HEAL PER SECOND:' }], effects: [{ type: 'heal', values: { magnitude: { state: 'known', value: 30 } }, targets: { teams: { state: 'known', value: ['self', 'ally'] } } }] });
    assert.ok(!zero.has('heal'));
});

test('flat hostile health transfer is damage and preserves copy-only healing', () => {
    const tags = infer('Steals health from the enemy with each strike and heals all other Junipers for that amount.', { health_steal_heroes: '7', AbilityUnitDamageType: 'DAMAGE_TYPE_PURE', SpellImmunityType: 'SPELL_IMMUNITY_ENEMIES_YES' }, { actorNames: ['Juniper'], fieldLabels: [{ field: 'health_steal_heroes', text: 'HEALTH STEAL (HEROES):' }], effects: [{ type: 'damage', targets: { teams: { state: 'known', value: ['enemy'] } } }, { type: 'heal', targets: { teams: { state: 'known', value: ['self', 'ally'] } } }] });
    for (const tag of ['pure', 'bkb_pierce']) assert.ok(tags.has(tag), tag);
    for (const tag of ['self_heal', 'ally_heal', 'lifesteal', 'self_lifesteal']) assert.ok(!tags.has(tag), tag);
    const zero = infer('Steals health from the enemy with each strike.', { health_steal_heroes: { value: '0', display_type: '1' }, AbilityUnitDamageType: 'DAMAGE_TYPE_PURE' }, { fieldLabels: [{ field: 'health_steal_heroes', text: 'HEALTH STEAL (HEROES):' }] });
    assert.ok(!zero.has('pure'));
});

test('an opaque owned HP-regen label corroborates a regeneration grant', () => {
    const tags = infer('The caster gains health regeneration while in a puddle.', { puddle_regen: '1.75' }, { fieldLabels: [{ field: 'puddle_regen', text: 'HP REGEN:' }], effects: [{ type: 'heal', targets: { teams: { state: 'known', value: ['self'] } } }] });
    for (const tag of ['health_regen', 'self_health_regen']) assert.ok(tags.has(tag), tag);
    assert.ok(!tags.has('heal'));
});

test('an output-local quantified opaque regeneration amount remains regeneration', () => {
    const tags = infer('If there is a tree nearby, he receives %tree_regen% HP regen.', { tree_regen: '1' });
    for (const tag of ['health_regen', 'self_health_regen']) assert.ok(tags.has(tag), tag);
    assert.ok(!tags.has('heal'));
});

test('a native basic-attack enchantment exposes its payload and distance formula', () => {
    const tags = infer('Places an enchantment on each attack while activated, causing it to deal additional damage based on how far away the target is. The farther the target, the greater the damage dealt.', { distance_damage_pct: { value: '5 10 15 20' }, distance_cap: '1750', AbilityUnitDamageType: 'DAMAGE_TYPE_PURE' }, { behavior: new Set(['DOTA_ABILITY_BEHAVIOR_UNIT_TARGET', 'DOTA_ABILITY_BEHAVIOR_AUTOCAST', 'DOTA_ABILITY_BEHAVIOR_ATTACK']), nativeTeams: ['enemy'] });
    for (const tag of ['attack_modifier', 'damage_over_distance', 'pure']) assert.ok(tags.has(tag), tag);
    assert.ok(!tags.has('attack_damage_scaling'));
});

test('autocast and attack flags do not alone establish attack modification', () => {
    const fields = { damage: '100', AbilityUnitDamageType: 'DAMAGE_TYPE_PURE' };
    const autocast = infer('Deals damage to an enemy.', fields, { behavior: new Set(['DOTA_ABILITY_BEHAVIOR_AUTOCAST']), nativeTeams: ['enemy'] });
    assert.ok(!autocast.has('attack_modifier'));
    const flagged = infer('Deals damage to an enemy.', fields, { behavior: new Set(['DOTA_ABILITY_BEHAVIOR_ATTACK']), nativeTeams: ['enemy'] });
    assert.ok(!flagged.has('attack_modifier'));
});

test('a zero distance coefficient cannot borrow numeric display or range metadata', () => {
    const tags = infer('Enchants each attack to deal additional damage based on distance to the target.', { distance_damage_pct: { value: '0', display_type: '1' }, distance_cap: '1750', AbilityCastRange: '575', AbilityUnitDamageType: 'DAMAGE_TYPE_PURE' }, { behavior: new Set(['DOTA_ABILITY_BEHAVIOR_ATTACK', 'DOTA_ABILITY_BEHAVIOR_AUTOCAST']), nativeTeams: ['enemy'] });
    for (const tag of ['attack_modifier', 'damage_over_distance', 'pure']) assert.ok(!tags.has(tag), tag);
});

test('ordinary range, movement and damage thresholds are not distance scaling', () => {
    const tags = infer('The caster moves a distance and deals damage when the target is within attack range.', { damage: '100', distance: '600', distance_cap: '1750', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL' });
    assert.ok(tags.has('magical'));
    assert.ok(!tags.has('damage_over_distance'));
    const threshold = infer('Deals damage if the target is farther than the threshold.', { damage: '100', distance_damage_pct: '5', distance_threshold: '500' });
    assert.ok(!threshold.has('damage_over_distance'));
    const capped = infer('Deals additional damage based on distance to the target.', { damage: '100', damage_distance_cap: '1750' });
    assert.ok(!capped.has('damage_over_distance'));
});

test('a caster-caused controlled-unit damage buff is not its own piercing damage', () => {
    const tags = infer('The caster causes neutral creeps or any unit under her control to deal additional damage to enemy heroes.', { damage_amp: { hero_levelup: '4' }, SpellImmunityType: 'SPELL_IMMUNITY_ENEMIES_YES', AbilityUnitDamageType: 'DAMAGE_TYPE_PURE' }, { behavior: new Set(['DOTA_ABILITY_BEHAVIOR_PASSIVE', 'DOTA_ABILITY_BEHAVIOR_AURA']), nativeTeams: ['enemy'], effects: [{ type: 'passive', targets: { teams: { state: 'known', value: ['enemy'] } } }] });
    for (const tag of ['aura', 'buff', 'controlled_unit_damage']) assert.ok(tags.has(tag), tag);
    for (const tag of ['bkb_pierce', 'pure', 'creep_damage', 'self_attack_damage', 'attack_modifier']) assert.ok(!tags.has(tag), tag);
});

test('a creep as an acting attacker is distinct from a damaged creep recipient', () => {
    const grant = infer('The caster causes controlled creatures to deal additional damage to enemy creeps.', { damage_amp: '4', SpellImmunityType: 'SPELL_IMMUNITY_ENEMIES_YES' });
    assert.ok(grant.has('controlled_unit_damage'));
    assert.ok(!grant.has('bkb_pierce'));
    assert.ok(!grant.has('creep_damage'));
    const damage = infer('Deals damage to enemy creeps.', { damage: '100' }, { nativeTeams: ['enemy'] });
    assert.ok(damage.has('creep_damage'));
});

test('an owning damage amplifier against neutral creeps preserves creep offense', () => {
    const tags = infer('The caster and units he controls deal extra damage to neutral creeps.', { damage_amp: { value: '18', hero_levelup: '2' } }, { behavior: new Set(['DOTA_ABILITY_BEHAVIOR_PASSIVE']) });
    assert.ok(tags.has('creep_damage'));
    for (const tag of ['pure', 'physical', 'magical', 'bkb_pierce']) assert.ok(!tags.has(tag), tag);
    const zero = infer('The caster and units he controls deal extra damage to neutral creeps.', { damage_amp: { value: '0', display_type: '1' } });
    assert.ok(!zero.has('creep_damage'));
});

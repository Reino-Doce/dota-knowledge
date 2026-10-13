import assert from 'node:assert/strict';
import test from 'node:test';
import { inferUtilityTags } from '../src/tags/native-utility.mjs';

const classify = (text, values = {}, options = {}) => [...inferUtilityTags({
    fields: new Map(Object.entries(values)), snippets: [{ suffix: 'Description', text }],
    behavior: new Set(['DOTA_ABILITY_BEHAVIOR_PASSIVE']), nativeTeams: ['self'], ...options,
})].sort();
const only = (text, values, expected, options) => assert.deepEqual(classify(text, values, options), [...expected].sort());

test('spell acquisition and repetition classify their utility without acquiring arbitrary spell damage', () => {
    only('The caster learns the last spell an enemy hero cast. The caster can use this spell as her own.', {}, ['ability_copy'], {
        behavior: new Set(['DOTA_ABILITY_BEHAVIOR_UNIT_TARGET']), nativeTeams: ['enemy'],
    });
    only('Enables the caster to cast his abilities and items multiple times with each use.', {
        multicast_2_times: { value: '75', future_upgrade: '+10' }, AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL',
    }, ['ability_repetition']);
    only('The caster can repeat an ability after its first cast.', { repeat_count: '2' }, ['ability_repetition']);
    only('The caster can copy an enemy spell.', {}, ['ability_copy']);
});

test('dynamic actor names and enemy cast targets do not change the utility beneficiary', () => {
    only('Amber Scholar studies one enemy hero, learning the secrets of the last spell the hero cast. Amber Scholar can use this spell as her own.', {}, ['ability_copy'], {
        actorNames: ['Amber Scholar'], behavior: new Set(['DOTA_ABILITY_BEHAVIOR_UNIT_TARGET']), nativeTeams: ['enemy'],
    });
    only('All Amber Scholars can use the item in the neutral item slot.', { permitted_slot: '1' }, ['item_sharing'], { actorNames: ['Amber Scholar'] });
});

test('skill progression requires the described point or level change and its matching numeric declaration', () => {
    only('The caster can skill this ability to reduce all ability and talent level requirements. On the next level up, the caster will receive an additional ability point.', {
        levels_between_upgrades: '5',
    }, ['skill_progression']);
    only('The caster gains a bonus ability point at levels %first_ability_level% and %second_ability_level%.', {
        first_ability_level: '6', second_ability_level: '12',
    }, ['skill_progression']);
    only('The caster gains damage per ability point spent.', { ability_points: '2', bonus_damage: '20' }, []);
});

test('ranged attacks interacting as melee is a qualitative capability', () => {
    only("The caster's ranged attacks behave as if they were melee attacks.", {}, ['melee_attack_interaction']);
    only('The caster is considered both a ranged and a melee attacker to gain the respective bonuses.', {}, ['melee_attack_interaction']);
    only('Amber Scholar counts as both a ranged and melee attacker.', {}, ['melee_attack_interaction'], { actorNames: ['Amber Scholar'] });
    only('Enemy ranged attacks behave as melee attacks.', {}, []);
    only('The enemy hero is considered both a ranged and a melee attacker.', {}, []);
    only('The caster grants enemy heroes the ability to be considered both ranged and melee attackers.', {}, []);
    only('The caster makes an enemy considered both a ranged and melee attacker.', {}, []);
    only('The caster is not considered both a ranged and a melee attacker.', {}, []);
    only('If the caster is considered both ranged and melee attacker, he gains %bonus_gold% gold.', { bonus_gold: '10' }, ['economy_gain']);
    only('The caster gains %bonus_gold% gold while he is both ranged and melee attacker.', { bonus_gold: '10' }, ['economy_gain']);
});

test('item capabilities classify disassembly, copying, sharing and enchantment upgrades', () => {
    only('The caster can disassemble most items.', {}, ['item_disassembly']);
    only("The caster's companion receives a copy of his neutral item with an independent cooldown.", {}, ['item_copy']);
    only('The caster can copy items.', {}, ['item_copy']);
    only('All allied clones can use the item in the neutral slot.', {}, ['item_sharing']);
    only('The caster stacks all previously selected enchantments onto newly crafted neutral items.', {}, ['item_upgrade']);
    only('The caster melts down an ancient item to grant an allied hero all its upgrades.', {}, ['item_upgrade']);
    only("The caster's items' passive bonuses are more powerful.", { bonus_stat_percent: '45' }, ['item_upgrade']);
    only('The caster shares items and experience with a clone.', {}, ['item_sharing']);
    only('Items share cooldowns between allied clones.', {}, []);
});

test('item selection respects extra-choice amounts and qualitative selectable options', () => {
    only('Has an extra choice of neutral item to select from.', { bonus_choice: '1' }, ['item_choice']);
    only('Has an extra choice of neutral item to select from.', { bonus_choice: '0' }, []);
    only('The caster can choose from multiple upgrade options. The items must be activated before they can be used.', {}, ['item_choice']);
});

test('courier recall and scoped numeric benefits stay utility', () => {
    only('The caster instantly summons her courier to her. After teleporting, it transfers items from her stash.', {}, ['courier_utility']);
    only('Passively grants all allied couriers %bonus_levels% bonus levels and %bonus_hp% bonus health.', {
        bonus_levels: '3', bonus_hp: '1',
    }, ['courier_utility']);
    only('All friendly couriers move faster.', { courier_speed: '50' }, ['courier_utility']);
    only('All friendly couriers move faster.', { courier_speed: '0', unrelated_damage: '100' }, []);
    only('Enemy couriers gain bonus speed.', { courier_speed: '50' }, []);
    only('When the courier teleports to the caster, he gains gold.', { bonus_gold: '10' }, ['economy_gain']);
});

test('single-use resource acquisition does not emit the acquired resource damage or summon effects', () => {
    only('The caster receives a random single-use keepsake whenever an enemy hero dies nearby. Additional keepsakes are held as charges.', {
        collection_range: '925', AbilityUnitDamageType: 'DAMAGE_TYPE_MAGICAL', damage: '200',
    }, ['consumable_generation']);
    only('The caster generates consumables for friendly heroes.', {}, ['consumable_generation']);
    only('Gather keepsakes from kills and assists.', {}, []);
    only('The caster uses a consumable to deal damage to an enemy.', { damage: '200' }, []);
});

test('gold gains distinguish receiving, stealing, rune boosts and owned refunds from costs', () => {
    only('The caster synthesizes additional gold from enemies. With each kill, the caster earns bonus gold.', { bonus_gold: '2' }, ['economy_gain']);
    only('The caster receives %kill_assist_gold_bonus_percent%%% more kill and assist gold if the dying enemy is wealthy.', {
        kill_assist_gold_bonus_percent: '20',
    }, ['economy_gain']);
    only('The caster steals %gold_steal% gold when targeting enemy heroes.', { gold_steal: '4' }, ['economy_gain']);
    only('Causes bounty runes to yield more gold.', { bounty_multiplier: '2' }, ['economy_gain']);
    only('When the owner dies, %death_gold_reduction%%% of the gold lost from death is added to an item, and will be refunded when it is consumed.', {
        death_gold_reduction: '100',
    }, ['economy_gain']);
    only('The caster spends gold to create an item.', { gold_cost: '100', bonus_gold: '20' }, []);
    only('The caster gains damage based on gold earned.', { bonus_gold: '20', bonus_damage: '30' }, []);
    only('The caster spends gold. The mana cost is refunded.', { bonus_gold: '20', mana_cost: '30' }, []);
});

test('payouts to enemies or unspecified death bounty recipients do not become caster income', () => {
    only('Grants %gold_bounty% gold if destroyed by an enemy hero.', { gold_bounty: '10' }, []);
    only('The ward grants nearby enemies %gold_bounty% gold when it dies.', { gold_bounty: '30' }, []);
    only('Grants %xp_bounty% experience if destroyed by an enemy hero.', { xp_bounty: '10' }, []);
    only('The caster grants enemy heroes bonus gold.', { bonus_gold: '20' }, []);
    only('The enemy hero receives %bonus_gold% gold on the caster death.', { bonus_gold: '20' }, []);
    only('Grants the caster %bonus_gold% gold on a successful capture.', { bonus_gold: '20' }, ['economy_gain']);
    only('Awards bonus gold to an allied hero.', { bonus_gold: '20' }, ['economy_gain']);
});

test('experience acquisition respects output resource, beneficiary and matching quantity', () => {
    only('When the caster denies a lane creep, he gets %xp_on_deny_percent%%% of its XP.', { xp_on_deny_percent: '25' }, ['experience_gain']);
    only('Every time the caster damages an enemy with an ability, she gains %experience_gain% experience.', { experience_gain: '6' }, ['experience_gain']);
    only("The hero on your team whose level is lower than anybody else's gains %xp_gain_rate%%% more experience.", { xp_gain_rate: '50' }, ['experience_gain']);
    only('When an enemy casts an ultimate nearby, the caster receives experience equal to %mana_to_xp_percentage%%% of its mana cost.', {
        mana_to_xp_percentage: '25', xp_gain_range: '1200',
    }, ['experience_gain']);
    only('Sacrifice an allied creep and give the caster its experience bounty.', { xp_pct: '69' }, ['experience_gain']);
    only('The enemy hero gains experience.', { experience_gain: '20' }, []);
    only('The caster gains damage based on experience.', { experience_gain: '20', bonus_damage: '30' }, []);
    only('The caster receives experience equal to %mana_to_xp_percentage%%% of mana spent.', { mana_to_xp_percentage: '0', xp_gain_range: '1200' }, []);
});

test('explicit friendly payout recipients override hostile cast targets without borrowing formula actors', () => {
    const hostileTarget = { behavior: new Set(['DOTA_ABILITY_BEHAVIOR_UNIT_TARGET']), nativeTeams: ['enemy'] };
    only('Grants the caster %bonus_gold% gold.', { bonus_gold: '20' }, ['economy_gain'], hostileTarget);
    only('Awards all nearby allied heroes bonus gold.', { bonus_gold: '20' }, ['economy_gain'], hostileTarget);
    only('Gives an ally %experience_gain% experience.', { experience_gain: '20' }, ['experience_gain'], hostileTarget);
    only('Gives the caster %experience_gain% experience.', { experience_gain: '20' }, ['experience_gain'], hostileTarget);
    only('Grants the enemy hero gold based on the caster level.', { bonus_gold: '20' }, [], hostileTarget);
    only('Gives experience to the enemy hero according to the caster experience.', { experience_gain: '20' }, [], hostileTarget);
    only('Grants gold based on a multiplier for the caster level.', { bonus_gold: '20' }, [], hostileTarget);
});

test('objective timing is information, without inferred vision or combat effects', () => {
    only('The caster and her teammates can see the objective respawn timer.', {}, ['objective_information']);
    only("The caster and her teammates can see Roshan's respawn timer.", {}, ['objective_information']);
    only('Enemy heroes can see the boss respawn timer.', {}, []);
    only('The caster cannot see the objective respawn timer.', {}, []);
});

test('conditional, negative, lore and parameter mentions do not grant utility capabilities', () => {
    for (const text of [
        'After copying an enemy spell, the caster gains attack speed.',
        'After disassembling an item, the caster gains armor.',
        'After gaining experience, the caster gains mana.',
        'The caster cannot copy enemy spells.',
        'The caster does not disassemble items.',
        'The caster does not gain gold.',
        'The caster does not receive experience.',
    ]) only(text, { bonus_gold: '20', experience_gain: '30', attack_speed: '40', bonus_armor: '10' }, []);
    assert.deepEqual([...inferUtilityTags({
        fields: new Map([['bonus_gold', '20'], ['experience_gain', '30']]),
        snippets: [{ suffix: 'Lore', text: 'The caster gains gold and experience.' }],
        behavior: new Set(['DOTA_ABILITY_BEHAVIOR_PASSIVE']),
    })], []);
    only('', { gold_on_death: '50', xp_on_death: '50' }, []);
    only('The caster receives gold and experience.', { gold_tick_interval: '3', xp_gain_range: '1000' }, []);
});

test('numeric utility gates use owned nonzero values without speculative upgrade branches', () => {
    only('The caster earns bonus gold.', { bonus_gold: { value: '0', future_upgrade: '+20' } }, []);
    only('The caster receives experience.', { experience_gain: { future_upgrade: '+20' } }, []);
    only('Enables the caster to cast spells multiple times with each use.', { multicast_2_times: { value: '0', future_upgrade: '+20' } }, []);
    only('The caster gains bonus ability points.', { ability_points: 'unknown' }, []);
    only('The caster can copy an enemy spell.', { MaxLevel: '0' }, []);
});

test('negative utility operations never become positive capabilities from nonzero declarations', () => {
    for (const [text, fields] of [
        ['The caster does not steal gold.', { gold_steal: '4' }],
        ['The caster does not synthesize additional gold.', { bonus_gold: '2' }],
        ['Bounty runes do not yield more gold.', { bounty_multiplier: '2' }],
        ['The caster does not retain gold.', { bonus_gold: '2' }],
        ['The caster does not get experience.', { experience_gain: '5' }],
        ['The caster cannot steal enemy abilities.', {}],
        ['The caster does not allow spells to be cast multiple times.', { repeat_count: '2' }],
        ['The caster does not reduce ability level requirements.', { required_level: '3' }],
        ["The caster's ranged attacks do not behave as melee attacks.", {}],
        ['The caster does not stack enchantments onto neutral items.', {}],
        ['The caster has no extra choice of neutral items.', { bonus_choice: '1' }],
        ['The caster cannot select neutral items.', {}],
        ['The caster does not summon her courier.', {}],
        ['The courier does not deliver items.', {}],
        ['All allied couriers are not faster.', { courier_speed: '50' }],
        ['The caster does not produce consumables.', {}],
        ['The caster does not obtain single-use keepsakes.', {}],
        ['The caster receives a keepsake that is not single-use.', {}],
    ]) only(text, fields, []);
    only('The caster receives a copy of a neutral item without additional bonuses.', {}, ['item_copy']);
    only('The caster produces a single-use keepsake without bonus gold.', { bonus_gold: '20' }, ['consumable_generation']);
    only('The caster receives a non-consumable copy of a neutral item.', {}, ['item_copy']);
});

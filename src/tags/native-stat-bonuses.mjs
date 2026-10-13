/**
 * Classify numeric stat grants and linked native modifiers. Source ownership,
 * localization binding and branch provenance are verified by the caller.
 * These rules use property grammar and normalized operations, never identities.
 */

function numericRanks(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? [value] : null;
    if (Array.isArray(value)) return value.length && value.every(number => typeof number === 'number' && Number.isFinite(number)) ? value : null;
    if (typeof value !== 'string') return null;
    const tokens = value.trim().split(/\s+/);
    return tokens.length && tokens.every(token => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) ? tokens.map(Number) : null;
}

function ownRanks(raw) {
    // A value wrapper can also contain requirements and conditional modifiers.
    // Only its owned base value establishes the direct talent's numeric grant.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return Object.hasOwn(raw, 'value') ? numericRanks(raw.value) : null;
    }
    return numericRanks(raw);
}

const statProperties = new Map([
    ['agility', ['attribute_bonus']], ['strength', ['attribute_bonus']], ['intelligence', ['attribute_bonus']],
    ['all attributes', ['attribute_bonus']], ['armor', ['self_armor']],
    ['attack range', ['self_attack_range']], ['attack speed', ['self_attack_speed']],
    ['base damage', ['self_attack_damage']], ['attack damage', ['self_attack_damage']], ['damage', ['self_attack_damage']],
    ['cast range', ['cast_range']], ['health', ['self_max_health']], ['maximum health', ['self_max_health']],
    ['max health', ['self_max_health']], ['mana', ['self_max_mana']], ['maximum mana', ['self_max_mana']],
    ['max mana', ['self_max_mana']], ['health regen', ['health_regen', 'self_health_regen']],
    ['health regeneration', ['health_regen', 'self_health_regen']], ['mana regen', ['self_mana_regen']],
    ['mana regeneration', ['self_mana_regen']], ['movement speed', ['self_movement_speed']],
    ['night vision', ['vision']], ['vision', ['vision']], ['spell area of effect', ['area_increase']],
    ['cleave', ['cleave']], ['evasion', ['evasion']], ['lifesteal', ['lifesteal', 'self_lifesteal']],
    ['spell lifesteal', ['spell_lifesteal']], ['magic resistance', ['magic_resistance']],
    ['status resistance', ['status_resistance']], ['slow resistance', ['slow_resistance']],
    ['spell amplification', ['spell_amplification']], ['spell damage amplification', ['spell_amplification']],
    ['cooldown reduction', ['cooldown_reduction']], ['mana cost reduction', ['mana_cost_reduction']],
    ['manacost reduction', ['mana_cost_reduction']], ['manacost/manaloss reduction', ['mana_cost_reduction']],
    ['mana cost/mana loss reduction', ['mana_cost_reduction']],
]);

/** Classify a whole generic quantitative root title with a bound own value. */
export function inferStatBonusTags({ abilityLabel, fields = new Map(), behavior = new Set() } = {}) {
    const tags = new Set();
    if (!['ABILITY_TYPE_ATTRIBUTES', 'DOTA_ABILITY_TYPE_ATTRIBUTES'].includes(fields.get('AbilityType'))
        || !behavior.has('DOTA_ABILITY_BEHAVIOR_PASSIVE') || typeof abilityLabel !== 'string') return tags;
    const values = ownRanks(fields.get('value'));
    if (!values?.length || !values.every(value => value > 0)) return tags;
    const label = abilityLabel.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const match = /^\+(\{s:value\}|(?:\d+(?:\.\d*)?|\.\d+))\s*(%)?\s+([a-z][a-z /-]*)$/.exec(label);
    if (!match || match[1] !== '{s:value}' && !values.every(value => value === Number(match[1]))) return tags;
    const keys = statProperties.get(match[3]);
    if (keys) for (const key of ['buff', ...keys]) tags.add(key);
    return tags;
}

function evaluate(base, operations) {
    const before = numericRanks(base);
    if (!before || !Array.isArray(operations) || !operations.length) return null;
    const decoded = [];
    let rankCount = before.length;
    for (const operation of operations) {
        if (!operation || !['add', 'subtract', 'percent-add', 'percent-subtract', 'multiply', 'divide', 'set', 'replace'].includes(operation.operator)) return null;
        const operands = numericRanks(operation.operand);
        if (!operands) return null;
        if (operands.length > 1 && rankCount > 1 && operands.length !== rankCount) return null;
        rankCount = Math.max(rankCount, operands.length);
        decoded.push({ operator: operation.operator, operands });
    }
    if (before.length !== 1 && before.length !== rankCount) return null;
    const initial = Array.from({ length: rankCount }, (_, rank) => before[before.length === 1 ? 0 : rank]);
    const after = [...initial];
    for (const { operator, operands } of decoded) {
        if (operands.length !== 1 && operands.length !== rankCount) return null;
        for (let rank = 0; rank < rankCount; rank++) {
            const operand = operands[operands.length === 1 ? 0 : rank];
            if (operator === 'add') after[rank] += operand;
            else if (operator === 'subtract') after[rank] -= operand;
            else if (operator === 'percent-add') after[rank] *= 1 + operand / 100;
            else if (operator === 'percent-subtract') after[rank] *= 1 - operand / 100;
            else if (operator === 'multiply') after[rank] *= operand;
            else if (operator === 'divide') {
                if (operand === 0) return null;
                after[rank] /= operand;
            } else after[rank] = operand;
            if (!Number.isFinite(after[rank])) return null;
        }
    }
    const signs = initial.map((value, rank) => Math.sign(after[rank] - value));
    if (!signs[0] || !signs.every(sign => sign === signs[0])) return null;
    return { before: initial, after, direction: signs[0] };
}

const setOf = values => values instanceof Set ? values : new Set(Array.isArray(values) ? values : []);
const teamsFor = effect => effect.targets?.teams?.state === 'known' && Array.isArray(effect.targets.teams.value) ? effect.targets.teams.value : [];
const damagePayloadTags = ['immediate_damage', 'damage_over_time', 'delayed_damage', 'building_damage', 'creep_damage'];
const controls = ['stun', 'silence', 'root', 'fear', 'sleep', 'taunt', 'hex', 'disarm', 'mute', 'slow'];

/** Classify only the contribution changed by a verified native parent branch. */
export function inferLinkedBonusTags({ field, base, operations, parentTags = [], parentTeams = [], parentEffects = [], fieldLabel = '', targetLabel = '' } = {}) {
    const tags = new Set();
    if (typeof field !== 'string') return tags;
    const change = evaluate(base, operations);
    if (!change) return tags;
    const parents = setOf(parentTags), teams = setOf(parentTeams);
    const property = field.toLowerCase(), label = String(fieldLabel).replace(/<[^>]*>/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
    const talentTitle = String(targetLabel).replace(/<[^>]*>/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
    const nonnegative = change.before.every(value => value >= 0) && change.after.every(value => value >= 0);
    const positiveBase = change.before.every(value => value > 0);
    const add = (...keys) => keys.forEach(key => tags.add(key));
    const buff = (...keys) => add('buff', ...keys);
    if (['abilitycooldown', 'abilitychargerestoretime'].includes(property)) {
        if (change.direction < 0 && positiveBase && nonnegative) buff('cooldown_reduction');
        return tags;
    }
    if (property === 'abilitymanacost') {
        if (change.direction < 0 && positiveBase && nonnegative) buff('mana_cost_reduction');
        return tags;
    }
    if (property === 'abilitycastrange') {
        if (change.direction > 0 && nonnegative) buff('cast_range');
        return tags;
    }
    const control = controls.find(key => new RegExp('(?:^|_)' + key + '_duration$').test(property));
    if (property === 'abilityduration' || property === 'duration' || control) {
        if (change.direction > 0 && nonnegative) {
            add('duration_extension');
            if (control && parents.has(control)) add(control);
        }
        return tags;
    }
    if (/(?:^|_)(?:radius|aoe|width)$/.test(property)) {
        const areaLabel = /\b(?:area of effect|aoe|blast|explosion|impact|effect|aura|damage)\s+(?:radius|width)\b|^(?:radius|area of effect|aoe)$/.test(label);
        const search = /search|detection|tree|spawn|collection|scan|spot|roam/.test(property + ' ' + label);
        const areaProof = parents.has('aoe') || parents.has('aura') || parentEffects.some(effect => effect.delivery?.kind === 'area');
        if (change.direction > 0 && nonnegative && !search && (areaProof || areaLabel)) buff('area_increase');
        return tags;
    }
    // Encodings can use either positive reductions or negative signed deltas.
    const strengthenedMagnitude = nonnegative && change.direction > 0
        || change.before.every((value, rank) => value !== 0 && Math.sign(value) === Math.sign(change.after[rank]) && Math.abs(change.after[rank]) > Math.abs(value));
    const denialFamilies = [
        [/^(?:armor_reduction|armor_reduction_pct|armor_reduction_percent|armor_reduction_per_stack|armor_debuff)$/i, 'armor_reduction'],
        [/^(?:move(?:ment)?_slow(?:_min|_max|_pct|_percent)?|slow(?:_pct|_percent)?)$/i, 'slow'],
        [/^(?:attack_slow|attack_speed_reduction|attack_speed_slow)(?:_pct|_percent)?$/i, 'enemy_attack_speed_reduction'],
        [/^(?:heal(?:ing)?_reduction|heal(?:ing)?_reduction_pct|health_restoration_reduction)$/i, 'anti_heal'],
        [/^(?:outgoing_damage_reduction|damage_reduction_on_enemies)(?:_pct|_percent)?$/i, 'outgoing_damage_reduction'],
    ];
    for (const [pattern, key] of denialFamilies) if (pattern.test(property)) {
        if (strengthenedMagnitude && parents.has(key)) add(key);
        return tags;
    }
    if (change.direction < 0 || !nonnegative) return tags;
    const statFamilies = [
        [/^(?:bonus_armor|armor_bonus|armor)$/i, 'self_armor', 'ally_armor'],
        [/^(?:bonus_attack_damage|attack_damage_bonus|bonus_damage|damage_bonus)$/i, 'self_attack_damage', 'ally_attack_damage'],
        [/^(?:bonus_attack_speed|attack_speed_bonus|attack_speed)$/i, 'self_attack_speed', 'ally_attack_speed'],
        [/^(?:bonus_attack_range|attack_range_bonus|attack_range)$/i, 'self_attack_range', 'ally_attack_range'],
        [/^(?:bonus_move_speed|bonus_movement_speed|move_speed_bonus|movement_speed_bonus|movement_speed|move_speed)$/i, 'self_movement_speed', 'ally_movement_speed'],
        [/^(?:hp_regen|health_regen|bonus_hp_regen|bonus_health_regen)$/i, 'self_health_regen', 'ally_health_regen', 'health_regen'],
        [/^(?:mana_regen|bonus_mana_regen)$/i, 'self_mana_regen', 'ally_mana_regen'],
        [/^(?:bonus_hp|bonus_health|max_health|health_bonus)$/i, 'self_max_health', 'ally_max_health'],
        [/^(?:bonus_mana|max_mana|mana_bonus)$/i, 'self_max_mana', 'ally_max_mana'],
    ];
    const controlledDamage = parents.has('controlled_unit_damage') || /\b(?:summon(?:ed)?(?: unit)?|controlled unit|creature|illusion)\s+(?:attack\s+)?damage\b/.test(label);
    const damageStat = statFamilies[1][0].test(property);
    const directOutgoing = parentEffects.some(effect => effect.type === 'damage' && teamsFor(effect).includes('enemy'));
    const outgoing = directOutgoing || damagePayloadTags.some(key => parents.has(key)) && (teams.has('enemy') || !teams.has('self'));
    const ambiguousDamageField = /^(?:bonus_damage|damage_bonus)$/.test(property);
    const explicitAttackStat = /\battack damage\b/.test(label) && !/\bspell|ability\b/.test(label);
    const explicitAbilityDamage = /\b(?:spell|ability|impact|explosion|burn) damage\b/.test(label);
    // A mixed ability can both buff its caster's attacks and deal spell damage.
    // A generic bonus_damage parameter cannot identify which operation changed.
    const mixedDamageOwners = outgoing && (parents.has('self_attack_damage') || parents.has('ally_attack_damage'));
    if (damageStat && controlledDamage) {
        buff('controlled_unit_damage');
        return tags;
    }
    for (const [pattern, selfTag, allyTag, sharedTag] of statFamilies) if (pattern.test(property)) {
        if (!damageStat || !parents.has('summons') && !parents.has('illusions')
            && (!ambiguousDamageField || !mixedDamageOwners || explicitAttackStat) && !explicitAbilityDamage) {
            if (teams.has('self') && parents.has(selfTag)) buff(selfTag, ...(sharedTag ? [sharedTag] : []));
            if (allyTag && teams.has('ally') && parents.has(allyTag)) buff(allyTag, ...(sharedTag ? [sharedTag] : []));
        }
        if (tags.size) return tags;
    }
    if (/^speed_bonus$/.test(property) && change.direction > 0 && nonnegative
        && /^\+\s*(?:\{s:[^}]+\}|\d+(?:\.\d*)?|\.\d+)\s*%?\s+(?:move|movement) speed\b/.test(talentTitle)
        && !/\b(?:ally|allies|friendly|teammates?)\b/.test(talentTitle)) {
        buff('self_movement_speed');
        return tags;
    }
    if (ambiguousDamageField && mixedDamageOwners && !explicitAbilityDamage) return tags;
    if (/duration|interval|delay|cooldown|cost|reduc|resist|reflect|incoming|share|threshold|chance|multiplier|health|hp|mana|pct_per_hit/.test(property + ' ' + label)) return tags;
    const damageField = /^(?:(?:total|impact|explosion|burst|burn|base|bonus|attack|spell)_)?damage(?:_per_second)?$|^(?:dps|damage_bonus)$/.test(property);
    if (damageField && outgoing) buff(controlledDamage ? 'controlled_unit_damage' : 'ability_damage_bonus');
    return tags;
}

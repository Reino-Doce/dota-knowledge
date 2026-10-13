import { stable } from '../canonical-model.mjs';
import { selectedResources, boundFields, boundLocalization, hasSource } from '../tags/ability-tags.mjs';
import { decodeMechanicsValue } from '../mechanics-values.mjs';

const flags = value => new Set(typeof value === 'string' ? value.split(/[|\s]+/u).map(part => part.trim()).filter(Boolean) : []);
const numericValue = field => {
    let node = field;
    while (node?.state === 'decoded' && node.base) node = node.base;
    if (node?.state !== 'known') return undefined;
    const values = Array.isArray(node.value) ? node.value : [node.value];
    if (!values.length || values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return undefined;
    return values.every(value => value === values[0]) ? values[0] : [...values];
};

function acquiredAbilitySlot(fields, snippets) {
    const behavior = flags(fields.get('AbilityBehavior'));
    if (!behavior.has('DOTA_ABILITY_BEHAVIOR_PASSIVE') || !behavior.has('DOTA_ABILITY_BEHAVIOR_NOT_LEARNABLE')
        || numericValue(decodeMechanicsValue(fields.get('MaxLevel'))) !== 0) return false;
    for (const snippet of snippets) {
        if (!/^description$/i.test(snippet.suffix)) continue;
        const text = snippet.text.replace(/<[^>]*>/g, ' ').toLowerCase();
        for (const sentence of text.split(/[.!?\n]+/)) {
            if (/\b(?:cannot|never|unable|without|not|no)\b/.test(sentence)
                || /\b(?:enemy|opponent|ally|allied|another|other|their)(?:'s)?\s+(?:ability\s+)?slots?\b/.test(sentence)) continue;
            const slot = /\b(?:this|the)\s+(?:ability\s+)?slot\b/;
            const ability = /\b(?:abilities|ability|spells|spell)\b/;
            const replacement = /\b(?:replace[sd]?|replacing|fill(?:ed|s)?|filling|populate[sd]?|populating|occup(?:y|ies|ied))\b/;
            if (!slot.test(sentence) || !ability.test(sentence) || !replacement.test(sentence)) continue;
            // A described change of spell stored in the owning slot establishes
            // a presentation placeholder, rather than a passive gameplay effect.
            if (/\bslot\b[^.!?]*\b(?:replaced|filled|populated|occupied)\s+(?:with|by)\b[^.!?]*\b(?:abilities|ability|spells|spell)\b/.test(sentence)
                || /\b(?:replace|replaces|fill|fills|populate|populates|occupy|occupies)\s+(?:this|the)\s+(?:ability\s+)?slot\b/.test(sentence)) return true;
        }
    }
    return false;
}

export function compactCastingType(fields, snippets = []) {
    const behavior = flags(fields.get('AbilityBehavior'));
    if (acquiredAbilitySlot(fields, snippets)) return 'placeholder';
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_PASSIVE')) return 'passive';
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_TOGGLE') || behavior.has('DOTA_ABILITY_BEHAVIOR_AUTOCAST')) return 'toggle';
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_VECTOR_TARGETING')) return 'vector';
    const unit = behavior.has('DOTA_ABILITY_BEHAVIOR_UNIT_TARGET');
    const point = behavior.has('DOTA_ABILITY_BEHAVIOR_POINT');
    if (unit && point) return 'target-or-point';
    if (unit) return 'target';
    if (point) return 'point';
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_NO_TARGET')) return 'self-target';
    return 'unknown';
}

export function compactTargets(fields) {
    const behavior = flags(fields.get('AbilityBehavior'));
    if (!behavior.has('DOTA_ABILITY_BEHAVIOR_UNIT_TARGET')) return [];
    const team = flags(fields.get('AbilityUnitTargetTeam'));
    const type = flags(fields.get('AbilityUnitTargetType'));
    const exclusions = flags(fields.get('AbilityUnitTargetFlags'));
    const friendly = team.has('DOTA_UNIT_TARGET_TEAM_FRIENDLY') || team.has('DOTA_UNIT_TARGET_TEAM_BOTH');
    const hostile = team.has('DOTA_UNIT_TARGET_TEAM_ENEMY') || team.has('DOTA_UNIT_TARGET_TEAM_BOTH');
    const all = type.has('DOTA_UNIT_TARGET_ALL');
    const target = new Set();
    if (all || type.has('DOTA_UNIT_TARGET_HERO')) {
        if (friendly) {
            if (!exclusions.has('DOTA_UNIT_TARGET_FLAG_NOT_SELF')) target.add('self');
            target.add('ally_hero');
        }
        if (hostile) target.add('enemy_hero');
    }
    if (all || type.has('DOTA_UNIT_TARGET_BASIC')) {
        if (friendly) target.add('ally_creep');
        if (hostile) {
            target.add('enemy_creep');
            if (!exclusions.has('DOTA_UNIT_TARGET_FLAG_NOT_CREEP_HERO') && exclusions.has('DOTA_UNIT_TARGET_FLAG_CREEP_HERO')) target.add('enemy_creep_hero');
            if (!exclusions.has('DOTA_UNIT_TARGET_FLAG_NOT_NEUTRAL')) target.add('neutral_creep');
        }
    }
    if (all || type.has('DOTA_UNIT_TARGET_BUILDING')) {
        if (friendly) target.add('ally_building');
        if (hostile) target.add('enemy_building');
    }
    if (all || type.has('DOTA_UNIT_TARGET_TREE')) target.add('tree');
    if (type.has('DOTA_UNIT_TARGET_COURIER')) {
        if (friendly) target.add('ally_courier');
        if (hostile) target.add('enemy_courier');
    }
    return [...target];
}

function compactBehavior(fields) {
    const behavior = flags(fields.get('AbilityBehavior'));
    const targetTypes = flags(fields.get('AbilityUnitTargetType'));
    const vector = behavior.has('DOTA_ABILITY_BEHAVIOR_VECTOR_TARGETING');
    const result = new Set();
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_UNIT_TARGET')) result.add('unit-target');
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_PASSIVE')) result.add('passive');
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_POINT') && !vector) result.add('point-target');
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_NO_TARGET')) result.add('no-target');
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_AUTOCAST')) result.add('auto-cast');
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_CHANNELLED')) result.add('channeled');
    if (vector) result.add(targetTypes.has('DOTA_UNIT_TARGET_TREE') ? 'tree-vector-target' : 'point-vector-target');
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_TOGGLE')) result.add('toggle');
    return [...result].sort();
}

function compactAffects(fields) {
    const team = flags(fields.get('AbilityUnitTargetTeam'));
    const type = flags(fields.get('AbilityUnitTargetType'));
    const friendly = team.has('DOTA_UNIT_TARGET_TEAM_FRIENDLY') || team.has('DOTA_UNIT_TARGET_TEAM_BOTH');
    const hostile = team.has('DOTA_UNIT_TARGET_TEAM_ENEMY') || team.has('DOTA_UNIT_TARGET_TEAM_BOTH');
    const all = type.has('DOTA_UNIT_TARGET_ALL');
    const heroes = all || type.has('DOTA_UNIT_TARGET_HERO');
    const basic = all || type.has('DOTA_UNIT_TARGET_BASIC');
    const creeps = all || type.has('DOTA_UNIT_TARGET_CREEP') || type.has('DOTA_UNIT_TARGET_CREEP_HERO');
    const buildings = all || type.has('DOTA_UNIT_TARGET_BUILDING');
    const trees = all || type.has('DOTA_UNIT_TARGET_TREE');
    const unitTypes = Number(heroes) + Number(basic || creeps);
    const hasKnownType = heroes || basic || creeps || buildings || trees;
    const result = new Set();
    if (!hasKnownType && !type.has('DOTA_UNIT_TARGET_CUSTOM')) {
        if (friendly && hostile) result.add('units');
        else if (friendly) result.add('allies');
        else if (hostile) result.add('enemy-units');
    } else if (unitTypes > 1) {
        if (friendly && hostile) result.add('units');
        else if (friendly) result.add('allied-units');
        else if (hostile) result.add('enemy-units');
    } else if (heroes) {
        if (friendly) result.add('allied-heroes');
        if (hostile) result.add('enemy-heroes');
    } else if (basic || creeps) {
        if (friendly && hostile) result.add('units');
        else if (friendly) result.add('allied-units');
        else if (hostile) result.add('enemy-creeps');
    }
    if (trees) result.add('trees');
    if (friendly && buildings) result.add('allied-buildings');
    if (hostile && buildings) result.add('enemy-buildings');
    return [...result].sort();
}

export function compactAbilityMetadata(fields) {
    const result = {};
    const behavior = compactBehavior(fields);
    if (behavior.length) result.behavior = behavior;
    const affects = compactAffects(fields);
    if (affects.length) result.affects = affects;

    const dispellable = fields.get('SpellDispellableType');
    if (dispellable === 'SPELL_DISPELLABLE_NO') result.dispellable = 'no';
    else if (dispellable === 'SPELL_DISPELLABLE_YES') {
        result.dispellable = 'yes';
        result.dispelType = 'basic';
    } else if (dispellable === 'SPELL_DISPELLABLE_YES_STRONG') {
        result.dispellable = 'strong-only';
        result.dispelType = 'strong';
    }

    const immunity = {
        SPELL_IMMUNITY_ENEMIES_NO: 'no',
        SPELL_IMMUNITY_ALLIES_NO: 'no',
        SPELL_IMMUNITY_ALLIES_YES: 'allies-only',
        SPELL_IMMUNITY_ALLIES_YES_ENEMIES_NO: 'allies-only',
        SPELL_IMMUNITY_ENEMIES_YES: 'yes',
    }[fields.get('SpellImmunityType')];
    if (immunity) result.piercesDebuffImmunity = immunity;

    const damageType = {
        DAMAGE_TYPE_MAGICAL: 'magical',
        DAMAGE_TYPE_PHYSICAL: 'physical',
        DAMAGE_TYPE_PURE: 'pure',
    }[fields.get('AbilityUnitDamageType')];
    if (damageType) result.damageType = damageType;

    const breakable = numericValue(decodeMechanicsValue(fields.get('IsBreakable')));
    if (breakable === 0 || breakable === 1) result.breakable = breakable === 1;
    return result;
}

const groupValue = rows => rows.length === 0 ? null : rows.length === 1 ? rows[0] : rows;

function titleNumber(raw) {
    let node = decodeMechanicsValue(raw);
    while (node?.state === 'decoded' && node.base) node = node.base;
    if (node?.state !== 'known') return undefined;
    const values = Array.isArray(node.value) ? node.value : [node.value];
    return values.length && values.every(value => typeof value === 'number' && Number.isFinite(value) && value === values[0]) ? values[0] : undefined;
}

export function compactEnglishName(native, resources) {
    if (!native) return undefined;
    const root = 'DOTA_Tooltip_ability_' + native.abilityId;
    const titles = boundLocalization(native, resources).filter(row => row.suffix === '');
    const names = new Set();
    for (const { text } of titles) {
        const token = Object.keys(native.localization?.tokens ?? {}).find(token => token.toLowerCase() === root.toLowerCase()
            && native.localization.tokens[token] === text);
        if (!token || !(native.localization.tokenSources?.[token] ?? []).some(row => row.state === 'known' && row.raw === text
            && /(?:^|\/)[^/]+_english\.txt$/i.test(row.sourceResource ?? '') && row.sourcePath === 'lang.Tokens.' + token
            && hasSource(resources, row.sourceResource, row.sourcePath, row.raw))) continue;
        const fields = native.state === 'known' && native.raw && hasSource(resources, native.sourceResource, native.sourcePath, native.raw)
            ? boundFields(native, resources) : new Map();
        let unresolved = false;
        const formatted = text.replace(/\{s:([a-z_][a-z0-9_]*)\}/gi, (_match, argument) => {
            const candidates = [argument, ...(argument.startsWith('bonus_') ? [argument.slice(6)] : [])];
            const values = [...new Set(candidates.filter(field => Object.hasOwn(native.raw ?? {}, field)
                || Object.hasOwn(native.raw?.AbilityValues ?? {}, field)).map(field => fields.has(field) ? titleNumber(fields.get(field)) : undefined)
                .filter(value => value !== undefined))];
            if (values.length !== 1) { unresolved = true; return ''; }
            return String(values[0]);
        }).trim();
        if (!unresolved && formatted && !/[{}]/.test(formatted)) names.add(formatted);
    }
    return names.size === 1 ? [...names][0] : undefined;
}

function sourceSlots(native, fields, resources) {
    const slots = new Map();
    for (const row of native?.abilitySlots ?? []) {
        if (!/^Ability[1-9][0-9]*$/.test(row.slot) || fields.get(row.slot) !== row.abilityId) continue;
        const declaration = native.nativeDeclarations?.fields?.[row.slot];
        const provenance = native.nativeDeclarations?.leafProvenance?.[row.slot]
            ?? { sourceResource: native.sourceResource, sourcePath: native.sourcePath + '.' + row.slot };
        if (!declaration || !hasSource(resources, declaration.sourceResource, declaration.sourcePath, declaration.raw)
            || declaration.raw !== row.abilityId || declaration.decoded !== row.abilityId
            || declaration.sourceResource !== provenance.sourceResource || declaration.sourcePath !== provenance.sourcePath) continue;
        slots.set(row.abilityId, { slot: row.slot, declaration });
    }
    return slots;
}

// The presentation is a projection. Stable IDs, activation provenance and unknown
// declarations remain in the canonical metadata rather than this hero view.
export function compactHeroAbilities(graph, heroId) {
    const resources = selectedResources(graph);
    const heroNative = graph.guides.get(heroId)?.native;
    const heroFields = heroNative ? boundFields(heroNative, resources) : new Map();
    const slots = sourceSlots(heroNative, heroFields, resources);
    const nativeById = new Map((heroNative?.abilities ?? []).map(row => [row.abilityId, row]));
    const activations = new Map(graph.entities.activations.map(row => [row.id, row]));
    const innate = [], skills = [], talents = [], bonus = [];
    const abilities = graph.entities.abilities.filter(row => row.heroId === heroId)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    const engineIds = new Set();
    for (const ability of abilities) {
        if (typeof ability.engineId !== 'string' || !ability.engineId || engineIds.has(ability.engineId)) throw new Error('Duplicate or missing hero ability engine identity: ' + heroId);
        engineIds.add(ability.engineId);
        const native = nativeById.get(ability.engineId);
        const fields = native?.state === 'known' && native.raw && hasSource(resources, native.sourceResource, native.sourcePath, native.raw)
            ? boundFields(native, resources) : new Map();
        const behavior = flags(fields.get('AbilityBehavior'));
        const slot = slots.get(ability.engineId);
        const base = heroNative?.nativeDeclarations?.base;
        const commonBonus = slot?.declaration.inherited === true && heroNative?.nativeDeclarations?.inheritance?.state === 'resolved'
            && slot.declaration.sourceResource === base?.sourceResource && slot.declaration.sourcePath === base?.sourcePath + '.' + slot.slot
            && behavior.has('DOTA_ABILITY_BEHAVIOR_PASSIVE') && behavior.has('DOTA_ABILITY_BEHAVIOR_HIDDEN')
            && numericValue(decodeMechanicsValue(fields.get('MaxLevel'))) > 0
            && numericValue(decodeMechanicsValue(fields.get('RequiredLevel'))) > 0;
        const start = numericValue(heroNative?.nativeDeclarations?.fields?.AbilityTalentStart);
        const sourceStart = heroFields.get('AbilityTalentStart');
        const talentSlot = slot && typeof start === 'number' && Number.isInteger(start) && sourceStart !== undefined
            && numericValue(decodeMechanicsValue(sourceStart)) === start
            && Number(slot.slot.slice(7)) >= start
            && heroNative.talents?.some(row => row.abilityId === ability.engineId && row.slots?.includes(slot.slot));
        const attribute = fields.get('AbilityType') === 'ABILITY_TYPE_ATTRIBUTES';
        const isInnate = numericValue(native?.nativeDeclarations?.fields?.Innate) === 1 && String(fields.get('Innate')) === '1';
        const tags = ability.tags;
        if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string') || stable(tags) !== stable([...new Set(tags)].sort())) throw new Error('Invalid compact ability tags: ' + ability.id);
        const row = { id: ability.engineId };
        const name = compactEnglishName(native, resources);
        if (name !== undefined) row.Name = name;
        Object.assign(row, compactAbilityMetadata(fields));
        if (commonBonus) { row.tags = [...tags]; bonus.push(row); continue; }
        if (attribute || talentSlot) { row.tags = [...tags]; talents.push(row); continue; }
        const type = compactCastingType(fields, native ? boundLocalization(native, resources) : []);
        if (!isInnate) row.order = ability.order;
        if (!isInnate || type !== 'passive' && type !== 'unknown') row.type = type;
        if (type !== 'passive' && type !== 'unknown' && type !== 'placeholder') {
            const activation = activations.get(ability.activationId);
            if (activation && (activation.heroId !== heroId || !activation.abilityIds.includes(ability.id))) throw new Error('Unbound compact activation: ' + ability.id);
            const target = compactTargets(fields);
            if (target.length && type !== 'toggle') row.target = target;
            for (const field of ['manaCost', 'cooldown']) {
                const value = numericValue(activation?.[field]);
                const declared = fields.get(field === 'manaCost' ? 'AbilityManaCost' : 'AbilityCooldown');
                const current = declared === undefined ? undefined : numericValue(decodeMechanicsValue(declared));
                if (value !== undefined && current !== undefined && stable(value) === stable(current)) row[field] = value;
            }
        }
        row.tags = [...tags];
        (isInnate ? innate : skills).push(row);
    }
    return { innate: groupValue(innate), skills, talents, bonus_attributes: groupValue(bonus) };
}

export function compactAbilityEntries(view) {
    const group = value => value === null ? [] : Array.isArray(value) ? value : [value];
    if (!view || typeof view !== 'object' || Array.isArray(view)
        || !Object.hasOwn(view, 'innate') || !Object.hasOwn(view, 'bonus_attributes')
        || !Array.isArray(view.skills) || !Array.isArray(view.talents)) throw new Error('Invalid compact hero ability grouping.');
    return [...group(view.innate), ...view.skills, ...view.talents, ...group(view.bonus_attributes)];
}

export function joinCompactHeroAbilities(graph, heroId, view, records, { validateAbilityView = true } = {}) {
    const byId = new Map(records.filter(row => row.heroId === heroId).map(row => [row.engineId, row]));
    if (byId.size !== records.filter(row => row.heroId === heroId).length) throw new Error('Duplicate canonical ability engine identity: ' + heroId);
    const used = new Set();
    const abilities = compactAbilityEntries(view).map(row => {
        const record = row && byId.get(row.id);
        if (!record || used.has(row.id)) throw new Error('Unknown or repeated compact ability: ' + row?.id);
        if (!Array.isArray(row.tags) || row.tags.some(tag => typeof tag !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(tag))
            || stable(row.tags) !== stable([...new Set(row.tags)].sort())) throw new Error('Invalid compact ability tags: ' + row.id);
        used.add(row.id);
        return { ...record, tags: row.tags };
    });
    if (used.size !== byId.size) throw new Error('Compact hero abilities omit canonical records: ' + heroId);
    if (validateAbilityView) {
        const projection = compactHeroAbilities({ ...graph, entities: { ...graph.entities, abilities } }, heroId);
        if (stable(projection) !== stable(view)) throw new Error('Compact hero ability projection does not match canonical source: ' + heroId);
    }
    return records.filter(row => row.heroId === heroId).map(row => ({ ...row, tags: abilities.find(ability => ability.id === row.id).tags }));
}

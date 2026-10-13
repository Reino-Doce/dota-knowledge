import { abilityTagCatalog } from './catalog.mjs';
import { inferNativeTags } from './native-semantics.mjs';
import { inferLinkedBonusTags, inferStatBonusTags } from './native-stat-bonuses.mjs';
import { inferUtilityTags } from './native-utility.mjs';
import { inferUnitTags } from './native-unit-tags.mjs';
import { inferFieldLabelTags } from './native-field-labels.mjs';
import { decodeMechanicsValue } from '../mechanics-values.mjs';

const sha256 = /^[a-f0-9]{64}$/;
const own = (value, path) => path.reduce((node, key) => node && Object.hasOwn(node, key) ? node[key] : undefined, value);
const merge = (base, override) => base && override && typeof base === 'object' && typeof override === 'object'
    && !Array.isArray(base) && !Array.isArray(override) ? Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(override)])].sort().map(key =>
        [key, Object.hasOwn(override, key) ? merge(base[key], override[key]) : base[key]])) : override === undefined ? base : override;

export function selectedResources(graph) {
    const resources = new Map();
    for (const source of graph.sources ?? []) {
        if (source.sourceKind !== 'installed-game-resource' || !sha256.test(source.sha256 ?? '')
            || !source.build || !graph.metadata?.build
            || !['clientVersion', 'serverVersion', 'sourceRevision'].every(field => source.build[field] === graph.metadata.build[field])) continue;
        const hashes = resources.get(source.resource) ?? new Set();
        hashes.add(source.sha256);
        resources.set(source.resource, hashes);
    }
    return new Set([...resources].filter(([, hashes]) => hashes.size === 1).map(([resource]) => resource));
}

export function hasSource(resources, resource, path, value) {
    return typeof path === 'string' && path.length > 0 && value !== undefined && resources.has(resource);
}

function nativeValue(native, field) {
    const isValue = Object.hasOwn(native.raw?.AbilityValues ?? {}, field)
        || !Object.hasOwn(native.raw ?? {}, field) && Object.hasOwn(native.nativeDeclarations?.fields?.AbilityValues?.branches ?? {}, field);
    const prefix = isValue ? 'AbilityValues.' + field : field;
    const declaration = isValue ? native.nativeDeclarations?.fields?.AbilityValues?.branches?.[field] : native.nativeDeclarations?.fields?.[field];
    if (['unsupported', 'unknown'].includes(declaration?.state)
        || isValue && native.nativeDeclarations?.fields?.AbilityValues?.state === 'unsupported') return undefined;
    const explicit = isValue ? native.raw?.AbilityValues?.[field] : native.raw?.[field];
    const raw = merge(declaration?.raw, explicit);
    if (raw === undefined) return undefined;
    const leaves = [];
    let unsupported = false, conflicted = false;
    const walk = (value, parts = []) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [key, child] of Object.entries(value)) walk(child, [...parts, key]);
            return;
        }
        const relative = [prefix, ...parts].join('.');
        const normalized = parts.reduce((node, key) => key === 'value' ? node?.base : node?.branches?.[key], declaration);
        const explicitLeaf = parts.length ? own(explicit, parts) : explicit;
        if (['unsupported', 'unknown'].includes(normalized?.state) && explicitLeaf === undefined) { unsupported = true; return; }
        const provenance = explicitLeaf !== undefined ? { sourceResource: native.sourceResource, sourcePath: native.sourcePath + '.' + relative }
            : native.nativeDeclarations?.leafProvenance?.[relative] ?? (parts.length ? null : declaration);
        if (!provenance?.sourceResource || !provenance.sourcePath) { unsupported = true; return; }
        if (explicitLeaf === undefined && normalized?.sourceResource && normalized?.sourcePath
            && (normalized.sourceResource !== provenance.sourceResource || normalized.sourcePath !== provenance.sourcePath)) {
            conflicted = true;
            return;
        }
        leaves.push({ raw: value, resource: provenance.sourceResource, path: provenance.sourcePath });
    };
    walk(raw);
    return conflicted || unsupported || !leaves.length ? undefined : { raw, leaves };
}

export function boundFields(native, resources) {
    const fields = new Map();
    const keys = new Set([
        ...Object.keys(native.raw ?? {}),
        ...Object.keys(native.nativeDeclarations?.fields ?? {}),
        ...Object.keys(native.raw?.AbilityValues ?? {}),
        ...Object.keys(native.nativeDeclarations?.fields?.AbilityValues?.branches ?? {}),
    ]);
    keys.delete('AbilityValues');
    for (const field of [...keys].sort()) {
        const value = nativeValue(native, field);
        if (value && value.leaves.every(leaf => hasSource(resources, leaf.resource, leaf.path, leaf.raw))) fields.set(field, value.raw);
    }
    return fields;
}

export function boundLocalization(native, resources) {
    if (native.localization?.state !== 'known') return [];
    const root = 'DOTA_Tooltip_ability_' + native.abilityId;
    const prefix = root + '_';
    const snippets = [];
    const conflictingTokens = new Set((native.localization.conflictingTokens ?? [])
        .filter(token => typeof token === 'string').map(token => token.toLowerCase()));
    for (const [token, text] of Object.entries(native.localization.tokens ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        if (!(token.toLowerCase() === root.toLowerCase() || token.toLowerCase().startsWith(prefix.toLowerCase())) || typeof text !== 'string'
            || conflictingTokens.has(token.toLowerCase())) continue;
        const suffix = token.length === root.length ? '' : token.slice(prefix.length);
        const rows = native.localization.tokenSources?.[token] ?? [];
        if (rows.some(row => row.state === 'known' && row.raw !== text)) continue;
        if (!rows.some(row => row.state === 'known' && row.raw === text
            && hasSource(resources, row.sourceResource, row.sourcePath, row.raw))) continue;
        snippets.push({ suffix, text });
    }
    return snippets;
}

function targetingTeams(fields) {
    const flags = new Set(String(fields.get('AbilityUnitTargetTeam') ?? '').split('|').map(value => value.trim()));
    return [...new Set([
        ...(flags.has('DOTA_UNIT_TARGET_TEAM_FRIENDLY') || flags.has('DOTA_UNIT_TARGET_TEAM_BOTH') ? ['self', 'ally'] : []),
        ...(flags.has('DOTA_UNIT_TARGET_TEAM_ENEMY') || flags.has('DOTA_UNIT_TARGET_TEAM_BOTH') ? ['enemy'] : []),
    ])];
}

function inheritedLocalization(native, hero, resources, active = new Set()) {
    const localized = boundLocalization(native, resources);
    if (localized.some(row => /^description$/i.test(row.suffix)) || active.has(native.abilityId)) return localized;
    const parentId = native.raw?._base;
    const inheritance = native.nativeDeclarations?.inheritance;
    if (typeof parentId !== 'string' || inheritance?.state !== 'resolved') return localized;
    const edge = inheritance.chain?.find(row => row.parentId === parentId && row.state === 'resolved'
        && row.sourceResource === native.sourceResource && row.sourcePath === native.sourcePath + '._base');
    const parent = hero.abilities?.find(row => row.abilityId === parentId);
    if (!edge || parent?.state !== 'known' || !parent.raw
        || edge.parent?.sourceResource !== parent.sourceResource || edge.parent?.sourcePath !== parent.sourcePath
        || !hasSource(resources, edge.sourceResource, edge.sourcePath, parentId)
        || !hasSource(resources, parent.sourceResource, parent.sourcePath, parent.raw)) return localized;
    if (Object.hasOwn(native.raw, 'BaseClass')) {
        const handler = boundFields(native, resources).get('BaseClass');
        const parentHandler = boundFields(parent, resources).get('BaseClass');
        if (typeof handler !== 'string' || handler !== parentId && handler !== parentHandler) return localized;
    }
    const suffixes = new Set(localized.map(row => row.suffix.toLowerCase()));
    return [...localized, ...inheritedLocalization(parent, hero, resources, new Set([...active, native.abilityId]))
        .filter(row => !suffixes.has(row.suffix.toLowerCase()))];
}

export function boundNode(native, node, relative, resources) {
    if (!node || !['known', 'decoded'].includes(node.state)
        || !hasSource(resources, node.sourceResource, node.sourcePath, node.raw)) return false;
    const explicit = own(native.raw, relative.split('.'));
    const provenance = explicit !== undefined ? { sourceResource: native.sourceResource, sourcePath: native.sourcePath + '.' + relative }
        : native.nativeDeclarations?.leafProvenance?.[relative];
    if (provenance?.sourceResource !== node.sourceResource || provenance?.sourcePath !== node.sourcePath
        || explicit !== undefined && JSON.stringify(explicit) !== JSON.stringify(node.raw)) return false;
    // Preserve the decoder's condition grammar: a bare negative base is a
    // signed number, while a negative conditional operand means subtraction.
    // This synthetic syntax wrapper supplies that context without using an
    // ability identity to decide its gameplay contribution.
    const decoded = node.branchKind === 'condition'
        ? decodeMechanicsValue({ special_bonus_condition: node.raw }).branches.special_bonus_condition
        : decodeMechanicsValue(node.raw);
    const interpretation = value => ({ state: value.state, kind: value.kind,
        ...(Object.hasOwn(value, 'value') ? { value: value.value } : {}),
        ...(Object.hasOwn(value, 'expression') ? { expression: value.expression } : {}) });
    return JSON.stringify(interpretation(node)) === JSON.stringify(interpretation(decoded));
}

function linkedOperations(node) {
    if (node?.kind !== 'expression' || node.state !== 'decoded' || !node.expression?.operations?.length) return null;
    const operations = node.expression.operations;
    if (!node.expression.rankIndexed) return operations;
    if (!operations.every(operation => operation.operator === operations[0].operator)) return null;
    return [{ operator: operations[0].operator, operand: operations.map(operation => operation.operand) }];
}

function addLinkedTags(contexts, resources) {
    const byHero = new Map();
    for (const context of contexts) {
        const abilities = byHero.get(context.ability.heroId) ?? new Map();
        abilities.set(context.ability.engineId, context);
        byHero.set(context.ability.heroId, abilities);
    }
    // A linked bonus must use the parent's own capability proof, not a tag
    // supplied by an earlier bonus in the entity iteration order.
    const parents = contexts.map(context => ({ ...context, tags: new Set(context.tags) }));
    for (const parent of parents) {
        if (!parent.fields) continue;
        const targets = byHero.get(parent.ability.heroId);
        const walk = (node, field, relative) => {
            if (!node || ['unknown', 'unsupported'].includes(node.state)) return;
            const base = node.base;
            for (const [key, branch] of Object.entries(node.branches ?? {})) {
                const target = targets.get(key);
                if (target && branch.branchKind === 'condition'
                    && base?.state === 'known' && ['number', 'rank-values'].includes(base.kind)
                    && boundNode(parent.native, base, relative + '.value', resources)
                    && boundNode(parent.native, branch, relative + '.' + key, resources)) {
                    const operations = linkedOperations(branch);
                    if (operations) {
                        const tags = inferLinkedBonusTags({ field, base: base.value, operations,
                            parentTags: parent.tags, parentTeams: parent.teams, parentEffects: parent.effects,
                            fieldLabel: parent.fieldLabels.find(row => row.field.toLowerCase() === field.toLowerCase())?.text ?? '',
                            targetLabel: target.abilityLabel ?? '' });
                        for (const tag of tags) target.tags.add(tag);
                    }
                }
                // A condition wrapper can itself have an ability record and
                // still contain an independent linked modifier. Continue to
                // its children; each level must supply its own bound base.
                if (!target || branch?.kind === 'conditional-value' && branch.branchKind === 'condition') {
                    walk(branch, field, relative + '.' + key);
                }
            }
        };
        for (const [field, node] of Object.entries(parent.native.nativeDeclarations?.fields ?? {})) {
            if (field === 'AbilityValues') {
                if (node.state === 'unsupported') continue;
                for (const [key, value] of Object.entries(node.branches ?? {})) walk(value, key, 'AbilityValues.' + key);
            } else walk(node, field, field);
        }
    }
}

/** Infer capability tags from source-backed declarations and gameplay semantics, without identity-specific rules. */
export function deriveAbilityTags(graph) {
    const resources = selectedResources(graph);
    const nativeRows = graph.entities.abilities.map(ability => {
        const hero = graph.guides.get(ability.heroId)?.native;
        return hero?.abilities?.find(row => row.abilityId === ability.engineId);
    });
    if (nativeRows.some(native => native?.sourceResource || native?.localization?.state === 'known') && !resources.size) {
        throw new Error('Ability tags cannot be derived without a source selected for the graph build.');
    }
    for (const native of nativeRows) if (native?.sourceResource && !resources.has(native.sourceResource)) {
        throw new Error('Ability tag source does not match the graph build: ' + native.sourceResource);
    }
    for (const native of nativeRows) if (native?.state === 'known' && native.raw
        && !hasSource(resources, native.sourceResource, native.sourcePath, native.raw)) {
        throw new Error('Ability tag source is incomplete for the graph build: ' + (native.sourceResource ?? native.abilityId));
    }
    const effectsByAbility = new Map();
    for (const effect of graph.entities.effects) {
        const effects = effectsByAbility.get(effect.abilityId) ?? [];
        effects.push(effect);
        effectsByAbility.set(effect.abilityId, effects);
    }
    const allowed = new Set(abilityTagCatalog.tags.map(row => row.key));
    const contexts = graph.entities.abilities.map(ability => {
        const hero = graph.guides.get(ability.heroId)?.native;
        const native = hero?.abilities?.find(row => row.abilityId === ability.engineId);
        const localized = native
            ? native.state === 'known' && native.raw ? inheritedLocalization(native, hero, resources) : boundLocalization(native, resources)
            : [];
        const abilityLabel = localized.find(row => row.suffix === '')?.text;
        const context = { ability, native, abilityLabel, tags: new Set(), effects: effectsByAbility.get(ability.id) ?? [] };
        if (native?.state === 'known' && native.raw && hasSource(resources, native.sourceResource, native.sourcePath, native.raw)) {
            const fields = boundFields(native, resources);
            const behavior = new Set(String(fields.get('AbilityBehavior') ?? '').split('|').map(value => value.trim()).filter(Boolean));
            const fieldNames = new Map([...fields.keys()].map(field => [field.toLowerCase(), field]));
            const fieldLabels = localized.filter(row => fieldNames.has(row.suffix.toLowerCase()))
                .map(row => ({ field: fieldNames.get(row.suffix.toLowerCase()), text: row.text }));
            const snippets = localized.filter(row => /^(?:description|note\d+|(?:scepter|shard)_description|facet_.+)$/i.test(row.suffix));
            const actorNames = [hero.name, ...Object.entries(hero.localization?.tokens ?? {})
                .filter(([key]) => /(?:__en)?:n$/i.test(key)).map(([, value]) => value)].filter(value => typeof value === 'string' && value.length > 0);
            const teams = [...new Set([...targetingTeams(fields), ...context.effects.flatMap(effect =>
                effect.targets?.teams?.state === 'known' ? effect.targets.teams.value ?? [] : [])])];
            if (!teams.length && (behavior.has('DOTA_ABILITY_BEHAVIOR_PASSIVE') || behavior.has('DOTA_ABILITY_BEHAVIOR_NO_TARGET'))) teams.push('self');
            context.tags = inferNativeTags({ fields, fieldLabels, snippets, abilityLabel,
                effects: context.effects,
                behavior, nativeTeams: targetingTeams(fields), actorNames });
            for (const tag of inferUtilityTags({ fields, snippets,
                behavior, nativeTeams: targetingTeams(fields), actorNames })) context.tags.add(tag);
            for (const tag of inferFieldLabelTags({ fields, fieldLabels, snippets, effects: context.effects,
                behavior, nativeTeams: targetingTeams(fields), actorNames })) context.tags.add(tag);
            for (const tag of inferUnitTags({ native, units: hero.unitDependencies ?? [], fields, snippets,
                effects: context.effects, behavior, nativeTeams: targetingTeams(fields),
                isBound: (record, node, relative) => boundNode(record, node, relative, resources) })) context.tags.add(tag);
            for (const tag of inferStatBonusTags({ fields, behavior, abilityLabel })) context.tags.add(tag);
            if (behavior.has('DOTA_ABILITY_BEHAVIOR_CHANNELLED')) context.tags.add('channeled');
            if (behavior.has('DOTA_ABILITY_BEHAVIOR_AOE')) context.tags.add('aoe');
            if (behavior.has('DOTA_ABILITY_BEHAVIOR_AURA')) context.tags.add('aura');
            // A hostile cast target and the beneficiary of an owned stat grant
            // can differ. Existing recipient-specific inference supplies proof
            // for linked stat changes without guessing from the cast target.
            if ([...context.tags].some(tag => tag.startsWith('self_')) && !teams.includes('self')) teams.push('self');
            if ([...context.tags].some(tag => tag.startsWith('ally_')) && !teams.includes('ally')) teams.push('ally');
            Object.assign(context, { fields, fieldLabels, teams });
        }
        return context;
    });
    addLinkedTags(contexts, resources);
    const abilities = contexts.map(({ ability, tags }) => {
        for (const tag of tags) if (!allowed.has(tag)) throw new Error('Ability tag is absent from data/tags/index.json: ' + tag);
        return { ...Object.fromEntries(Object.entries(ability).filter(([key]) => !['tags', 'tagAssertions'].includes(key))), tags: [...tags].sort() };
    });
    return { abilities, tagIndex: abilityTagCatalog };
}

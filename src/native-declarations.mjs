import { normalizeMechanicsValue } from './native-import.mjs';

export const NATIVE_DECLARATION_DECODER_VERSION = 'native-declarations-3';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const source = record => ({ sourceResource: record.sourceResource, sourcePath: record.sourcePath });
const sameSource = (left, right) => left.sourceResource === right.sourceResource && left.sourcePath === right.sourcePath;

/** Resolve explicit declaration templates. This is a source overlay, not an engine execution model. */
export function decodeNativeDeclarations(record, base, { findParent, ambiguities = () => [], exclude = [], maxDepth = 64 } = {}) {
    const issues = [];
    const chain = [];
    const layer = (value, at, depth = 0) => {
        if (depth > maxDepth) throw new Error('Native declaration depth bound exceeded.');
        return { raw: value, ...source(at), alternatives: ambiguities(at.sourceResource, at.sourcePath), overrides: [],
            ...(object(value) ? { children: Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
                layer(child, { ...at, sourcePath: `${at.sourcePath}.${key}` }, depth + 1)])) } : {}) };
    };
    const merge = (prior, next) => {
        if (!prior) return next;
        const overrides = [...next.overrides, source(prior), ...prior.overrides];
        if (!prior.children || !next.children) return { ...next, overrides };
        const children = Object.assign(Object.create(null), prior.children);
        for (const [key, child] of Object.entries(next.children)) children[key] = merge(children[key], child);
        return { ...next, children, overrides, raw: Object.fromEntries(Object.entries(children).map(([key, child]) => [key, child.raw])) };
    };
    const issue = (reason, current, extra = {}) => {
        const row = { state: 'unsupported', reason, ...source(current), ...extra };
        issues.push(row);
        return row;
    };
    const resolve = (current, active = []) => {
        if (!object(current.raw)) return null;
        const identity = `${current.sourceResource}:${current.sourcePath}`;
        if (active.length > maxDepth) {
            issue('explicit-parent-depth-bound', current);
            return null;
        }
        if (active.includes(identity)) {
            issue('explicit-parent-cycle', current, { cycle: [...active, identity] });
            return null;
        }
        let inherited = null;
        if (Object.hasOwn(current.raw, '_base')) {
            const at = { ...current, sourcePath: `${current.sourcePath}._base` };
            const id = current.raw._base;
            const duplicate = ambiguities(at.sourceResource, at.sourcePath);
            if (duplicate.length) issue('duplicate-parent-declaration', at, { raw: id, alternatives: duplicate });
            else if (typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(id)) {
                issue('unsupported-parent-reference', at, { raw: id });
            }
            else {
                const parent = findParent?.(id, current);
                const parentDuplicates = parent && ambiguities(parent.sourceResource, parent.sourcePath)
                    .filter(row => row.path === parent.sourcePath || parent.sourcePath?.startsWith(`${row.path}.`));
                const edge = { parentId: id, ...source(at), parent: parent ? source(parent) : null };
                chain.push(edge);
                if (!object(parent?.raw)) {
                    edge.state = 'unsupported';
                    issue(parent?.reason || 'parent-definition-unavailable', at, { raw: id, candidates: parent?.candidates || [] });
                }
                else if (parentDuplicates.length) {
                    edge.state = 'unsupported';
                    issue('duplicate-parent-definition', at, { raw: id, alternatives: parentDuplicates });
                }
                else {
                    const before = issues.length;
                    inherited = resolve(parent, [...active, identity]);
                    edge.state = before === issues.length ? 'resolved' : 'partial';
                }
            }
        }
        return merge(inherited, layer(current.raw, current));
    };
    const explicit = resolve(record);
    const effective = explicit ? merge(object(base?.raw) ? layer(base.raw, base) : null, explicit) : null;
    const leafProvenance = Object.create(null);
    const unresolvedParent = issues.length ? { ...issues[0], raw: record.raw?._base ?? issues[0].raw } : null;
    let unresolvedDeclaration = false;
    const decode = (node, fieldPath, depth = 0, priorDecoded = null) => {
        if (depth > maxDepth) throw new Error('Native declaration depth bound exceeded.');
        const inherited = !sameSource(node, { ...record, sourcePath: `${record.sourcePath}.${fieldPath}` });
        const normalized = { ...(priorDecoded || normalizeMechanicsValue(node.raw, source(node))), ...source(node) };
        const inheritedDefault = node.sourceResource === base?.sourceResource && node.sourcePath.startsWith(`${base?.sourcePath}.`);
        const descendants = node.children ? Object.fromEntries(Object.entries(node.children).map(([key, child]) =>
            [key, decode(child, `${fieldPath}.${key}`, depth + 1, key === 'value' ? normalized.base : normalized.branches?.[key])])) : null;
        if (descendants) {
            normalized.base = descendants.value || normalizeMechanicsValue(undefined, { ...source(node), sourcePath: `${node.sourcePath}.value` });
            normalized.branches = Object.fromEntries(Object.entries(descendants).filter(([key]) => key !== 'value').map(([key, child]) =>
                [key, { ...child, ...(normalized.branches?.[key]?.branchKind ? { branchKind: normalized.branches[key].branchKind } : {}) }]));
            normalized.provenance = 'per-leaf';
        }
        else leafProvenance[fieldPath] = { ...source(node), inherited, overrides: node.overrides };
        const alternatives = node.children ? node.alternatives.filter(row => row.path === node.sourcePath
            || node.sourcePath.startsWith(`${row.path}.`)) : node.alternatives;
        if (alternatives.length || (issues.length && inheritedDefault)) {
            delete normalized.value;
            normalized.state = 'unsupported';
            normalized.reason = alternatives.length ? 'duplicate-declaration' : 'explicit-parent-inheritance-unresolved';
            if (alternatives.length) normalized.alternatives = alternatives;
        }
        if (['unsupported', 'unknown'].includes(normalized.state)) unresolvedDeclaration = true;
        return { ...normalized, inherited };
    };
    const fields = Object.fromEntries(Object.entries(effective?.children || {}).filter(([key]) => !exclude.includes(key)).sort(([a], [b]) =>
        a.localeCompare(b)).map(([key, value]) => [key, decode(value, key)]));
    return { state: explicit && !issues.length && !unresolvedDeclaration ? 'known' : 'partial',
        method: 'recursive-explicit-template-and-default-overlay', base: base ? source(base) : null,
        inheritance: { state: issues.length ? 'partial' : explicit ? 'resolved' : 'unknown', chain, issues },
        ...(unresolvedParent ? { unresolvedParent } : {}), fields, leafProvenance,
        interpretation: 'Explicit keys recursively override template and default declarations. Engine dispatch, implicit defaults and execution remain unverified.' };
}

const sections = {
    behavior: ['AbilityBehavior', 'AbilityType', 'BaseClass', 'Innate', 'IsCastableWhileHidden', 'HasSubAbility', 'IsBreakable'],
    targeting: ['AbilityUnitTargetTeam', 'AbilityUnitTargetType', 'AbilityUnitTargetFlags', 'AbilityUnitTargetFlag', 'AbilityCastRange', 'AbilityCastRangeBuffer'],
    damage: ['AbilityDamage', 'AbilityDamageType', 'AbilityUnitDamageType', 'AbilityModifierSupportBonus', 'AbilityModifierSupportValue'],
    immunity: ['SpellImmunityType'],
    dispel: ['SpellDispellableType'],
    timing: ['AbilityCastPoint', 'AbilityChannelTime', 'AbilityCooldown', 'AbilityDuration', 'AbilityChargeRestoreTime', 'AbilitySharedCooldown'],
    costs: ['AbilityManaCost', 'AbilityHealthCost', 'AbilityCharges', 'InitialAbilityCharges'],
    progression: ['MaxLevel', 'RequiredLevel', 'LevelsBetweenUpgrades', 'RestrictValuesToMaxLevel'],
    upgrades: ['HasScepterUpgrade', 'HasShardUpgrade', 'IsGrantedByScepter', 'IsGrantedByShard', 'IsShardUpgrade', 'ScepterUpgradeID', 'ShardUpgradeID'],
    links: ['_base', 'LinkedAbility', 'LinkedAbilities', 'DependentOnAbility', 'AssociatedPrimaryAbilities', 'AssociatedSecondaryAbilities',
        'SubAbilityNames', 'FakeSubAbilityNames', 'ad_linked_ability', 'AbilityDraftExtraAbilities', 'AbilityDraftUltShardAbility', 'SpecialBonusIntrinsicModifier'],
    presentation: ['AbilityCastAnimation', 'AbilityCastGestureSlot', 'AbilityChannelAnimation', 'AbilitySound', 'AbilityTextureName', 'AnimationIgnoresModelScale',
        'AnimationPlaybackRate', 'DisplayAdditionalHeroes', 'EnableChargeDisplayOverride', 'FightRecapLevel', 'HotKeyOverride', 'OnCastbar', 'OnLearnbar',
        'ShowCooldownInTooltips', 'TooltipSummaryProperties', 'precache'],
};
const branchKind = key => /^special_bonus_shard(?:_|$)/.test(key) ? 'shard' : /^special_bonus_scepter(?:_|$)/.test(key) ? 'scepter'
    : /^special_bonus_facet(?:_|$)/.test(key) ? 'facet' : /^special_bonus_/.test(key) ? 'talent-reference'
        : /scepter/i.test(key) ? 'scepter-declaration' : /shard/i.test(key) ? 'shard-declaration' : /facet/i.test(key) ? 'facet-declaration'
            : /^(?:Requires|IsGrantedBy|Has.+Upgrade)/.test(key) ? 'condition-declaration' : null;

/** A compact semantic index: the typed source values live once in nativeDeclarations.fields. */
export function indexDecodedAbilityMechanics(nativeDeclarations, linkedEntities = []) {
    const fields = nativeDeclarations.fields;
    const remaining = new Set(Object.keys(fields));
    const index = Object.fromEntries(Object.entries(sections).map(([name, keys]) => [name, keys.filter(key => {
        if (!Object.hasOwn(fields, key)) return false;
        remaining.delete(key);
        return true;
    })]));
    const valueFields = ['AbilityValues', 'AbilitySpecial'].filter(key => remaining.delete(key));
    index.other = [...remaining];
    const branches = [];
    const gaps = [...nativeDeclarations.inheritance.issues];
    const visit = (node, fieldPath) => {
        if (['unsupported', 'unknown'].includes(node.state) && node.raw !== undefined) gaps.push({ fieldPath, state: node.state,
            reason: node.reason || 'unresolved-declaration-syntax', ...source(node) });
        if (node.base?.raw !== undefined) visit(node.base, `${fieldPath}.value`);
        for (const [key, child] of Object.entries(node.branches || {})) {
            const kind = branchKind(key);
            if (kind) branches.push({ fieldPath: `${fieldPath}.${key}`, kind, ...source(child) });
            visit(child, `${fieldPath}.${key}`);
        }
    };
    for (const [key, field] of Object.entries(fields)) {
        const kind = branchKind(key);
        if (kind) branches.push({ fieldPath: key, kind, ...source(field) });
        visit(field, key);
    }
    if (!Object.keys(fields).length) gaps.push({ state: 'unknown', reason: 'ability-definition-unavailable' });
    return { decoderVersion: NATIVE_DECLARATION_DECODER_VERSION, evidenceKind: 'installed-declaration-projection',
        state: gaps.length ? 'partial' : 'decoded', declarationsPath: 'nativeDeclarations.fields', sections: index, valueFields, branches,
        linkedEntities, gaps, completeMechanics: false, engineBehavior: 'unverified',
        interpretation: 'Field names and typed declarations describe declared targeting, values and conditions; they do not prove runtime effects or tactical roles.' };
}

/** Lossless declaration syntax. A decoded token is not a verified engine effect. */
export const MECHANICS_VALUE_DECODER_VERSION = 'hero-mechanics-values-1';
export const MECHANICS_VALUE_LIMITS = Object.freeze({ depth: 32, nodes: 8192, entries: 2048, tokens: 512, stringLength: 65536 });
const signedNumberPattern = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const enumPattern = /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|k[A-Z][A-Za-z0-9]+)$/;
const referencePattern = /^(?:npc_dota_|special_bonus_|item_|modifier_)[a-zA-Z0-9_]+$/;
const metadataKeys = new Set(['affected_by_aoe_increase', 'CalculateSpellDamageTooltip', 'DamageTypeTooltip', 'display_type',
    'dynamic_value', 'levelkey', 'levelup_interval', 'RequiresShard', 'RequiresScepter']);
const role = key => /^special_bonus_[a-zA-Z0-9_]+$/.test(key) ? 'condition'
    : key === 'hero_levelup' ? 'progression' : metadataKeys.has(key) ? 'metadata' : 'field';
const childSource = (source, key) => ({ ...source, ...(source.sourcePath ? { sourcePath: `${source.sourcePath}.${key}` } : {}) });

function expression(tokens, conditional) {
    let initialPrefix = null;
    const operations = tokens.map((token, index) => {
        const match = token.match(/^([+=x*/-]?)(.*?)(%)?$/);
        if (!match || !signedNumberPattern.test(match[2])) return null;
        const operand = Number(match[2]);
        if (!Number.isFinite(operand)) return null;
        if (index === 0) initialPrefix = match[1];
        // Some retained rank sequences use one leading operator: "+4 7 10 13".
        const prefix = match[1] || (index > 0 ? initialPrefix : '');
        if (match[3]) {
            if (!['', '+', '-'].includes(prefix)) return null;
            return { operator: prefix === '+' ? 'percent-add' : prefix === '-' ? 'percent-subtract' : 'percent', operand };
        }
        if (!prefix || (prefix === '-' && !conditional)) return null;
        return { operator: ({ '+': 'add', '-': 'subtract', '=': 'replace', x: 'multiply', '*': 'multiply', '/': 'divide' })[prefix], operand };
    });
    return operations.every(Boolean) ? { operations, rankIndexed: operations.length > 1 } : null;
}

export function decodeMechanicsValue(raw, source = {}) {
    let nodes = 0;
    const active = new Set();
    const visit = (value, origin, depth, branchKind = null) => {
        nodes += 1;
        if (nodes > MECHANICS_VALUE_LIMITS.nodes || depth > MECHANICS_VALUE_LIMITS.depth) throw new Error('Mechanics value exceeds decoding bounds.');
        const record = { ...origin, ...(value === undefined ? {} : { raw: value }) };
        if (value === undefined) return { ...record, state: 'unknown', kind: 'missing' };
        if (value === null) return { ...record, state: 'decoded', kind: 'null', decoded: null };
        if (typeof value === 'boolean') return { ...record, state: 'decoded', kind: 'boolean', decoded: value };
        if (typeof value === 'number') return Number.isFinite(value) ? { ...record, state: 'known', kind: 'number', value }
            : { ...record, state: 'unsupported', kind: 'invalid-number', reason: 'non-finite-number' };
        if (typeof value === 'object') {
            if (active.has(value)) throw new Error('Cyclic mechanics value.');
            if (![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) throw new Error('Invalid mechanics value object.');
            const entries = Object.entries(value);
            if (entries.length > MECHANICS_VALUE_LIMITS.entries) throw new Error('Mechanics value exceeds decoding bounds.');
            active.add(value);
            if (Array.isArray(value)) {
                const elements = value.map((item, index) => visit(item, childSource(origin, index), depth + 1));
                active.delete(value);
                return { ...record, state: 'decoded', kind: 'array', elements };
            }
            const branches = Object.fromEntries(entries.filter(([key]) => key !== 'value').map(([key, item]) => {
                const branch = role(key);
                return [key, { ...visit(item, childSource(origin, key), depth + 1, branch), branchKind: branch }];
            }));
            const base = visit(value.value, childSource(origin, 'value'), depth + 1);
            active.delete(value);
            return { ...record, state: 'decoded', kind: Object.hasOwn(value, 'value')
                || Object.values(branches).some(branch => ['condition', 'progression'].includes(branch.branchKind)) ? 'conditional-value' : 'object',
            base, branches };
        }
        if (typeof value !== 'string') throw new Error('Invalid mechanics value type.');
        if (value.length > MECHANICS_VALUE_LIMITS.stringLength) throw new Error('Mechanics value exceeds decoding bounds.');
        const text = value.trim();
        const tokens = text ? text.split(/\s+/) : [];
        if (tokens.length > MECHANICS_VALUE_LIMITS.tokens) throw new Error('Mechanics value exceeds decoding bounds.');
        const operation = tokens.length ? expression(tokens, ['condition', 'progression'].includes(branchKind)) : null;
        if (operation) return { ...record, state: 'decoded', kind: 'expression', expression: operation };
        if (tokens.length && tokens.every(token => signedNumberPattern.test(token) && Number.isFinite(Number(token)))) {
            const values = tokens.map(Number);
            return { ...record, state: 'known', kind: values.length === 1 ? 'number' : 'rank-values', value: values.length === 1 ? values[0] : values };
        }
        if (text === 'true' || text === 'false') return { ...record, state: 'decoded', kind: 'boolean', decoded: text === 'true' };
        const flags = text.split('|').map(token => token.trim());
        if (flags.length > 1 && flags.every(token => enumPattern.test(token))) return { ...record, state: 'decoded', kind: 'flags', decoded: flags };
        if (enumPattern.test(text)) return { ...record, state: 'decoded', kind: 'enum', decoded: text };
        if (referencePattern.test(text)) return { ...record, state: 'decoded', kind: 'reference', decoded: text, resolution: 'unresolved-reference' };
        if (/^(?:[+=x*/]|-\d)/.test(text) || /\s[+*/%-]\s/.test(text)) {
            return { ...record, state: 'unsupported', kind: 'unparsed-expression', reason: 'expression-grammar-unsupported' };
        }
        return { ...record, state: 'decoded', kind: 'string', decoded: value };
    };
    return visit(raw, source, 0);
}

/** Resolve only a declared branch calculation. Rank is a one-based declaration index, not inferred hero level.
 * Conditions require explicit true/false; progression requires an explicit application count. Display/scaling metadata
 * remains attached but is not applied. This is never an attribute-modified or engine-verified gameplay value.
 */
export function resolveMechanicsValue(decoded, { rank = null, conditions = {}, progression = {}, branchOrder = null,
    baseValue = undefined, branchOperations = {}, percentMode = null } = {}) {
    const pending = (reason, detail = {}) => ({ state: 'unresolved', scope: 'declared-branch-value', reason, ...detail });
    const known = (value, detail = {}) => ({ state: 'known', scope: 'declared-branch-value', value, ...detail });
    const select = values => {
        if (!Array.isArray(values)) return known(values);
        if (values.length === 1) return known(values[0]);
        return Number.isInteger(rank) && rank >= 1 && rank <= values.length ? known(values[rank - 1]) : pending('explicit-valid-rank-required');
    };
    const literal = node => {
        if (node?.state === 'known' && Object.hasOwn(node, 'value')) return select(node.value);
        if (node?.state === 'decoded' && ['enum', 'flags', 'boolean', 'string', 'null'].includes(node.kind)) return known(node.decoded);
        return pending(node?.kind === 'reference' ? 'reference-target-unresolved' : 'literal-value-unresolved');
    };
    const apply = (node, current, branchKey = null, count = 1) => {
        let operation;
        if (node?.kind === 'expression') {
            const selected = select(node.expression?.operations);
            if (selected.state !== 'known') return selected;
            operation = selected.value;
        }
        else {
            const selected = literal(node);
            if (selected.state !== 'known') return selected;
            if (!branchKey) return selected;
            if (!Object.hasOwn(branchOperations, branchKey)) return pending('explicit-branch-operation-required', { branchKey });
            operation = { operator: branchOperations[branchKey], operand: selected.value };
        }
        const { operator, operand } = operation || {};
        if (!Number.isFinite(operand)) return pending('numeric-operand-required');
        if (operator === 'replace') return known(operand);
        if (!Number.isFinite(current)) return pending('explicit-numeric-base-required');
        let result;
        if (operator === 'add') result = current + operand * count;
        else if (operator === 'subtract') result = current - operand * count;
        else if (operator === 'multiply') result = current * operand ** count;
        else if (operator === 'divide' && operand !== 0) result = current / operand ** count;
        else if (operator === 'percent-add') result = current * (1 + operand / 100) ** count;
        else if (operator === 'percent-subtract') result = current * (1 - operand / 100) ** count;
        else if (operator === 'percent' && percentMode === 'scale-base') result = current * (operand / 100) ** count;
        else return pending(operator === 'percent' ? 'explicit-percent-meaning-required' : 'operation-unsupported');
        return Number.isFinite(result) ? known(result) : pending('non-finite-result');
    };
    if (decoded?.kind === 'expression') return apply(decoded, baseValue);
    if (decoded?.kind !== 'conditional-value') return literal(decoded);
    const metadata = Object.fromEntries(Object.entries(decoded.branches || {}).filter(([, node]) => node.branchKind === 'metadata'));
    const active = [];
    const unresolved = [];
    for (const [key, node] of Object.entries(decoded.branches || {})) {
        if (node.branchKind === 'metadata') continue;
        if (node.branchKind === 'condition') {
            if (!Object.hasOwn(conditions, key) || typeof conditions[key] !== 'boolean') unresolved.push(key);
            else if (conditions[key]) active.push({ key, node, count: 1 });
        }
        else if (node.branchKind === 'progression') {
            if (!Object.hasOwn(progression, key) || !Number.isInteger(progression[key]) || progression[key] < 0 || progression[key] > 256) unresolved.push(key);
            else if (progression[key]) active.push({ key, node, count: progression[key] });
        }
        else unresolved.push(key);
    }
    if (unresolved.length) return pending('branch-context-incomplete', { unresolvedBranches: unresolved, metadata });
    if (active.length > 1) {
        if (!Array.isArray(branchOrder) || branchOrder.length !== active.length || new Set(branchOrder).size !== active.length
            || active.some(branch => !branchOrder.includes(branch.key))) return pending('explicit-branch-order-required', { activeBranches: active.map(branch => branch.key), metadata });
        active.sort((a, b) => branchOrder.indexOf(a.key) - branchOrder.indexOf(b.key));
    }
    let result = literal(decoded.base);
    if (result.state !== 'known' && baseValue !== undefined) result = known(baseValue);
    for (const branch of active) {
        result = apply(branch.node, result.state === 'known' ? result.value : undefined, branch.key, branch.count);
        if (result.state !== 'known') return { ...result, branchKey: branch.key, metadata };
    }
    return { ...result, appliedBranches: active.map(branch => branch.key), metadata, externalModifiersApplied: false };
}

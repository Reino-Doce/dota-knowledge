import { normalizeAlias, safeKey } from './record-contracts.mjs';

// This explicit preference follows the published alias contract for `hunter`.
const conflictResolutions = Object.freeze({ hunter: 'bounty_hunter' });

export function buildHeroAliasIndex(heroes) {
    const candidates = new Map();
    for (const hero of heroes) for (const rawAlias of hero.aliases) {
        const alias = normalizeAlias(rawAlias);
        if (!alias) continue;
        if (!candidates.has(alias)) candidates.set(alias, new Set());
        candidates.get(alias).add(hero.key);
    }

    const aliases = Object.create(null);
    const conflicts = [];
    const candidateRows = [];
    for (const [alias, keys] of [...candidates].sort(([left], [right]) => left.localeCompare(right))) {
        const sortedKeys = [...keys].sort();
        candidateRows.push({ alias, keys: sortedKeys });
        if (sortedKeys.length === 1) aliases[alias] = sortedKeys[0];
        else {
            const resolvedKey = conflictResolutions[alias] ?? null;
            if (resolvedKey && sortedKeys.includes(resolvedKey)) aliases[alias] = resolvedKey;
            conflicts.push({ alias, keys: sortedKeys, resolvedKey });
        }
    }
    return { aliases, conflicts, candidateRows };
}

export function validateHeroAliasIndex(heroes, aliases) {
    if (aliases === null || typeof aliases !== 'object' || Array.isArray(aliases)) {
        throw new Error('Hero aliases must be a flat alias-to-key object.');
    }
    const expected = buildHeroAliasIndex(heroes).aliases;
    const actualKeys = Object.keys(aliases);
    const expectedKeys = Object.keys(expected);
    if (actualKeys.length !== expectedKeys.length
        || expectedKeys.some(alias => !Object.hasOwn(aliases, alias) || aliases[alias] !== expected[alias])
        || actualKeys.some(alias => !safeKey(aliases[alias]))) {
        throw new Error('Hero alias map is incomplete, ambiguous, or points to the wrong hero.');
    }
}

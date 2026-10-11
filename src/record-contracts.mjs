export const SCHEMA_VERSION = 2;
export const COMPILER_VERSION = 'dota-knowledge-compiler-3';
export const ROLE_NAMES = ['carry', 'support', 'nuker', 'disabler', 'jungler', 'durable', 'escape', 'pusher', 'initiator'];
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const normalizeAlias = value => value.trim().toLowerCase().replace(/\s+/g, ' ');
export const safeKey = value => typeof value === 'string' && /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(value);
export const safePath = value => typeof value === 'string' && value.length <= 240
    && value.split('/').every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) && part !== '.' && part !== '..');

export function subjectHeroIds(subject, subjects) {
    if (subject.sourceKey && subject.key) return [subject.id];
    if (subject.heroId) return [subject.heroId];
    if (subject.heroIds) return subject.heroIds;
    if (subject.ownerId) return subjects.get(subject.ownerId)?.heroId ? [subjects.get(subject.ownerId).heroId] : [];
    return [...new Set((subject.effectIds ?? []).map(id => subjects.get(id)?.heroId).filter(Boolean))];
}

export function validateProfile(row) {
    if (!isObject(row) || !/^[1-9][0-9]{0,5}$/.test(row.id) || !safeKey(row.key)
        || row.sourceKey !== 'npc_dota_hero_' + row.key || typeof row.name !== 'string' || !row.name
        || typeof row.enabled !== 'boolean' || typeof row.cmEnabled !== 'boolean'
        || !Array.isArray(row.aliases) || row.aliases.some(alias => typeof alias !== 'string' || !normalizeAlias(alias))
        || new Set(row.aliases).size !== row.aliases.length
        || ![null, 0, 1, 2, 3].includes(row.primaryAttribute)
        || row.attackRange !== null && (typeof row.attackRange !== 'number' || !Number.isFinite(row.attackRange) || row.attackRange < 0)
        || ![null, 1, 2, 3].includes(row.complexity) || !Array.isArray(row.roles)
        || row.roles.some(role => !ROLE_NAMES.includes(role.role) || !Number.isInteger(role.level) || role.level < 0 || role.level > 3)
        || new Set(row.roles.map(role => role.role)).size !== row.roles.length
        || !isObject(row.coverage?.fields) || !Array.isArray(row.abilityIds) || !Array.isArray(row.effectIds)) {
        throw new Error('Malformed hero profile: ' + row?.id);
    }
    for (const field of ['primaryAttribute', 'attackRange', 'complexity', 'roles']) {
        const status = row.coverage.fields[field];
        if (!isObject(status) || !['known', 'unknown', 'unsupported', 'notApplicable', 'conflicted'].includes(status.state)
            || status.state !== 'known' && (typeof status.reason !== 'string' || !status.reason)
            || field !== 'roles' && (row[field] === null) !== (status.state !== 'known')) {
            throw new Error('Profile field coverage mismatch: ' + row.id + '.' + field);
        }
    }
}

export function validateImageDescriptor(row) {
    if (!isObject(row) || typeof row.id !== 'string' || !row.id || !['hero', 'ability', 'item'].includes(row.entityKind)
        || typeof row.entityId !== 'string' || !row.entityId || typeof row.variant !== 'string' || !row.variant) {
        throw new Error('Invalid image identity.');
    }
    if (row.state === 'unavailable') {
        if (typeof row.reason !== 'string' || !row.reason
            || ['path', 'width', 'height', 'mediaType', 'bytes', 'sha256'].some(field => Object.hasOwn(row, field))) {
            throw new Error('Unavailable image must explain absence without asset claims.');
        }
        return;
    }
    if (row.state !== 'available' || !safePath(row.path) || !/^image\/(png|jpeg|webp|avif)$/.test(row.mediaType)
        || !/^[a-f0-9]{64}$/.test(row.sha256) || ['width', 'height', 'bytes'].some(field => !Number.isSafeInteger(row[field]) || row[field] < 1)) {
        throw new Error('Invalid available image descriptor.');
    }
}

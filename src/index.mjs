import { sha256Hex } from './sha256.mjs';
import { COMPILER_VERSION, validateProfile, subjectHeroIds, normalizeAlias } from './record-contracts.mjs';

export const KNOWLEDGE_CORE_MAX_BYTES = 64 * 1024 * 1024;
export const HERO_EVIDENCE_MAX_BYTES = 16 * 1024 * 1024;
export const HERO_EVIDENCE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const HERO_EVIDENCE_CACHE_MAX_COUNT = 8;
export const OBSERVATION_SHARD_MAX_BYTES = 32 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const HERO_ID = /^[1-9]\d{0,5}$/;
const entityKinds = ['heroes', 'abilities', 'activations', 'effects', 'modifiers', 'rules', 'conditions', 'units', 'upgrades'];
const decoder = new TextDecoder('utf-8', { fatal: true });

export class KnowledgeDataError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'KnowledgeDataError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new KnowledgeDataError(code, message);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identityEntries(value) {
    return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function identityOverlapMatches(candidate, canonical) {
    return Object.entries(candidate).every(([key, value]) => !Object.hasOwn(canonical, key) || canonical[key] === value);
}

function bytes(value, label, maximum) {
    if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) {
        fail('ARTIFACT_SIZE', `${label} is empty or exceeds its size limit.`);
    }
    return value;
}

function decode(value, label) {
    try {
        return JSON.parse(decoder.decode(value));
    }
    catch (error) {
        throw new KnowledgeDataError('ARTIFACT_JSON', `${label} is not valid UTF-8 JSON.`, { cause: error });
    }
}

function validRelativeName(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 240
        && !value.startsWith('/') && !value.includes('\\')
        && value.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== '.' && part !== '..');
}

function validateDescriptor(value, label, maximum) {
    if (!isRecord(value) || !validRelativeName(value.name) || !HASH.test(value.sha256 || '')
        || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > maximum) {
        fail('MANIFEST_SCHEMA', `${label} has an invalid artifact descriptor.`);
    }
}

function validateManifest(manifest) {
    if (!isRecord(manifest) || manifest.schemaVersion !== 2 || !VERSION.test(manifest.version || '')
        || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || !isRecord(manifest.core)
        || !isRecord(manifest.guides) || !isRecord(manifest.sourceIdentities) || !Object.keys(manifest.sourceIdentities).length
        || !Array.isArray(manifest.observationShards)) {
        fail('MANIFEST_SCHEMA', 'The knowledge manifest has an unsupported schema or identity.');
    }
    validateDescriptor(manifest.core, 'core', KNOWLEDGE_CORE_MAX_BYTES);
    const artifactNames = new Set([manifest.core.name]);
    for (const [id, guide] of Object.entries(manifest.guides)) {
        if (!HERO_ID.test(id)) fail('MANIFEST_SCHEMA', `Invalid hero evidence identity: ${id}.`);
        validateDescriptor(guide, `hero ${id} evidence`, HERO_EVIDENCE_MAX_BYTES);
        if (artifactNames.has(guide.name)) fail('MANIFEST_SCHEMA', `Artifact name ${guide.name} is repeated.`);
        artifactNames.add(guide.name);
    }
    for (const shard of manifest.observationShards) {
        validateDescriptor(shard, 'observation shard', OBSERVATION_SHARD_MAX_BYTES);
        if (artifactNames.has(shard.name)) fail('MANIFEST_SCHEMA', `Artifact name ${shard.name} is repeated.`);
        artifactNames.add(shard.name);
        const identityArrays = ['heroIds', 'otherHeroIds', 'allyHeroIds', 'opponentHeroIds'];
        const stringArrays = ['kinds', 'sourceIds'];
        if (!Array.isArray(shard.heroIds) || !shard.heroIds.length
            || identityArrays.some(field => shard[field] !== undefined && (!Array.isArray(shard[field])
                || new Set(shard[field]).size !== shard[field].length || shard[field].some(id => !HERO_ID.test(id))))
            || stringArrays.some(field => !Array.isArray(shard[field])
                || new Set(shard[field]).size !== shard[field].length
                || shard[field].some(value => typeof value !== 'string' || (field === 'kinds' && !value)))
            || shard.cohortIds !== undefined && (!Array.isArray(shard.cohortIds)
                || new Set(shard.cohortIds).size !== shard.cohortIds.length || shard.cohortIds.some(id => typeof id !== 'string'))) {
            fail('MANIFEST_SCHEMA', 'Observation shard indexes are invalid.');
        }
    }
}

function validateCore(core, manifest) {
    if (!isRecord(core) || core.schemaVersion !== 2 || core.version !== manifest.version
        || core.generatedAt !== manifest.createdAt || core.createdAt !== manifest.createdAt
        || !isRecord(core.build) || !isRecord(core.patchLabel) || !['known', 'decoded', 'unknown', 'unsupported', 'notApplicable', 'conflicted'].includes(core.patchLabel.state)
        || core.compilerVersion !== COMPILER_VERSION || !Array.isArray(core.reviewBindings)
        || !isRecord(core.entities)
        || !Array.isArray(core.sources) || !Array.isArray(core.claims) || !Array.isArray(core.observations)
        || !isRecord(core.sourceIdentities)) {
        fail('CORE_IDENTITY', 'The compiled core does not match its manifest.');
    }
    if (identityEntries(core.sourceIdentities) !== identityEntries(manifest.sourceIdentities)) {
        fail('CORE_IDENTITY', 'The compiled core source identities do not match its manifest.');
    }
    if (core.patchLabel.state === 'known' && typeof core.patchLabel.value !== 'string'
        || ['unknown', 'unsupported', 'notApplicable'].includes(core.patchLabel.state) && typeof core.patchLabel.reason !== 'string') {
        fail('CORE_SCHEMA', 'The public patch label must preserve its declared state and reason.');
    }
    const tables = Object.create(null);
    const tableLimits = { heroes: 2048, abilities: 100000, activations: 100000, effects: 250000,
        modifiers: 250000, rules: 250000, conditions: 500000, units: 100000, upgrades: 100000 };
    for (const kind of entityKinds) {
        const rows = core.entities[kind];
        if (!Array.isArray(rows) || rows.length > tableLimits[kind]) fail('CORE_SCHEMA', `The core is missing or exceeds the ${kind} table bound.`);
        const index = new Map();
        for (const row of rows) {
            if (!isRecord(row) || typeof row.id !== 'string' || !row.id || index.has(row.id)) {
                fail('CORE_SCHEMA', `The ${kind} table contains a missing or duplicate ID.`);
            }
            index.set(row.id, row);
        }
        tables[kind] = index;
    }
    const valueIndex = new Map();
    const addValue = (value, ownerId, field) => {
        const id = `value:${ownerId}:${field}`;
        if (!isRecord(value) || value.id !== undefined && value.id !== id
            || value.ownerId !== undefined && value.ownerId !== ownerId
            || value.field !== undefined && value.field !== field || valueIndex.has(id)) {
            fail('CORE_SCHEMA', `Typed value ${value?.id ?? id} has invalid or duplicate identity.`);
        }
        Object.assign(value, { id, ownerId, field });
        valueIndex.set(id, value);
    };
    for (const [id, activation] of tables.activations) {
        for (const field of ['manaCost', 'cooldown', 'charges']) {
            if (activation[field] !== undefined) addValue(activation[field], id, field);
        }
    }
    for (const [id, effect] of tables.effects) {
        if (!isRecord(effect.values)) fail('CORE_SCHEMA', `${id}.values must be a typed-value object.`);
        for (const [field, value] of Object.entries(effect.values)) addValue(value, id, field);
    }
    tables.values = valueIndex;
    const sourceIndex = new Map();
    for (const row of core.sources) {
        if (!isRecord(row) || typeof row.id !== 'string' || !row.id || sourceIndex.has(row.id)) {
            fail('CORE_SCHEMA', 'The source table contains a missing or duplicate ID.');
        }
        if (row.sha256 !== undefined && row.sha256 !== null && !HASH.test(row.sha256)) {
            fail('CORE_SCHEMA', `Source ${row.id} has an invalid content hash.`);
        }
        sourceIndex.set(row.id, row);
    }
    const claimIndex = new Map();
    for (const row of core.claims) {
        if (!isRecord(row) || typeof row.id !== 'string' || !row.id || claimIndex.has(row.id)) {
            fail('CORE_SCHEMA', 'The claim table contains a missing or duplicate ID.');
        }
        if (!['reviewed', 'proposed', 'disputed', 'rejected', 'unknown'].includes(row.status)) fail('REVIEW_INTEGRITY', 'Unknown review decision state.');
        for (const sourceId of row.sourceIds ?? []) {
            if (!sourceIndex.has(sourceId)) fail('UNKNOWN_REFERENCE', `Claim ${row.id} references missing source ${sourceId}.`);
        }
        if (row.sourceIds !== undefined && (!Array.isArray(row.sourceIds) || new Set(row.sourceIds).size !== row.sourceIds.length)) {
            fail('CORE_SCHEMA', `Claim ${row.id}.sourceIds must be unique source identities.`);
        }
        claimIndex.set(row.id, row);
    }
    const requiredArray = (owner, field, table) => {
        const values = owner[field] ?? [];
        if (!Array.isArray(values) || new Set(values).size !== values.length) {
            fail('CORE_SCHEMA', `${owner.id}.${field} must contain unique IDs.`);
        }
        for (const id of values) {
            if (!tables[table].has(id)) fail('UNKNOWN_REFERENCE', `${owner.id} references missing ${table} ID ${id}.`);
        }
        return values;
    };
    const heroKeys = new Set();
    for (const [id, row] of tables.heroes) {
        try { validateProfile(row); }
        catch (error) { fail('CORE_SCHEMA', error.message); }
        if (heroKeys.has(row.key)) fail('CORE_SCHEMA', 'Duplicate hero key: ' + row.key);
        heroKeys.add(row.key);
        if (!HERO_ID.test(id) || row.id !== id) fail('CORE_SCHEMA', `Invalid decimal hero ID ${id}.`);
        for (const abilityId of requiredArray(row, 'abilityIds', 'abilities')) {
            const ability = tables.abilities.get(abilityId);
            if (ability.heroId !== id) fail('UNKNOWN_REFERENCE', `${abilityId} is owned by another hero.`);
            if (ability.order !== row.abilityIds.indexOf(abilityId)) fail('CORE_ORDER', `${abilityId} is out of order for hero ${id}.`);
        }
        for (const [order, effectId] of requiredArray(row, 'effectIds', 'effects').entries()) {
            const effect = tables.effects.get(effectId);
            if (effect.heroId !== id || effect.order !== order) {
                fail('CORE_ORDER', `${effectId} is out of order or owned by another hero.`);
            }
        }
    }
    const heroIds = [...tables.heroes.keys()];
    if (Object.keys(manifest.guides).length !== heroIds.length || heroIds.some(id => !manifest.guides[id])) {
        fail('MANIFEST_SCHEMA', 'The runtime manifest must provide one lazy evidence guide for each hero.');
    }
    for (const [id, row] of tables.abilities) {
        if (typeof row.heroId !== 'string' || !tables.heroes.has(row.heroId)) fail('UNKNOWN_REFERENCE', `${id} has no owning hero.`);
        if (typeof row.activationId !== 'string' || !tables.activations.has(row.activationId)) {
            fail('CORE_SCHEMA', `${id} has an invalid activation identity.`);
        }
        if (!Number.isSafeInteger(row.order) || row.order < 0 || typeof row.engineId !== 'string' || !row.engineId
            || !['known', 'unknown', 'unsupported'].includes(row.state)) {
            fail('CORE_SCHEMA', `${id} is not a complete ability record.`);
        }
        const activation = tables.activations.get(row.activationId);
        if (activation.heroId !== row.heroId || !activation.abilityIds.includes(id)) {
            fail('UNKNOWN_REFERENCE', `${id} is not bound to its activation record.`);
        }
        for (const sourceId of row.sourceIds ?? []) {
            if (!sourceIndex.has(sourceId)) fail('UNKNOWN_REFERENCE', `${id} references missing source ${sourceId}.`);
        }
    }
    for (const [id, row] of tables.activations) {
        if (typeof row.heroId !== 'string' || !tables.heroes.has(row.heroId)) fail('UNKNOWN_REFERENCE', `${id} has no owning hero.`);
        requiredArray(row, 'abilityIds', 'abilities');
        requiredArray(row, 'valueIds', 'values');
        for (const field of ['manaCost', 'cooldown', 'charges']) {
            if (!isRecord(row[field]) || !row.valueIds.includes(`value:${id}:${field}`)) {
                fail('CORE_SCHEMA', `${id}.${field} must retain a typed value with a stable identity.`);
            }
        }
    }
    const bindingFields = new Map();
    const subjects = new Map(entityKinds.flatMap(kind => [...tables[kind]]));
    const pointer = (subject, field) => field.split('/').slice(1).reduce((value, part) => value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], subject);
    for (const binding of core.reviewBindings) {
        const subject = subjects.get(binding.subjectId);
        const identity = binding.subjectId + '#' + binding.field;
        if (!subject || typeof binding.field !== 'string' || !/^\/(?:[^/~]|~[01]|\/)+$/.test(binding.field)
            || !Object.hasOwn(binding, 'value') || bindingFields.has(identity)) fail('REVIEW_INTEGRITY', 'Invalid or duplicate review binding.');
        const parent = binding.field.slice(0, binding.field.lastIndexOf('/'));
        if (parent && pointer(subject, parent) === undefined) fail('REVIEW_INTEGRITY', 'Review field has no canonical parent.');
        const field = binding.field.split('/').at(-1);
        if (field === 'sourceIds' && (!Array.isArray(binding.value) || binding.value.some(id => !sourceIndex.has(id)))
            || field === 'sourceId' && !sourceIndex.has(binding.value)
            || field === 'claimId' && !claimIndex.has(binding.value)) fail('UNKNOWN_REFERENCE', 'Unbound conflict or acquisition attribution.');
        if (field === 'claimIds' && (!Array.isArray(binding.value) || !binding.value.length
            || new Set(binding.value).size !== binding.value.length || binding.value.some(id => !claimIndex.has(id) || claimIndex.get(id).subjectId !== binding.subjectId))) {
            fail('REVIEW_INTEGRITY', 'Effect review binding has an unknown or different subject.');
        }
        bindingFields.set(identity, binding.value);
    }
    for (const [id, row] of tables.effects) {
        if (typeof row.heroId !== 'string' || !tables.heroes.has(row.heroId)) fail('UNKNOWN_REFERENCE', `${id} has no owning hero.`);
        if (!Number.isSafeInteger(row.order) || row.order < 0 || typeof row.type !== 'string' || !row.type
            || typeof row.subtype !== 'string' || !row.subtype || typeof row.legacyEffectId !== 'string') {
            fail('CORE_SCHEMA', `${id} is not a complete ordered effect record.`);
        }
        if (row.abilityId !== null && row.abilityId !== undefined && !tables.abilities.has(row.abilityId)) {
            fail('UNKNOWN_REFERENCE', `${id} references missing ability ${row.abilityId}.`);
        }
        for (const [field, table] of [['modifierIds', 'modifiers'], ['ruleIds', 'rules'],
            ['conditionIds', 'conditions'], ['valueIds', 'values']]) {
            requiredArray(row, field, table);
        }
        for (const field of Object.keys(row.values)) {
            if (!row.valueIds.includes(`value:${id}:${field}`)) fail('CORE_SCHEMA', `${id}.${field} is missing its stable value identity.`);
        }
        if (row.activationId !== undefined && !tables.activations.has(row.activationId)) {
            fail('UNKNOWN_REFERENCE', `${id} references missing activation ${row.activationId}.`);
        }
        for (const sourceId of row.sourceIds ?? []) {
            if (!sourceIndex.has(sourceId)) fail('UNKNOWN_REFERENCE', `${id} references missing source ${sourceId}.`);
        }
        const effectClaims = bindingFields.get(id + '#/claimIds');
        if (!effectClaims?.length) fail('REVIEW_INTEGRITY', `${id} has no bound review decision.`);
        for (const claimId of effectClaims) {
            if (!claimIndex.has(claimId)) fail('UNKNOWN_REFERENCE', `${id} references missing claim ${claimId}.`);
            if (claimIndex.get(claimId).subjectId !== id) fail('REVIEW_INTEGRITY', `${id} is bound to a claim for a different subject.`);
        }
        if (row.claimIds !== undefined && (!Array.isArray(row.claimIds) || new Set(row.claimIds).size !== row.claimIds.length)) {
            fail('CORE_SCHEMA', `${id}.claimIds must contain unique IDs.`);
        }
    }
    for (const [id, row] of tables.modifiers) requiredArray(row, 'effectIds', 'effects');
    for (const [id, row] of tables.rules) requiredArray(row, 'effectIds', 'effects');
    const conditionGraph = new Map();
    for (const [id, row] of tables.conditions) {
        if (!tables.effects.has(row.ownerId)) fail('UNKNOWN_REFERENCE', `${id} has no owning effect.`);
        requiredArray(row, 'conditionIds', 'conditions');
        conditionGraph.set(id, row.conditionIds ?? []);
    }
    const conditionState = new Map();
    for (const initialId of conditionGraph.keys()) {
        if (conditionState.get(initialId) === 2) continue;
        const stack = [{ id: initialId, exit: false, depth: 0 }];
        while (stack.length) {
            const current = stack.pop();
            if (current.depth > 256) fail('REFERENCE_DEPTH', `Condition references exceed the depth bound at ${current.id}.`);
            if (current.exit) {
                conditionState.set(current.id, 2);
                continue;
            }
            const state = conditionState.get(current.id);
            if (state === 1) fail('REFERENCE_CYCLE', `Condition references contain a cycle at ${current.id}.`);
            if (state === 2) continue;
            conditionState.set(current.id, 1);
            stack.push({ ...current, exit: true });
            const children = conditionGraph.get(current.id) ?? [];
            if (children.length > 64) fail('CORE_SCHEMA', `${current.id} exceeds the bounded condition-reference count.`);
            for (const child of children) stack.push({ id: child, exit: false, depth: current.depth + 1 });
        }
    }
    for (const [id, row] of tables.values) {
        if (!tables.effects.has(row.ownerId) && !tables.activations.has(row.ownerId)) {
            fail('UNKNOWN_REFERENCE', `${id} has no owning effect or activation.`);
        }
        if (!['known', 'decoded', 'unknown', 'unsupported', 'notApplicable', 'conflicted'].includes(row.state)) {
            fail('CORE_SCHEMA', `${id} has an invalid typed-value state.`);
        }
        if (row.state === 'known' && !Object.hasOwn(row, 'value')) fail('CORE_SCHEMA', `${id} has no known value.`);
        if (['unknown', 'unsupported', 'notApplicable'].includes(row.state) && typeof row.reason !== 'string') {
            fail('CORE_SCHEMA', `${id} must explain its ${row.state} value.`);
        }
        if (row.state === 'decoded' && (typeof row.kind !== 'string' || !row.kind
            || !Object.hasOwn(row, 'raw') && !Object.hasOwn(row, 'decoded'))) {
            fail('CORE_SCHEMA', `${id} does not retain its decoded form and raw source value.`);
        }
        if (row.state === 'conflicted') {
            if (!Array.isArray(row.conflicts) || row.conflicts.length < 2 || row.conflicts.length > 64) {
                fail('CORE_SCHEMA', `${id} must retain at least two conflicting claims.`);
            }
            for (const conflict of row.conflicts) {
                if (!isRecord(conflict) || !Object.hasOwn(conflict, 'value')
                    || conflict.claimId && !claimIndex.has(conflict.claimId)
                    || conflict.sourceId && !sourceIndex.has(conflict.sourceId)) {
                    fail('UNKNOWN_REFERENCE', `${id} contains a conflict bound to a missing claim or source.`);
                }
            }
        }
        if (row.unitId !== undefined && !tables.units.has(row.unitId)) {
            fail('UNKNOWN_REFERENCE', `${id} references missing unit ${row.unitId}.`);
        }
    }
    const allEntityIds = new Set(entityKinds.flatMap(kind => [...tables[kind].keys()]));
    for (const [id, claim] of claimIndex) {
        if (claim.subjectId !== undefined && !allEntityIds.has(claim.subjectId)) {
            fail('UNKNOWN_REFERENCE', `Claim ${id} references missing subject ${claim.subjectId}.`);
        }
        if (claim.heroId !== undefined && !tables.heroes.has(String(claim.heroId))) {
            fail('UNKNOWN_REFERENCE', `Claim ${id} references missing hero ${claim.heroId}.`);
        }
        for (const ref of claim.sourceRefs ?? []) {
            const source = sourceIndex.get(ref.sourceId);
            if (!source || source.resource !== ref.resource
                || ref.sha256 !== undefined && ref.sha256 !== null && source.sha256 !== ref.sha256
                || !(claim.sourceIds ?? []).includes(ref.sourceId)) {
                fail('SOURCE_BINDING', `Claim ${id} has an unbound source reference.`);
            }
        }
        if (claim.status === 'reviewed') {
            if (claim.review?.status !== 'reviewed' || claim.compatibility?.sourceState !== 'bound'
                || claim.compatibility?.nativeSourceHash !== core.sourceIdentities.mechanics
                || claim.compatibility?.annotationVersion !== core.reviewVersion) {
                fail('REVIEW_INTEGRITY', `Reviewed claim ${id} is not bound to the recorded source and review revision.`);
            }
        }
    }
    const observationIds = new Set();
    for (const row of core.observations) {
        if (!isRecord(row) || typeof row.id !== 'string' || !row.id || observationIds.has(row.id)
            || typeof row.kind !== 'string' || !row.kind) fail('CORE_SCHEMA', 'The observation table contains an invalid record.');
        observationIds.add(row.id);
        for (const field of ['heroId', 'otherHeroId', 'allyHeroId', 'opponentHeroId']) {
            if (row[field] !== undefined && (typeof row[field] !== 'string' || !tables.heroes.has(row[field]))) {
                fail('UNKNOWN_REFERENCE', `${row.id} references missing hero ${row[field]}.`);
            }
        }
        if (row.sourceId !== undefined && row.sourceId !== null && !sourceIndex.has(row.sourceId)) {
            fail('UNKNOWN_REFERENCE', `${row.id} references missing source ${row.sourceId}.`);
        }
        if (row.claimId !== undefined && !claimIndex.has(row.claimId)) {
            fail('UNKNOWN_REFERENCE', `${row.id} references missing claim ${row.claimId}.`);
        }
        for (const field of ['winCount', 'lossCount', 'matchCount', 'sampleCount', 'count']) {
            if (row[field] !== undefined && (typeof row[field] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row[field]))) {
                fail('CORE_SCHEMA', `${row.id}.${field} must be an exact decimal-string count.`);
            }
        }
    }
    return { tables, sourceIndex, claimIndex };
}

function freezeData(value) {
    if (!value || typeof value !== 'object') return value;
    const seen = new WeakSet();
    const pending = [value];
    while (pending.length) {
        const current = pending.pop();
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);
        for (const child of Object.values(current)) {
            if (child && typeof child === 'object' && !seen.has(child)) pending.push(child);
        }
        Object.freeze(current);
    }
    return value;
}

async function digestBytes(value) {
    if (globalThis.crypto?.subtle?.digest) {
        const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', value));
        return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return sha256Hex(value);
}

async function verifyArtifact(value, descriptor, label, maximum) {
    if (!(value instanceof Uint8Array)) fail('ARTIFACT_UNAVAILABLE', `${label} could not be read.`);
    bytes(value, label, maximum);
    if (value.byteLength !== descriptor.bytes || await digestBytes(value) !== descriptor.sha256) {
        fail('ARTIFACT_INTEGRITY', `${label} does not match its manifest digest.`);
    }
    return value;
}

function touch(cache, key, value) {
    cache.delete(key);
    cache.set(key, value);
}

function validateObservationFilter(filter) {
    if (!isRecord(filter)) fail('QUERY_SCHEMA', 'Observation filters must be an object.');
    const allowed = new Set(['kind', 'heroId', 'otherHeroId', 'allyHeroId', 'opponentHeroId', 'sourceId', 'cohortId']);
    if (Object.keys(filter).some(key => !allowed.has(key)
        || filter[key] !== undefined && typeof filter[key] !== 'string')) {
        fail('QUERY_SCHEMA', 'Observation filter fields must be supported identity strings.');
    }
}

function matchesObservation(row, filter) {
    return Object.entries(filter).every(([field, value]) => value === undefined || row[field] === value);
}

function validateGuideClaims(guide, heroId, claimIndex, sourceIndex) {
    if (guide.claims === undefined) return;
    if (!Array.isArray(guide.claims)) fail('GUIDE_SCHEMA', `Evidence for hero ${heroId} has invalid claim details.`);
    const seen = new Set();
    for (const detail of guide.claims) {
        if (!isRecord(detail) || typeof detail.id !== 'string' || seen.has(detail.id)) {
            fail('GUIDE_SCHEMA', `Evidence for hero ${heroId} has duplicate or invalid claim details.`);
        }
        seen.add(detail.id);
        const summary = claimIndex.get(detail.id);
        if (!summary || summary.heroId !== heroId || detail.heroId !== heroId
            || detail.status !== summary.status || detail.subjectId !== summary.subjectId
            || JSON.stringify(detail.sourceIds ?? []) !== JSON.stringify(summary.sourceIds ?? [])
            || JSON.stringify(detail.compatibility ?? null) !== JSON.stringify(summary.compatibility ?? null)
            || detail.review?.status !== summary.review?.status) {
            fail('REVIEW_INTEGRITY', `Detailed claim ${detail.id} does not match its core summary.`);
        }
        for (const ref of detail.sourceRefs ?? []) {
            const source = sourceIndex.get(ref.sourceId);
            if (!source || source.resource !== ref.resource
                || ref.sha256 !== undefined && source.sha256 !== ref.sha256
                || !(detail.sourceIds ?? []).includes(ref.sourceId)) {
                fail('SOURCE_BINDING', `Detailed claim ${detail.id} has an unbound source reference.`);
            }
        }
        for (const reference of detail.review?.references ?? []) {
            const nativeBound = (detail.sourceRefs ?? []).some(ref => `${ref.resource}#${ref.path}` === reference);
            const supplementalBound = (detail.review?.supplementalDocumentation ?? []).some(document =>
                typeof document.url === 'string' && reference.startsWith(`${document.url}#`));
            if (!nativeBound && !supplementalBound) {
                fail('SOURCE_BINDING', `Review ${detail.id} cites an unbound source location.`);
            }
        }
        if (summary.status === 'reviewed' && detail.review?.status !== 'reviewed') {
            fail('REVIEW_INTEGRITY', `Detailed reviewed claim ${detail.id} lost its decision.`);
        }
    }
    const expected = [...claimIndex.values()].filter(claim => claim.heroId === heroId).map(claim => claim.id);
    if (seen.size !== expected.length || expected.some(id => !seen.has(id))) {
        fail('REVIEW_INTEGRITY', `Evidence for hero ${heroId} omits or adds claim details.`);
    }
}

/** Load and validate the indexed core before exposing any records. No I/O runs at module import. */
export async function loadKnowledgeStore({ manifest, readArtifact, guideCacheSize = 8,
    guideCacheMaxBytes = HERO_EVIDENCE_CACHE_MAX_BYTES } = {}) {
    const profiling = globalThis.process?.env?.DOTA_KNOWLEDGE_PROFILE === '1';
    const profileStart = performance.now();
    const profileMark = label => {
        if (profiling) globalThis.process.stderr.write(`${label}: ${(performance.now() - profileStart).toFixed(1)}ms\n`);
    };
    validateManifest(manifest);
    if (typeof readArtifact !== 'function') fail('LOAD_OPTIONS', 'readArtifact must be provided by the caller.');
    if (!Number.isInteger(guideCacheSize) || guideCacheSize < 0 || guideCacheSize > HERO_EVIDENCE_CACHE_MAX_COUNT
        || !Number.isSafeInteger(guideCacheMaxBytes) || guideCacheMaxBytes < 0
        || guideCacheMaxBytes > HERO_EVIDENCE_CACHE_MAX_BYTES) {
        fail('LOAD_OPTIONS', 'Guide cache bounds are invalid.');
    }
    let coreBytes;
    try {
        coreBytes = await readArtifact({ ...manifest.core, kind: 'core' });
    }
    catch (error) {
        throw new KnowledgeDataError('ARTIFACT_UNAVAILABLE', 'The compiled core could not be read.', { cause: error });
    }
    profileMark('read');
    await verifyArtifact(coreBytes, manifest.core, 'The compiled core', KNOWLEDGE_CORE_MAX_BYTES);
    profileMark('digest');
    const core = decode(coreBytes, 'The compiled core');
    profileMark('decode');
    const { tables, sourceIndex, claimIndex } = validateCore(core, manifest);
    profileMark('validate');
    freezeData(core);
    profileMark('freeze');
    const heroEffects = new Map();
    const heroKeyIndex = new Map();
    const heroAliasIndex = new Map();
    const noHeroes = Object.freeze([]);
    const heroBindings = new Map(core.entities.heroes.map(row => [row.id, []]));
    const bindingSubjects = new Map(entityKinds.flatMap(kind => [...tables[kind]]));
    for (const binding of core.reviewBindings) for (const heroId of subjectHeroIds(bindingSubjects.get(binding.subjectId), bindingSubjects)) {
        heroBindings.get(heroId).push(binding);
    }
    for (const [id, hero] of tables.heroes) {
        heroEffects.set(id, Object.freeze(hero.effectIds.map(effectId => tables.effects.get(effectId))));
        heroKeyIndex.set(hero.key, hero);
        for (const alias of new Set(hero.aliases.map(normalizeAlias))) {
            if (!heroAliasIndex.has(alias)) heroAliasIndex.set(alias, []);
            heroAliasIndex.get(alias).push(hero);
        }
    }
    for (const candidates of heroAliasIndex.values()) {
        candidates.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
        Object.freeze(candidates);
    }
    profileMark('indexes');
    const observations = Object.freeze(core.observations);
    const artifactCache = new Map();
    const artifactRequests = new Map();
    let cachedArtifactBytes = 0;
    let cachedGuideCount = 0;
    let retired = false;
    const coreSha256 = manifest.core.sha256;
    const cacheKey = heroId => `${coreSha256}:${heroId}`;

    const cached = key => {
        const record = artifactCache.get(key);
        if (record) touch(artifactCache, key, record);
        return record;
    };
    const remember = (key, record, guide) => {
        if (record.bytes > guideCacheMaxBytes || guide && guideCacheSize === 0) return;
        while (cachedArtifactBytes + record.bytes > guideCacheMaxBytes
            || guide && cachedGuideCount >= guideCacheSize) {
            const oldest = artifactCache.keys().next().value;
            if (oldest === undefined) return;
            const removed = artifactCache.get(oldest);
            cachedArtifactBytes -= removed.bytes;
            if (removed.kind === 'guide') cachedGuideCount -= 1;
            artifactCache.delete(oldest);
        }
        artifactCache.set(key, record);
        cachedArtifactBytes += record.bytes;
        if (guide) cachedGuideCount += 1;
    };
    const clearArtifacts = () => {
        artifactCache.clear();
        cachedArtifactBytes = 0;
        cachedGuideCount = 0;
    };
    const readObservationShard = async descriptor => {
        const key = `${coreSha256}:observations:${descriptor.name}`;
        const found = cached(key);
        if (found) return found.value;
        if (artifactRequests.has(key)) return artifactRequests.get(key);
        const request = (async () => {
            let shardBytes;
            try {
                shardBytes = await readArtifact({ ...descriptor, kind: 'observations', coreSha256 });
            }
            catch (error) {
                throw new KnowledgeDataError('ARTIFACT_UNAVAILABLE',
                    `Observation shard ${descriptor.name} could not be read.`, { cause: error });
            }
            await verifyArtifact(shardBytes, descriptor, `Observation shard ${descriptor.name}`, OBSERVATION_SHARD_MAX_BYTES);
            const shard = decode(shardBytes, `Observation shard ${descriptor.name}`);
            if (!isRecord(shard) || shard.schemaVersion !== 2 || shard.version !== manifest.version
                || shard.coreSha256 !== coreSha256 || !Array.isArray(shard.observations)) {
                fail('OBSERVATION_IDENTITY', `Observation shard ${descriptor.name} belongs to another dataset.`);
            }
            const shardIds = new Set();
            for (const row of shard.observations) {
                if (!isRecord(row) || typeof row.id !== 'string' || shardIds.has(row.id)) {
                    fail('OBSERVATION_SCHEMA', `Observation shard ${descriptor.name} contains invalid records.`);
                }
                shardIds.add(row.id);
                if (row.sourceId !== undefined && row.sourceId !== null && !sourceIndex.has(row.sourceId)) {
                    fail('UNKNOWN_REFERENCE', `${row.id} references missing source ${row.sourceId}.`);
                }
                if (row.claimId !== undefined && !claimIndex.has(row.claimId)) {
                    fail('UNKNOWN_REFERENCE', `${row.id} references missing claim ${row.claimId}.`);
                }
                for (const field of ['heroId', 'otherHeroId', 'allyHeroId', 'opponentHeroId']) {
                    if (row[field] !== undefined && (typeof row[field] !== 'string' || !tables.heroes.has(row[field]))) {
                        fail('UNKNOWN_REFERENCE', `${row.id} references missing hero ${row[field]}.`);
                    }
                }
                for (const field of ['winCount', 'lossCount', 'matchCount', 'sampleCount', 'count']) {
                    if (row[field] !== undefined && (typeof row[field] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row[field]))) {
                        fail('OBSERVATION_SCHEMA', `${row.id}.${field} must be an exact decimal-string count.`);
                    }
                }
                if (!descriptor.heroIds.includes(row.heroId)
                    || !descriptor.kinds.includes(row.kind)
                    || row.sourceId && !descriptor.sourceIds.includes(row.sourceId)
                    || ['otherHeroId', 'allyHeroId', 'opponentHeroId'].some(field => row[field] !== undefined
                        && descriptor[`${field.replace('HeroId', '')}HeroIds`]
                        && !descriptor[`${field.replace('HeroId', '')}HeroIds`].includes(row[field]))
                    || row.cohortId && descriptor.cohortIds && !descriptor.cohortIds.includes(row.cohortId)) {
                    fail('OBSERVATION_INDEX', `Observation shard ${descriptor.name} does not match its manifest index.`);
                }
            }
            freezeData(shard);
            if (retired) fail('STORE_RETIRED', 'This knowledge store was replaced while observations were loading.');
            remember(key, { value: shard.observations, bytes: shardBytes.byteLength, kind: 'observations' }, false);
            return shard.observations;
        })().finally(() => artifactRequests.delete(key));
        artifactRequests.set(key, request);
        return request;
    };

    const store = {
        manifest: freezeData(structuredClone(manifest)),
        version: core.version,
        metadata: freezeData({ schemaVersion: core.schemaVersion, version: core.version, createdAt: core.createdAt,
            generatedAt: core.generatedAt, build: core.build, patchLabel: core.patchLabel,
            extractorVersion: core.extractorVersion ?? null, decoderVersion: core.decoderVersion ?? null,
            reviewVersion: core.reviewVersion ?? null, compilerVersion: core.compilerVersion,
            sourceIdentities: core.sourceIdentities, sourceCompatibility: core.sourceCompatibility ?? {},
            coverage: core.coverage ?? {} }),
        coreSha256,
        heroes: () => Object.freeze([...tables.heroes.values()]),
        hero: id => tables.heroes.get(String(id)),
        heroByKey: key => heroKeyIndex.get(key),
        heroesByAlias: alias => heroAliasIndex.get(normalizeAlias(alias)) ?? noHeroes,
        ability: id => tables.abilities.get(String(id)),
        activation: id => tables.activations.get(String(id)),
        effect: id => tables.effects.get(String(id)),
        effectsForHero: id => heroEffects.get(String(id)) ?? Object.freeze([]),
        modifier: id => tables.modifiers.get(String(id)),
        rule: id => tables.rules.get(String(id)),
        condition: id => tables.conditions.get(String(id)),
        value: id => tables.values.get(String(id)),
        unit: id => tables.units.get(String(id)),
        upgrade: id => tables.upgrades.get(String(id)),
        source: id => sourceIndex.get(String(id)),
        sources: () => Object.freeze([...sourceIndex.values()]),
        claim: id => claimIndex.get(String(id)),
        claims: () => Object.freeze([...claimIndex.values()]),
        observations(filter = {}) {
            validateObservationFilter(filter);
            return Object.freeze(observations.filter(row => matchesObservation(row, filter)));
        },
        async loadObservations(filter = {}) {
            validateObservationFilter(filter);
            const index = manifest.observationShards ?? [];
            const relevant = index.filter(shard =>
                (!filter.kind || shard.kinds.includes(filter.kind))
                && (!filter.sourceId || shard.sourceIds.includes(filter.sourceId))
                && (!filter.heroId || shard.heroIds.includes(filter.heroId))
                && (!filter.otherHeroId || !shard.otherHeroIds || shard.otherHeroIds.includes(filter.otherHeroId))
                && (!filter.allyHeroId || !shard.allyHeroIds || shard.allyHeroIds.includes(filter.allyHeroId))
                && (!filter.opponentHeroId || !shard.opponentHeroIds || shard.opponentHeroIds.includes(filter.opponentHeroId))
                && (!filter.cohortId || !shard.cohortIds || shard.cohortIds.includes(filter.cohortId)));
            const groups = await Promise.all(relevant.map(readObservationShard));
            const rows = new Map(observations.filter(row => matchesObservation(row, filter)).map(row => [row.id, row]));
            for (const group of groups) {
                for (const row of group) if (matchesObservation(row, filter)) rows.set(row.id, row);
            }
            return Object.freeze([...rows.values()]);
        },
        getHeroEvidence(id) {
            const key = cacheKey(String(id));
            const record = artifactCache.get(key);
            if (!record) return undefined;
            touch(artifactCache, key, record);
            return record.value;
        },
        async loadHeroEvidence(id) {
            const heroId = String(id);
            if (!HERO_ID.test(heroId) || !tables.heroes.has(heroId)) return undefined;
            const key = cacheKey(heroId);
            if (artifactCache.has(key)) {
                const record = artifactCache.get(key);
                touch(artifactCache, key, record);
                return record.value;
            }
            if (artifactRequests.has(key)) return artifactRequests.get(key);
            const descriptor = manifest.guides[heroId];
            if (!descriptor) return undefined;
            const request = (async () => {
                let guideBytes;
                try {
                    guideBytes = await readArtifact({ ...descriptor, kind: 'guide', heroId, coreSha256 });
                }
                catch (error) {
                    throw new KnowledgeDataError('ARTIFACT_UNAVAILABLE', `Evidence for hero ${heroId} could not be read.`, { cause: error });
                }
                await verifyArtifact(guideBytes, descriptor, `Evidence for hero ${heroId}`, HERO_EVIDENCE_MAX_BYTES);
                const guide = decode(guideBytes, `Evidence for hero ${heroId}`);
                if (!isRecord(guide) || guide.schemaVersion !== 2 || guide.version !== manifest.version
                    || guide.createdAt !== manifest.createdAt || guide.heroId !== heroId || guide.coreSha256 !== coreSha256
                    || !isRecord(guide.sourceIdentities) || !identityOverlapMatches(guide.sourceIdentities, manifest.sourceIdentities)
                    || !Array.isArray(guide.claims)) {
                    fail('GUIDE_IDENTITY', `Evidence for hero ${heroId} belongs to another dataset.`);
                }
                validateGuideClaims(guide, heroId, claimIndex, sourceIndex);
                const expectedBindings = new Map(heroBindings.get(heroId).map(row => [row.subjectId + '#' + row.field, row]));
                if (!Array.isArray(guide.reviewBindings) || guide.reviewBindings.length !== expectedBindings.size) {
                    fail('REVIEW_INTEGRITY', `Evidence for hero ${heroId} omits or adds review bindings.`);
                }
                for (const binding of guide.reviewBindings) {
                    const identity = binding?.subjectId + '#' + binding?.field;
                    const expected = expectedBindings.get(identity);
                    if (!expected || JSON.stringify(binding.value) !== JSON.stringify(expected.value)) {
                        fail('REVIEW_INTEGRITY', `Evidence for hero ${heroId} has an unbound review field.`);
                    }
                    expectedBindings.delete(identity);
                }
                freezeData(guide);
                if (retired) fail('STORE_RETIRED', 'This knowledge store was replaced while evidence was loading.');
                remember(key, { value: guide, bytes: guideBytes.byteLength, kind: 'guide' }, true);
                return guide;
            })().finally(() => artifactRequests.delete(key));
            artifactRequests.set(key, request);
            return request;
        },
        clearEvidenceCache() {
            clearArtifacts();
        },
        retire() {
            retired = true;
            clearArtifacts();
        },
    };
    return Object.freeze(store);
}

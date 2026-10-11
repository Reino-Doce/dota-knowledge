import { safePath } from './record-contracts.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validatePreservationReference(value) {
    if (!value || value.kind !== 'archived-json' || !safePath(value.path)
        || !value.path.startsWith('evidence/') || !digest(value.sha256)
        || !Number.isSafeInteger(value.bytes) || value.bytes < 1
        || typeof value.pointer !== 'string' || !/^(?:\/(?:[^~]|~[01])*)*$/.test(value.pointer)
        || Object.keys(value).some(key => !['kind', 'path', 'bytes', 'sha256', 'pointer'].includes(key))) {
        throw new Error('Invalid preservation reference.');
    }
    return value;
}

export function historicalSourceId(sha256) {
    if (!digest(sha256)) throw new Error('Historical source requires a verified SHA-256.');
    return 'source:historical:' + sha256;
}

export function historicalObservationId(heroId, sha256) {
    if (typeof heroId !== 'string' || !/^[1-9]\d*$/.test(heroId)) throw new Error('Invalid historical hero identity.');
    historicalSourceId(sha256);
    return `observation:${heroId}:historical-profile:${sha256}`;
}

/** Original attribution remains resolvable in evidence; clocks, cohorts and values stay here. */
export function historicalSource(source, preservation) {
    validatePreservationReference(preservation);
    const { repo: _repo, url: _url, ...record } = source;
    if (record.rawSource) {
        const { url: _rawUrl, ...rawSource } = record.rawSource;
        record.rawSource = rawSource;
    }
    return { ...record, id: historicalSourceId(source.sha256), preservation };
}

export function historicalProfile(heroId, input, source) {
    if (!input || Object.keys(input).some(key => !['sourceId', 'sourceRecord'].includes(key))
        || typeof input.sourceId !== 'string' || !input.sourceRecord || Array.isArray(input.sourceRecord)
        || typeof input.sourceRecord !== 'object' || !source || !/historical/.test(source.sourceKind ?? source.kind ?? '')) {
        throw new Error('Unsupported historical profile input.');
    }
    const allowed = new Set(['id', 'engineKey', 'name', 'aliases', 'primaryAttribute', 'complexity', 'roles', 'attackRange', 'flags', 'ranks']);
    if (Object.keys(input.sourceRecord).some(key => !allowed.has(key))) throw new Error('Unsupported historical profile field.');
    if (input.sourceRecord.id !== undefined && String(input.sourceRecord.id) !== heroId) throw new Error('Historical profile hero identity mismatch.');
    return { id: historicalObservationId(heroId, source.sha256), kind: 'historical-profile', heroId,
        sourceId: historicalSourceId(source.sha256), originalField: 'historicalProfile', sourceRecord: input.sourceRecord };
}

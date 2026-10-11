import { createHash } from 'node:crypto';
import { COMPILER_VERSION, SCHEMA_VERSION, ROLE_NAMES, normalizeAlias, validateProfile } from './record-contracts.mjs';

export const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
    : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
        : JSON.stringify(value);
export const hash = value => createHash('sha256').update(value).digest('hex');
export const semanticHash = value => hash(stable(value));
export const escapePointer = value => value.replaceAll('~', '~0').replaceAll('/', '~1');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Merge partial occurrences only when every overlapping field, including array order, agrees. */
export function mergeRecord(left, right, location = right?.id ?? '') {
    if (left === undefined) return structuredClone(right);
    if (object(left) && object(right)) {
        for (const [key, value] of Object.entries(right)) {
            left[key] = Object.hasOwn(left, key) ? mergeRecord(left[key], value, location + '/' + key) : structuredClone(value);
        }
        return left;
    }
    if (stable(left) !== stable(right)) throw new Error('Conflicting duplicate record at ' + location);
    return left;
}

// These exact field names are provenance, never mechanics values. Each removed subtree has a binding.
const attributionFields = new Set(['sourceIds', 'sourceRefs', 'sourceIdentity', 'declarationRef', 'sourceResource',
    'sourcePath', 'sourceId', 'claimId', 'claimIds', 'review', 'declarationReview', 'compatibility', 'importerAudit']);
export function separateAttribution(record, bindings) {
    const visit = (value, pointer) => {
        if (Array.isArray(value)) return value.map((child, index) => visit(child, pointer + '/' + index));
        if (!object(value)) return value;
        const result = {};
        for (const [field, child] of Object.entries(value)) {
            const location = pointer + '/' + escapePointer(field);
            if (attributionFields.has(field)) bindings.push({ subjectId: record.id, field: location, value: child });
            else result[field] = visit(child, location);
        }
        return result;
    };
    return visit(record, '');
}

export function makeProfile(hero, guide, observations = [], extraAliases = []) {
    const native = guide?.native;
    if (!native || native.key !== hero.key || String(native.heroId) !== hero.id) throw new Error('Native profile identity mismatch: ' + hero.id);
    const raw = native.raw ?? {};
    const stats = native.nativeStats ?? {};
    const attrs = { DOTA_ATTRIBUTE_STRENGTH: 0, DOTA_ATTRIBUTE_AGILITY: 1, DOTA_ATTRIBUTE_INTELLECT: 2,
        DOTA_ATTRIBUTE_INTELLIGENCE: 2, DOTA_ATTRIBUTE_ALL: 3, DOTA_ATTRIBUTE_UNIVERSAL: 3 };
    const primaryAttribute = attrs[stats.AttributePrimary?.decoded ?? raw.AttributePrimary] ?? null;
    const number = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
    const attackRange = number(stats.AttackRange?.value ?? raw.AttackRange);
    const complexity = number(raw.Complexity);
    if (complexity !== null && ![1, 2, 3].includes(complexity)) throw new Error('Invalid native complexity: ' + hero.id);
    const names = raw.Role ? raw.Role.split(',').map(value => value.trim().toLowerCase()) : [];
    const levels = raw.Rolelevels ? raw.Rolelevels.split(',').map(number) : [];
    if (names.length !== levels.length || names.some(name => !ROLE_NAMES.includes(name))) throw new Error('Invalid native roles: ' + hero.id);
    const roles = names.map((role, index) => ({ role, level: levels[index] }));
    const aliases = new Set([hero.name, hero.key, hero.heroKey ?? hero.sourceKey, ...extraAliases,
        ...(raw.NameAliases ?? '').split(';')].filter(value => typeof value === 'string' && normalizeAlias(value)));
    for (const row of observations.filter(row => /profile$/.test(row.kind))) {
        for (const value of [row.sourceRecord?.name, row.sourceRecord?.localized_name, ...(row.sourceRecord?.aliases ?? [])]) {
            if (typeof value === 'string' && normalizeAlias(value)) aliases.add(value);
        }
    }
    const status = (value, field) => value === null ? { state: 'unknown', reason: 'No usable current native ' + field + ' declaration.' } : { state: 'known' };
    const profile = { id: hero.id, key: hero.key, sourceKey: hero.heroKey ?? hero.sourceKey, name: hero.name,
        aliases: [...aliases].sort(), primaryAttribute, attackRange, complexity, roles,
        enabled: hero.enabled, cmEnabled: hero.cmEnabled, abilityIds: hero.abilityIds, effectIds: hero.effectIds,
        coverage: { ...hero.coverage, fields: { primaryAttribute: status(primaryAttribute, 'attribute'), attackRange: status(attackRange, 'attack range'),
            complexity: status(complexity, 'complexity'), roles: names.length ? { state: 'known' } : status(null, 'roles') } } };
    validateProfile(profile);
    return profile;
}

/** Bundle imports and historical layout readers share this record graph. */
export function normalizeLegacyRecords({ metadata, heroes, sources, claims, observations, guides, reference }, { crosswalk = [], aliases = [] } = {}) {
    const byObservation = new Map();
    let occurrences = 0;
    for (const row of observations) {
        byObservation.set(row.id, mergeRecord(byObservation.get(row.id), row));
        occurrences += 1;
    }
    const indexed = metadata.runtimeObservations ?? [];
    const projections = [];
    const projectionByFields = new Map();
    const runtimeProjection = new Map();
    for (const row of indexed) {
        const fields = Object.keys(row).sort();
        const key = JSON.stringify(fields);
        if (!projectionByFields.has(key)) { projectionByFields.set(key, projections.length); projections.push(fields); }
        runtimeProjection.set(row.id, projectionByFields.get(key));
    }
    const bindings = [];
    const entities = { heroes: [], abilities: [], activations: [], effects: [], conditions: [],
        modifiers: reference.modifiers ?? [], rules: reference.rules ?? [], units: reference.units ?? [], upgrades: reference.upgrades ?? [] };
    const history = [];
    const locations = [];
    const details = new Map();
    for (const row of heroes) {
        const hero = row.hero;
        const guide = guides.get(hero.id);
        if (!guide || guide.sourceIdentities?.mechanics !== metadata.sourceIdentities.mechanics
            || guide.sourceIdentities?.enrichedNative !== metadata.sourceIdentities.enrichedNative) {
            throw new Error('Current native profile is not bound to the selected build: ' + hero.id);
        }
        const stats = [...byObservation.values()].filter(value => value.heroId === hero.id);
        const extraAliases = aliases.filter(alias => alias.keys.includes(hero.key)).map(alias => alias.alias);
        const identity = crosswalk.find(entry => entry.id === hero.id);
        if (identity && (identity.key !== hero.key || identity.sourceKey !== hero.heroKey)) throw new Error('Crosswalk identity mismatch: ' + hero.id);
        const provider = identity?.providerSlug ?? stats.find(value => value.originalField === 'pickerProfile')?.sourceRecord?.value?.slug ?? null;
        const profile = makeProfile(hero, guide, stats, provider ? [...extraAliases, provider] : extraAliases);
        entities.heroes.push(profile);
        for (const kind of ['abilities', 'activations', 'effects', 'conditions']) {
            entities[kind].push(...(row[kind] ?? []).map(record => separateAttribution(record, bindings)));
        }
        // Preserve every old profile field, including redundant import identifiers, outside the plain profile.
        for (const field of ['sourceIdentity', 'detailRecord', 'heroId', 'heroKey']) {
            if (Object.hasOwn(hero, field)) bindings.push({ subjectId: hero.id, field: '/' + field, value: hero[field] });
        }
        if (row.evidence) bindings.push({ subjectId: hero.id, field: '/evidence', value: row.evidence });
        const { schemaVersion: _schema, version: _version, createdAt: _clock, coreSha256: _hash, claims: _claims,
            officialHero, officialDataset, ...detail } = guide;
        details.set(hero.id, detail);
        history.push({ heroId: hero.id, selection: 'current-build-native', build: metadata.build,
            sourceIdentities: guide.sourceIdentities, fields: Object.fromEntries(['AttributePrimary', 'AttackRange', 'Complexity', 'Role', 'Rolelevels']
                .map(field => [field, { raw: guide.native.raw?.[field] ?? null, decoded: guide.native.nativeStats?.[field] ?? null }])),
            historicalObservationIds: stats.filter(value => /profile$/.test(value.kind)).map(value => value.id),
            officialHero: officialHero ?? null, officialDataset: officialDataset ?? null });
        locations.push({ id: hero.id, key: hero.key, sourceKey: profile.sourceKey, providerSlug: provider,
            profile: `heroes/${hero.key}/profile.json`, abilities: `heroes/${hero.key}/abilities.json`,
            mechanics: `heroes/${hero.key}/mechanics.json`, guide: `heroes/${hero.key}/guides/details.json` });
    }
    for (const kind of ['modifiers', 'rules', 'units', 'upgrades']) entities[kind] = entities[kind].map(row => separateAttribution(row, bindings));
    const aliasIndex = new Map();
    for (const hero of entities.heroes) for (const alias of hero.aliases) {
        const key = normalizeAlias(alias);
        if (!aliasIndex.has(key)) aliasIndex.set(key, new Set());
        aliasIndex.get(key).add(hero.key);
    }
    const { sourceFiles: _files, runtimeObservations: _indexed, ...header } = metadata;
    return { metadata: { ...header, schemaVersion: SCHEMA_VERSION, compilerVersion: COMPILER_VERSION }, entities, sources,
        claims, bindings, history, guides: details, observations: [...byObservation.values()], projections, runtimeProjection,
        heroIndex: locations, aliases: [...aliasIndex].sort(([a], [b]) => a.localeCompare(b)).map(([alias, keys]) => ({ alias, keys: [...keys].sort() })),
        reconciliation: { observationOccurrences: occurrences, duplicateOccurrences: occurrences - byObservation.size,
            uniqueObservations: byObservation.size }, extras: new Map() };
}

export function graphFromBundleImport(result) {
    return normalizeLegacyRecords({ metadata: { ...result.canonical.metadata, runtimeObservations: result.core.observations },
        heroes: result.canonical.heroes, sources: result.core.sources, claims: result.canonical.claims,
        observations: [...result.core.observations, ...[...result.statisticFiles.values()].flat()],
        guides: result.guideFiles, reference: result.core.entities });
}

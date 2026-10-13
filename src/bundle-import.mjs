import { createHash } from 'node:crypto';
import { graphFromBundleImport } from './canonical-model.mjs';
import { historicalSource, historicalProfile } from './historical-records.mjs';

const COMPILE_VERSION = 'dota-knowledge-compiler-5';
const nativeStatsId = 'source:installed-game-resources';
const textHash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const externalSources = row => row?.sourceId ? [row.sourceId] : [];

function uniqueById(rows, label) {
    const result = new Map();
    for (const row of rows) {
        const prior = result.get(row.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error(`Conflicting ${label} identity: ${row.id}`);
        result.set(row.id, row);
    }
    return [...result.values()];
}

function toSourceRef(row, sourceByResource) {
    const source = sourceByResource.get(`${row.resource}:${row.sha256}`);
    return { ...row, ...(source ? { sourceId: source.id } : {}) };
}

function createExternalObservations(heroId, hero, sourceIds) {
    const rows = [];
    const sourceFields = {
        matchups: 'picker-matchups', pickerProfile: 'd2-heroes',
        positions: 'picker-positions', lanes: 'picker-lanes', timings: 'picker-timings', profile: 'd2-heroes',
        backupMatchups: 'd2-matchups', backupDurations: 'd2-durations', builds: 'd2-builds',
    };
    const kinds = {
        matchups: 'matchup', pickerProfile: 'provider-profile',
        positions: 'position-outcome', lanes: 'lane-outcome', timings: 'duration-outcome', profile: 'provider-profile',
        backupMatchups: 'matchup', backupDurations: 'duration-outcome', builds: 'item-build', tags: 'tag-claim',
        models: 'model-estimate',
    };
    const add = (field, sourceRecord, index = null, otherHeroId = null) => {
        const sourceId = sourceFields[field] ? `source:${sourceFields[field]}` : null;
        rows.push({ id: `observation:${heroId}:${field}${index === null ? '' : `:${index}`}`,
            kind: kinds[field] ?? `provider-record:${field}`, heroId,
            ...(otherHeroId ? { otherHeroId } : {}), ...(sourceId && sourceIds.has(sourceId) ? { sourceId } : {}),
            ...(object(sourceRecord) && typeof sourceRecord.cohortId === 'string' ? { cohortId: sourceRecord.cohortId } : {}),
            originalField: field, sourceRecord });
    };
    for (const [field, value] of Object.entries(hero)) {
        if (field === 'claims' || field === 'historicalProfiles') continue;
        if (/profile$/i.test(field) && !Object.hasOwn(kinds, field)) throw new Error('Unsupported historical profile field: ' + field);
        if (field === 'matchups' || field === 'backupMatchups') {
            for (const [index, row] of (Array.isArray(value) ? value : []).entries()) {
                add(field, row, index, Array.isArray(row) && row.length ? String(row[0]) : null);
            }
        }
        else if (Array.isArray(value) && ['lanes', 'timings', 'backupDurations', 'models'].includes(field)) {
            for (const [index, row] of value.entries()) add(field, row, index);
        }
        else add(field, value);
    }
    for (const [band, positions] of Object.entries(hero.positions ?? {})) {
        if (!['all', 'divine', 'immortal'].includes(band) || !Array.isArray(positions)) continue;
        positions.forEach(([games, wins], index) => rows.push({ id: `observation:${heroId}:positions:${band}:${index + 1}`,
            kind: 'position-outcome', heroId, sourceId: sourceIds.has('source:picker-positions') ? 'source:picker-positions' : null,
            originalField: 'positions', rankBand: band, position: index + 1, matchCount: String(games), winCount: String(wins),
            unit: 'matches', sourceRecord: [games, wins] }));
    }
    return rows;
}

function compactScoringObservation(row) {
    const value = row.sourceRecord;
    const base = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'sourceRecord'));
    if (row.kind === 'native-classification' && value && typeof value === 'object') {
        return { ...base, roles: value.roles, attackCapability: value.attackCapability, complexity: value.complexity,
            build: value.build, classificationOnly: true, sourceRefs: value.sourceRefs };
    }
    if (row.kind === 'population-overall' || row.kind === 'population-duration' || row.kind === 'population-matchup'
        || row.kind === 'duration-outcome' || row.kind === 'model-estimate') return null;
    if (row.kind === 'synergy' || row.originalField === 'positions') return base;
    if (!Array.isArray(value)) return null;
    switch (row.originalField) {
        case 'matchups':
            return { ...base, disadvantagePercentagePoints: value[1], winRatePercent: value[2], matchCount: String(value[3]),
                direction: 'hero-vs-opponent', unit: 'matches' };
        case 'backupMatchups':
            return { ...base, winCount: String(value[1]), matchCount: String(value[2]), unit: 'matches' };
        case 'lanes':
            return { ...base, position: value[1], laneCount: String(value[2]), winCount: String(value[3]),
                drawCount: String(value[4]), lossCount: String(value[5]), gameWinCount: String(value[6]), unit: 'lanes' };
        case 'timings':
            return { ...base, bucketIndex: Number(row.id.split(':').at(-1)), matchCount: String(value[0]),
                winRatePercent: value[1], deviationPercentagePoints: value[2], unit: 'matches' };
        case 'backupDurations':
            return { ...base, durationSeconds: value[0], winRate: value[1], matchCount: String(value[2]), unit: 'matches' };
        case 'models':
            return { ...base, score: value[1], calibratedProbability: false };
        default:
            return null;
    }
}

function createPopulationObservations(heroId, population) {
    const sourceId = 'source:stratz-population';
    const cohorts = population?.cohorts ?? [];
    const cohortFor = identity => typeof identity === 'number' && Number.isInteger(identity)
        ? cohorts[identity] : typeof identity === 'string' ? cohorts.find(row => row.id === identity) : null;
    const profile = population?.heroes?.[heroId];
    const decimalCount = (value, label) => {
        if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
        throw new Error(`${label} is not an exact non-negative integer count.`);
    };
    if (!profile || profile.state !== 'available') return [{
        id: `observation:population:${heroId}:availability`, kind: 'population-overall', heroId, sourceId,
        availability: profile?.state ?? 'unavailable', sourceRecord: profile ?? { state: 'unavailable' },
    }];
    const rows = [];
    const base = (kind, identity) => {
        const cohort = cohortFor(identity);
        return { kind, heroId, sourceId, ...(cohort ? { cohortId: cohort.id, cohort: { ...cohort } } : {}),
            ...(cohort?.dataThrough ? { observedAt: cohort.dataThrough } : {}) };
    };
    const overall = profile.overall;
    if (Array.isArray(overall) && overall.length >= 2) {
        rows.push({ ...base('population-overall', overall[2]), id: `observation:population:${heroId}:overall`,
            winCount: decimalCount(overall[0], `Population wins for hero ${heroId}`),
            matchCount: decimalCount(overall[1], `Population matches for hero ${heroId}`), unit: 'matches', sourceRecord: overall });
    }
    else rows.push({ id: `observation:population:${heroId}:overall`, kind: 'population-overall', heroId, sourceId,
        availability: 'unknown', sourceRecord: overall ?? null });
    for (const [index, tuple] of (profile.encodedDurations ?? []).entries()) {
        if (!Array.isArray(tuple) || tuple.length < 3) throw new Error(`Population duration record ${heroId}:${index} is malformed.`);
        const [providerDurationIndex, winCount, matchCount] = tuple;
        rows.push({ ...base('population-duration', overall?.[2]), id: `observation:population:${heroId}:duration:${index}`,
            providerDurationIndex, winCount: decimalCount(winCount, `Duration wins for hero ${heroId}`),
            matchCount: decimalCount(matchCount, `Duration matches for hero ${heroId}`), unit: 'provider-duration-index',
            meaning: population.verification?.durations ?? { state: 'unknown' }, sourceRecord: tuple });
    }
    for (const [index, tuple] of (profile.matchups ?? []).entries()) {
        if (!Array.isArray(tuple) || tuple.length < 4) throw new Error(`Population matchup record ${heroId}:${index} is malformed.`);
        const [otherHeroId, winCount, matchCount, advantagePercentagePoints, cohortIndex] = tuple;
        rows.push({ ...base('population-matchup', cohortIndex), id: `observation:population:${heroId}:matchup:${otherHeroId}`,
            otherHeroId: String(otherHeroId), winCount: decimalCount(winCount, `Matchup wins for hero ${heroId}`),
            matchCount: decimalCount(matchCount, `Matchup matches for hero ${heroId}`), advantagePercentagePoints,
            direction: population.verification?.matchupDirection ?? 'unknown',
            advantageDefinition: population.verification?.advantage ?? { state: 'unknown' },
            unit: 'matches', sourceRecord: tuple });
    }
    return rows;
}

function bundleDataError(value, name) {
    if (!object(value)) throw new Error(`${name} must be a JSON object.`);
}

/** Import selected offline bundles; field values remain source records. */
export function importBundleKnowledge({ mechanics, annotations, browserCatalog, externalEvidence, heroGuides,
    version, createdAt, sourceBytes = {}, historicalPreservations = new Map() } = {}) {
    for (const [name, value] of [['mechanics', mechanics], ['annotations', annotations],
        ['browser catalog', browserCatalog], ['external evidence', externalEvidence]]) bundleDataError(value, name);
    if (!Array.isArray(mechanics.heroes) || !Array.isArray(browserCatalog.heroes)
        || annotations.sourceHash !== mechanics.sourceHash || browserCatalog.sourceHash !== mechanics.sourceHash
        || externalEvidence.nativeSourceHash === mechanics.sourceHash) {
        throw new Error('Selected mechanics, review, browser, and enriched-native source identities are inconsistent.');
    }
    if (typeof version !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(version)
        || !Number.isFinite(Date.parse(createdAt))) throw new Error('A stable dataset version and generation clock are required.');

    const browserHeroes = new Map(browserCatalog.heroes.map(hero => [String(hero.heroId), hero]));
    const nativeHeroes = new Map(mechanics.heroes.map(hero => [String(hero.heroId), hero]));
    const guides = heroGuides instanceof Map ? heroGuides : new Map(Object.entries(heroGuides ?? {}));
    const sources = [];
    const sourceByResource = new Map();
    const sourceIds = new Set();
    const addSource = source => {
        if (sourceIds.has(source.id)) return;
        sourceIds.add(source.id);
        sources.push(source);
    };
    for (const row of mechanics.sources ?? []) {
        const id = `source:native:${row.sha256}:${row.resource}`;
        const source = { ...row, id, sourceKind: 'installed-game-resource', build: mechanics.build,
            evidenceAvailability: 'recoverable-only-after-source-hash-verification' };
        addSource(source);
        sourceByResource.set(`${row.resource}:${row.sha256}`, source);
    }
    addSource({ id: nativeStatsId, sourceKind: 'installed-game-resource-set', sha256: externalEvidence.nativeSourceHash,
        build: mechanics.build, evidenceAvailability: 'compiled-source-bindings-retained' });
    addSource({ id: 'source:mechanics-catalog', sourceKind: 'reviewed-mechanics-source', sha256: mechanics.sourceHash,
        build: mechanics.build, retrievalTime: null });
    addSource({ id: 'source:mechanics-annotations', sourceKind: 'human-review-records',
        sha256: sourceBytes.annotations ? textHash(sourceBytes.annotations) : null,
        nativeSourceHash: annotations.sourceHash, version: annotations.version, retrievalTime: null });
    addSource({ id: 'source:external-evidence-bundle', sourceKind: 'compiled-provider-evidence',
        sha256: sourceBytes.externalEvidence ? textHash(sourceBytes.externalEvidence) : null,
        version: externalEvidence.version, createdAt: externalEvidence.createdAt,
        nativeSourceHash: externalEvidence.nativeSourceHash, retrievalTime: null });
    const historicalInputs = new Set();
    for (const [heroId, hero] of Object.entries(externalEvidence.heroes ?? {})) {
        if (hero.historicalProfiles !== undefined && !Array.isArray(hero.historicalProfiles)) throw new Error('historicalProfiles must be an array.');
        if (hero.historicalProfiles?.length && !browserHeroes.has(heroId)) throw new Error('Historical profile has no selected hero.');
        for (const profile of hero.historicalProfiles ?? []) historicalInputs.add(profile.sourceId);
    }
    const historicalSources = new Map();
    for (const row of externalEvidence.sources ?? []) {
        const populationMetadata = row.id === 'stratz-population' && externalEvidence.stratzPopulation
            ? Object.fromEntries(Object.entries(externalEvidence.stratzPopulation).filter(([key]) => key !== 'heroes')) : undefined;
        let source = { ...row, id: `source:${row.id}`, sourceKind: row.kind ?? 'external-source',
            ...(populationMetadata ? { recordMetadata: populationMetadata } : {}) };
        if (historicalInputs.has(source.id)) {
            const bytes = sourceBytes.historicalSources?.get(source.id);
            if (!(bytes instanceof Uint8Array) || textHash(bytes) !== row.sha256) throw new Error('Historical source response hash is not verified.');
            historicalSources.set(source.id, source);
            source = historicalSource(source, historicalPreservations.get(source.id));
        }
        if (sourceIds.has(source.id)) throw new Error('Source identity collision: ' + source.id);
        addSource(source);
    }
    for (const id of historicalInputs) if (!historicalSources.has(id)) throw new Error('Missing historical source: ' + id);

    const claims = [];
    const canonicalHeroes = [];
    const entities = { heroes: [], abilities: [], activations: [], effects: [], modifiers: [], rules: [],
        conditions: [], units: [], upgrades: [] };
    const observations = [];
    const observationShards = [];
    const guideFiles = new Map();
    const statisticFiles = new Map();
    const selectedIds = [...browserHeroes.keys()].sort((left, right) => Number(left) - Number(right));
    if (selectedIds.length !== mechanics.heroes.length) throw new Error('Native and browser rosters differ.');

    for (const heroId of selectedIds) {
        const hero = browserHeroes.get(heroId);
        const nativeHero = nativeHeroes.get(heroId);
        const evidence = externalEvidence.heroes?.[heroId] ?? {};
        const enriched = guides.get(heroId);
        if (!nativeHero || !enriched || String(enriched.heroId) !== heroId) {
            throw new Error(`Selected hero ${heroId} is missing native or enriched evidence.`);
        }
        const rawAbilities = nativeHero.abilities ?? [];
        const abilities = rawAbilities.map((ability, order) => {
            const id = `ability:${heroId}:${ability.abilityId}`;
            const source = sourceByResource.get(`${ability.sourceResource}:${mechanics.sources?.find(row => row.resource === ability.sourceResource)?.sha256}`);
            const sourceRef = source ? { sourceId: source.id, resource: ability.sourceResource, path: ability.sourcePath,
                sha256: source.sha256 } : null;
            const declaredValue = value => {
                if (value === undefined || value === null) return { state: 'unknown', reason: 'No native declaration is recorded.' };
                if (typeof value === 'number' && Number.isFinite(value)) return { state: 'known', value };
                const raw = String(value).trim();
                const parts = raw.split(/\s+/);
                if (parts.length && parts.every(part => /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(part))) {
                    const numbers = parts.map(Number);
                    return { state: 'known', value: numbers.length === 1 ? numbers[0] : numbers };
                }
                return { state: 'unsupported', reason: 'The native declaration is not a plain numeric literal or rank curve.', raw: value };
            };
            const activationId = `activation:${heroId}:${ability.abilityId}`;
            const activationValues = { manaCost: declaredValue(ability.raw?.AbilityManaCost ?? ability.raw?.AbilityValues?.AbilityManaCost),
                cooldown: declaredValue(ability.raw?.AbilityCooldown ?? ability.raw?.AbilityValues?.AbilityCooldown),
                charges: declaredValue(ability.raw?.AbilityCharges ?? ability.raw?.AbilityValues?.AbilityCharges) };
            const valueIds = Object.entries(activationValues).map(([field, value]) => {
                const valueId = `value:${activationId}:${field}`;
                activationValues[field] = { id: valueId, ownerId: activationId, field, ...value };
                return valueId;
            });
            entities.activations.push({ id: activationId, heroId, abilityIds: [id], ...activationValues, valueIds });
            return { id, heroId, engineId: ability.abilityId, activationId,
                order, owner: ability.owner, state: ability.state,
                ...(sourceRef ? { sourceIds: [sourceRef.sourceId] } : { sourceIds: [] }) };
        });
        const abilityByEngineId = new Map(abilities.map(ability => [ability.engineId, ability]));
        const effects = hero.effects.map((effect, order) => {
            const sourceRefs = (effect.sourceRefs ?? []).map(row => toSourceRef(row, sourceByResource));
            const supplementalRefs = (effect.review?.supplementalDocumentation ?? []).map(document => {
                const digest = typeof document.sourceResponseSha256 === 'string' && /^[a-f0-9]{64}$/.test(document.sourceResponseSha256)
                    ? document.sourceResponseSha256 : null;
                const resource = document.url ?? document.sourceFile ?? 'unknown-supplemental-source';
                const identity = digest ?? textHash(`${resource}:${document.revisionId ?? 'unknown'}`);
                const sourceId = `source:liquipedia:${document.revisionId ?? 'unknown'}:${identity}`;
                addSource({ id: sourceId, sourceKind: 'Liquipedia-review-evidence', resource, sha256: digest,
                    revision: document.revisionId ?? null, editedAt: document.editedAt ?? null,
                    retrievedAt: document.retrievedAt ?? null, license: document.license ?? null,
                    attribution: document.attribution ?? null,
                    evidenceAvailability: digest ? 'compiled-response-hash-retained' : 'original-response-unavailable' });
                return { sourceId, resource, path: `${document.abilityId ?? ''}.${document.field ?? ''}`,
                    ...(digest ? { sha256: digest } : {}) };
            });
            const claimSourceRefs = [...sourceRefs, ...supplementalRefs];
            const sourceIdsForClaim = [...new Set(claimSourceRefs.map(row => row.sourceId).filter(Boolean))];
            const id = `effect:${effect.effectId}`;
            const claimId = `claim:review:${effect.effectId}`;
            claims.push({ id: claimId, subjectId: id, heroId, kind: 'reviewed-mechanics-interpretation',
                status: effect.review?.status ?? 'unknown', review: effect.review ?? null, sourceIds: sourceIdsForClaim,
                sourceRefs: claimSourceRefs, compatibility: { build: mechanics.build, nativeSourceHash: mechanics.sourceHash,
                    annotationVersion: annotations.version, sourceState: annotations.sourceHash === mechanics.sourceHash ? 'bound' : 'mismatch' } });
            const ability = abilityByEngineId.get(effect.abilityId);
            const { review, sourceRefs: _sourceRefs, ...mechanic } = effect;
            const legacyAbilityId = mechanic.abilityId;
            const values = Object.fromEntries(Object.entries(effect.values ?? {}).map(([field, value]) => {
                const valueId = `value:${id}:${field}`;
                return [field, { id: valueId, ownerId: id, field, ...value }];
            }));
            const valueIds = Object.values(values).map(value => value.id);
            const conditionIds = (effect.availability?.requiresContext ?? []).map((context, index) => {
                const conditionId = `condition:${effect.effectId}:${index}`;
                entities.conditions.push({ id: conditionId, ownerId: id, kind: 'required-context',
                    predicate: { state: 'known', operator: 'requires', field: 'scenarioContext', value: context } });
                return conditionId;
            });
            return { ...mechanic, values, id, legacyEffectId: effect.effectId, heroId, order,
                abilityId: ability?.id ?? null, legacyAbilityId,
                modifierIds: effect.relationships?.modifierIds ?? [], ruleIds: effect.relationships?.ruleIds ?? [],
                conditionIds, valueIds,
                activationId: ability?.activationId ?? `activation:${heroId}:${legacyAbilityId}`,
                claimIds: [claimId] };
        });
        const { effects: _projectionEffects, ...heroSummary } = hero;
        const heroRecord = { ...heroSummary, id: heroId,
            abilityIds: abilities.map(ability => ability.id), effectIds: effects.map(effect => effect.id),
            sourceIdentity: mechanics.sourceHash, detailRecord: `heroes/${heroId}.json` };
        entities.heroes.push(heroRecord);
        entities.abilities.push(...abilities);
        entities.effects.push(...effects);

        for (const unit of nativeHero.unitDependencies ?? []) {
            const unitKey = unit.unitKey ?? unit.id;
            if (typeof unitKey === 'string' && unitKey) {
                const id = `unit:${unitKey}`;
                const record = entities.units.find(row => row.id === id);
                if (record) record.heroIds.push(heroId);
                else entities.units.push({ ...unit, id, heroIds: [heroId] });
            }
        }
        for (const effect of effects) for (const upgrade of effect.availability?.upgrades ?? []) {
            if (typeof upgrade === 'string' && upgrade) entities.upgrades.push({ id: `upgrade:${upgrade}`, key: upgrade,
                sourceKind: 'declared-effect-prerequisite' });
        }
        for (const effect of effects) {
            for (const modifierId of effect.relationships?.modifierIds ?? []) {
                if (typeof modifierId === 'string') {
                    const record = entities.modifiers.find(row => row.id === modifierId);
                    if (record) record.effectIds.push(effect.id);
                    else entities.modifiers.push({ id: modifierId, effectIds: [effect.id] });
                }
            }
            for (const ruleId of effect.relationships?.ruleIds ?? []) {
                if (typeof ruleId === 'string') {
                    const record = entities.rules.find(row => row.id === ruleId);
                    if (record) record.effectIds.push(effect.id);
                    else entities.rules.push({ id: ruleId, effectIds: [effect.id] });
                }
            }
        }
        const profile = externalEvidence.nativeProfiles?.[heroId];
        if (profile) observations.push(compactScoringObservation({ id: `observation:native-role:${heroId}`,
            kind: 'native-classification', heroId, sourceId: nativeStatsId, sourceRecord: profile }));
        const stats = createExternalObservations(heroId, evidence, sourceIds);
        const historicalIds = new Set();
        for (const input of evidence.historicalProfiles ?? []) {
            const row = historicalProfile(heroId, input, historicalSources.get(input.sourceId));
            if (historicalIds.has(row.id)) throw new Error('Historical observation identity collision: ' + row.id);
            historicalIds.add(row.id); stats.push(row);
        }
        stats.push(...createPopulationObservations(heroId, externalEvidence.stratzPopulation));
        observations.push(...stats.map(compactScoringObservation).filter(Boolean));
        const heroGuide = { schemaVersion: 1, version, createdAt, heroId, coreSha256: null,
            sourceIdentities: { mechanics: mechanics.sourceHash, enrichedNative: externalEvidence.nativeSourceHash,
                external: externalEvidence.version, knowledgeSource: enriched.nativeSourceHash },
            native: enriched.native, consolidated: enriched.consolidated ?? null, liquipedia: enriched.liquipedia ?? null,
            liquipediaSource: enriched.liquipediaSource ?? null,
            officialHero: externalEvidence.officialHeroData?.heroes?.[heroId] ?? null,
            officialDataset: externalEvidence.officialHeroData ? {
                version: externalEvidence.officialHeroData.version,
                nativeSourceHash: externalEvidence.officialHeroData.nativeSourceHash,
                nativeBuild: externalEvidence.officialHeroData.nativeBuild,
                sourceManifestSha256: externalEvidence.officialHeroData.sourceManifestSha256,
                interpretation: externalEvidence.officialHeroData.interpretation,
            } : null,
            externalClaims: evidence.claims ?? [], statObservationIds: stats.map(row => row.id),
        };
        guideFiles.set(heroId, heroGuide);
        canonicalHeroes.push({ hero: heroRecord, abilities, effects,
            evidence: { sourceIds: [...new Set([nativeStatsId, ...stats.map(row => row.sourceId).filter(Boolean)])].sort(),
                guidePath: `runtime/guides/${heroId}.json` } });
        statisticFiles.set(heroId, stats);
    }

    for (const unit of entities.units) unit.heroIds = [...new Set(unit.heroIds)].sort((left, right) => Number(left) - Number(right));
    entities.upgrades.splice(0, entities.upgrades.length, ...uniqueById(entities.upgrades, 'upgrade'));
    entities.modifiers.splice(0, entities.modifiers.length, ...uniqueById(entities.modifiers, 'modifier'));
    entities.rules.splice(0, entities.rules.length, ...uniqueById(entities.rules, 'rule'));
    const externalClaims = [];
    for (const [heroId, row] of Object.entries(externalEvidence.heroes ?? {})) {
        for (const [category, values] of Object.entries(row.claims ?? {})) {
            const sourceId = category === 'abilities' || category === 'items' ? 'source:dota-counters' : 'source:dota-counters';
            for (const [index, value] of (Array.isArray(values) ? values : []).entries()) {
                externalClaims.push({ id: `claim:provider:${heroId}:${category}:${index}`, heroId, kind: category,
                    status: 'proposed', sourceIds: sourceIds.has(sourceId) ? [sourceId] : [], sourceRecord: value,
                    compatibility: { selectionPolicy: 'consumer-owned', sourceClaimStatus: 'unreviewed' } });
            }
        }
    }
    claims.push(...externalClaims);

    for (const [key, value] of Object.entries(externalEvidence.synergies ?? {})) {
        const [first, second] = key.split(':');
        if (!HERO_ID_PATTERN.test(first) || !HERO_ID_PATTERN.test(second)) continue;
        const shard = statisticFiles.get(first) ?? [];
        const [storedFirst, storedSecond, advantagePercentagePoints, games, winRatePercent, farmCells] = value;
        const row = { id: `observation:synergy:${key}`, kind: 'synergy', heroId: first, otherHeroId: second,
            sourceId: sourceIds.has('source:picker-synergies') ? 'source:picker-synergies' : null,
            sourcePairKey: key, storedHeroIds: [String(storedFirst), String(storedSecond)], advantagePercentagePoints,
            matchCount: String(games), winRatePercent, farmCells, unit: 'matches', sourceRecord: value };
        shard.push(row);
        statisticFiles.set(first, shard);
        observations.push(compactScoringObservation(row));
    }
    const sourceRows = uniqueById(sources, 'source').sort((left, right) => left.id.localeCompare(right.id));
    const sourceResourceIds = new Set(sourceRows.map(row => row.id));
    const claimRows = uniqueById(claims, 'claim');
    for (const claim of claimRows) {
        if (claim.sourceIds?.some(id => !sourceResourceIds.has(id))) throw new Error(`Claim ${claim.id} references a missing source.`);
    }
    const claimsByHero = new Map(entities.heroes.map(hero => [hero.id, []]));
    for (const claim of claimRows) {
        if (claimsByHero.has(claim.heroId)) claimsByHero.get(claim.heroId).push(claim);
    }
    for (const canonicalHero of canonicalHeroes) {
        const heroClaims = claimsByHero.get(canonicalHero.hero.id) ?? [];
        canonicalHero.claims = heroClaims;
        canonicalHero.guide = guideFiles.get(canonicalHero.hero.id);
        canonicalHero.guide.claims = heroClaims;
        const heroEffectIds = new Set(canonicalHero.hero.effectIds);
        canonicalHero.activations = entities.activations.filter(row => row.heroId === canonicalHero.hero.id);
        canonicalHero.conditions = entities.conditions.filter(row => heroEffectIds.has(row.ownerId));
    }
    const expectedEffects = browserCatalog.coverage.reviewedEffects;
    if (entities.effects.length !== expectedEffects || entities.effects.some(effect => !effect.claimIds.length)) {
        throw new Error('The imported reviewed-effect roster does not match its selected coverage manifest.');
    }
    const metadata = { schemaVersion: 1, version, createdAt, generatedAt: createdAt, build: mechanics.build,
        patchLabel: mechanics.build?.publicPatchLabel
            ? { state: 'known', value: mechanics.build.publicPatchLabel }
            : { state: 'unknown', reason: 'The installed build has no verified public patch mapping.' },
        extractorVersion: mechanics.importerVersion ?? null,
        decoderVersion: mechanics.valueDecoderVersion ?? null, reviewVersion: annotations.version,
        compilerVersion: COMPILE_VERSION, sourceIdentities: {
            mechanics: mechanics.sourceHash, reviewedAnnotations: annotations.sourceHash,
            annotationBytes: sourceBytes.annotations ? textHash(sourceBytes.annotations) : null,
            enrichedNative: externalEvidence.nativeSourceHash, externalEvidence: externalEvidence.version,
            externalEvidenceBytes: sourceBytes.externalEvidence ? textHash(sourceBytes.externalEvidence) : null,
        },
        sourceCompatibility: { originalPolicyVersion: externalEvidence.policyVersion ?? null,
            limits: externalEvidence.limits ?? null, limitations: externalEvidence.limitations ?? [],
            populationVersion: externalEvidence.stratzPopulation?.version ?? null,
            officialDataset: externalEvidence.officialHeroData ? {
                version: externalEvidence.officialHeroData.version,
                nativeSourceHash: externalEvidence.officialHeroData.nativeSourceHash,
                nativeBuild: externalEvidence.officialHeroData.nativeBuild,
                createdAt: externalEvidence.officialHeroData.createdAt,
                sourceBundle: externalEvidence.officialHeroData.sourceBundle,
                sourceManifestSha256: externalEvidence.officialHeroData.sourceManifestSha256,
                coverage: externalEvidence.officialHeroData.coverage,
                interpretation: externalEvidence.officialHeroData.interpretation,
            } : null,
        },
        coverage: { roster: entities.heroes.length, enabled: entities.heroes.filter(hero => hero.enabled).length,
            reviewedEffects: entities.effects.length, completeMechanics: false,
            externalSourceCount: sourceRows.filter(source => source.sourceKind !== 'installed-game-resource').length } };
    const coreClaims = claimRows.map(claim => {
        const { review, sourceRefs, sourceRecord, ...summary } = claim;
        return { ...summary,
            ...(review ? { review: { status: review.status, version: review.version,
                evidenceKind: review.evidenceKind, engineVerification: review.engineVerification,
                complete: review.complete } } : {}),
            detailsRef: `runtime/guides/${claim.heroId}.json#claims/${claim.id}` };
    });
    const core = { ...metadata, entities: {
        heroes: entities.heroes, abilities: entities.abilities, activations: entities.activations, effects: entities.effects,
        modifiers: entities.modifiers, rules: entities.rules, conditions: entities.conditions,
        units: entities.units, upgrades: entities.upgrades,
    }, sources: sourceRows, claims: coreClaims, observations };
    const population = externalEvidence.stratzPopulation ?? null;
    const canonical = { metadata, sources: sourceRows, claims: claimRows, heroes: canonicalHeroes };
    const result = { core, canonical, statisticFiles, guideFiles, population, sourceIdentities: metadata.sourceIdentities,
        rawBundles: { mechanics, annotations, browserCatalog, externalEvidence } };
    result.graph = graphFromBundleImport(result);
    return result;
}

const HERO_ID_PATTERN = /^[1-9]\d{0,5}$/;
export { COMPILE_VERSION, createPopulationObservations };

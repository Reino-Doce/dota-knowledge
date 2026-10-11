import { createHash } from 'node:crypto';
import { MECHANICS_VALUE_DECODER_VERSION, normalizeMechanicsValue, parseMechanicsDefinitions } from './native-import.mjs';
import { decodeNativeDeclarations, indexDecodedAbilityMechanics, NATIVE_DECLARATION_DECODER_VERSION } from './native-declarations.mjs';

export const NATIVE_HERO_DATA_VERSION = 'hero-data-native-2';
export const NATIVE_HERO_DATA_LIMITS = Object.freeze({ resources: 512, bytes: 16 * 1024 * 1024,
    heroes: 256, nodesPerHero: 1024, referencesPerHero: 16384, unitCandidatesPerHero: 256, depth: 64, fields: 1000000 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pointer = (resource, sourcePath) => ({ sourceResource: resource, sourcePath });
const abilityResource = 'scripts/npc/npc_abilities.txt';
const unitResource = 'scripts/npc/npc_units.txt';
const abilityIdResource = 'scripts/npc/npc_ability_ids.txt';
const abilityLocalization = 'resource/localization/abilities_english.txt';
const optionalLocalization = ['resource/localization/dota_english.txt', 'resource/localization/hero_lore_english.txt'];

/** A declaration overlay is evidence about file defaults, never a claim about engine behavior. */
export function enrichNativeHeroData(catalog, read) {
    if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.heroes) || !Array.isArray(catalog.sources)
        || catalog.heroes.length > NATIVE_HERO_DATA_LIMITS.heroes || typeof read !== 'function') {
        throw new Error('Native enrichment requires a bounded raw mechanics catalog and resource reader.');
    }
    const sources = new Map();
    const documents = new Map();
    const ambiguities = [...(catalog.declarationAmbiguities || [])];
    const optionalResources = [];
    const load = (resource, optional = false) => {
        if (!/^(?:scripts\/npc\/[\w./-]+|resource\/localization\/[\w/-]+)\.txt$/.test(resource)
            || resource.includes('..')) throw new Error('Invalid native enrichment resource path.');
        if (documents.has(resource)) return documents.get(resource);
        if (sources.size >= NATIVE_HERO_DATA_LIMITS.resources) throw new Error('Native resource bound exceeded.');
        let bytes;
        try {
            bytes = Buffer.from(read(resource));
        }
        catch (error) {
            if (!optional) throw error;
            optionalResources.push({ resource, state: 'unknown', reason: 'resource-unavailable' });
            return null;
        }
        if (bytes.length > NATIVE_HERO_DATA_LIMITS.bytes) throw new Error('Native resource byte bound exceeded.');
        const sha256 = hash(bytes);
        const prior = catalog.sources.find(source => source.resource === resource);
        if (prior && prior.sha256 !== sha256) throw new Error(`Native source changed during extraction: ${resource}`);
        const text = bytes.toString('utf8').replace(/^\s*#base\s+"[^"]+"/gm, '');
        const document = parseMechanicsDefinitions(text, { duplicateDeclarations: ambiguities, resource });
        sources.set(resource, { resource, sha256, bytes: bytes.length });
        documents.set(resource, document);
        if (optional) optionalResources.push({ resource, state: 'known', sha256 });
        return document;
    };
    for (const source of catalog.sources) load(source.resource);
    const shared = load(abilityResource).DOTAAbilities;
    const units = load(unitResource).DOTAUnits;
    if (!object(shared) || !object(units)) throw new Error('Missing native ability or unit declarations.');
    for (const resource of optionalLocalization) load(resource, true);
    const abilityIds = load(abilityIdResource, true)?.DOTAAbilityIDs?.UnitAbilities?.Locked || {};
    const ambiguityMap = new Map();
    for (const ambiguity of ambiguities) {
        const key = JSON.stringify(ambiguity);
        ambiguityMap.set(key, ambiguity);
    }
    const declarationAmbiguities = [...ambiguityMap.values()];
    const relatedAmbiguities = (resource, sourcePath) => declarationAmbiguities.filter(row => row.state !== 'equivalent-duplicate'
        && row.resource === resource
        && (row.path === sourcePath || row.path.startsWith(`${sourcePath}.`) || sourcePath.startsWith(`${row.path}.`)));
    const declaration = (raw, resource, sourcePath) => ({ state: raw === undefined ? 'unknown'
        : relatedAmbiguities(resource, sourcePath).length ? 'unsupported' : 'known', raw: raw ?? null,
    ...pointer(resource, sourcePath) });
    const heroBaseEntry = [...documents.entries()].find(([, document]) => object(document.DOTAHeroes?.npc_dota_hero_base));
    if (!heroBaseEntry) throw new Error('Missing native hero base declaration.');
    const baseDeclarations = {
        hero: declaration(heroBaseEntry[1].DOTAHeroes.npc_dota_hero_base, heroBaseEntry[0], 'DOTAHeroes.npc_dota_hero_base'),
        ability: declaration(shared.ability_base, abilityResource, 'DOTAAbilities.ability_base'),
        unit: declaration(units.npc_dota_units_base, unitResource, 'DOTAUnits.npc_dota_units_base'),
        abilityClass: declaration(shared.dota_base_ability, abilityResource, 'DOTAAbilities.dota_base_ability'),
    };
    const fields = (record, base, options = {}) => decodeNativeDeclarations(record, base,
        { ...options, ambiguities: relatedAmbiguities, maxDepth: NATIVE_HERO_DATA_LIMITS.depth });
    const localizationEntries = [...documents.entries()].filter(([resource]) => resource.startsWith('resource/localization/'))
        .flatMap(([resource, document]) => Object.entries(document.lang?.Tokens || {}).map(([key, value]) => ({ resource, key, value })))
        .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const tokenRange = prefix => {
        let start = 0;
        let end = localizationEntries.length;
        while (start < end) {
            const middle = Math.floor((start + end) / 2);
            if (localizationEntries[middle].key < prefix) start = middle + 1;
            else end = middle;
        }
        const result = [];
        for (let index = start; index < localizationEntries.length && localizationEntries[index].key.startsWith(prefix); index += 1) {
            result.push(localizationEntries[index]);
        }
        return result;
    };
    const localizationCache = new Map();
    const knownAbilityNames = new Set([...Object.keys(shared), ...catalog.heroes.flatMap(hero =>
        [...(hero.abilities || []).map(ability => ability.abilityId), ...Object.keys(hero.raw?.AbilityDefinitions || {})])]);
    const tokenAbility = token => {
        let name = token.replace(/^DOTA_Tooltip_(?:ability|modifier)_/, '');
        while (name) {
            if (knownAbilityNames.has(name)) return name;
            const last = name.lastIndexOf('_');
            name = last < 0 ? '' : name.slice(0, last);
        }
        return null;
    };
    const localize = prefixes => {
        const cacheKey = JSON.stringify(prefixes);
        if (localizationCache.has(cacheKey)) return localizationCache.get(cacheKey);
        const tokenSources = {};
        const tokens = {};
        for (const { resource, key, value } of prefixes.flatMap(tokenRange)) {
            if (!prefixes.some(prefix => key === prefix || key.startsWith(`${prefix}_`) || key.startsWith(`${prefix}:`))) continue;
            const tokenPrefix = /^DOTA_Tooltip_(?:ability|modifier)_/.exec(key)?.[0];
            if (tokenPrefix) {
                const owner = tokenAbility(key);
                if (owner && prefixes.some(prefix => prefix.startsWith(tokenPrefix)
                    && owner.length > prefix.slice(tokenPrefix.length).length)) continue;
            }
            const record = declaration(value, resource, `lang.Tokens.${key}`);
            (tokenSources[key] ||= []).push(record);
            if (!Object.hasOwn(tokens, key)) tokens[key] = value;
        }
        const conflictingTokens = Object.entries(tokenSources).filter(([, rows]) => rows.some(row => row.state !== 'known')
            || new Set(rows.map(row => JSON.stringify(row.raw))).size > 1).map(([token]) => token);
        const result = { state: conflictingTokens.length ? 'unsupported' : Object.keys(tokens).length ? 'known' : 'unknown',
            sourceResource: abilityLocalization, sourceResources: [...new Set(Object.values(tokenSources).flat().map(row => row.sourceResource))],
            tokens, tokenSources, conflictingTokens,
            interpretation: 'Source text can include markup, placeholders and outdated descriptions; declarations remain separate.' };
        localizationCache.set(cacheKey, result);
        return result;
    };
    const abilityRecords = new Map();
    const register = (id, record) => {
        if (!object(record.raw)) return;
        const rows = abilityRecords.get(id) || [];
        rows.push(record);
        abilityRecords.set(id, rows);
    };
    for (const [id, raw] of Object.entries(shared)) {
        if (!['ability_base', 'dota_base_ability'].includes(id)) register(id, declaration(raw, abilityResource, `DOTAAbilities.${id}`));
    }
    for (const hero of catalog.heroes) {
        for (const [id, raw] of Object.entries(hero.raw?.AbilityDefinitions || {})) {
            register(id, { ...declaration(raw, hero.sourceResource, `DOTAHeroes.${hero.heroKey}.AbilityDefinitions.${id}`), owner: hero.heroKey });
        }
    }
    const findAbility = (id, owner) => {
        if (id === 'ability_base') return baseDeclarations.ability;
        if (id === 'dota_base_ability') return baseDeclarations.abilityClass;
        const candidates = abilityRecords.get(id) || [];
        const own = candidates.filter(record => record.owner === owner);
        const sharedRecords = candidates.filter(record => !record.owner);
        const selected = own.length ? own : sharedRecords.length ? sharedRecords : candidates;
        if (selected.length === 1) return { ...selected[0], candidates: [] };
        return { state: selected.length ? 'unsupported' : 'unknown', raw: null, candidates: selected,
            reason: selected.length ? 'multiple-ability-declarations' : 'ability-definition-unavailable' };
    };
    const upgradeBranches = record => {
        const rows = [];
        const visit = (value, sourcePath, depth = 0) => {
            if (depth > NATIVE_HERO_DATA_LIMITS.depth) throw new Error('Native declaration depth bound exceeded.');
            if (!object(value)) return;
            for (const [key, child] of Object.entries(value)) {
                const at = `${sourcePath}.${key}`;
                if (/scepter|shard|facet|special_bonus|^Requires|^IsGrantedBy|^Has.+Upgrade/i.test(key)) {
                    rows.push({ key, ...declaration(child, record.sourceResource, at), interpretation: 'unreviewed-condition' });
                }
                visit(child, at, depth + 1);
            }
        };
        visit(record.raw, record.sourcePath);
        return rows;
    };
    const dependencyGraph = [...(catalog.dependencyGraph || [])].filter(edge => edge.kind === 'base-include');
    const enrichedHeroes = catalog.heroes.map(hero => {
        const heroRecord = declaration(hero.raw, hero.sourceResource, `DOTAHeroes.${hero.heroKey}`);
        const references = [];
        const seenReferences = new Set();
        const queue = [];
        const visited = new Set();
        const abilityDependencies = [];
        const unitDependencies = [];
        let examinedFields = 0;
        const addReference = (from, kind, id, sourceResource, sourcePath, relation) => {
            if (id === hero.heroKey || !id || id === '0') return;
            const key = JSON.stringify([from, kind, id, sourceResource, sourcePath, relation]);
            if (seenReferences.has(key)) return;
            if (references.length >= NATIVE_HERO_DATA_LIMITS.referencesPerHero) throw new Error('Native reference bound exceeded.');
            seenReferences.add(key);
            const ref = { from, to: id, kind, relation, ...pointer(sourceResource, sourcePath),
                interpretation: 'explicit-declaration-reference; ownership and runtime behavior unproven' };
            references.push(ref);
            queue.push({ id, kind });
        };
        const scan = (raw, from, resource, sourcePath, depth = 0) => {
            if (depth > NATIVE_HERO_DATA_LIMITS.depth) throw new Error('Native declaration depth bound exceeded.');
            if (!object(raw)) return;
            for (const [key, value] of Object.entries(raw)) {
                examinedFields += 1;
                if (examinedFields > NATIVE_HERO_DATA_LIMITS.fields) throw new Error('Native field bound exceeded.');
                const at = `${sourcePath}.${key}`;
                if (key === 'AbilityDefinitions') continue;
                if (abilityRecords.has(key) || key.startsWith('special_bonus_')) {
                    addReference(from, 'ability', key, resource, at, 'declaration-key-reference');
                }
                if (typeof value === 'string') {
                    for (const id of value.match(/\bnpc_dota_[a-z0-9_]+\b/g) || []) {
                        addReference(from, id.startsWith('npc_dota_hero_') ? 'hero-reference' : 'unit', id, resource, at, 'literal-name-reference');
                    }
                    const words = value.trim().split(/[\s,;|]+/);
                    const abilityField = /^(?:_base|Ability\d+|ad_linked_ability|LinkedAbility|LinkedAbilities|AbilityNames?|AssociatedPrimaryAbilities|AssociatedSecondaryAbilities|DependentOnAbility|SubAbilityNames|FakeSubAbilityNames|AbilityDraftExtraAbilities|AbilityDraftUltShardAbility)$/i.test(key);
                    for (const id of words) {
                        if (/^[a-z][a-z0-9_]*$/.test(id) && !id.startsWith('npc_dota_') && (abilityRecords.has(id) || abilityField)) {
                            addReference(from, 'ability', id, resource, at, abilityField ? 'ability-field-reference' : 'literal-name-reference');
                        }
                    }
                }
                else scan(value, from, resource, at, depth + 1);
            }
        };
        const excludedAbilityDeclarations = (hero.abilities || []).filter(ability =>
            Object.hasOwn(hero.raw?.AbilityDefinitions || {}, ability.abilityId) && !object(hero.raw.AbilityDefinitions[ability.abilityId]))
            .map(ability => ({ ...ability, state: 'unsupported', reason: 'non-object-ability-declaration' }));
        const excluded = new Set(excludedAbilityDeclarations.map(row => row.abilityId));
        const initialAbilities = (hero.abilities || []).filter(ability => !excluded.has(ability.abilityId));
        const initialIds = new Set(initialAbilities.map(ability => ability.abilityId));
        scan(hero.raw, hero.heroKey, hero.sourceResource, heroRecord.sourcePath);
        for (const slot of hero.abilitySlots || []) {
            const source = Object.hasOwn(hero.raw, slot.slot) ? heroRecord : baseDeclarations.hero;
            if (!excluded.has(slot.abilityId)) addReference(hero.heroKey, 'ability', slot.abilityId, source.sourceResource,
                `${source.sourcePath}.${slot.slot}`, 'ability-slot');
        }
        for (const id of initialIds) queue.push({ id, kind: 'ability' });
        while (queue.length) {
            const { id, kind } = queue.shift();
            const visitKey = `${kind}:${id}`;
            if (visited.has(visitKey) || kind === 'hero-reference') continue;
            if (visited.size >= NATIVE_HERO_DATA_LIMITS.nodesPerHero) throw new Error('Native dependency node bound exceeded.');
            visited.add(visitKey);
            const record = kind === 'ability' ? findAbility(id, hero.heroKey)
                : declaration(units[id], unitResource, `DOTAUnits.${id}`);
            const idDeclaration = declaration(abilityIds[id], abilityIdResource, `DOTAAbilityIDs.UnitAbilities.Locked.${id}`);
            const engineId = idDeclaration.state !== 'known' ? idDeclaration : /^\d{1,16}$/.test(abilityIds[id])
                ? { ...idDeclaration, value: abilityIds[id] } : { ...idDeclaration, state: 'unsupported' };
            const nativeDeclarations = fields(record, kind === 'ability' ? baseDeclarations.ability : baseDeclarations.unit,
                { findParent: (parentId, current) => kind === 'ability' ? findAbility(parentId, current.owner || hero.heroKey)
                    : declaration(units[parentId], unitResource, `DOTAUnits.${parentId}`) });
            const enriched = { ...(kind === 'ability' ? { abilityId: id } : { unitKey: id }), ...record,
                ...(kind === 'ability' ? { localization: localize([`DOTA_Tooltip_ability_${id}`]),
                    modifierLocalizationCandidates: { ...localize([`DOTA_Tooltip_modifier_${id}`]),
                        evidenceKind: 'name-based-localization-candidate', relation: 'unknown',
                        interpretation: 'Token names share an ability-name prefix; attribution, effects and ownership are unverified.' },
                    upgradeBranches: upgradeBranches(record), engineId } : {}),
                nativeDeclarations,
                interpretation: { state: 'unknown', reason: 'A declared reference does not establish controllability, ownership or runtime behavior.' } };
            if (kind === 'ability') abilityDependencies.push(enriched);
            else unitDependencies.push(enriched);
            if (record.raw) scan(record.raw, id, record.sourceResource, record.sourcePath);
            for (const [fieldPath, provenance] of Object.entries(nativeDeclarations.leafProvenance)) {
                if (!provenance.inherited) continue;
                const [field, ...parts] = fieldPath.split('.');
                const value = parts.reduce((node, key) => node?.[key], nativeDeclarations.fields[field].raw);
                const key = parts.at(-1) || field;
                scan({ [key]: value }, id, provenance.sourceResource, provenance.sourcePath.slice(0, -(key.length + 1)));
            }
        }
        const indexedAbilities = new Map(abilityDependencies.map(ability => [ability.abilityId, ability]));
        const upgradeSelector = id => /^special_bonus_(?:shard|scepter|facet)(?:_|$)/.test(id);
        const talentSlotIds = new Set((hero.abilitySlots || []).map(slot => slot.abilityId)
            .filter(id => id.startsWith('special_bonus_') && !upgradeSelector(id)));
        const isTalent = ability => !upgradeSelector(ability.abilityId) && (talentSlotIds.has(ability.abilityId)
            || ability.raw?.AbilityType === 'ABILITY_TYPE_ATTRIBUTES');
        const talentRecord = ability => ({ abilityId: ability.abilityId,
            state: ability.state, slots: (hero.abilitySlots || []).filter(slot => slot.abilityId === ability.abilityId).map(slot => slot.slot),
            localization: ability.localization, sourceResource: ability.sourceResource, sourcePath: ability.sourcePath,
            modifierReferences: references.filter(ref => ref.to === ability.abilityId && ref.relation === 'declaration-key-reference'),
            levelRequirement: ability.raw?.RequiredLevel === undefined ? { state: 'unknown' }
                : normalizeMechanicsValue(ability.raw.RequiredLevel, pointer(ability.sourceResource, `${ability.sourcePath}.RequiredLevel`)) });
        const talents = abilityDependencies.filter(isTalent).map(talentRecord);
        const talentCandidates = abilityDependencies.filter(ability => !isTalent(ability) && ability.abilityId.startsWith('special_bonus_unique_'))
            .map(ability => ({ ...talentRecord(ability), state: 'unknown', reason: 'modifier-key-without-declared-talent-slot-or-type' }));
        const talentCandidateIds = new Set(talentCandidates.map(candidate => candidate.abilityId));
        for (const ability of abilityDependencies) {
            const incoming = references.filter(ref => ref.to === ability.abilityId);
            const kind = ability.raw !== null ? 'ability-declaration' : upgradeSelector(ability.abilityId) ? 'upgrade-condition-selector'
                : talentSlotIds.has(ability.abilityId) ? 'declared-talent-slot' : talentCandidateIds.has(ability.abilityId) ? 'talent-modifier-candidate'
                    : incoming.length && incoming.every(ref => ref.sourcePath.endsWith('.FakeSubAbilityNames')) ? 'fake-subability-name'
                        : ability.abilityId.startsWith('item_') ? 'item-reference' : 'unresolved-ability-reference';
            ability.referenceClassification = { kind,
                standaloneDefinitionExpected: ['upgrade-condition-selector', 'fake-subability-name'].includes(kind) ? false
                    : ['talent-modifier-candidate', 'item-reference', 'declared-talent-slot'].includes(kind) ? 'unknown' : true };
            ability.decodedMechanics = indexDecodedAbilityMechanics(ability.nativeDeclarations, references.filter(ref => ref.from === ability.abilityId));
            for (const gap of ability.decodedMechanics.gaps) {
                if (gap.reason === 'ability-definition-unavailable') {
                    gap.reason = ({ 'upgrade-condition-selector': 'condition-selector-without-standalone-ability',
                        'declared-talent-slot': 'talent-slot-without-standalone-definition',
                        'talent-modifier-candidate': 'modifier-symbol-without-declared-talent-definition',
                        'fake-subability-name': 'fake-subability-label-without-standalone-definition',
                        'item-reference': 'referenced-item-definition-not-imported' })[kind] || gap.reason;
                    gap.referenceKind = kind;
                }
            }
        }
        const abilities = initialAbilities.map(ability => ({ ...ability, ...indexedAbilities.get(ability.abilityId), owner: hero.heroKey }));
        const facetMetadata = Object.entries(hero.raw?.Facets || {}).map(([facetId, raw]) => ({ facetId,
            ...declaration(raw, hero.sourceResource, `${heroRecord.sourcePath}.Facets.${facetId}`),
            nativeDeclarations: fields(declaration(raw, hero.sourceResource, `${heroRecord.sourcePath}.Facets.${facetId}`), null),
            deprecated: raw?.Deprecated === undefined ? { state: 'unknown' }
                : { state: 'known', raw: raw.Deprecated, value: ['true', '1'].includes(String(raw.Deprecated).toLowerCase()) },
            localization: localize([`DOTA_Tooltip_Facet_${facetId}`]), interpretation: 'Historical declarations do not establish current selectability.' }));
        const unresolvedReferences = references.filter(ref => ref.kind === 'ability' ? indexedAbilities.get(ref.to)?.state !== 'known'
            : ref.kind === 'unit' ? !object(units[ref.to]) : !catalog.heroes.some(candidate => candidate.heroKey === ref.to));
        const unitCandidates = [];
        for (const unresolved of unitDependencies.filter(unit => unit.raw === null)) {
            for (const [unitKey, raw] of Object.entries(units)) {
                if (!object(raw) || !unitKey.startsWith(unresolved.unitKey)
                    || !/^[1-9]\d*$/.test(unitKey.slice(unresolved.unitKey.length))) continue;
                if (unitCandidates.length >= NATIVE_HERO_DATA_LIMITS.unitCandidatesPerHero) throw new Error('Native unit candidate bound exceeded.');
                const record = declaration(raw, unitResource, `DOTAUnits.${unitKey}`);
                unitCandidates.push({ unitKey, candidateFor: unresolved.unitKey, ...record,
                    nativeDeclarations: fields(record, baseDeclarations.unit,
                        { findParent: parentId => declaration(units[parentId], unitResource, `DOTAUnits.${parentId}`) }),
                    evidenceKind: 'enumerated-name-family-candidate', relation: 'unknown', ownership: 'unknown',
                    interpretation: 'An installed unit name matches the unresolved stem plus a positive integer; runtime linkage is unverified.',
                    abilitySlots: Object.entries(raw).filter(([key, value]) => /^Ability\d+$/.test(key) && typeof value === 'string' && value.length)
                        .sort(([left], [right]) => Number(left.slice(7)) - Number(right.slice(7)))
                        .map(([slot, abilityId]) => ({ slot, abilityId, ...pointer(unitResource, `${record.sourcePath}.${slot}`) })),
                });
            }
        }
        dependencyGraph.push(...references.map(ref => ({ ...ref, owner: hero.heroKey })));
        return { ...hero, abilities, nativeDeclarations: fields(heroRecord, baseDeclarations.hero, { exclude: ['AbilityDefinitions'],
            findParent: id => id === 'npc_dota_hero_base' ? baseDeclarations.hero : (() => {
                const parent = catalog.heroes.find(candidate => candidate.heroKey === id);
                return parent ? declaration(parent.raw, parent.sourceResource, `DOTAHeroes.${id}`) : null;
            })() }),
        localization: localize([hero.heroKey]), talents, talentCandidates, facetMetadata, excludedAbilityDeclarations,
        importerAudit: { unitDependencies: hero.unitDependencies || [] }, unitDependencies,
        nativeDependencies: { state: 'partial', abilities: abilityDependencies.filter(ability => !initialIds.has(ability.abilityId)),
            references, unresolvedReferences, unitCandidates, ownership: 'unknown', implicitRuntimeDependencies: 'unknown' },
        dependencyCoverage: { state: 'partial', explicitReferences: references.length, unresolvedReferences: unresolvedReferences.length,
            reason: 'Literal declarations are traversed transitively; native code and runtime-created dependencies are not discoverable here.' } };
    });
    const manifestSources = [...sources.values()].sort((a, b) => a.resource.localeCompare(b.resource));
    const sourceHash = hash(JSON.stringify({ version: NATIVE_HERO_DATA_VERSION, build: catalog.build, sources: manifestSources,
        unavailableResources: optionalResources.filter(row => row.state !== 'known').map(row => row.resource) }));
    const decodedAbilities = enrichedHeroes.flatMap(hero => [...hero.abilities, ...hero.nativeDependencies.abilities]);
    return { ...catalog, nativeEnrichmentVersion: NATIVE_HERO_DATA_VERSION, baseDeclarations, optionalResources, sourceHash,
        declarationDecoderVersion: NATIVE_DECLARATION_DECODER_VERSION, mechanicsValueDecoderVersion: MECHANICS_VALUE_DECODER_VERSION,
        declarationProjectionHash: hash(JSON.stringify({ sourceHash, declarationDecoderVersion: NATIVE_DECLARATION_DECODER_VERSION,
            mechanicsValueDecoderVersion: MECHANICS_VALUE_DECODER_VERSION })),
        rawMechanicsSourceHash: catalog.sourceHash, sources: manifestSources, declarationAmbiguities, dependencyGraph, heroes: enrichedHeroes,
        coverage: { ...catalog.coverage, definitionComplete: false, enrichmentComplete: false,
            optionalLocalizationAvailable: optionalResources.filter(row => row.state === 'known' && optionalLocalization.includes(row.resource)).length,
            declarationAmbiguities: declarationAmbiguities.filter(row => row.state !== 'equivalent-duplicate').length,
            equivalentDuplicateDeclarations: declarationAmbiguities.filter(row => row.state === 'equivalent-duplicate').length,
            declarationDecoding: { abilities: decodedAbilities.length,
                decoded: decodedAbilities.filter(ability => ability.decodedMechanics.state === 'decoded').length,
                partial: decodedAbilities.filter(ability => ability.decodedMechanics.state === 'partial').length,
                unavailableDefinitions: Object.fromEntries([...new Set(decodedAbilities.filter(ability => ability.raw === null)
                    .map(ability => ability.referenceClassification.kind))].sort().map(kind => [kind,
                    decodedAbilities.filter(ability => ability.raw === null && ability.referenceClassification.kind === kind).length])),
                explicitParents: decodedAbilities.reduce((count, ability) => count + ability.nativeDeclarations.inheritance.chain.length, 0),
                resolvedParentEdges: decodedAbilities.reduce((count, ability) => count
                    + ability.nativeDeclarations.inheritance.chain.filter(edge => edge.state === 'resolved').length, 0),
                completeMechanics: 0 },
            explicitReferences: enrichedHeroes.reduce((count, hero) => count + hero.nativeDependencies.references.length, 0),
            unresolvedReferences: enrichedHeroes.reduce((count, hero) => count + hero.nativeDependencies.unresolvedReferences.length, 0) },
        limitations: [...(catalog.limitations || []),
            'Explicit _base templates and defaults are recursively overlaid with leaf provenance; engine dispatch and implicit defaults remain unverified.',
            'Missing, cyclic or ambiguous templates remain explicit inheritance gaps; raw declarations and duplicate alternatives are preserved.',
            'Name references are lexical evidence only and never prove summons, controllability, ownership or tactical relationships.',
            'Localization is preserved verbatim with markup/placeholders and may lag executable mechanics.',
            'Modifier localization and numbered unit-name families are labeled name-based candidates; neither establishes a runtime relationship.',
            'Talent slots and raw prerequisites are preserved without inferring unlock levels; deprecated facets remain historical metadata.',
            'Upgrade selectors are not talents; unique modifier keys lacking talent slots or types remain separate talent candidates.',
            'Duplicate declarations retain alternatives and are unsupported; raw values must not be treated as resolved mechanics.'] };
}

import type { AbilityRecord, ActivationRecord, ClaimRecord, ConditionRecord, EffectRecord, HeroEvidence, HeroId, HeroRecord,
    MechanicRuleRecord, ModifierRecord, ObservationFilter, ObservationRecord, SourceRecord, StableId, UnitRecord,
    UpgradeRecord, ValueRecord } from './records.js';
export type { AbilityRecord, ActivationRecord, ClaimRecord, ConditionRecord, DecodedValue, EffectRecord, HeroEvidence, HeroId, HeroRecord,
    ConflictedValue, KnownValue, MechanicRuleRecord, ModifierRecord, NotApplicableValue, ObservationFilter, ObservationRecord,
    SourceRecord, PreservationReference, StableId, TypedValue, UnitRecord, UnknownValue, UnsupportedValue, UpgradeRecord, ValueConflict,
    ValueRepresentation, EvidenceRef, ValueRecord, NativeRole, ProfileFieldStatus, ReviewBinding, ImageIdentity, ImageDescriptor, ItemId } from './records.js';
export interface KnowledgeEntity { readonly id: StableId | HeroId; readonly [field: string]: unknown }
export interface ArtifactDescriptor {
    readonly name: string;
    readonly bytes: number;
    readonly sha256: string;
}
export interface ObservationShardDescriptor extends ArtifactDescriptor {
    readonly heroIds: readonly HeroId[];
    readonly otherHeroIds?: readonly HeroId[];
    readonly allyHeroIds?: readonly HeroId[];
    readonly opponentHeroIds?: readonly HeroId[];
    readonly cohortIds?: readonly StableId[];
    readonly kinds: readonly string[];
    readonly sourceIds: readonly StableId[];
}
export interface KnowledgeDatasetMetadata {
    readonly schemaVersion: 2;
    readonly version: string;
    readonly createdAt: string;
    readonly generatedAt: string;
    readonly build: Readonly<Record<string, unknown>>;
    readonly patchLabel: Readonly<Record<string, unknown>>;
    readonly extractorVersion: string | null;
    readonly decoderVersion: string | null;
    readonly reviewVersion: string | null;
    readonly compilerVersion: string;
    readonly sourceIdentities: Readonly<Record<string, string | null>>;
    readonly sourceCompatibility: Readonly<Record<string, unknown>>;
    readonly coverage: Readonly<Record<string, unknown>>;
}
export interface KnowledgeManifest {
    readonly schemaVersion: 2;
    readonly version: string;
    readonly createdAt: string;
    readonly core: ArtifactDescriptor;
    readonly guides: Readonly<Record<string, ArtifactDescriptor>>;
    readonly observationShards?: readonly ObservationShardDescriptor[];
    readonly [field: string]: unknown;
}
export interface KnowledgeStore {
    readonly manifest: KnowledgeManifest;
    readonly metadata: KnowledgeDatasetMetadata;
    readonly version: string;
    readonly coreSha256: string;
    heroes(): readonly HeroRecord[];
    hero(id: HeroId | string): HeroRecord | undefined;
    /** Exact canonical key; no case folding, provider-slug conversion or alias fallback. */
    heroByKey(key: string): HeroRecord | undefined;
    /** All recorded alias candidates, normalized by trim/lowercase/collapsed whitespace and sorted by canonical key. */
    heroesByAlias(alias: string): readonly HeroRecord[];
    ability(id: StableId | string): AbilityRecord | undefined;
    activation(id: StableId | string): ActivationRecord | undefined;
    effect(id: StableId | string): EffectRecord | undefined;
    effectsForHero(id: HeroId | string): readonly EffectRecord[];
    modifier(id: StableId | string): ModifierRecord | undefined;
    rule(id: StableId | string): MechanicRuleRecord | undefined;
    condition(id: StableId | string): ConditionRecord | undefined;
    value(id: StableId | string): ValueRecord | undefined;
    unit(id: StableId | string): UnitRecord | undefined;
    upgrade(id: StableId | string): UpgradeRecord | undefined;
    source(id: StableId | string): SourceRecord | undefined;
    sources(): readonly SourceRecord[];
    claim(id: StableId | string): ClaimRecord | undefined;
    claims(): readonly ClaimRecord[];
    observations(filter?: ObservationFilter): readonly ObservationRecord[];
    loadObservations(filter?: ObservationFilter): Promise<readonly ObservationRecord[]>;
    getHeroEvidence(id: HeroId | string): HeroEvidence | undefined;
    loadHeroEvidence(id: HeroId | string): Promise<HeroEvidence | undefined>;
    clearEvidenceCache(): void;
    retire(): void;
}
export class KnowledgeDataError extends Error {
    readonly code: string;
}
export const KNOWLEDGE_CORE_MAX_BYTES: number;
export const HERO_EVIDENCE_MAX_BYTES: number;
export const HERO_EVIDENCE_CACHE_MAX_BYTES: number;
export const HERO_EVIDENCE_CACHE_MAX_COUNT: number;
export const OBSERVATION_SHARD_MAX_BYTES: number;
export function loadKnowledgeStore(options: {
    manifest: KnowledgeManifest;
    readArtifact: (artifact: ArtifactDescriptor & { kind: 'core' } | ArtifactDescriptor & {
        kind: 'guide'; heroId: HeroId; coreSha256: string;
    } | ObservationShardDescriptor & { kind: 'observations'; coreSha256: string }) => Promise<Uint8Array>;
    guideCacheSize?: number;
    guideCacheMaxBytes?: number;
}): Promise<KnowledgeStore>;
export function sha256Hex(bytes: Uint8Array): string;

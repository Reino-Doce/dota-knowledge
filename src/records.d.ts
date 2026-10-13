/** Public decimal identity from the game; never convert it to a JS number. */
export type HeroId = string & { readonly __heroId: unique symbol };
export type ItemId = string & { readonly __itemId: unique symbol };
/** Stable semantic identity persisted across compiler runs. */
export type StableId = string & { readonly __stableId: unique symbol };
export type ValueRepresentation = 'literal' | 'rankCurve' | 'formula' | 'structured';

export type KnownValue<T> = { readonly state: 'known'; readonly value: T; readonly unit?: string; readonly unitId?: StableId };
export type DecodedValue = { readonly state: 'decoded'; readonly kind: string; readonly decoded?: unknown; readonly raw?: unknown };
export type UnknownValue = { readonly state: 'unknown'; readonly reason: string };
export type UnsupportedValue = { readonly state: 'unsupported'; readonly reason: string; readonly raw?: unknown };
export type NotApplicableValue = { readonly state: 'notApplicable'; readonly reason: string };
export interface ValueConflict<T = unknown> {
    readonly value: T;
    readonly reason?: string;
}
export type ConflictedValue<T = unknown> = {
    readonly state: 'conflicted';
    readonly conflicts: readonly [ValueConflict<T>, ValueConflict<T>, ...ValueConflict<T>[]];
};
export type TypedValue<T = unknown> = KnownValue<T> | DecodedValue | UnknownValue | UnsupportedValue | NotApplicableValue | ConflictedValue<T>;

export interface EvidenceRef {
    readonly sourceId: StableId;
    readonly resource: string;
    readonly path: string;
    readonly sha256?: string | null;
    readonly [field: string]: unknown;
}
export interface HeroRecord {
    readonly id: HeroId;
    readonly key: string;
    /** Game engine identity, not an acquisition source. */
    readonly sourceKey: string;
    readonly name: string;
    /** Lowercase, normalized lookup aliases; ambiguous claims may have no lookup mapping. */
    readonly aliases: readonly string[];
    /** 0 strength, 1 agility, 2 intelligence, 3 universal. */
    readonly primaryAttribute: 0 | 1 | 2 | 3 | null;
    readonly attackRange: number | null;
    readonly complexity: 1 | 2 | 3 | null;
    readonly roles: readonly { readonly role: NativeRole; readonly level: 0 | 1 | 2 | 3 }[];
    readonly enabled: boolean;
    readonly cmEnabled: boolean;
    readonly abilityIds: readonly StableId[];
    readonly effectIds: readonly StableId[];
    /** Category scores: each distinct owned ability tag adds one point to every category it belongs to. */
    readonly capabilities?: Readonly<Record<string, number>>;
    readonly coverage: Readonly<Record<string, unknown>> & {
        readonly fields: Readonly<Record<'primaryAttribute' | 'attackRange' | 'complexity' | 'roles', ProfileFieldStatus>>;
    };
    readonly [field: string]: unknown;
}
export interface AbilityRecord {
    readonly id: StableId;
    readonly heroId: HeroId;
    readonly engineId: string;
    readonly activationId: StableId;
    readonly order: number;
    readonly state: 'known' | 'unknown' | 'unsupported';
    readonly tags: readonly string[];
    readonly [field: string]: unknown;
}
export interface ActivationRecord {
    readonly id: StableId;
    readonly heroId: HeroId;
    readonly abilityIds: readonly StableId[];
    readonly manaCost: TypedValue;
    readonly cooldown: TypedValue;
    readonly charges: TypedValue;
    readonly valueIds: readonly StableId[];
    readonly trigger?: TypedValue;
    readonly [field: string]: unknown;
}
export interface EffectRecord {
    readonly id: StableId;
    readonly legacyEffectId?: StableId;
    readonly heroId: HeroId;
    readonly abilityId: StableId | null;
    readonly legacyAbilityId?: string | null;
    readonly activationId: StableId;
    readonly order: number;
    readonly type: string;
    readonly subtype: string;
    readonly targets?: Readonly<Record<string, TypedValue>>;
    readonly values: Readonly<Record<string, TypedValue>>;
    readonly availability?: Readonly<Record<string, unknown>>;
    readonly delivery?: Readonly<Record<string, unknown>>;
    readonly interactions?: Readonly<Record<string, TypedValue>>;
    readonly relationships?: Readonly<Record<string, unknown>>;
    readonly valueIds: readonly StableId[];
    readonly conditionIds: readonly StableId[];
    readonly modifierIds: readonly StableId[];
    readonly ruleIds: readonly StableId[];
    readonly [field: string]: unknown;
}
export interface ConditionRecord {
    readonly id: StableId;
    readonly ownerId: StableId;
    readonly kind: string;
    readonly predicate: Readonly<Record<string, unknown>>;
    readonly conditionIds?: readonly StableId[];
}
export type ValueRecord = TypedValue & {
    readonly id: StableId;
    readonly ownerId: StableId;
    readonly field: string;
    readonly representation?: ValueRepresentation;
};
export interface ModifierRecord { readonly id: StableId; readonly effectIds: readonly StableId[]; readonly [field: string]: unknown }
export interface MechanicRuleRecord { readonly id: StableId; readonly effectIds: readonly StableId[]; readonly [field: string]: unknown }
export interface UnitRecord { readonly id: StableId; readonly heroIds: readonly HeroId[]; readonly [field: string]: unknown }
export interface UpgradeRecord { readonly id: StableId; readonly [field: string]: unknown }
/** Hash-bound original metadata in persistent evidence; runtime loading does not read it. */
export interface PreservationReference {
    readonly kind: 'archived-json';
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly pointer: string;
}
export interface SourceRecord {
    readonly id: StableId;
    readonly sha256?: string | null;
    readonly retrievedAt?: string | null;
    readonly observedAt?: string | null;
    readonly editedAt?: string | null;
    readonly publishedAt?: string | null;
    readonly revision?: string | number | null;
    readonly license?: string | null;
    readonly attribution?: string | null;
    readonly preservation?: PreservationReference;
    readonly [field: string]: unknown;
}
export interface ClaimRecord {
    readonly id: StableId;
    readonly subjectId?: StableId | HeroId;
    readonly heroId?: HeroId;
    readonly sourceIds: readonly StableId[];
    readonly status: 'reviewed' | 'proposed' | 'disputed' | 'rejected' | 'unknown';
    readonly review?: Readonly<Record<string, unknown>> | null;
    readonly compatibility?: Readonly<Record<string, unknown>>;
    readonly [field: string]: unknown;
}
export interface ObservationRecord {
    readonly id: StableId;
    readonly kind: string;
    readonly heroId?: HeroId;
    readonly otherHeroId?: HeroId;
    readonly allyHeroId?: HeroId;
    readonly opponentHeroId?: HeroId;
    readonly sourceId?: StableId | null;
    readonly cohortId?: StableId;
    readonly winCount?: string;
    readonly lossCount?: string;
    readonly matchCount?: string;
    readonly sampleCount?: string;
    readonly count?: string;
    readonly observedAt?: string | null;
    readonly direction?: string;
    readonly unit?: string;
    readonly sourceRecord?: unknown;
    readonly [field: string]: unknown;
}
export interface HeroEvidence {
    readonly heroId: HeroId;
    readonly version: string;
    readonly coreSha256: string;
    readonly sourceIdentities: Readonly<Record<string, string | null>>;
    readonly claims: readonly ClaimRecord[];
    readonly reviewBindings: readonly ReviewBinding[];
    readonly profileHistory?: Readonly<Record<string, unknown>>;
    readonly [field: string]: unknown;
}

export type NativeRole = 'carry' | 'support' | 'nuker' | 'disabler' | 'jungler' | 'durable' | 'escape' | 'pusher' | 'initiator';
export type ProfileFieldStatus = { readonly state: 'known' } | {
    readonly state: 'unknown' | 'unsupported' | 'notApplicable' | 'conflicted'; readonly reason: string;
};
/** Attribution for an explicit JSON pointer in a static subject record. */
export interface ReviewBinding {
    readonly subjectId: StableId | HeroId;
    readonly field: string;
    readonly value: unknown;
}
export interface ImageIdentity {
    readonly id: StableId;
    readonly entityKind: 'hero' | 'ability' | 'item';
    readonly entityId: StableId | HeroId | ItemId;
    readonly variant: string;
}
export type ImageDescriptor = ImageIdentity & ({
    readonly state: 'available';
    readonly path: string;
    readonly width: number;
    readonly height: number;
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/avif';
    readonly bytes: number;
    readonly sha256: string;
} | {
    readonly state: 'unavailable';
    readonly reason: string;
    readonly path?: never;
    readonly width?: never;
    readonly height?: never;
    readonly mediaType?: never;
    readonly bytes?: never;
    readonly sha256?: never;
});
export interface ObservationFilter {
    kind?: string;
    heroId?: HeroId | string;
    otherHeroId?: HeroId | string;
    allyHeroId?: HeroId | string;
    opponentHeroId?: HeroId | string;
    sourceId?: StableId | string;
    cohortId?: StableId | string;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface HeroIdentity { id: string; key: string; sourceKey: string; providerSlug?: string | null; enabled?: boolean }
export interface Artifact { name: string; sha256: string; bytes: number }
export type Provider = 'dotabuff' | 'stratz' | 'opendota';
export type Step = 'roster' | 'counters' | 'positions' | 'synergies' | 'timings' | 'lanes' | 'calibration';
export interface RequestDescriptor { provider: Provider; operation: string; format: 'json' | 'html'; [key: string]: Json }
export type ProviderClient = (request: RequestDescriptor, context: { signal: AbortSignal }) => Promise<Response>;
export interface Limits { retries: number; timeoutMs: number; maxBytes: number; spacingMs: number; maxWaitMs: number; resumeAgeMs: number; maxPages: number; maxWindows: number }
export interface Recipe { id: string; version: 1; [key: string]: Json }
export type RecipeName = 'dotabuff' | 'positions' | 'roles' | 'synergies' | 'timings' | 'lanes' | 'calibration';
export type RecipeSettings = Record<RecipeName, Recipe>;
export interface PriorInputs { positionPriors: Record<string, Record<number, number>> | null; matchRanges?: [string, string][]; [key: string]: Json | undefined }
export interface ModelAdapter {
    id: string; version: string; inputSignature: string; keys: string[];
    constraints: { nonPositive?: string[] };
    acceptance: { minMatches: number; minGain: number; maxBinError: number; minBinGames: number; positive: string[] };
    sample(match: { id: string; radiant: string[]; dire: string[]; y: number }, inputs: PriorInputs): Record<string, Json> | null;
    vectorize(sample: Record<string, Json>, tau: number): Record<string, number>;
}
export interface PopulationStorage {
    readonly root: string;
    read<T = Json>(name: string): Promise<T | null>;
    write(name: string, value: unknown): Promise<void>;
    artifact(bytes: Uint8Array, heroKey?: string | null, extension?: 'bin' | 'json'): Promise<Artifact>;
    bytes(descriptor: Artifact): Promise<Uint8Array>;
    list(prefix: string): Promise<string[]>;
    removeArtifact(descriptor: Artifact): Promise<void>;
    lock<T>(name: string, callback: () => Promise<T>): Promise<T>;
    recoverLock(name: string): Promise<void>;
}
export interface Roster {
    heroes: HeroIdentity[];
    resolve(field: 'id' | 'key' | 'sourceKey' | 'providerSlug', value: string | number): HeroIdentity;
    providerRows(rows: Json[], provider: 'stratz' | 'opendota'): Json[];
}
export interface ScopeSpec {
    key: string; kind: string; step: Step; provider: Provider; recipe: RecipeName;
    cohort: Record<string, Json>; heroKey: string | null; replacement: Record<string, Json>;
    matchIdRange?: [string, string]; matches?: string;
}
export interface StoredResponse { request: RequestDescriptor; artifact: Artifact; retrievedAt: string }
export interface NormalizedScope {
    schemaVersion: 1; state: 'complete'; spec: ScopeSpec; cohort: Record<string, Json>;
    observedAt: string; retrievedAt: string; recipe: Recipe; rows: PopulationObservation[];
    requests: StoredResponse[]; inputFingerprint: string;
}
export interface PopulationObservation { id: string; heroId: string; kind: string; logicalKey: Json; [key: string]: Json }
export interface ScopeResult { state: 'complete' | 'failed'; spec: ScopeSpec; normalized?: Artifact; evidence?: Artifact[]; observedAt?: string; code?: string; published?: boolean }
export interface PopulationRun {
    schemaVersion: 1; id: string; state: 'collecting' | 'complete' | 'partial'; fingerprint: string; startedAt: string; updatedAt: string;
    config: { roster: HeroIdentity[]; recipes: RecipeSettings; steps: readonly Step[]; priorInputs: PriorInputs; model: Json; queries: Json; plan: ScopeSpec[] };
    plan: ScopeSpec[]; scopes: Record<string, ScopeResult>; artifacts: Artifact[];
    requests: Record<string, StoredResponse & { state: 'complete' | 'invalid'; elapsedMs: number }>;
}
export interface CollectionOptions {
    runId: string; roster: HeroIdentity[]; clients: Partial<Record<Provider, ProviderClient>>; storage: PopulationStorage;
    clock: () => Date; sleep: (ms: number, signal: AbortSignal) => Promise<void>; signal: AbortSignal;
    logger: (event: Record<string, string | number>) => void; limits: Limits; recipes: RecipeSettings; priorInputs: PriorInputs;
    calibrationAdapter?: ModelAdapter; steps?: readonly Step[]; offline?: boolean; fresh?: boolean;
}
export const DEFAULT_STEPS: readonly Step[];
export const DEFAULT_LIMITS: Readonly<Limits>;
export const RECIPES_V1: RecipeSettings;
export function recipeSettings(overrides?: Partial<Record<RecipeName, Record<string, Json>>>): RecipeSettings;
export function createFileStorage(root: string): Promise<PopulationStorage>;
export function createRoster(heroes: HeroIdentity[]): Roster;
export function planPopulation(input: { roster: Roster; recipes: RecipeSettings; steps: readonly Step[]; now: number }): ScopeSpec[];
export function collectPopulation(options: CollectionOptions): Promise<PopulationRun>;
export function normalizeScope(spec: ScopeSpec, responses: (StoredResponse & { body: Json })[], context: {
    roster: Roster; recipes: RecipeSettings; priorInputs: PriorInputs; calibrationAdapter?: ModelAdapter;
}): NormalizedScope;
export function loadCompletedScopes(options: { run: PopulationRun; storage: PopulationStorage; selected?: string[]; calibrationAdapter?: ModelAdapter }): Promise<(ScopeResult & { value: NormalizedScope })[]>;
export function applyPopulation(options: { dataset: string; storage: PopulationStorage; runId: string; selected?: string[];
    clock: () => Date; calibrationAdapter?: ModelAdapter; interruptAt?: string; prune?: boolean }): Promise<{ state: string; manifestSha256: string }>;
export function recoverPopulation(options: { dataset: string; storage: PopulationStorage; interruptAt?: string }): Promise<{ state: string }>;
export function prunePopulation(options: { dataset: string; storage: PopulationStorage; interruptAt?: string }): Promise<{ state: string; manifestSha256: string; remaining: Artifact[]; deleted: string[] }>;
export function parseResponseJson(bytes: Uint8Array): Json;
export function decimal(value: string | number | bigint): string;
export function addCounts(...values: (string | number | bigint)[]): string;
export interface PairCounts { a: string; b: string; games: string; wins: string; cells: Record<'cc' | 'cs' | 'sc' | 'ss', { games: string; wins: string }> }
export interface SynergyTotals { heroes: Map<string, { games: string; wins: string }>; pairs: Map<string, PairCounts>; ambiguous: string }
export function foldSynergy(rows: { t: string | (number | string)[]; w: boolean | string | number }[], roster: Roster,
    positionPriors?: Record<string, Record<number, number>> | null, previous?: SynergyTotals): SynergyTotals;
export function derivePositions(lanes: Map<string, Record<string, { presence: number; winRate: number; gpm: number }>>,
    overall?: Map<string, number>): Map<string, { positions: Record<number, number>; positionWinRate: Record<number, number>; topPositions: number[] }>;
export function assignPositions<T>(team: T[], priors: Map<T, Record<number, number>>): { positions: number[]; margin: number; cellMargin: number };
export function fitModel(rows: Json[], context: { roster: Roster; priorInputs: PriorInputs; adapter: ModelAdapter; recipe: Recipe }): Record<string, Json>;
export function bandForMinRank(minRank: number): 'all' | 'divine' | 'immortal';
export function positionPriorsFromCounts(rows: PopulationObservation[], options: { band: string }): {
    priors: Record<string, Record<number, number>>; unavailable: Record<string, { state: 'unavailable'; reason: string }>;
};
export function createElectronClient(options: { electron: object; sessionDirectory: string; evidenceDirectory: string;
    clock: () => Date; sleep: (ms: number, signal: AbortSignal) => Promise<void>; signal: AbortSignal;
    logger: (event: Record<string, string>) => void; onChallenge: (context: { window: object; signal: AbortSignal }) => Promise<void>;
    challengeTimeoutMs: number }): Promise<ProviderClient & { close(): Promise<void> }>;

import type { Artifact, PopulationStorage } from './population.js';
import type { ImageCatalog, ImageEntity, ImageManifest } from '../images.js';
export { loadImageCatalog, resolveImageUrl } from '../images.js';
export type ImageStorage = PopulationStorage;
export interface ImageRoster {
    heroes: readonly { id: string; key: string; sourceKey: string; enabled: boolean; providerSlug?: string | null }[];
    abilities: readonly { id: string; heroId: string; engineId: string }[];
}
export interface ItemImagePolicy { version: string; clientVersion: string; pickups: readonly string[] }
export interface ImageSource { resource: string; sha256: string }
export interface ImageRequest {
    id: string; entityKind: 'hero' | 'ability' | 'item'; entityId: string; variant: 'icon' | 'profile';
    destination: string; reason: string; resource?: string | null; source?: ImageSource;
    heroKey?: string; providerSlug?: string | null; mapping?: string;
}
export interface ImageInventory {
    recipe: string; build: Record<string, unknown>; rosterSignature: string;
    entities: { heroes: readonly ImageEntity[]; abilities: readonly ImageEntity[]; items: readonly ImageEntity[] };
    exclusions: readonly { engineId: string; reason: string }[];
    requests: ImageRequest[]; inputs: readonly { resource: string; sha256: string; bytes: number }[];
    itemPolicy: ItemImagePolicy; evidence?: readonly { resource: string; artifact: Artifact }[];
}
export interface ImageDecoder {
    identity: { name: string; version: string; sha256: string };
    decode(resources: readonly { resource: string; bytes: Uint8Array }[], signal: AbortSignal): Promise<Map<string, Uint8Array>>;
}
export interface ImageRun {
    schemaVersion: 1; runId: string; state: 'collecting' | 'complete' | 'partial' | 'cancelled';
    generatedAt: string; inputSignature: string; inventory: ImageInventory;
    decoder: ImageDecoder['identity']; normalized: Artifact | null;
    results: Record<string, { state: string; raw?: Artifact; png?: Artifact; reason?: string }>;
}
export const STANDARD_ITEM_POLICY: ItemImagePolicy;
export function createImageStorage(root: string): Promise<ImageStorage>;
export function inventoryImages(options: { roster: ImageRoster; build: Record<string, unknown>; files: readonly string[];
    readResource(resource: string): Promise<Uint8Array>; itemPolicy?: ItemImagePolicy }): Promise<ImageInventory>;
export function collectImages(options: { runId: string; storage: ImageStorage; clock(): string; signal: AbortSignal;
    logger(event: Readonly<Record<string, unknown>>): void; inventory?: ImageInventory; decoder?: ImageDecoder;
    readSource?(source: ImageSource, signal: AbortSignal): Promise<Uint8Array>; verifySource?(): Promise<void>;
    offline?: boolean; fresh?: boolean }): Promise<ImageRun>;
export function applyImages(options: { dataset: string; storage: ImageStorage; runId: string; interruptAt?: string }): Promise<{ state: string }>;
export function recoverImages(options: { dataset: string; storage: ImageStorage; interruptAt?: string }): Promise<{ state: string }>;
export function loadImageDirectory(root: string): Promise<ImageCatalog>;
export function loadImagePackage(): Promise<ImageCatalog>;
export function inspectPng(bytes: Uint8Array): { width: number; height: number; mediaType: 'image/png'; bytes: number; sha256: string };
export function validateImageDirectory(root: string): Promise<{ manifest: ImageManifest; assets: number; images: number; available: number }>;
export function createSource2Decoder(options: { executable: string; workDirectory: string; timeoutMs?: number }): Promise<ImageDecoder>;
export type ValveCdnReader = (kind: 'heroes' | 'abilities' | 'items', key: string, signal: AbortSignal) => Promise<{ resource: string; bytes: Uint8Array } | null>;
export function createValveCdnReader(options: { fetch: typeof globalThis.fetch; timeoutMs?: number; maxBytes?: number }): ValveCdnReader;
export function createNativeImageSource(options: { game: string; roster: ImageRoster; storage: ImageStorage; signal: AbortSignal;
    pickerDirectory?: string; itemPolicy?: ItemImagePolicy; cdnReader?: ValveCdnReader }): Promise<{
        inventory: ImageInventory; verifySource(): Promise<void>; readSource(source: ImageSource): Promise<Uint8Array>;
    }>;

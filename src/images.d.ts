import type { ImageDescriptor, HeroId, StableId, ItemId } from './records.js';
import type { ArtifactDescriptor } from './index.js';
export type { ImageDescriptor, ItemId } from './records.js';
export type ImageEntityKind = 'hero' | 'ability' | 'item';
export interface ImageEntity {
    readonly id: HeroId | StableId | ItemId;
    readonly engineId: string;
    readonly key?: string;
    readonly heroId?: HeroId;
    readonly acquisition?: string;
}
export interface ImageManifest {
    readonly schemaVersion: 1;
    readonly generatedAt: string;
    readonly inputSignature: string;
    readonly rosterSignature: string;
    readonly build: Readonly<Record<string, unknown>>;
    readonly catalog: ArtifactDescriptor;
    readonly [field: string]: unknown;
}
export interface ImageCatalog {
    readonly manifest: ImageManifest;
    entities(kind: ImageEntityKind): readonly ImageEntity[];
    exclusions(): readonly { readonly engineId: string; readonly reason: string }[];
    images(kind?: ImageEntityKind, id?: string): readonly ImageDescriptor[];
    image(kind: ImageEntityKind, id: string, variant?: 'profile' | 'icon'): ImageDescriptor | undefined;
    loadBytes(imageId: string): Promise<Uint8Array | undefined>;
}
export const IMAGE_CATALOG_MAX_BYTES: number;
export const IMAGE_MAX_BYTES: number;
export function loadImageCatalog(options: {
    manifest: ImageManifest;
    readArtifact: (artifact: ArtifactDescriptor & { kind: 'catalog' | 'image' }) => Promise<Uint8Array>;
}): Promise<ImageCatalog>;
/** Base URL is the directory corresponding to the package's data directory. */
export function resolveImageUrl(descriptor: ImageDescriptor, baseUrl: string | URL): string | undefined;

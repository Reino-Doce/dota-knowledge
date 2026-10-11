import type { KnowledgeStore, KnowledgeManifest, ArtifactDescriptor } from './index.js';

export { loadKnowledgeStore, KnowledgeDataError } from './index.js';
export { openVpk, parseKeyValues, resolveGameDirectory } from './node/game-files.js';
export { acquireProviderArtifact } from './node/provider-acquisition.js';
export type { KeyValuesObject, VpkArchive } from './node/game-files.js';
export type { AcquiredProviderArtifact } from './node/provider-acquisition.js';
export function loadKnowledgeDirectory(manifestPath: string, options?: {
    readonly guideCacheSize?: number;
    readonly guideCacheMaxBytes?: number;
}): Promise<KnowledgeStore>;
export function loadKnowledgePackage(options?: {
    readonly guideCacheSize?: number;
    readonly guideCacheMaxBytes?: number;
}): Promise<KnowledgeStore>;
export type { KnowledgeStore, KnowledgeManifest, ArtifactDescriptor };

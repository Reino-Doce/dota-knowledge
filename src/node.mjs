import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnowledgeStore } from './index.mjs';

export { loadKnowledgeStore, KnowledgeDataError } from './index.mjs';
export { openVpk, parseKeyValues, resolveGameDirectory } from './node/game-files.mjs';
export { acquireProviderArtifact } from './node/provider-acquisition.mjs';

/** Load a packaged manifest and artifacts from a directory using Node's filesystem APIs. */
export async function loadKnowledgeDirectory(manifestPath, options = {}) {
    const absoluteManifest = resolve(manifestPath);
    const root = dirname(absoluteManifest);
    const manifest = JSON.parse(await readFile(absoluteManifest, 'utf8'));
    const readArtifact = async descriptor => {
        const artifactPath = resolve(root, ...descriptor.name.split('/'));
        const relativePath = relative(root, artifactPath);
        if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
            throw new Error('Artifact path escapes the knowledge dataset.');
        }
        return new Uint8Array(await readFile(artifactPath));
    };
    return loadKnowledgeStore({ ...options, manifest, readArtifact });
}

export async function loadKnowledgePackage(options = {}) {
    const here = dirname(fileURLToPath(import.meta.url));
    return loadKnowledgeDirectory(resolve(here, '../data/runtime/manifest.json'), options);
}

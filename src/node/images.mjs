import { fileURLToPath } from 'node:url';
import { regularBytes } from './canonical.mjs';
import { loadImageCatalog } from '../images.mjs';
export { loadImageCatalog, resolveImageUrl } from '../images.mjs';
export { inspectPng, validateImageDirectory } from './image-files.mjs';
export { collectImages, createImageStorage } from '../../scripts/images/collect.mjs';
export { applyImages, recoverImages } from '../../scripts/images/apply.mjs';
export { inventoryImages, STANDARD_ITEM_POLICY } from '../../scripts/images/inventory.mjs';
export { createNativeImageSource, createSource2Decoder, createValveCdnReader } from '../../scripts/images/native.mjs';

/** Root is the directory containing images/manifest.json and the canonical image paths. */
export async function loadImageDirectory(root) {
    const manifest = JSON.parse(await regularBytes(root, 'images/manifest.json'));
    return loadImageCatalog({ manifest, readArtifact: artifact => regularBytes(root, artifact.name) });
}
export const loadImagePackage = () => loadImageDirectory(fileURLToPath(new URL('../../data/', import.meta.url)));

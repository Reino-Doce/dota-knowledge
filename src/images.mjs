import { sha256Hex } from './sha256.mjs';
import { imageId, validateImageCatalog, validateImageManifest, IMAGE_CATALOG_MAX_BYTES, IMAGE_MAX_BYTES } from './image-contracts.mjs';
export { resolveImageUrl, IMAGE_CATALOG_MAX_BYTES, IMAGE_MAX_BYTES } from './image-contracts.mjs';

function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}

/** Only the catalog is read here. Pixels are fetched explicitly through loadBytes. */
export async function loadImageCatalog({ manifest, readArtifact }) {
    validateImageManifest(manifest);
    manifest = freeze(structuredClone(manifest));
    if (typeof readArtifact !== 'function') throw new TypeError('An image artifact reader is required.');
    const read = async (artifact, kind, limit) => {
        const bytes = await readArtifact({ ...artifact, kind });
        if (!(bytes instanceof Uint8Array) || bytes.length > limit || bytes.length !== artifact.bytes
            || sha256Hex(bytes) !== artifact.sha256) throw new Error('Image artifact integrity mismatch: ' + artifact.name);
        return bytes;
    };
    const catalog = freeze(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(manifest.catalog, 'catalog', IMAGE_CATALOG_MAX_BYTES))));
    const { entities, descriptors } = validateImageCatalog(catalog);
    for (const row of descriptors.values()) freeze(row);
    const pending = new Map();
    return Object.freeze({
        manifest,
        entities: kind => Object.freeze([...(entities[kind]?.values() ?? [])]),
        exclusions: () => catalog.exclusions,
        images: (kind, id) => Object.freeze([...descriptors.values()].filter(row => (kind === undefined || row.entityKind === kind) && (id === undefined || row.entityId === id))),
        image: (kind, id, variant = 'icon') => descriptors.get(imageId(kind, id, variant)),
        async loadBytes(id) {
            const row = descriptors.get(id);
            if (!row || row.state === 'unavailable') return undefined;
            if (!pending.has(row.sha256)) {
                const request = read({ name: row.path, bytes: row.bytes, sha256: row.sha256 }, 'image', IMAGE_MAX_BYTES);
                pending.set(row.sha256, request);
                request.finally(() => pending.delete(row.sha256)).catch(() => {});
            }
            // No retained pixel cache; callers own their returned mutable bytes.
            return new Uint8Array(await pending.get(row.sha256));
        },
    });
}

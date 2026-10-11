import { safeKey, safePath, isObject, validateImageDescriptor } from './record-contracts.mjs';

export const IMAGE_SCHEMA_VERSION = 1;
export const IMAGE_CATALOG_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 16 * 1024 * 1024;
export const IMAGE_MAX_DIMENSION = 4096;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const decimal = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
export const imageId = (kind, id, variant) => `image:${kind}:${id}:${variant}`;
export const isImageFile = name => /^images\/(manifest|catalog)\.json$/.test(name)
    || /^(heroes\/[a-z0-9_-]+\/images\/(?:abilities\/)?[a-z0-9_-]+|abilities\/[a-z0-9_-]+\/images\/[a-z0-9_-]+|items\/[a-z0-9_-]+\/images\/[a-z0-9_-]+|images\/shared\/[a-f0-9]{64})\.png$/.test(name);

export function validateImageManifest(manifest) {
    const row = manifest?.catalog;
    if (manifest?.schemaVersion !== IMAGE_SCHEMA_VERSION || !digest(manifest.inputSignature)
        || !digest(manifest.rosterSignature) || !isObject(manifest.build)
        || typeof manifest.generatedAt !== 'string' || !Number.isFinite(Date.parse(manifest.generatedAt))
        || row?.name !== 'images/catalog.json' || !digest(row.sha256)
        || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > IMAGE_CATALOG_MAX_BYTES) {
        throw new Error('Invalid image manifest.');
    }
}

export function validateImageCatalog(catalog) {
    if (catalog?.schemaVersion !== IMAGE_SCHEMA_VERSION || !isObject(catalog.entities)
        || !Array.isArray(catalog.assets) || !Array.isArray(catalog.images)
        || !Array.isArray(catalog.exclusions)) throw new Error('Invalid image catalog.');
    const entities = {};
    for (const [kind, plural] of [['hero', 'heroes'], ['ability', 'abilities'], ['item', 'items']]) {
        if (!Array.isArray(catalog.entities[plural])) throw new Error('Missing image entity inventory.');
        const ids = new Map();
        const keys = new Set();
        for (const row of catalog.entities[plural]) {
            if (!isObject(row) || typeof row.id !== 'string' || !row.id
                || (kind === 'ability' ? !/^[A-Za-z0-9_]+$/.test(row.engineId) : !safeKey(row.engineId))
                || kind !== 'ability' && (!decimal(row.id) || !safeKey(row.key) || keys.has(row.key))
                || kind === 'hero' && row.engineId !== 'npc_dota_hero_' + row.key
                || kind === 'item' && row.engineId !== 'item_' + row.key
                || kind === 'ability' && !entities.hero.has(row.heroId)
                || ids.has(row.id)) throw new Error('Invalid or duplicate image entity identity.');
            ids.set(row.id, row); keys.add(row.key);
        }
        entities[kind] = ids;
    }
    const assets = new Map();
    const paths = new Set();
    const hashes = new Set();
    for (const asset of catalog.assets) {
        if (!isObject(asset) || Object.keys(asset).some(key => !['id', 'path', 'width', 'height', 'bytes', 'mediaType', 'sha256'].includes(key))) {
            throw new Error('Unexpected physical image asset metadata.');
        }
        validateImageDescriptor({ ...asset, id: asset.id, entityKind: 'item', entityId: '1', variant: 'icon', state: 'available' });
        if (asset.id !== 'asset:' + asset.sha256 || !isImageFile(asset.path) || !asset.path.endsWith('.png')
            || asset.mediaType !== 'image/png' || asset.bytes > IMAGE_MAX_BYTES
            || asset.width > IMAGE_MAX_DIMENSION || asset.height > IMAGE_MAX_DIMENSION
            || paths.has(asset.path) || hashes.has(asset.sha256)) throw new Error('Invalid or duplicate physical image asset.');
        assets.set(asset.id, asset); paths.add(asset.path); hashes.add(asset.sha256);
    }
    const descriptors = new Map();
    const used = new Set();
    for (const row of catalog.images) {
        if (!isObject(row) || !entities[row.entityKind]?.has(row.entityId)
            || !(['hero'].includes(row.entityKind) ? ['profile', 'icon'] : ['icon']).includes(row.variant)
            || row.id !== imageId(row.entityKind, row.entityId, row.variant) || descriptors.has(row.id)) {
            throw new Error('Invalid, duplicate or unknown image binding.');
        }
        const identity = { id: row.id, entityKind: row.entityKind, entityId: row.entityId, variant: row.variant };
        let descriptor;
        if (row.state === 'unavailable') {
            if (Object.hasOwn(row, 'assetId')) throw new Error('Unavailable image references an asset.');
            descriptor = { ...identity, state: 'unavailable', reason: row.reason };
        }
        else {
            const asset = assets.get(row.assetId);
            if (row.state !== 'available' || !asset || Object.hasOwn(row, 'reason')) throw new Error('Broken image asset reference.');
            const { path, width, height, bytes, mediaType, sha256 } = asset;
            descriptor = { ...identity, path, width, height, bytes, mediaType, sha256, state: 'available' };
            used.add(asset.id);
        }
        validateImageDescriptor(descriptor); descriptors.set(row.id, descriptor);
    }
    for (const [kind, rows] of Object.entries(entities)) for (const id of rows.keys()) {
        for (const variant of kind === 'hero' ? ['profile', 'icon'] : ['icon']) {
            if (!descriptors.has(imageId(kind, id, variant))) throw new Error('Incomplete image coverage inventory.');
        }
    }
    if (used.size !== assets.size) throw new Error('Unreferenced image assets.');
    const excluded = new Set();
    for (const row of catalog.exclusions) {
        if (!safeKey(row.engineId) || !row.engineId.startsWith('item_') || typeof row.reason !== 'string' || !row.reason
            || excluded.has(row.engineId) || [...entities.item.values()].some(item => item.engineId === row.engineId)) {
            throw new Error('Invalid item exclusion inventory.');
        }
        excluded.add(row.engineId);
    }
    return { entities, assets, descriptors };
}

export function resolveImageUrl(descriptor, baseUrl) {
    validateImageDescriptor(descriptor);
    if (descriptor.state === 'unavailable') return undefined;
    if (!safePath(descriptor.path)) throw new Error('Unsafe image path.');
    const base = new URL(baseUrl);
    if (!['https:', 'http:', 'file:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        throw new Error('Image base URL must be an uncredentialed directory URL.');
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    return new URL(descriptor.path, base).href;
}

import { PNG } from 'pngjs';
import { hash } from '../canonical-model.mjs';
import { regularBytes } from './canonical.mjs';
import { validateImageCatalog, validateImageManifest, IMAGE_MAX_BYTES, IMAGE_MAX_DIMENSION } from '../image-contracts.mjs';

export function inspectPng(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 33 || bytes.length > IMAGE_MAX_BYTES) throw new Error('Invalid PNG size.');
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Expected actual PNG bytes.');
    const width = buffer.readUInt32BE(16); const height = buffer.readUInt32BE(20);
    if (!width || !height || width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION) throw new Error('PNG dimensions exceed limits.');
    const decoded = PNG.sync.read(buffer, { checkCRC: true });
    if (decoded.width !== width || decoded.height !== height) throw new Error('Decoded PNG dimensions differ.');
    return { width, height, mediaType: 'image/png', bytes: bytes.length, sha256: hash(bytes) };
}

export async function validateImageDirectory(root, { read = name => regularBytes(root, name) } = {}) {
    const manifest = JSON.parse(await read('images/manifest.json'));
    validateImageManifest(manifest);
    const catalogBytes = await read(manifest.catalog.name);
    if (catalogBytes.length !== manifest.catalog.bytes || hash(catalogBytes) !== manifest.catalog.sha256) throw new Error('Image catalog integrity mismatch.');
    const catalog = JSON.parse(catalogBytes);
    const { assets, descriptors } = validateImageCatalog(catalog);
    for (const asset of assets.values()) {
        const actual = inspectPng(await read(asset.path));
        if (Object.entries(actual).some(([key, value]) => asset[key] !== value)) throw new Error('Image metadata mismatch: ' + asset.path);
    }
    return { manifest, catalog, assets: assets.size, images: descriptors.size,
        available: [...descriptors.values()].filter(row => row.state === 'available').length };
}

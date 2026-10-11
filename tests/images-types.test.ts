import { loadImageCatalog, resolveImageUrl, type ImageManifest, type ImageDescriptor } from '@reino-doce/dota-knowledge/images';
import { createImageStorage, collectImages, loadImagePackage, type ImageInventory, type ImageDecoder } from '@reino-doce/dota-knowledge/node/images';

async function browser(manifest: ImageManifest) {
    const catalog = await loadImageCatalog({ manifest, readArtifact: async descriptor => new Uint8Array(await (await fetch(new URL(descriptor.name, 'https://example.test/data/'))).arrayBuffer()) });
    const image: ImageDescriptor | undefined = catalog.image('hero', '1', 'profile');
    if (image?.state === 'available') {
        const url: string | undefined = resolveImageUrl(image, 'https://example.test/data/');
        const bytes: Uint8Array | undefined = await catalog.loadBytes(image.id); void [url, bytes];
    }
    // @ts-expect-error Unselected cosmetic variants are not part of this API.
    catalog.image('hero', '1', 'cosmetic');
}
async function collector(inventory: ImageInventory, decoder: ImageDecoder) {
    const storage = await createImageStorage('/caller-owned/evidence');
    const run = await collectImages({ inventory, decoder, storage, runId: 'fixture', readSource: async () => new Uint8Array(),
        clock: () => new Date().toISOString(), signal: new AbortController().signal, logger: () => {} });
    const catalog = await loadImagePackage(); void [run, catalog];
}
void [browser, collector];

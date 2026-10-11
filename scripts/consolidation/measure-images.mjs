import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadImageCatalog } from '../../src/images.mjs';

if (!globalThis.gc) throw new Error('Use --expose-gc for image measurements.');
const root = path.resolve(process.argv[2]);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'images/manifest.json')));
const summary = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { samples: values, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
};
globalThis.gc();
const emptyHeap = process.memoryUsage().heapUsed;
let catalog; let pixelReads = 0;
const loads = [];
for (let index = 0; index < 7; index++) {
    catalog = null; globalThis.gc();
    const start = performance.now();
    catalog = await loadImageCatalog({ manifest, readArtifact: row => {
        if (row.kind === 'image') pixelReads++;
        return fs.readFile(path.join(root, row.name));
    } });
    loads.push(performance.now() - start);
}
if (pixelReads !== 0) throw new Error('Catalog loading read image bytes.');
globalThis.gc();
const catalogHeap = process.memoryUsage().heapUsed;
const images = catalog.images().filter(row => row.state === 'available');
const selected = images.filter((row, index) => images.findIndex(other => other.sha256 === row.sha256) === index).slice(0, 100);
const queryTimes = [];
for (let index = 0; index < 1100; index++) {
    const row = images[index % images.length]; const start = performance.now();
    catalog.image(row.entityKind, row.entityId, row.variant);
    if (index >= 100) queryTimes.push(performance.now() - start);
}
const byteTimes = [];
for (const row of selected) {
    const start = performance.now(); await catalog.loadBytes(row.id); byteTimes.push(performance.now() - start);
}
globalThis.gc();
const afterBytesHeap = process.memoryUsage().heapUsed;
console.log(JSON.stringify({ methodology: 'Dedicated process; seven metadata-only loads; 100 warmed lookups; 1000 measured lookups; 100 distinct lazy byte reads; explicit GC. No pixel decoding or retained pixel cache.',
    catalogBytes: manifest.catalog.bytes, availableBindings: images.length, imageBytes: [...new Map(images.map(row => [row.sha256, row.bytes])).values()].reduce((sum, value) => sum + value, 0),
    loadMs: { first: loads[0], repeated: summary(loads.slice(1)) }, queryMs: summary(queryTimes), lazyBytesMs: summary(byteTimes),
    pixelReadsOnCatalogLoad: 0, pixelReads, memory: { retainedCatalogBytes: catalogHeap - emptyHeap,
        retainedAfterBytes: afterBytesHeap - emptyHeap, peakRssBytes: process.resourceUsage().maxRSS * 1024 } }));

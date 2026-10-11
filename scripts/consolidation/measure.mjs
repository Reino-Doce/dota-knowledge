import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { loadKnowledgeDirectory } from '../../src/node.mjs';

function summary(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return { samples, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

export async function measure(manifestPath, { runs = 5, queries = 200 } = {}) {
    if (!globalThis.gc) throw new Error('Run the baseline measurement with --expose-gc.');
    const manifestBytes = await fs.readFile(manifestPath);
    globalThis.gc();
    const emptyHeap = process.memoryUsage().heapUsed;
    const loads = [];
    let store;
    for (let i = 0; i < runs; i += 1) {
        if (store) store.retire();
        store = null;
        globalThis.gc();
        const start = performance.now();
        store = await loadKnowledgeDirectory(manifestPath, { guideCacheSize: 8 });
        loads.push(performance.now() - start);
    }
    globalThis.gc();
    const coreHeap = process.memoryUsage().heapUsed;
    const heroes = store.heroes().slice(0, 17).map(hero => hero.id);
    const queryTimes = [];
    for (let i = 0; i < queries + 20; i += 1) {
        const heroId = heroes[i % heroes.length];
        const start = performance.now();
        store.hero(heroId);
        store.effectsForHero(heroId);
        store.observations({ heroId, kind: 'matchup' });
        if (i >= 20) queryTimes.push(performance.now() - start);
    }
    const guideTimes = [];
    const observationTimes = [];
    for (const heroId of heroes) {
        let start = performance.now();
        await store.loadHeroEvidence(heroId);
        guideTimes.push(performance.now() - start);
        start = performance.now();
        await store.loadObservations({ heroId, kind: 'matchup' });
        observationTimes.push(performance.now() - start);
    }
    globalThis.gc();
    const lazyHeap = process.memoryUsage().heapUsed;
    const start = performance.now();
    await store.loadHeroEvidence(heroes.at(-1));
    const cachedGuideMs = performance.now() - start;
    const result = {
        schemaVersion: 1, node: process.version, architecture: process.arch,
        methodology: 'Dedicated process; first load is process-cold, OS file cache uncontrolled. Subsequent loads are new stores. Query batch: hero, ordered effects, matchup filter; 20 warmups. Explicit GC before heap readings.',
        manifestBytes: manifestBytes.length, loadMs: { first: loads[0], repeated: summary(loads.slice(1)) },
        queryBatchMs: summary(queryTimes), lazyGuideMs: summary(guideTimes), lazyObservationsMs: summary(observationTimes),
        cachedGuideMs, guideCacheSize: 8, distinctLazyHeroes: heroes.length,
        memory: { emptyHeap, coreHeap, lazyHeap, retainedCoreBytes: coreHeap - emptyHeap,
            retainedLazyBytes: lazyHeap - emptyHeap, peakRssBytes: process.resourceUsage().maxRSS * 1024 },
        interpretation: 'Baseline samples, not a regression verdict; compare repeated runs on the same host and workload.',
    };
    store.retire();
    return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.stdout.write(JSON.stringify(await measure(path.resolve(process.argv[2]))) + '\n');
}

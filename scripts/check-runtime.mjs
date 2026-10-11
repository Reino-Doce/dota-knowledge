import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadKnowledgeDirectory } from '../src/node.mjs';

export async function checkRuntime(root = fileURLToPath(new URL('../data/runtime', import.meta.url))) {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json')));
    const names = new Set([manifest.core.name, ...Object.values(manifest.guides).map(row => row.name), ...manifest.observationShards.map(row => row.name)]);
    const store = await loadKnowledgeDirectory(path.join(root, 'manifest.json'));
    const identities = new Set();
    for (const claim of store.claims()) if (!names.has(claim.detailsRef?.split('#')[0])) throw new Error('Packaged claim reference is missing: ' + claim.id);
    for (const hero of store.heroes()) {
        const guide = await store.loadHeroEvidence(hero.id);
        const observations = await store.loadObservations({ heroId: hero.id });
        const ownIds = new Set(observations.map(row => row.id));
        for (const id of guide.statObservationIds ?? []) if (!ownIds.has(id)) throw new Error('Missing guide observation: ' + id);
        for (const row of observations) identities.add(row.id);
        if (manifest.guides[hero.id].name !== `heroes/${hero.key}/guide.json`) throw new Error('Packaged guide is not hero-keyed.');
    }
    const result = { heroes: store.heroes().length, observations: identities.size, claims: store.claims().length, schemaVersion: manifest.schemaVersion };
    store.retire();
    return result;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.stdout.write(JSON.stringify(await checkRuntime(process.argv[2] ? path.resolve(process.argv[2]) : undefined)) + '\n');
}

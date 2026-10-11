import { normalizeLegacyRecords } from '../../src/canonical-model.mjs';
import { readJson, regularBytes, jsonBytes } from '../../src/node/canonical.mjs';

/** Version 1 reading is restricted to preservation/comparison tooling. */
export async function readLegacyLayout(root, { read = name => readJson(root, name), crosswalk, aliases, retainMaps = true } = {}) {
    const metadata = await read('manifest.json');
    if (metadata.schemaVersion !== 1) throw new Error('Historical reading requires a version 1 manifest.');
    const heroes = [];
    const guides = new Map();
    const observations = await read('observations/index.json');
    const runtimeObservations = observations.slice();
    const claims = [];
    for (const descriptor of metadata.sourceFiles.filter(row => /^heroes\/[0-9]+\.json$/.test(row.name))) {
        const row = await read(descriptor.name);
        heroes.push(row); claims.push(...row.claims);
        guides.set(row.hero.id, await read(`runtime/guides/${row.hero.id}.json`));
        observations.push(...(await read(`observations/heroes/${row.hero.id}.json`)).observations);
    }
    heroes.sort((a, b) => Number(a.hero.id) - Number(b.hero.id));
    const graph = normalizeLegacyRecords({ metadata: { ...metadata, runtimeObservations }, heroes, guides, observations, claims,
        sources: await read('sources.json'), reference: await read('mechanics/reference.json') }, { crosswalk, aliases });
    if (retainMaps) {
        for (const descriptor of metadata.sourceFiles.filter(row => row.name.startsWith('reconciliation/'))) {
            const name = 'reviews/' + descriptor.name;
            const bytes = await regularBytes(root, descriptor.name);
            if (descriptor.name === 'reconciliation/index.json') {
                const index = JSON.parse(bytes);
                for (const row of index.sourceBundles) row.fieldFile = 'reviews/' + row.fieldFile;
                graph.extras.set(name, jsonBytes(index));
            }
            else graph.extras.set(name, bytes);
        }
    }
    return graph;
}

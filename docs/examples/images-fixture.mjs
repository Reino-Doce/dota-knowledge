// Creates an isolated synthetic canonical dataset; no installation, browser, or network needed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { createImageStorage, collectImages, applyImages, loadImageDirectory } from '@reino-doce/dota-knowledge/node/images';
import { normalizeLegacyRecords, hash } from '../../src/canonical-model.mjs';
import { writeCanonical, regularBytes } from '../../src/node/canonical.mjs';
import { rosterSignature } from '../../scripts/images/inventory.mjs';

export async function imageFixtureExample() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-example-'));
    try {
        const sourceIdentities = { mechanics: 'a'.repeat(64), enrichedNative: 'b'.repeat(64) };
        const graph = normalizeLegacyRecords({ metadata: { schemaVersion: 1, version: 'fixture', createdAt: '2026-10-01T00:00:00Z',
            generatedAt: '2026-10-01T00:00:00Z', sourceIdentities, reviewVersion: 'fixture', build: { clientVersion: 'fixture' },
            patchLabel: { state: 'unknown', reason: 'Synthetic fixture.' }, runtimeObservations: [] },
        heroes: [{ hero: { id: '1', heroId: '1', heroKey: 'npc_dota_hero_fixture', key: 'fixture', name: 'Fixture',
            enabled: true, cmEnabled: true, abilityIds: [], effectIds: [], coverage: { complete: false } }, abilities: [], activations: [], effects: [], conditions: [] }],
        guides: new Map([['1', { heroId: '1', sourceIdentities, native: { heroId: '1', key: 'fixture',
            raw: { AttributePrimary: 'DOTA_ATTRIBUTE_AGILITY', AttackRange: '150', Complexity: '1', Role: 'Carry', Rolelevels: '1' }, nativeStats: {} } }]]),
        sources: [], claims: [], observations: [], reference: {} }, { crosswalk: [] });
        const dataset = path.join(root, 'data'); await writeCanonical(dataset, graph);
        const before = await regularBytes(dataset, 'manifest.json');
        const image = new PNG({ width: 2, height: 2 }); image.data.fill(255); const bytes = PNG.sync.write(image);
        const storage = await createImageStorage(path.join(root, 'evidence'));
        const inventory = { recipe: 'fixture-1', build: graph.metadata.build, rosterSignature: rosterSignature(graph.entities),
            entities: { heroes: [{ id: '1', key: 'fixture', engineId: 'npc_dota_hero_fixture' }], abilities: [], items: [] }, exclusions: [], inputs: [],
            itemPolicy: { version: 'fixture', clientVersion: 'fixture', pickups: [] },
            requests: ['profile', 'icon'].map(variant => ({ id: 'image:hero:1:' + variant, entityKind: 'hero', entityId: '1', variant,
                destination: 'heroes/fixture/images/' + variant + '.png', reason: 'Synthetic fixture.', source: { resource: 'fixture.vtex_c', sha256: hash(bytes) } })) };
        const options = { runId: 'fixture', storage, inventory, clock: () => '2026-10-11T00:00:00.000Z', signal: new AbortController().signal,
            logger: () => {}, readSource: async () => bytes,
            decoder: { identity: { name: 'fixture', version: '1', sha256: 'a'.repeat(64) }, decode: async rows => new Map(rows.map(row => [row.resource, row.bytes])) } };
        assert.equal((await collectImages(options)).state, 'complete');
        assert.deepEqual(await regularBytes(dataset, 'manifest.json'), before);
        await collectImages({ ...options, offline: true, readSource: async () => { throw new Error('Unexpected acquisition'); } });
        assert.equal((await applyImages({ dataset, storage, runId: 'fixture' })).state, 'verified-promoted');
        const catalog = await loadImageDirectory(dataset);
        assert.deepEqual(await catalog.loadBytes(catalog.image('hero', '1').id), new Uint8Array(bytes));
        assert.equal((await applyImages({ dataset, storage, runId: 'fixture' })).state, 'unchanged');
        return { state: 'passed', images: catalog.images().length, assets: 1 };
    }
    finally {
        const actual = await fs.realpath(root);
        if (path.dirname(actual) !== await fs.realpath(os.tmpdir()) || !path.basename(actual).startsWith('image-example-')) throw new Error('Unsafe fixture cleanup.');
        await fs.rm(actual, { recursive: true });
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await imageFixtureExample()));

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PNG } from 'pngjs';
import { graphFixture } from './fixtures/canonical-graph.mjs';
import { hash } from '../src/canonical-model.mjs';
import { readCanonical, writeCanonical, regularBytes, jsonBytes } from '../src/node/canonical.mjs';
import { publishDataset } from '../src/node/publish-dataset.mjs';
import { validateDataset } from '../scripts/consolidation/validation.mjs';
import { compileCanonical } from '../scripts/compile-canonical.mjs';
import { validateImageCatalog, imageId } from '../src/image-contracts.mjs';
import { loadImageCatalog, resolveImageUrl } from '../src/images.mjs';
import { collectImages, createImageStorage, applyImages, recoverImages, inspectPng, loadImageDirectory, createValveCdnReader } from '../src/node/images.mjs';
import { selectItems, inventoryImages, rosterIdentity, rosterSignature } from '../scripts/images/inventory.mjs';
import { collectPopulation, applyPopulation, createFileStorage, recipeSettings, DEFAULT_LIMITS } from '../src/node/population.mjs';

function png(seed = 1, width = 4, height = 2) {
    const image = new PNG({ width, height }); image.data.fill(seed); return PNG.sync.write(image);
}
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'images-test-'));
    t.after(async () => {
        const actual = await fs.realpath(root);
        if (path.dirname(actual) !== await fs.realpath(os.tmpdir()) || !path.basename(actual).startsWith('images-test-')) throw new Error('Unsafe test cleanup.');
        await fs.rm(actual, { recursive: true });
    });
    const graph = graphFixture(); graph.heroIndex.find(row => row.id === '7').providerSlug = 'earthshaker';
    const dataset = path.join(root, 'data'); await writeCanonical(dataset, graph);
    const storage = await createImageStorage(path.join(root, 'evidence'));
    const entities = rosterIdentity(graph.entities);
    entities.heroes = entities.heroes.map(({ enabled: _enabled, ...row }) => row);
    entities.items = [{ id: '9007199254740993', key: 'blink', engineId: 'item_blink', acquisition: 'shop' }];
    const requests = []; const sources = new Map();
    for (const [index, hero] of graph.entities.heroes.entries()) for (const variant of ['profile', 'icon']) {
        const resource = `fixtures/${hero.key}-${variant}.png`;
        const bytes = png(index + (variant === 'icon' ? 10 : 20));
        sources.set(resource, bytes);
        requests.push({ id: imageId('hero', hero.id, variant), entityKind: 'hero', entityId: hero.id, variant,
            destination: `heroes/${hero.key}/images/${variant}.png`, reason: 'Synthetic disabled hero.',
            ...(hero.enabled ? { source: { resource, sha256: hash(bytes) } } : {}) });
    }
    const bytes = png(77); sources.set('fixtures/blink.vtex_c', bytes);
    for (const [kind, id, destination] of [['ability', 'ability:blink', 'heroes/antimage/images/abilities/blink.png'], ['item', '9007199254740993', 'items/blink/images/icon.png']]) requests.push({
        id: imageId(kind, id, 'icon'), entityKind: kind, entityId: id, variant: 'icon', destination, reason: 'Missing fixture.',
        source: { resource: 'fixtures/blink.vtex_c', sha256: hash(bytes) },
    });
    const inventory = { recipe: 'fixture-1', build: graph.metadata.build, rosterSignature: rosterSignature(graph.entities),
        entities, requests, exclusions: [], inputs: [], itemPolicy: { version: 'fixture', clientVersion: '1', pickups: [] } };
    const options = { inventory, storage, clock: () => '2026-10-11T21:00:00.000Z', signal: new AbortController().signal, logger: () => {},
        readSource: async source => sources.get(source.resource), decoder: { identity: { name: 'fixture', version: '1', sha256: '0'.repeat(64) },
            decode: async resources => new Map(resources.map(row => [row.resource, row.bytes])) } };
    return { root, graph, dataset, storage, options };
}

test('PNG validation decodes the full image, checks CRC and bounds, and preserves dimensions', () => {
    const bytes = png(4, 128, 72); assert.equal(inspectPng(bytes).width, 128);
    assert.throws(() => inspectPng(bytes.subarray(0, 33)));
    const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 2] ^= 1; assert.throws(() => inspectPng(corrupt));
    const huge = Buffer.from(bytes); huge.writeUInt32BE(0xffffffff, 16); assert.throws(() => inspectPng(huge), /dimensions/);
    assert.throws(() => inspectPng(Buffer.from('<html>blocked</html>')));
});

test('item selection retains exact IDs, active pools, pickups and obtainable recipes; excludes inactive definitions', () => {
    const definitions = { item_blink: {}, item_recipe_blink: { ItemRecipe: '1', ItemCost: '1', ItemResult: 'item_blink' },
        item_zero: { ItemRecipe: '1', ItemCost: '0', ItemResult: 'item_blink' }, item_old: { IsObsolete: '1' },
        item_inactive: { ItemIsNeutralActiveDrop: '1', ItemPurchasable: '0' }, item_active: { ItemIsNeutralPassiveDrop: '1', ItemPurchasable: '0' },
        item_pickup: { ItemPurchasable: '0' }, item_internal: { ItemPurchasable: '0' }, item_event: { EventID: '14' } };
    const ids = Object.fromEntries(Object.keys(definitions).map((key, i) => [key, String(9007199254740993n + BigInt(i))]));
    const options = { definitions, ids, neutrals: { items: { item_active: '1', item_inactive: '0' } },
        policy: { version: '1', clientVersion: '1', pickups: ['item_pickup'] }, build: { clientVersion: '1' } };
    const selected = selectItems(options);
    assert.deepEqual(selected.items.map(row => row.key), ['blink', 'recipe_blink', 'active', 'pickup']);
    assert.equal(selected.items[0].id, '9007199254740993'); assert.equal(selected.exclusions.length, 5);
    assert.throws(() => selectItems({ ...options, build: { clientVersion: '2' } }), /policy/);
    assert.throws(() => selectItems({ ...options, ids: {} }), /ID/);
});

test('native inventory honors engine texture declarations and canonical keys rather than provider names', async () => {
    const records = { 'scripts/npc/items.txt': '"DOTAAbilities" {}', 'scripts/npc/npc_ability_ids.txt': '"DOTAAbilityIDs" { "ItemAbilities" { "Locked" {} } }',
        'scripts/npc/neutral_items.txt': '"neutral_items" {}', 'scripts/npc/npc_abilities.txt': '"DOTAAbilities" { "blink" { "AbilityTextureName" "real_blink" } }',
        'scripts/npc/heroes/npc_dota_hero_antimage.txt': '"DOTAHeroes" { "npc_dota_hero_antimage" {} }' };
    const result = await inventoryImages({ roster: { heroes: [{ id: '1', key: 'antimage', sourceKey: 'npc_dota_hero_antimage', enabled: true, providerSlug: 'anti-mage' }],
        abilities: [{ id: 'ability:1:blink', heroId: '1', engineId: 'blink' }] }, build: { clientVersion: '1' },
        files: [...Object.keys(records), 'panorama/images/spellicons/real_blink_png.vtex_c'],
        readResource: async name => Buffer.from(records[name]), itemPolicy: { version: 'fixture', clientVersion: '1', pickups: [] } });
    assert.equal(result.requests[0].destination, 'heroes/antimage/images/profile.png');
    assert.equal(result.requests[2].resource, 'panorama/images/spellicons/real_blink_png.vtex_c');
    assert.equal(result.requests[2].mapping, 'native-texture-declaration');
});

test('generated item selection follows selected native subitems without adding obsolete, event or free recipe definitions', () => {
    const definitions = { item_foragers_kit: { SubAbilityNames: 'item_health;item_stats;item_mana;item_recipe;item_old;item_event' },
        item_health: { ItemPurchasable: '0', SubAbilityNames: 'item_foragers_kit' }, item_stats: { ItemPurchasable: '0' },
        item_mana: { ItemPurchasable: '0' }, item_recipe: { ItemRecipe: '1', ItemCost: '0', ItemResult: 'item_health' },
        item_old: { IsObsolete: '1' }, item_event: { EventID: '14' },
        item_inactive: { ItemPurchasable: '0', SubAbilityNames: 'item_unreachable' }, item_unreachable: { ItemPurchasable: '0' } };
    const options = { definitions, ids: Object.fromEntries(Object.keys(definitions).map((key, index) => [key, String(index + 1)])),
        neutrals: {}, policy: { version: '1', clientVersion: '1', pickups: [] }, build: { clientVersion: '1' } };
    const selected = selectItems(options);
    assert.deepEqual(selected.items.map(row => row.key), ['foragers_kit', 'health', 'stats', 'mana']);
    assert.equal(selected.items[1].acquisition, 'native-generated-subitem');
    definitions.item_health.SubAbilityNames = 'item_missing';
    assert.throws(() => selectItems(options), /Unknown generated native item/);
});

test('refresh is isolated; offline apply deduplicates artwork and preserves knowledge bytes and clocks', async t => {
    const f = await fixture(t); const before = await regularBytes(f.dataset, 'manifest.json');
    const run = await collectImages({ ...f.options, runId: 'first' }); assert.equal(run.state, 'complete');
    assert.deepEqual(await regularBytes(f.dataset, 'manifest.json'), before);
    await collectImages({ ...f.options, runId: 'first', offline: true, readSource: async () => { throw new Error('Unexpected acquisition'); } });
    assert.equal((await applyImages({ dataset: f.dataset, storage: f.storage, runId: 'first' })).state, 'verified-promoted');
    const catalog = await loadImageDirectory(f.dataset);
    assert.equal(catalog.image('hero', '127').state, 'unavailable');
    assert.equal(catalog.image('ability', 'ability:blink').path, catalog.image('item', '9007199254740993').path);
    for (const old of JSON.parse(before).sourceFiles) assert.equal(hash(await regularBytes(f.dataset, old.name)), old.sha256);
    const published = await regularBytes(f.dataset, 'manifest.json');
    assert.equal((await applyImages({ dataset: f.dataset, storage: f.storage, runId: 'first' })).state, 'unchanged');
    await compileCanonical({ dataset: f.dataset }); assert.deepEqual(await regularBytes(f.dataset, 'manifest.json'), published);
    await collectImages({ ...f.options, runId: 'same-inputs', clock: () => '2026-11-01T00:00:00.000Z' });
    assert.equal((await applyImages({ dataset: f.dataset, storage: f.storage, runId: 'same-inputs' })).state, 'unchanged');
    assert.deepEqual(await regularBytes(f.dataset, 'manifest.json'), published);
});

test('lazy byte loading verifies integrity, coalesces concurrent loads and retries failures without a retained cache', async t => {
    const f = await fixture(t); await collectImages({ ...f.options, runId: 'lazy' }); await applyImages({ dataset: f.dataset, storage: f.storage, runId: 'lazy' });
    const manifest = JSON.parse(await regularBytes(f.dataset, 'images/manifest.json')); let calls = 0; let fail = true;
    const catalog = await loadImageCatalog({ manifest, readArtifact: async row => {
        if (row.kind === 'image') { calls++; await new Promise(resolve => setTimeout(resolve, 1)); if (fail) return new Uint8Array(4); }
        return regularBytes(f.dataset, row.name);
    } });
    assert.equal(calls, 0); const image = catalog.image('hero', '1', 'profile');
    assert.match(resolveImageUrl(image, 'https://example.test/data'), /data\/heroes\/antimage\/images\/profile.png$/);
    assert.equal(resolveImageUrl(catalog.image('hero', '127'), 'https://example.test/'), undefined);
    assert.throws(() => resolveImageUrl(image, 'https://secret:token@example.test/'), /uncredentialed/);
    await assert.rejects(catalog.loadBytes(image.id), /integrity/); fail = false;
    const [one, two] = await Promise.all([catalog.loadBytes(image.id), catalog.loadBytes(image.id)]);
    assert.equal(calls, 2); one[0] = 0; assert.notEqual(one[0], two[0]);
    await catalog.loadBytes(image.id); assert.equal(calls, 3);
    assert.equal(await catalog.loadBytes(catalog.image('hero', '127').id), undefined);
});

test('partial, cancelled and incompatible runs cannot replace published images; resume uses saved bytes', async t => {
    const f = await fixture(t); await collectImages({ ...f.options, runId: 'old' }); await applyImages({ dataset: f.dataset, storage: f.storage, runId: 'old' });
    const before = await regularBytes(f.dataset, 'manifest.json');
    const partial = await collectImages({ ...f.options, runId: 'partial', decoder: { ...f.options.decoder, decode: async () => { throw new Error('decoder timeout'); } } });
    assert.equal(partial.state, 'partial');
    await assert.rejects(applyImages({ dataset: f.dataset, storage: f.storage, runId: 'partial' }), /Incomplete/);
    const resumed = await collectImages({ ...f.options, runId: 'partial', readSource: async () => { throw new Error('Resume unexpectedly reacquired'); } });
    assert.equal(resumed.state, 'complete');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(collectImages({ ...f.options, runId: 'cancel', signal: controller.signal }));
    assert.equal((await f.storage.read('runs/cancel/manifest.json')).state, 'cancelled');
    await assert.rejects(collectImages({ ...f.options, runId: 'old', inventory: { ...f.options.inventory, recipe: 'changed' } }), /incompatible/);
    assert.deepEqual(await regularBytes(f.dataset, 'manifest.json'), before);
});

test('catalog validation rejects missing coverage, unsafe assets, unknown identities and duplicate physical assets', async t => {
    const f = await fixture(t); const run = await collectImages({ ...f.options, runId: 'validation' });
    const value = JSON.parse(await f.storage.bytes(run.normalized)).catalog;
    const invalid = change => { const catalog = structuredClone(value); change(catalog); assert.throws(() => validateImageCatalog(catalog)); };
    invalid(catalog => catalog.images.pop()); invalid(catalog => { catalog.images[0].entityId = '999'; });
    invalid(catalog => { catalog.assets[0].path = '../escape.png'; }); invalid(catalog => catalog.assets.push(catalog.assets[0]));
    invalid(catalog => { catalog.images[0].assetId = 'missing'; });
    value.assets[0].entityKind = 'item'; value.assets[0].entityId = '999';
    const bytes = jsonBytes(value);
    const manifest = { ...JSON.parse(await f.storage.bytes(run.normalized)).manifest,
        catalog: { name: 'images/catalog.json', bytes: bytes.length, sha256: hash(bytes) } };
    await assert.rejects(loadImageCatalog({ manifest, readArtifact: async () => bytes }), /Unexpected physical image asset metadata/);
});

test('apply and dataset validation reject incomplete or altered canonical identities even with the correct roster signature', async t => {
    const f = await fixture(t); await collectImages({ ...f.options, runId: 'complete' });
    await applyImages({ dataset: f.dataset, storage: f.storage, runId: 'complete' });
    const before = await regularBytes(f.dataset, 'manifest.json');
    for (const kind of ['omitted', 'altered']) {
        const inventory = structuredClone(f.options.inventory);
        if (kind === 'omitted') {
            inventory.entities.heroes = inventory.entities.heroes.filter(row => row.id !== '127');
            inventory.requests = inventory.requests.filter(row => row.entityId !== '127');
        }
        else inventory.entities.abilities[0].engineId = 'unknown_blink';
        const run = await collectImages({ ...f.options, inventory, runId: kind });
        assert.equal(run.state, 'complete');
        await assert.rejects(applyImages({ dataset: f.dataset, storage: f.storage, runId: kind }), /complete canonical/);
        assert.deepEqual(await regularBytes(f.dataset, 'manifest.json'), before);
        const normalized = JSON.parse(await f.storage.bytes(run.normalized));
        const graph = await readCanonical(f.dataset);
        graph.extras.set('images/catalog.json', jsonBytes(normalized.catalog));
        graph.extras.set('images/manifest.json', jsonBytes(normalized.manifest));
        const output = path.join(f.root, kind); await writeCanonical(output, graph);
        await assert.rejects(validateDataset(output), /complete canonical/);
    }
});

test('image publication refuses to overwrite a canonical publication completed after its input was read', async t => {
    const f = await fixture(t); await collectImages({ ...f.options, runId: 'concurrent' });
    let concurrentManifest;
    const storage = { ...f.storage, write: async (name, value) => {
        if (name === 'publication.json' && value.state === 'publishing') {
            const graph = await readCanonical(f.dataset); graph.metadata.reviewVersion = 'concurrent-review';
            await publishDataset({ target: f.dataset, replace: true, ownedFiles: ['manifest.json', ...graph.metadata.sourceFiles.map(row => row.name)],
                build: output => writeCanonical(output, graph), validate: validateDataset });
            concurrentManifest = await regularBytes(f.dataset, 'manifest.json');
        }
        return f.storage.write(name, value);
    } };
    await assert.rejects(applyImages({ dataset: f.dataset, storage, runId: 'concurrent' }), /Concurrent changes since canonical input/);
    assert.deepEqual(await regularBytes(f.dataset, 'manifest.json'), concurrentManifest);
    assert.equal((await readCanonical(f.dataset)).metadata.reviewVersion, 'concurrent-review');
    assert.equal((await recoverImages({ dataset: f.dataset, storage: f.storage })).state, 'restored');
    await applyImages({ dataset: f.dataset, storage: f.storage, runId: 'concurrent' });
    assert.equal((await readCanonical(f.dataset)).metadata.reviewVersion, 'concurrent-review');
    assert.equal((await recoverImages({ dataset: f.dataset, storage: f.storage })).state, 'verified-promoted');
});

test('guarded publication and interrupted rollback retain prior images, evidence and unrelated files', async t => {
    const f = await fixture(t); await collectImages({ ...f.options, runId: 'old' }); await applyImages({ dataset: f.dataset, storage: f.storage, runId: 'old' });
    await fs.writeFile(path.join(f.dataset, 'unrelated.txt'), 'keep'); const before = await regularBytes(f.dataset, 'manifest.json');
    const inventory = structuredClone(f.options.inventory); inventory.recipe = 'next';
    await collectImages({ ...f.options, inventory, runId: 'new' });
    await assert.rejects(applyImages({ dataset: f.dataset, storage: f.storage, runId: 'new', interruptAt: 'prepared' }), /interrupted/);
    await recoverImages({ dataset: f.dataset, storage: f.storage });
    assert.deepEqual(await regularBytes(f.dataset, 'manifest.json'), before);
    await assert.rejects(applyImages({ dataset: f.dataset, storage: f.storage, runId: 'new', interruptAt: 'promoted' }), /interrupted/);
    await fs.writeFile(path.join(f.dataset, 'images/catalog.json'), 'corrupt');
    await assert.rejects(recoverImages({ dataset: f.dataset, storage: f.storage, interruptAt: 'restore-prepared' }), /Interrupted/);
    await recoverImages({ dataset: f.dataset, storage: f.storage });
    assert.deepEqual(await regularBytes(f.dataset, 'manifest.json'), before);
    assert.equal(await fs.readFile(path.join(f.dataset, 'unrelated.txt'), 'utf8'), 'keep');
    await collectImages({ ...f.options, runId: 'old', offline: true });
});

test('population publication retains all image artifacts', async t => {
    const f = await fixture(t); await collectImages({ ...f.options, runId: 'images' }); await applyImages({ dataset: f.dataset, storage: f.storage, runId: 'images' });
    const before = (await readCanonical(f.dataset)).extras;
    const storage = await createFileStorage(path.join(f.root, 'population'));
    const roster = f.graph.heroIndex.map(row => ({ ...row, providerSlug: row.id === '127' ? null : row.id === '1' ? 'anti-mage' : row.key, enabled: row.id !== '127' }));
    const options = { runId: 'counters', roster, storage, clock: () => new Date('2026-10-11T00:00:00Z'), sleep: async () => {},
        signal: new AbortController().signal, logger: () => {}, priorInputs: { positionPriors: null }, limits: { ...DEFAULT_LIMITS, spacingMs: 0, retries: 0 },
        recipes: recipeSettings({ dotabuff: { minMatchupRows: 1, minRosterRows: 1 } }), steps: ['counters'], clients: { dotabuff: async request => new Response(request.operation === 'hero-stats'
            ? '<a href="/heroes/anti-mage">Magina</a><a href="/heroes/earthshaker">Earthshaker</a>' : '<table><tr><td><a href="/heroes/'
            + (request.slug === 'anti-mage' ? 'earthshaker' : 'anti-mage') + '">Name</a></td><td data-value="1">1</td><td data-value="52">52</td><td data-value="1000">1000</td></tr></table>') } };
    assert.equal((await collectPopulation(options)).state, 'complete');
    await applyPopulation({ dataset: f.dataset, storage, runId: 'counters', clock: options.clock });
    const after = (await readCanonical(f.dataset)).extras;
    for (const [name, bytes] of before) assert.deepEqual(after.get(name), bytes);
});

test('selected CDN reader rejects unexpected identities, authentication/rate failures, malformed bytes and oversized responses', async () => {
    const signal = new AbortController().signal;
    for (const status of [401, 429, 500]) await assert.rejects(createValveCdnReader({ fetch: async () => new Response('private', { status }) })('items', 'blink', signal), /HTTP/);
    const missing = createValveCdnReader({ fetch: async () => new Response('', { status: 404 }) }); assert.equal(await missing('items', 'blink', signal), null);
    await assert.rejects(missing('items', '../blink', signal), /identity/);
    await assert.rejects(createValveCdnReader({ fetch: async () => new Response('html') })('heroes', 'antimage', signal));
    await assert.rejects(createValveCdnReader({ maxBytes: 1, fetch: async () => new Response(png()) })('items', 'blink', signal), /limit/);
});

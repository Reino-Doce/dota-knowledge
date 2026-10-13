import fs from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readCanonical, readJson, validateRuntime } from '../../src/node/canonical.mjs';
import { verifyReplacements } from '../population/reconciliation.mjs';
import { validateImageDirectory } from '../../src/node/image-files.mjs';
import { isImageFile } from '../../src/image-contracts.mjs';
import { sha256Hex } from '../../src/sha256.mjs';
import { rosterSignature, validateImageRoster } from '../images/inventory.mjs';
import { verifyIdentityLedger } from './identity-reconciliation.mjs';

let validators;
export async function schemaValidators() {
    if (validators) return validators;
    const root = new URL('../../schema/', import.meta.url);
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    addFormats(ajv);
    const names = (await fs.readdir(root)).filter(name => name.endsWith('.schema.json'));
    for (const name of names) ajv.addSchema(JSON.parse(await fs.readFile(new URL(name, root))));
    validators = new Map(names.map(name => [name.slice(0, -12), ajv.getSchema('https://github.com/devilesk/dota-interactive-map/dota-knowledge/' + name)]));
    validators.set('legacy-abilities', ajv.getSchema('https://github.com/devilesk/dota-interactive-map/dota-knowledge/abilities.schema.json#/$defs/legacy'));
    return validators;
}
export async function validateDataset(root) {
    const graph = await readCanonical(root);
    if ([...graph.extras.keys()].some(isImageFile)) {
        const images = await validateImageDirectory(root);
        validateImageRoster(images.catalog, graph.entities);
        if (images.manifest.rosterSignature !== rosterSignature(graph.entities)
            || ['clientVersion', 'sourceRevision'].some(key => images.manifest.build[key] !== graph.metadata.build[key])) throw new Error('Image catalog belongs to different canonical identities/build.');
        const owned = new Set(['images/manifest.json', 'images/catalog.json', ...images.catalog.assets.map(row => row.path)]);
        const listed = graph.metadata.sourceFiles.filter(row => isImageFile(row.name));
        if (listed.length !== owned.size || listed.some(row => !owned.has(row.name))) throw new Error('Image artifacts differ from canonical manifest.');
    }
    const preserved = verifyReplacements(graph);
    verifyIdentityLedger(graph, preserved);
    const historical = graph.extras.get('reviews/reconciliation/index.json');
    if (historical) {
        const ids = new Set([...graph.claims, ...graph.observations].map(row => row.id));
        for (const claim of JSON.parse(historical).uniqueClaims ?? []) for (const id of claim.targetClaimIds) {
            if (!ids.has(id) && !preserved.has(id)) throw new Error('Historical claim targets unknown canonical identity: ' + id);
        }
    }
    const schemas = await schemaValidators();
    const validate = (name, value, label) => {
        const validator = schemas.get(name);
        if (!validator || !validator(value)) throw new Error('Schema mismatch ' + label + ': ' + JSON.stringify(validator?.errors?.slice(0, 4)));
    };
    if (historical) validate('reconciliation-index', JSON.parse(historical), 'Reconciliation index');
    if (graph.extras.has('reviews/reconciliation/identities.json')) validate('identity-ledger',
        JSON.parse(graph.extras.get('reviews/reconciliation/identities.json')), 'Historical identity ledger');
    if (graph.extras.has('items/index.json')) {
        const index = JSON.parse(graph.extras.get('items/index.json'));
        validate('item-index', index, 'Native item index');
        if (index.sourceHash !== sha256Hex(Buffer.from(JSON.stringify({ build: index.build, sources: index.sources }), 'utf8'))) {
            throw new Error('Native item index source identity does not match its build and input hashes.');
        }
        const itemIds = new Set();
        const keys = new Set();
        const engineIds = new Set();
        const itemPaths = new Set();
        for (const ref of index.items) {
            const expectedPath = `items/${ref.key}/data.json`;
            if (ref.path !== expectedPath || itemIds.has(ref.id) || keys.has(ref.key) || engineIds.has(ref.engineId)
                || itemPaths.has(ref.path) || !graph.extras.has(ref.path)) throw new Error('Native item index has an inconsistent or duplicate item identity.');
            itemIds.add(ref.id); keys.add(ref.key); engineIds.add(ref.engineId); itemPaths.add(ref.path);
            const item = JSON.parse(graph.extras.get(ref.path));
            validate('item-profile', item, ref.path);
            if (item.id !== ref.id || item.key !== ref.key || item.sourceKey !== ref.engineId
                || item.ability && item.ability.id !== ref.engineId) {
                throw new Error('Native item profile disagrees with its indexed identity: ' + ref.path);
            }
        }
        for (const item of index.unmatchedIds) {
            if (itemIds.has(item.id) || engineIds.has(item.engineId)) throw new Error('Native item index has a duplicate unmatched identity.');
            itemIds.add(item.id); engineIds.add(item.engineId);
        }
        const manifestedItemPaths = new Set(graph.metadata.sourceFiles.filter(row => /^items\/[^/]+\/data\.json$/.test(row.name)).map(row => row.name));
        if (manifestedItemPaths.size !== itemPaths.size || [...itemPaths].some(name => !manifestedItemPaths.has(name))) {
            throw new Error('Native item profiles differ from their canonical manifest paths.');
        }
    }
    if (graph.extras.has('images/manifest.json')) {
        validate('image-manifest', await readJson(root, 'images/manifest.json'), 'Image manifest');
        validate('image-catalog', await readJson(root, 'images/catalog.json'), 'Image catalog');
    }
    for (const [name, schema] of [['manifest.json', 'canonical-manifest'], ['heroes/index.json', 'hero-index'], ['heroes/aliases.json', 'aliases'],
        ['observations/index.json', 'observations-index'], ['observations/sources.json', 'source-registry'], ['mechanics/reference.json', 'mechanics-reference'],
        ['reviews/claims.json', 'claim-index'], ['reviews/bindings.json', 'review-bindings'], ['reviews/profiles.json', 'profile-history'],
        ['runtime/manifest.json', 'manifest'], ['runtime/core.json', 'core']]) validate(schema, await readJson(root, name), name);
    const seen = new Set();
    const compactLayout = graph.metadata.sourceFiles.some(row => row.name === 'mechanics/abilities.json');
    for (const row of graph.metadata.sourceFiles) {
        let schema;
        if (/^heroes\/[^/]+\/profile.json$/.test(row.name)) schema = 'hero';
        else if (row.name === 'items/index.json') schema = 'item-index';
        else if (/^items\/[^/]+\/data\.json$/.test(row.name)) schema = 'item-profile';
        else if (/^heroes\/[^/]+\/abilities.json$/.test(row.name)) schema = compactLayout ? 'abilities' : 'legacy-abilities';
        else if (row.name === 'mechanics/abilities.json') schema = 'ability-metadata';
        else if (/^heroes\/[^/]+\/mechanics.json$/.test(row.name)) schema = 'mechanics';
        else if (/^heroes\/[^/]+\/(statistics|matchups\/(counters|synergies)).json$/.test(row.name)) schema = 'hero-observations';
        else if (/^runtime\/heroes\/[^/]+\/guide.json$/.test(row.name)) schema = 'guide';
        else if (/^runtime\/heroes\/[^/]+\/observations.json$/.test(row.name)) schema = 'observation-shard';
        if (schema) validate(schema, await readJson(root, row.name), row.name);
        seen.add(row.name);
    }
    for (const row of graph.heroIndex) for (const field of ['profile', 'abilities', 'mechanics', 'guide']) {
        if (!seen.has(row[field])) throw new Error('Unmanifested canonical record: ' + row[field]);
    }
    await validateRuntime(root);
    return { schemas: schemas.size, heroes: graph.entities.heroes.length, abilities: graph.entities.abilities.length,
        activations: graph.entities.activations.length, effects: graph.entities.effects.length, claims: graph.claims.length,
        observations: graph.observations.length };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readCanonical, readJson, validateRuntime } from '../../src/node/canonical.mjs';
import { verifyReplacements } from '../population/reconciliation.mjs';
import { validateImageDirectory } from '../../src/node/image-files.mjs';
import { isImageFile } from '../../src/image-contracts.mjs';
import { rosterSignature, validateImageRoster } from '../images/inventory.mjs';

let validators;
export async function schemaValidators() {
    if (validators) return validators;
    const root = new URL('../../schema/', import.meta.url);
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    addFormats(ajv);
    const names = (await fs.readdir(root)).filter(name => name.endsWith('.schema.json'));
    for (const name of names) ajv.addSchema(JSON.parse(await fs.readFile(new URL(name, root))));
    validators = new Map(names.map(name => [name.slice(0, -12), ajv.getSchema('https://github.com/devilesk/dota-interactive-map/dota-knowledge/' + name)]));
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
    if (graph.extras.has('images/manifest.json')) {
        validate('image-manifest', await readJson(root, 'images/manifest.json'), 'Image manifest');
        validate('image-catalog', await readJson(root, 'images/catalog.json'), 'Image catalog');
    }
    for (const [name, schema] of [['manifest.json', 'canonical-manifest'], ['heroes/index.json', 'hero-index'], ['heroes/aliases.json', 'aliases'],
        ['observations/index.json', 'observations-index'], ['observations/sources.json', 'source-registry'], ['mechanics/reference.json', 'mechanics-reference'],
        ['reviews/claims.json', 'claim-index'], ['reviews/bindings.json', 'review-bindings'], ['reviews/profiles.json', 'profile-history'],
        ['runtime/manifest.json', 'manifest'], ['runtime/core.json', 'core']]) validate(schema, await readJson(root, name), name);
    const seen = new Set();
    for (const row of graph.metadata.sourceFiles) {
        let schema;
        if (/^heroes\/[^/]+\/profile.json$/.test(row.name)) schema = 'hero';
        else if (/^heroes\/[^/]+\/abilities.json$/.test(row.name)) schema = 'abilities';
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

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { hash } from '../../src/canonical-model.mjs';
import { jsonBytes, readCanonical } from '../../src/node/canonical.mjs';
import { importDataset } from '../../scripts/import-bundle.mjs';

/** Minimal complete offline input bundles, including a hash-verified historical response. */
export async function writeBundleFixture(root) {
    const clock = '2026-10-01T00:00:00.000Z';
    const sourceHash = 'a'.repeat(64); const nativeHash = 'b'.repeat(64);
    const hero = { heroId: '1', heroKey: 'npc_dota_hero_antimage', key: 'antimage', name: 'Anti-Mage', enabled: true, cmEnabled: true, effects: [] };
    const profile = { name: 'Magina', aliases: ['mage'], complexity: 1.5, ranks: { rankAll: { m: '9007199254740993',
        ens: [{ id: 7, wr: 49.125, adv: -0.5, pr: 1 }], tms: [{ id: 7, wr: 53, adv: 0.5, pr: 1 }] } } };
    const response = jsonBytes({ heroes: [profile], items: [{ id: 1, name: 'historical item' }] });
    const historicalHash = hash(response);
    const source = { id: 'fixture-history', kind: 'historical-profile', sha256: historicalHash, rawFile: 'responses/history.json',
        retrievedAt: clock, observedAt: '2024-01-01T00:00:00.000Z', metadata: { items: [{ id: 1, name: 'historical item' }] },
        cohort: { window: 'unknown' } };
    const mechanics = { schemaVersion: 1, sourceHash, build: { clientVersion: '1' }, heroes: [{ ...hero, abilities: [] }], sources: [] };
    const annotations = { sourceHash, version: 'fixture-review', effects: [] };
    const browserCatalog = { sourceHash, heroes: [hero], coverage: { reviewedEffects: 0 } };
    const externalEvidence = { version: 'fixture-external', createdAt: clock, nativeSourceHash: nativeHash, sources: [source,
        { id: 'stratz-population', kind: 'population', status: 'unavailable' }],
        heroes: { '1': { historicalProfiles: [{ sourceId: 'source:fixture-history', sourceRecord: profile }] } } };
    const guide = { heroId: '1', nativeSourceHash: nativeHash, native: { heroId: '1', key: 'antimage', raw: {
        AttributePrimary: 'DOTA_ATTRIBUTE_AGILITY', Complexity: '1', AttackRange: '150', Role: 'Carry,Escape', Rolelevels: '3,2' } } };
    const write = async (name, value, raw = false) => {
        const bytes = raw ? value : jsonBytes(value);
        const filename = path.join(root, name); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, bytes, { flag: 'wx' });
        return { name: name.slice(name.indexOf('/') + 1), bytes: bytes.length, sha256: hash(bytes) };
    };
    const files = [];
    for (const [name, value] of Object.entries({ hero_mechanics: mechanics, hero_mechanics_annotations: annotations, hero_mechanics_browser: browserCatalog })) files.push(await write('mechanics/' + name + '.json', value));
    await write('mechanics/hero_mechanics_manifest.json', { schemaVersion: 1, files });
    const evidenceFiles = [await write('external/draft_evidence.json', externalEvidence), await write('external/responses/history.json', response, true)];
    const guideFile = await write('external/hero_mechanics/1.json', guide);
    await write('external/draft_evidence_manifest.json', { schemaVersion: 1, version: externalEvidence.version, createdAt: clock,
        files: evidenceFiles, mechanicsKnowledge: { heroes: { '1': guideFile } } });
    return { mechanics: path.join(root, 'mechanics'), evidence: path.join(root, 'external'), output: path.join(root, 'data'),
        version: 'fixture-bundle', generatedAt: clock, replace: true, evidenceRepository: root, profile, historicalHash };
}

export async function runBundleFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-bundle-fixture-'));
    try {
        const options = await writeBundleFixture(root);
        await importDataset({ ...options, quiet: true });
        const graph = await readCanonical(options.output);
        const row = graph.observations.find(row => row.kind === 'historical-profile');
        if (hash(JSON.stringify(row.sourceRecord)) !== hash(JSON.stringify(options.profile))) throw new Error('Historical payload changed.');
        return { state: 'passed', heroes: graph.entities.heroes.length, historicalProfiles: 1, observationId: row.id };
    }
    finally {
        if (path.dirname(await fs.realpath(root)) !== await fs.realpath(os.tmpdir())) throw new Error('Unsafe fixture cleanup.');
        await fs.rm(root, { recursive: true });
    }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.stdout.write(JSON.stringify(await runBundleFixture()) + '\n');

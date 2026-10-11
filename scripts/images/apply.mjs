import path from 'node:path';
import fs from 'node:fs/promises';
import { readCanonical, readJson, regularBytes, jsonBytes, writeCanonical, verifyManifest } from '../../src/node/canonical.mjs';
import { publishDataset, recoverPublication } from '../../src/node/publish-dataset.mjs';
import { validateDataset } from '../consolidation/validation.mjs';
import { isImageFile } from '../../src/image-contracts.mjs';
import { validateImageDirectory } from '../../src/node/image-files.mjs';
import { rosterSignature, validateImageRoster } from './inventory.mjs';
import { verifiedRun, runPath } from './collect.mjs';

export async function applyImages({ dataset, storage, runId, interruptAt }) {
    return storage.lock('images', async () => {
        const run = await storage.read(runPath(runId));
        const normalized = await verifiedRun(storage, run);
        const graph = await readCanonical(dataset);
        validateImageRoster(normalized.catalog, graph.entities);
        if (rosterSignature(graph.entities) !== normalized.manifest.rosterSignature
            || ['clientVersion', 'sourceRevision'].some(key => graph.metadata.build[key] !== normalized.manifest.build[key])) throw new Error('Image run does not match the canonical identities/build.');
        const prior = graph.extras.get('images/manifest.json');
        if (prior && JSON.parse(prior).inputSignature === normalized.manifest.inputSignature) {
            const published = await validateImageDirectory(dataset);
            if (published.manifest.catalog.sha256 !== normalized.manifest.catalog.sha256) throw new Error('Image input signature collision.');
            return { state: 'unchanged' };
        }
        for (const name of graph.extras.keys()) if (isImageFile(name)) graph.extras.delete(name);
        graph.extras.set('images/catalog.json', jsonBytes(normalized.catalog));
        graph.extras.set('images/manifest.json', jsonBytes(normalized.manifest));
        for (const file of normalized.files) graph.extras.set(file.path, await storage.bytes(file.artifact));
        const journal = { state: 'publishing', dataset: path.resolve(dataset), runId, inputSignature: run.inputSignature };
        await storage.write('publication.json', journal);
        const result = await publishDataset({ target: dataset, replace: true,
            expectedFiles: [graph.inputManifest, ...graph.metadata.sourceFiles],
            ownedFiles: ['manifest.json', ...graph.metadata.sourceFiles.map(row => row.name)],
            build: output => writeCanonical(output, graph), validate: validateDataset, interruptAt });
        await verifyManifest(dataset);
        if ((await readJson(dataset, 'images/manifest.json')).inputSignature !== run.inputSignature) throw new Error('Promoted image manifest differs.');
        await storage.write('publication.json', { ...journal, state: 'verified' });
        return result;
    });
}

export async function recoverImages({ dataset, storage, interruptAt }) {
    await storage.recoverLock('images');
    return storage.lock('images', async () => {
        const journal = await storage.read('publication.json');
        if (journal && journal.dataset !== path.resolve(dataset)) throw new Error('Image recovery target differs.');
        let result;
        try { result = await recoverPublication(dataset, { validate: validateDataset, interruptAt }); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const staging = path.join(path.dirname(path.resolve(dataset)), '.' + path.basename(dataset) + '-staging');
            const exists = await fs.lstat(staging).then(() => true, missing => {
                if (missing.code === 'ENOENT') return false;
                throw missing;
            });
            if (exists) throw error; // Missing recovery files inside an existing operation are not an idle recovery.
        }
        if (journal) {
            await validateDataset(dataset);
            let promoted = false;
            try { promoted = JSON.parse(await regularBytes(dataset, 'images/manifest.json')).inputSignature === journal.inputSignature; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            await storage.write('publication.json', { ...journal, state: promoted ? 'verified' : 'rolled-back' });
            return result ?? { state: promoted ? 'verified-promoted' : 'restored' };
        }
        return result ?? { state: 'unchanged' };
    });
}

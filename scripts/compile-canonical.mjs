import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readCanonical, writeCanonical } from '../src/node/canonical.mjs';
import { publishDataset, recoverPublication } from '../src/node/publish-dataset.mjs';
import { validateDataset } from './consolidation/validation.mjs';

export async function compileCanonical({ dataset = fileURLToPath(new URL('../data', import.meta.url)), output = dataset, replace = true } = {}) {
    const graph = await readCanonical(dataset);
    return publishDataset({ target: output, replace,
        expectedFiles: path.resolve(output) === path.resolve(dataset) ? [graph.inputManifest, ...graph.metadata.sourceFiles] : undefined,
        ownedFiles: path.resolve(output) === path.resolve(dataset) ? ['manifest.json', ...graph.metadata.sourceFiles.map(row => row.name)] : undefined,
        build: stage => writeCanonical(stage, graph), validate: validateDataset });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const { values } = parseArgs({ options: { dataset: { type: 'string' }, output: { type: 'string' }, recover: { type: 'boolean' } } });
    const dataset = path.resolve(values.dataset ?? fileURLToPath(new URL('../data', import.meta.url)));
    const result = values.recover ? await recoverPublication(values.output ?? dataset, { validate: validateDataset })
        : await compileCanonical({ dataset, output: values.output ?? dataset });
    process.stdout.write(JSON.stringify(result) + '\n');
}

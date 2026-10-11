import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readCanonical } from '../../src/node/canonical.mjs';
import { collectImages, createImageStorage } from './collect.mjs';
import { applyImages, recoverImages } from './apply.mjs';
import { createNativeImageSource, createSource2Decoder, createValveCdnReader } from './native.mjs';

export async function main(args = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
        dataset: { type: 'string' }, evidence: { type: 'string' }, run: { type: 'string' },
        game: { type: 'string' }, 'resource-tool': { type: 'string' }, 'picker-portraits': { type: 'string' },
        offline: { type: 'boolean' }, fresh: { type: 'boolean' }, cdn: { type: 'boolean' },
    } });
    const [command] = positionals;
    if (!['refresh', 'apply', 'recover'].includes(command) || positionals.length !== 1) throw new Error('Expected refresh, apply, or recover.');
    const dataset = path.resolve(values.dataset ?? fileURLToPath(new URL('../../data', import.meta.url)));
    const storage = await createImageStorage(path.resolve(values.evidence ?? fileURLToPath(new URL('../../evidence/images/acquisition', import.meta.url))));
    if (command === 'recover') return recoverImages({ dataset, storage });
    if (!values.run) throw new Error('--run is required.');
    if (command === 'apply') return applyImages({ dataset, storage, runId: values.run });
    const controller = new AbortController(); const cancel = () => controller.abort();
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
        const dependencies = { runId: values.run, storage, clock: () => new Date().toISOString(), signal: controller.signal,
            logger: event => process.stdout.write(JSON.stringify(event) + '\n') };
        if (values.offline) return collectImages({ ...dependencies, offline: true });
        if (!values.game || !values['resource-tool']) throw new Error('Fresh acquisition requires --game and --resource-tool.');
        const graph = await readCanonical(dataset);
        const roster = { heroes: graph.entities.heroes.map(hero => ({ ...hero, providerSlug: graph.heroIndex.find(row => row.id === hero.id)?.providerSlug })), abilities: graph.entities.abilities };
        const source = await createNativeImageSource({ game: path.resolve(values.game), roster, storage,
            pickerDirectory: values['picker-portraits'] ? path.resolve(values['picker-portraits']) : undefined,
            cdnReader: values.cdn ? createValveCdnReader({ fetch: globalThis.fetch }) : undefined, signal: controller.signal });
        const decoder = await createSource2Decoder({ executable: values['resource-tool'], workDirectory: path.join(storage.root, 'decoder-work') });
        return collectImages({ ...dependencies, ...source, decoder, fresh: Boolean(values.fresh) });
    }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().then(result => { process.stdout.write(JSON.stringify({ state: result.state, runId: result.runId }) + '\n'); if (result.state === 'partial') process.exitCode = 1; },
        error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}

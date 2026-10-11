import { collectPopulation, recipeSettings, DEFAULT_LIMITS, createFileStorage, applyPopulation, type CollectionOptions, type ModelAdapter } from '@reino-doce/dota-knowledge/node/population';

// Compile the consumer contract without running collection or touching the filesystem.
async function consumer(root: string, adapter: ModelAdapter) {
    const storage = await createFileStorage(root + '/evidence/population');
    const options: CollectionOptions = {
        runId: 'typed-fixture', roster: [{ id: '1', key: 'antimage', sourceKey: 'npc_dota_hero_antimage', providerSlug: 'anti-mage' }],
        storage, clients: { opendota: async (_request, { signal }) => { signal.throwIfAborted(); return new Response('[]'); } },
        clock: () => new Date(), sleep: async (_milliseconds, signal) => { signal.throwIfAborted(); }, signal: new AbortController().signal,
        logger: () => {}, limits: { ...DEFAULT_LIMITS }, recipes: recipeSettings(), priorInputs: { positionPriors: null }, calibrationAdapter: adapter,
    };
    const run = await collectPopulation(options);
    return applyPopulation({ dataset: root + '/data', storage, runId: run.id, clock: options.clock });
}
void consumer;

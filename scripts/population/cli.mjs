import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFileStorage, collectPopulation, applyPopulation, recoverPopulation, recipeSettings, DEFAULT_LIMITS, DEFAULT_STEPS, createElectronClient } from '../../src/node/population.mjs';
import { readJson } from '../../src/node/canonical.mjs';

export async function main(argv = process.argv.slice(2)) {
    const [command, ...args] = argv;
    const { values } = parseArgs({ args, options: {
        help: { type: 'boolean' }, adapter: { type: 'string' }, evidence: { type: 'string' }, dataset: { type: 'string' },
        run: { type: 'string' }, steps: { type: 'string' }, scopes: { type: 'string' }, offline: { type: 'boolean' },
        fresh: { type: 'boolean' }, browser: { type: 'boolean' }, session: { type: 'string' },
    } });
    if (values.help) {
        process.stdout.write('population <refresh|apply|recover> --dataset <canonical-directory> --evidence <owned-directory> --run <id>\n'
            + 'refresh: --adapter <module> [--steps roster,counters,positions,synergies,timings,lanes] [--fresh|--offline]\n'
            + 'apply: [--scopes comma-separated-scope-keys] [--adapter <calibration-module>]\n'
            + 'Optional browser: explicitly run this CLI with Electron, --browser --session <separate-directory>.\n');
        return;
    }
    if (!['refresh', 'apply', 'recover'].includes(command)) throw new Error('Choose refresh, apply or recover.');
    const dataset = path.resolve(values.dataset ?? 'data');
    const storage = await createFileStorage(path.resolve(values.evidence ?? 'evidence/population'));
    const controller = new AbortController(); const cancel = () => controller.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    let browser;
    try {
        const signal = controller.signal;
        const clock = () => new Date(); const pause = (ms, signal) => sleep(ms, undefined, { signal });
        const adapter = values.adapter ? await import(pathToFileURL(path.resolve(values.adapter))) : null;
        const supplied = adapter ? await adapter.createPopulationAdapter({ signal }) : {};
        if (command === 'recover') return await recoverPopulation({ dataset, storage });
        if (command === 'apply') {
            if (!values.run) throw new Error('Apply requires --run.');
            return await applyPopulation({ dataset, storage, runId: values.run, selected: values.scopes?.split(','), clock, calibrationAdapter: supplied.calibrationAdapter });
        }
        if (!values.run) throw new Error('Refresh requires an explicit --run ID.');
        const saved = values.offline ? await storage.read(`runs/${values.run}/manifest.json`) : null;
        if (!values.offline && !adapter) throw new Error('Fresh collection requires a caller-supplied --adapter module.');
        const clients = supplied.clients ?? {};
        if (values.browser) {
            if (!values.session || !process.versions.electron) throw new Error('Use an explicitly selected Electron executable and --session for browser collection.');
            const electron = await import('electron');
            browser = await createElectronClient({ electron, sessionDirectory: path.resolve(values.session), evidenceDirectory: storage.root,
                signal, clock, sleep: pause, logger: event => process.stdout.write(event.event + '\n'),
                onChallenge: async () => {}, challengeTimeoutMs: 180000 });
            clients.dotabuff = browser;
        }
        const roster = saved?.config.roster ?? supplied.roster ?? await Promise.all((await readJson(dataset, 'heroes/index.json')).heroes.map(async hero =>
            ({ ...hero, enabled: (await readJson(dataset, hero.profile)).enabled })));
        return await collectPopulation({ runId: values.run, roster, clients, storage, clock, sleep: pause, signal,
            logger: event => process.stdout.write(JSON.stringify(event) + '\n'),
            limits: { ...DEFAULT_LIMITS, ...supplied.limits }, recipes: saved?.config.recipes ?? supplied.recipes ?? recipeSettings(),
            priorInputs: saved?.config.priorInputs ?? supplied.priorInputs ?? { positionPriors: null },
            calibrationAdapter: supplied.calibrationAdapter, steps: values.steps?.split(',') ?? saved?.config.steps ?? DEFAULT_STEPS,
            offline: Boolean(values.offline), fresh: Boolean(values.fresh) });
    }
    finally {
        await browser?.close(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
        if (process.versions.electron) (await import('electron')).app.quit();
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(result => { if (result?.state) { process.stdout.write(result.state + '\n'); if (result.state === 'partial') process.exitCode = 1; } }, () => {
        // Caller adapters may include credentials in errors; never echo their exception text.
        process.stderr.write('Population command failed. Check explicit inputs and saved scope status.\n'); process.exitCode = 1;
    });
}

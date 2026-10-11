import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function checkPackage() {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-package-'));
    try {
        const npmCli = process.env.npm_execpath;
        if (!npmCli) throw new Error('Run this check using npm run package:verify.');
        const packOutput = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary],
            { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }));
        const [packed] = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
        if (!packed || !Array.isArray(packed.files)) throw new Error('npm pack did not return an artifact inventory.');
        if (packed.files.some(file => /^(evidence|\.3esmit|data\/hero-knowledge|data\/heroes|tests|node_modules)\//.test(file.path))) throw new Error('Development data leaked into the runtime package.');
        execFileSync('tar', ['-xzf', path.join(temporary, packed.filename), '-C', temporary], { windowsHide: true, stdio: 'pipe' });
        const extracted = path.join(temporary, 'package');
        execFileSync(process.execPath, [npmCli, 'install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
            { cwd: extracted, windowsHide: true, stdio: 'pipe', maxBuffer: 1024 * 1024 });
        for (const name of ['electron', 'typescript', 'jsdom']) {
            try { await fs.access(path.join(extracted, 'node_modules', name)); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            throw new Error('Optional/development dependency installed in extraction: ' + name);
        }
        // Fixture collection runs with the same external-network prohibition as the suite.
        await fs.copyFile(path.join(root, 'tests/population/no-network.mjs'), path.join(temporary, 'no-network.mjs'));
        const populationResult = JSON.parse(execFileSync(process.execPath, ['--import', pathToFileURL(path.join(temporary, 'no-network.mjs')).href, 'docs/examples/population-fixture.mjs'],
            { cwd: extracted, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }));
        const nodeSmoke = `import { loadKnowledgePackage } from '@reino-doce/dota-knowledge/node';
import manifest from '@reino-doce/dota-knowledge/runtime/manifest.json' with { type: 'json' };
const store = await loadKnowledgePackage();
if (manifest.schemaVersion !== 2 || store.hero('1').key !== 'antimage') throw new Error('Extracted Node exports failed.');
store.retire();
const { checkRuntime } = await import('./scripts/check-runtime.mjs');
console.log(JSON.stringify(await checkRuntime()));`;
        const nodeResult = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', nodeSmoke],
            { cwd: extracted, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }));
        const browserSmoke = `import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const root = process.cwd();
const context = vm.createContext({ TextDecoder, TextEncoder, Uint8Array, structuredClone, crypto: webcrypto, performance });
const modules = new Map();
async function moduleFor(filename) {
 if (!filename.startsWith(path.join(root, 'src') + path.sep)) throw new Error('Browser entry imports outside src.');
 if (modules.has(filename)) return modules.get(filename);
 const module = new vm.SourceTextModule(await fs.readFile(filename, 'utf8'), { context, identifier: filename });
 modules.set(filename, module);
 await module.link((specifier, referencing) => {
  if (!specifier.startsWith('./')) throw new Error('Browser entry has a non-browser dependency: ' + specifier);
  return moduleFor(path.resolve(path.dirname(referencing.identifier), specifier));
 }); return module;
}
const entry = await moduleFor(path.join(root, 'src/index.mjs')); await entry.evaluate();
const manifest = JSON.parse(await fs.readFile('data/runtime/manifest.json'));
const store = await entry.namespace.loadKnowledgeStore({ manifest, readArtifact: row => fs.readFile(path.join(root, 'data/runtime', row.name)) });
if (store.hero('1').sourceKey !== 'npc_dota_hero_antimage' || !(await store.loadHeroEvidence('1')).reviewBindings.length) throw new Error('Browser profile/guide failure.');
if (!(await store.loadObservations({ kind: 'matchup', heroId: '1' })).length) throw new Error('Browser observation failure.');
store.retire(); console.log(JSON.stringify({ state: 'passed', modules: modules.size }));`;
        const browserResult = JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', browserSmoke],
            { cwd: extracted, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
        return { files: packed.entryCount, compressedBytes: packed.size, unpackedBytes: packed.unpackedSize, node: nodeResult,
            browserEntry: browserResult, population: populationResult, dependenciesInstalledInExtraction: 'production-only' };
    }
    finally {
        if (path.dirname(await fs.realpath(temporary)) !== await fs.realpath(os.tmpdir()) || !path.basename(temporary).startsWith('knowledge-package-')) throw new Error('Unsafe package cleanup.');
        await fs.rm(temporary, { recursive: true });
    }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.stdout.write(JSON.stringify(await checkPackage(), null, 2) + '\n');

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openVpk, resolveGameDirectory } from '../src/node/game-files.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const defaultDataset = path.join(packageRoot, 'data');
const defaultOutput = path.join(packageRoot, 'evidence', 'native-vpk');

function usage() {
    return `Usage: node scripts/recover-installed-native.mjs [options]\n\nOptions:\n  --dataset <directory>  Canonical dataset source registry.\n  --game <directory>     Explicit Dota game directory or installation root.\n  --output <directory>   Persistent evidence output (default: evidence/native-vpk).\n  --help                 Print this help.\n\nOnly VPK resources matching their recorded SHA-256 are retained.`;
}

function resolveWithin(root, relative) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative)
        || relative.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Unsafe native evidence path.');
    }
    const resolved = path.resolve(root, ...relative.split('/'));
    const fromRoot = path.relative(root, resolved);
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
        throw new Error('Native evidence path escapes its output directory.');
    }
    return resolved;
}

async function writeOnce(filename, bytes) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    try {
        await fs.writeFile(filename, bytes, { flag: 'wx' });
    }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await fs.readFile(filename);
        if (hash(existing) !== hash(bytes) || existing.byteLength !== bytes.byteLength) {
            throw new Error(`Existing evidence differs from its recorded hash: ${path.basename(filename)}`);
        }
    }
}

async function recoverInstalledNative({ dataset = defaultDataset, game = undefined, output = defaultOutput } = {}) {
    const sources = JSON.parse(await fs.readFile(path.join(dataset, 'observations', 'sources.json'), 'utf8'))
        .filter(source => source.sourceKind === 'installed-game-resource')
        .map(source => ({ id: source.id, resource: source.resource, sha256: source.sha256 }))
        .sort((left, right) => left.id.localeCompare(right.id));
    if (!sources.length || sources.some(source => !source.resource || !/^[a-f0-9]{64}$/.test(source.sha256 || ''))) {
        throw new Error('Dataset has no complete installed-resource source registry.');
    }
    const identity = hash(Buffer.from(JSON.stringify(sources)));
    const evidenceRoot = path.resolve(output, identity);
    let archive = null;
    let unavailableReason = null;
    try {
        const gameDirectory = resolveGameDirectory(game);
        archive = openVpk(path.join(gameDirectory, 'dota', 'pak01_dir.vpk'));
    }
    catch (error) {
        unavailableReason = error.code === 'ENOENT' ? 'installed-vpk-unavailable' : 'installed-game-directory-unavailable';
    }

    const records = [];
    for (const source of sources) {
        let state = unavailableReason ?? 'resource-unavailable';
        let bytes = null;
        if (archive) {
            try {
                bytes = archive.read(source.resource);
                state = hash(bytes) === source.sha256 ? 'recovered-hash-verified' : 'installed-resource-hash-mismatch';
            }
            catch {
                state = 'resource-unavailable';
            }
        }
        const record = { ...source, state, bytes: state === 'recovered-hash-verified' ? bytes.byteLength : null,
            evidenceFile: null, reason: state === 'recovered-hash-verified' ? null : state };
        if (state === 'recovered-hash-verified') {
            const relative = `${source.sha256}/${source.resource}`;
            await writeOnce(resolveWithin(evidenceRoot, relative), bytes);
            record.evidenceFile = `${path.relative(packageRoot, evidenceRoot).split(path.sep).join('/')}/${relative}`;
        }
        records.push(record);
    }
    const manifest = { schemaVersion: 1, sourceIdentity: identity, recoveredAt: new Date().toISOString(), records };
    const manifestPath = resolveWithin(path.resolve(output), `${identity}/manifest.json`);
    const manifestBytes = Buffer.from(json(manifest));
    try {
        await writeOnce(manifestPath, manifestBytes);
    }
    catch (error) {
        if (!/Existing evidence differs/.test(error.message)) throw error;
        const existing = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (existing.sourceIdentity !== identity || JSON.stringify(existing.records) !== JSON.stringify(records)) throw error;
    }
    const verified = records.filter(record => record.state === 'recovered-hash-verified');
    const bytes = verified.reduce((total, record) => total + record.bytes, 0);
    process.stdout.write(`Verified ${verified.length}/${records.length} native resources (${bytes} bytes).\n`);
    return { manifest, manifestPath, verifiedBytes: bytes };
}

async function main() {
    const { values } = parseArgs({ options: { dataset: { type: 'string' }, game: { type: 'string' },
        output: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
    if (values.help) {
        process.stdout.write(usage());
        return;
    }
    await recoverInstalledNative({ dataset: values.dataset, game: values.game, output: values.output });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exitCode = 1;
    });
}

export { recoverInstalledNative, usage };

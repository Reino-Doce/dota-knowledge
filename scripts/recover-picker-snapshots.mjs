import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultDataset = path.join(packageRoot, 'data');
const defaultRepository = path.resolve(packageRoot, '..', 'dotabuff-picker');
const defaultOutput = path.join(packageRoot, 'evidence', 'picker-snapshots');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;

function usage() {
    return `Usage: node scripts/recover-picker-snapshots.mjs [options]\n\nOptions:\n  --dataset <directory>      Reconciled canonical dataset.\n  --repository <directory>   Local checkout containing recorded Git revisions.\n  --output <directory>       Persistent evidence output (default: evidence/picker-snapshots).\n  --help                     Print this help.\n\nThis tool reads only recorded Git objects and accepts snapshots only when their hashes match.`;
}

function safeRelative(name) {
    if (typeof name !== 'string' || !name || name.includes('\\') || path.isAbsolute(name)
        || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe snapshot path.');
    return name;
}

function runGit(repository, args, maxBuffer = 16 * 1024 * 1024) {
    return execFileSync('git', ['-C', repository, ...args], { encoding: null, maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] });
}

async function writeOnce(filename, bytes) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    try {
        await fs.writeFile(filename, bytes, { flag: 'wx' });
    }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await fs.readFile(filename);
        if (existing.byteLength !== bytes.byteLength || hash(existing) !== hash(bytes)) {
            throw new Error(`Existing source snapshot differs from its recorded hash: ${path.basename(filename)}`);
        }
    }
}

async function recoverPickerSnapshots({ dataset = defaultDataset, repository = defaultRepository, output = defaultOutput } = {}) {
    const registry = JSON.parse(await fs.readFile(path.join(dataset, 'observations', 'sources.json'), 'utf8'));
    const sources = registry.filter(source => source.repo === 'yarikleto/dotabuff-picker')
        .map(source => ({ id: source.id, repo: source.repo, revision: source.commit,
            resource: safeRelative(source.resource), sha256: source.sha256 }))
        .sort((left, right) => left.id.localeCompare(right.id));
    if (sources.length !== 6) throw new Error(`Expected the six selected Picker snapshots, found ${sources.length}.`);
    const sourceIdentity = hash(Buffer.from(JSON.stringify(sources)));
    const evidenceDirectory = path.resolve(output, sourceIdentity);
    const records = [];
    for (const source of sources) {
        let state = 'original-bytes-unavailable';
        let reason = null;
        let bytes = null;
        try {
            if (!/^[a-f0-9]{40}$/.test(source.revision || '') || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) {
                throw new Error('recorded-git-identity-invalid');
            }
            runGit(repository, ['cat-file', '-e', `${source.revision}^{commit}`]);
            bytes = runGit(repository, ['show', `${source.revision}:${source.resource}`], 64 * 1024 * 1024);
            if (hash(bytes) !== source.sha256) {
                state = 'recorded-git-revision-hash-mismatch';
                reason = state;
                bytes = null;
            }
            else state = 'recovered-hash-verified';
        }
        catch (error) {
            reason = error.code === 'ENOENT' ? 'local-git-repository-unavailable' : error.message === 'recorded-git-identity-invalid'
                ? error.message : 'recorded-git-object-unavailable';
        }
        const record = { ...source, state, bytes: bytes?.byteLength ?? null, reason, evidenceFile: null };
        if (bytes) {
            const relative = `${source.revision}/${source.resource}`;
            const filename = path.resolve(evidenceDirectory, ...relative.split('/'));
            const inside = path.relative(evidenceDirectory, filename);
            if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
                throw new Error('Recovered Picker snapshot escapes its evidence directory.');
            }
            await writeOnce(filename, bytes);
            record.evidenceFile = `${path.relative(packageRoot, evidenceDirectory).split(path.sep).join('/')}/${relative}`;
        }
        records.push(record);
    }
    const manifest = { schemaVersion: 1, sourceIdentity, recoveredAt: new Date().toISOString(), records };
    const manifestPath = path.join(evidenceDirectory, 'manifest.json');
    const manifestBytes = Buffer.from(json(manifest));
    try {
        await writeOnce(manifestPath, manifestBytes);
    }
    catch (error) {
        if (!/Existing source snapshot differs/.test(error.message)) throw error;
        const previous = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (previous.sourceIdentity !== sourceIdentity || JSON.stringify(previous.records) !== JSON.stringify(records)) throw error;
    }
    const verified = records.filter(record => record.state === 'recovered-hash-verified');
    process.stdout.write(`Verified ${verified.length}/${records.length} Picker snapshots at the recorded Git revision.\n`);
    return { manifest, manifestPath };
}

async function main() {
    const { values } = parseArgs({ options: { dataset: { type: 'string' }, repository: { type: 'string' },
        output: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
    if (values.help) {
        process.stdout.write(usage());
        return;
    }
    await recoverPickerSnapshots({ dataset: values.dataset, repository: values.repository, output: values.output });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exitCode = 1;
    });
}

export { recoverPickerSnapshots, usage };

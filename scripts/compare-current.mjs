import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readCanonical } from '../src/node/canonical.mjs';
import { readLegacyLayout } from './consolidation/legacy-layout.mjs';
import { verifiedIdentityMapping, reconcileValue, historicalInputSignature } from './consolidation/identity-reconciliation.mjs';
import { verifyReplacements } from './population/reconciliation.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultDataset = path.join(packageRoot, 'data');
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
        : JSON.stringify(value);

export function classifyChange(file, pointer) {
    if (file === 'sources.json' || file === 'manifest.json' || file.startsWith('reconciliation/')) return 'provenance';
    if (file === 'observations/index.json' || file.startsWith('observations/heroes/')) return 'observations';
    if (file === 'claims/index.json') return 'interpretations';
    if (file === 'mechanics/reference.json') return pointer.startsWith('/sourceIdentities') ? 'provenance' : 'mechanics';
    if (file.startsWith('heroes/')) {
        if (/^\/(?:hero|abilities|activations|conditions)(?:\/|$)/.test(pointer)) return 'mechanics';
        if (/^\/(?:effects|claims)(?:\/|$)/.test(pointer)) return 'interpretations';
        if (/^\/evidence(?:\/|$)/.test(pointer)) return 'provenance';
        return 'mechanics';
    }
    return 'provenance';
}

function diffJson(before, after, pointer, visit) {
    if (stable(before) === stable(after)) return;
    if (Array.isArray(before) && Array.isArray(after)) {
        const identityRows = [...before, ...after].every(value => value && typeof value === 'object'
            && !Array.isArray(value) && typeof value.id === 'string');
        if (identityRows) {
            const left = new Map(before.map(row => [row.id, row]));
            const right = new Map(after.map(row => [row.id, row]));
            for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
                if (!left.has(id) || !right.has(id)) visit(`${pointer}/${id}`, left.get(id), right.get(id));
                else diffJson(left.get(id), right.get(id), `${pointer}/${id}`, visit);
            }
            const oldOrder = before.map(row => row.id);
            const newOrder = after.map(row => row.id);
            if (stable(oldOrder) !== stable(newOrder)) visit(`${pointer}/$order`, oldOrder, newOrder);
            return;
        }
        const length = Math.max(before.length, after.length);
        for (let index = 0; index < length; index += 1) {
            if (index >= before.length || index >= after.length) visit(`${pointer}/${index}`, before[index], after[index]);
            else diffJson(before[index], after[index], `${pointer}/${index}`, visit);
        }
        return;
    }
    if (before && after && typeof before === 'object' && typeof after === 'object'
        && !Array.isArray(before) && !Array.isArray(after)) {
        for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
            const child = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
            if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) visit(child, before[key], after[key]);
            else diffJson(before[key], after[key], child, visit);
        }
        return;
    }
    visit(pointer || '/', before, after);
}

function git(repository, args, { encoding = 'utf8', maxBuffer = 64 * 1024 * 1024 } = {}) {
    return execFileSync('git', ['-C', repository, ...args], { encoding, maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] });
}

function summarize(value) {
    if (value === undefined) return { state: 'absent' };
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    return { state: 'record', sha256: createHash('sha256').update(stable(value)).digest('hex') };
}

export function compareGraphs(before, after) {
    const changes = [];
    const add = (category, identity, pointer, left, right) => changes.push({ category, identity, pointer,
        before: summarize(left), after: summarize(right) });
    const records = (category, name, left, right) => {
        const a = new Map(left.map(row => [row.id, row]));
        const b = new Map(right.map(row => [row.id, row]));
        if (a.size !== left.length || b.size !== right.length) throw new Error('Duplicate comparison identity: ' + name);
        for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
            diffJson(a.get(id), b.get(id), '', (pointer, oldValue, newValue) => {
                const kind = name === 'heroes' && /^\/(key|sourceKey|name|aliases)(\/|$)/.test(pointer) ? 'naming' : category;
                add(kind, name + ':' + id, pointer, oldValue, newValue);
            });
        }
    };
    for (const kind of new Set([...Object.keys(before.entities), ...Object.keys(after.entities)])) {
        records('gameplay', kind, before.entities[kind] ?? [], after.entities[kind] ?? []);
    }
    records('observations', 'observations', before.observations, after.observations);
    const projections = graph => [...graph.runtimeProjection].map(([id, index]) => ({ id, fields: graph.projections[index] }));
    records('observations', 'runtimeProjection', projections(before), projections(after));
    records('reviewDecisions', 'claims', before.claims, after.claims);
    records('reviewDecisions', 'bindings', before.bindings.map(row => ({ ...row, id: row.subjectId + '#' + row.field })),
        after.bindings.map(row => ({ ...row, id: row.subjectId + '#' + row.field })));
    records('metadata', 'sources', before.sources, after.sources);
    records('metadata', 'profileHistory', before.history.map(row => ({ ...row, id: row.heroId })), after.history.map(row => ({ ...row, id: row.heroId })));
    records('metadata', 'guides', [...before.guides].map(([id, guide]) => ({ id, guide })), [...after.guides].map(([id, guide]) => ({ id, guide })));
    const header = graph => Object.fromEntries(Object.entries(graph.metadata).filter(([key]) => !['sourceFiles', 'consolidation'].includes(key)));
    diffJson(header(before), header(after), '', (pointer, a, b) => add('metadata', 'dataset', pointer, a, b));
    if (before.layoutVersion !== after.layoutVersion) add('structural', 'layout', '/', before.layoutVersion, after.layoutVersion);
    const counts = Object.fromEntries(['gameplay', 'observations', 'reviewDecisions', 'structural', 'naming', 'metadata'].map(category =>
        [category, changes.filter(change => change.category === category).length]));
    return { schemaVersion: 2, equivalent: !counts.gameplay && !counts.observations && !counts.reviewDecisions, counts,
        changeCount: changes.length, changes };
}

export async function compareWithIdentities(before, after, { repository = packageRoot } = {}) {
    const raw = compareGraphs(before, after);
    const mapping = await verifiedIdentityMapping(after, repository, verifyReplacements(after));
    if (!mapping.entries.length) return { ...raw, identityChanges: [] };
    const aligned = { ...before };
    for (const field of ['entities', 'sources', 'observations', 'claims', 'bindings', 'history', 'metadata']) aligned[field] = reconcileValue(before[field], mapping);
    aligned.guides = new Map([...before.guides].map(([key, value]) => [key, reconcileValue(value, mapping)]));
    aligned.runtimeProjection = new Map([...before.runtimeProjection].map(([id, value]) => [mapping.ids.get(id) ?? id, value]));
    const reconciled = compareGraphs(aligned, after);
    const previousIdentities = new Set([...before.sources, ...before.observations].map(record => createHash('sha256').update(record.id).digest('hex')));
    const identityChanges = mapping.entries.filter(row => previousIdentities.has(row.oldIdentitySha256));
    const expectedSignature = identityChanges.length || reconciled.changes.some(row => row.identity === 'dataset' && row.pointer === '/inputSignature')
        ? historicalInputSignature(after) : null;
    const unexplained = reconciled.changes.filter(row => {
        if (row.category !== 'metadata' || row.identity !== 'dataset') return true;
        if (row.pointer === '/inputSignature') return row.before !== mapping.generation.before.inputSignature
            || row.after !== expectedSignature;
        const field = row.pointer.slice(1);
        return !['createdAt', 'generatedAt'].includes(field) || row.before !== mapping.generation.before[field] || row.after !== mapping.generation.after[field];
    });
    if (identityChanges.length) for (const [field, expected] of Object.entries({ ...mapping.generation.after, inputSignature: expectedSignature })) {
        if (after.metadata[field] !== expected && !unexplained.some(row => row.identity === 'dataset' && row.pointer === '/' + field)) {
            unexplained.push({ category: 'metadata', identity: 'dataset', pointer: '/' + field,
                before: before.metadata[field], after: after.metadata[field], reason: 'Historical transition requires the verified generation and recomputed signature.' });
        }
    }
    return { ...reconciled, equivalent: unexplained.length === 0, raw,
        identityChanges, unexplained };
}

async function compareCurrent({ base, dataset = defaultDataset } = {}) {
    if (typeof base !== 'string' || !base.trim()) throw new Error('Pass --base <git-revision>.');
    const ref = git(packageRoot, ['rev-parse', '--verify', base + '^{commit}']).trim();
    const files = new Set(git(packageRoot, ['ls-tree', '-r', '--name-only', ref]).trim().split('\n'));
    const oldLayout = files.has('data/hero-knowledge/manifest.json');
    let before;
    if (oldLayout) {
        const read = async name => JSON.parse(git(packageRoot, ['show', ref + ':data/hero-knowledge/' + name]));
        before = await readLegacyLayout(null, { read, retainMaps: false }); before.layoutVersion = 1;
    }
    else {
        // Materialize only manifest-listed files in an owned comparison directory.
        const os = await import('node:os');
        const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-compare-'));
        try {
            const manifest = JSON.parse(git(packageRoot, ['show', ref + ':data/manifest.json']));
            for (const name of ['manifest.json', ...manifest.sourceFiles.map(row => row.name)]) {
                const { within } = await import('../src/node/canonical.mjs');
                const destination = within(temporary, name);
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.writeFile(destination, git(packageRoot, ['show', ref + ':data/' + name], { encoding: null }));
            }
            before = await readCanonical(temporary); before.layoutVersion = 2;
        }
        finally {
            if (path.dirname(await fs.realpath(temporary)) !== await fs.realpath(os.tmpdir())) throw new Error('Unsafe comparison cleanup.');
            await fs.rm(temporary, { recursive: true });
        }
    }
    const current = path.resolve(dataset);
    const manifest = JSON.parse(await fs.readFile(path.join(current, 'manifest.json')));
    const after = manifest.schemaVersion === 1 ? await readLegacyLayout(current, { retainMaps: false }) : await readCanonical(current, { verify: false });
    after.layoutVersion = manifest.schemaVersion;
    return { ...await compareWithIdentities(before, after), base: ref, dataset: path.relative(packageRoot, current).split(path.sep).join('/') };
}

function usage() {
    return `Usage: node scripts/compare-current.mjs --base <git-revision> [options]\n\nOptions:\n  --base <revision>       Git commit to compare against (required).\n  --dataset <directory>  Current dataset (default: data).\n  --help                  Print this help.\n\nReports gameplay, observations, review decisions, structural, naming, and metadata changes.`;
}

async function main() {
    const { values } = parseArgs({ options: { base: { type: 'string' }, dataset: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
    if (values.help) {
        process.stdout.write(usage());
        return;
    }
    const report = await compareCurrent({ base: values.base, dataset: values.dataset });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.equivalent) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exitCode = 1;
    });
}

export { compareCurrent, usage };

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGzip, gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hash, stable, git, within, regularFile, filesUnder, writeJson, fieldRow, leafCount,
    escapePointer, gitTree, blobHash, restoreBaseline, reserveOutput } from './consolidation/io.mjs';
import { crosswalk, parseRoster, classifyScript, observationDestination, fileDestinations,
    heroFieldDestination, pickerDataPolicy, mapPickerData } from './consolidation/policy.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const datasetName = 'data/hero-knowledge';
const focusedTests = ['tests/semantic-diff.test.mjs', 'tests/population-import.test.mjs', 'tests/store.test.mjs'];

async function ledger(output, name) {
    const stream = createGzip({ level: 6 });
    const done = pipeline(stream, createWriteStream(within(output, name), { flags: 'wx' }));
    // Attach immediately so a disk error cannot become an unhandled rejection.
    done.catch(() => {});
    return {
        async append(rows) {
            if (rows.length && !stream.write(rows.map(row => JSON.stringify(row) + '\n').join(''))) await once(stream, 'drain');
        },
        async close() { stream.end(); await done; },
        async abort() { stream.destroy(); await done.catch(() => {}); },
    };
}

function checkedDescriptor(bytes, expected, label) {
    const descriptor = { bytes: bytes.length, sha256: hash(bytes) };
    if (expected && (expected.bytes !== descriptor.bytes || expected.sha256 !== descriptor.sha256)) {
        throw new Error('Artifact integrity mismatch: ' + label);
    }
    return descriptor;
}

function countBy(rows, field) {
    const counts = {};
    for (const row of rows) counts[row[field] ?? 'unknown'] = (counts[row[field] ?? 'unknown'] ?? 0) + 1;
    return counts;
}

function imports(text) {
    return [...text.matchAll(/^import\s+(?:[^;]*?\s+from\s+)?["']([^"'\r\n]+)["']/gm)].map(match => match[1]);
}

export function pngDescriptor(bytes) {
    if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        || bytes.subarray(12, 16).toString() !== 'IHDR' || bytes.readUInt32BE(8) !== 13) {
        throw new Error('Portrait is not a PNG with an IHDR header.');
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (!width || !height) throw new Error('Portrait dimensions must be positive.');
    return { mediaType: 'image/png', width, height,
        verification: 'Signature and IHDR only; full image decoding is a Phase D gate.' };
}

async function inventoryPicker({ picker, output, heroes }) {
    const revision = git(picker, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    const scripts = (await fs.readdir(path.join(picker, 'scripts'))).filter(name => /\.(?:mjs|js|html)$/.test(name)).sort();
    const scriptRows = [];
    for (const name of scripts) {
        const bytes = await regularFile(picker, 'scripts/' + name);
        scriptRows.push({ path: 'scripts/' + name, ...classifyScript(name), imports: imports(bytes.toString('utf8')) });
    }
    const fixtures = await filesUnder(picker, 'scripts/fixtures');
    const dataFiles = await filesUnder(picker, 'public/data');
    const portraits = await filesUnder(picker, 'public/heroes');
    const support = ['src/data/heroes.ts', 'package.json', 'package-lock.json', 'NOTICE.md', 'LICENSE',
        'src/lib/dataset.ts', 'src/lib/positions.ts', 'src/lib/winModel.ts'];
    const selection = [...scripts.map(name => 'scripts/' + name), ...fixtures, ...dataFiles, ...portraits, ...support].sort();
    const entries = [];
    const data = [];
    const images = [];
    const fixtureRows = [];
    const bySlug = new Map(heroes.filter(hero => hero.providerSlug).map(hero => [hero.providerSlug, hero]));
    for (const name of selection) {
        const bytes = await regularFile(picker, name);
        const retainedFile = 'inputs/picker/' + name;
        await fs.mkdir(path.dirname(within(output, retainedFile)), { recursive: true });
        await fs.writeFile(within(output, retainedFile), bytes, { flag: 'wx' });
        const entry = { path: name, ...checkedDescriptor(bytes), retainedFile };
        if (name.startsWith('public/data/')) {
            const policy = pickerDataPolicy[path.posix.basename(name)];
            if (!policy) throw new Error('Unmapped Picker output: ' + name);
            const value = JSON.parse(bytes);
            data.push({ ...entry, provider: policy.provider, preserve: policy.preserve,
                fields: mapPickerData(path.posix.basename(name), value, heroes),
                unavailable: name.endsWith('/lanes.json') ? ['against', 'with'].filter(key => !Object.hasOwn(value, key))
                    .map(key => ({ field: key, state: 'unavailable', reason: 'Absent from selected output; collector support is not evidence of acquired data.' })) : [],
            });
        }
        else if (name.startsWith('public/heroes/')) {
            const slug = path.posix.basename(name, '.png');
            const hero = bySlug.get(slug);
            if (!hero) throw new Error('Portrait has no canonical identity: ' + name);
            images.push({ ...entry, heroId: hero.id, key: hero.key, providerSlug: slug, attribution: 'Valve Corporation; inputs/picker/NOTICE.md',
                ...pngDescriptor(bytes), destination: 'data/heroes/' + hero.key + '/images/profile.png' });
        }
        else if (name.startsWith('scripts/fixtures/')) fixtureRows.push({ ...entry,
            provider: name.endsWith('stratz-lane-outcome.json') ? 'STRATZ' : 'Dotabuff',
            destination: 'tests/population/fixtures/' + path.posix.basename(name), fate: 'move with parser tests' });
        entry.destinations = dataFiles.includes(name) ? data.at(-1).fields.map(row => row.destination)
            : portraits.includes(name) ? [images.at(-1).destination]
                : fixtures.includes(name) ? [fixtureRows.at(-1).destination]
                    : scripts.includes(path.posix.basename(name)) ? [scriptRows.find(row => row.path === name).destination]
                        : ['evidence:' + retainedFile];
        entry.destinations = [...new Set(entry.destinations)];
        entries.push(entry);
    }
    const dependencies = JSON.parse(await regularFile(picker, 'package.json'));
    const unavailable = heroes.filter(hero => !images.some(image => image.heroId === hero.id))
        .map(hero => ({ heroId: hero.id, key: hero.key, variant: 'profile', state: 'unavailable',
            reason: 'No portrait in the selected Picker inventory.', destination: 'data/heroes/' + hero.key + '/images/profile.png' }));
    unavailable.push(...['hero icons', 'ability images', 'item images'].map(kind => ({ kind, state: 'unavailable',
        reason: 'Not supplied by the selected Picker inputs; enumerate and acquire in Phase D.' })));
    return { revision, workingTreeStatus: git(picker, ['status', '--porcelain=v1', '--untracked-files=normal']).trim().split(/\r?\n/).filter(Boolean),
        entries, scripts: scriptRows, fixtures: fixtureRows, data, images, unavailable,
        dependencies: { runtime: dependencies.dependencies, development: dependencies.devDependencies,
            disposition: 'React/Vite remain application dependencies. Electron is an optional acquisition adapter; no dependency is added in Phase A.' },
        exclusions: ['scripts/.cache (unselected transient acquisitions and possible session state)', 'public/ranks and docs/assets (application presentation)'],
    };
}

function mapHeroDocument(file, document, hero) {
    const rows = [];
    for (const [section, value] of Object.entries(document)) {
        const records = Array.isArray(value) ? value : [value];
        if (!records.length) {
            rows.push(fieldRow(file, '/' + section, value, heroFieldDestination(section, '', hero.key)));
            continue;
        }
        for (const [index, record] of records.entries()) {
            const pointer = '/' + section + (Array.isArray(value) ? '/' + index : '');
            if (!record || typeof record !== 'object' || !Object.keys(record).length) throw new Error('Unexpected hero record: ' + file + pointer);
            for (const [field, child] of Object.entries(record)) rows.push(fieldRow(file, pointer + '/' + escapePointer(field), child,
                heroFieldDestination(section, field, hero.key), record.id ?? hero.id));
        }
    }
    return rows;
}

function observationSummary(record, file, pointer, destination, sources) {
    const source = sources.get(record.sourceId);
    const metadata = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'sourceRecord'));
    return { file, pointer, destination, ...metadata,
        semanticSha256: hash(stable(record)),
        sourceContext: source ? { sourceId: source.id, sourceRevision: source.commit ?? source.revision ?? null,
            retrievedAt: source.retrievedAt ?? null, observedAt: source.observedAt ?? null,
            period: source.period ?? null, cohort: source.cohort ?? null } : { state: 'unavailable', reason: 'Record has no linked source identity.' },
        historicalRanks: record.kind === 'historical-profile' ? Object.keys(record.sourceRecord?.ranks ?? {}) : undefined,
        sourceRecord: record.sourceRecord === undefined ? { state: 'absent' } : {
            pointer: pointer + '/sourceRecord', semanticSha256: hash(stable(record.sourceRecord)), leaves: leafCount(record.sourceRecord) },
    };
}

export async function captureBaseline({ repository = packageRoot, picker = path.resolve(packageRoot, '../dotabuff-picker'),
    output, base = 'HEAD', measure = true } = {}) {
    const current = await fs.readFile(path.join(repository, 'data/manifest.json')).catch(error => {
        if (error.code === 'ENOENT') return null; throw error;
    });
    if (current && JSON.parse(current).schemaVersion === 2) {
        const { captureCanonicalAudit } = await import('./consolidation/canonical-audit.mjs');
        return captureCanonicalAudit({ repository, output, measure });
    }
    repository = await fs.realpath(repository);
    picker = await fs.realpath(picker);
    if (path.resolve(git(repository, ['rev-parse', '--show-toplevel']).trim()) !== repository) throw new Error('Library must be an independent Git root.');
    const revision = git(repository, ['rev-parse', '--verify', base + '^{commit}']).trim();
    const tree = gitTree(repository, revision);
    const committed = new Map(tree.map(entry => [entry.name, entry]));
    const startedAt = new Date().toISOString();
    output = path.resolve(output ?? path.join(repository, 'evidence/consolidation/phase-a-' + startedAt.replace(/[:.]/g, '-') + '-' + revision.slice(0, 12)));
    // New output only: a failed or previous capture is never erased or overwritten.
    output = await reserveOutput(repository, picker, output);
    const baselineStatus = git(repository, ['status', '--porcelain=v1', '--untracked-files=normal']).trim().split(/\r?\n/).filter(Boolean);
    const dataset = within(repository, datasetName);
    const canonicalManifest = JSON.parse(await regularFile(dataset, 'manifest.json'));
    const runtimeManifest = JSON.parse(await regularFile(dataset, 'runtime/manifest.json'));
    const core = JSON.parse(await regularFile(dataset, 'runtime/core.json'));
    const roster = parseRoster((await regularFile(picker, 'src/data/heroes.ts')).toString('utf8'));
    const heroes = crosswalk(core.entities.heroes, roster);
    const byId = new Map(heroes.map(hero => [hero.id, hero]));
    const sourceRows = JSON.parse(await regularFile(dataset, 'sources.json'));
    const sources = new Map(sourceRows.map(row => [row.id, row]));
    const reconciliation = JSON.parse(await regularFile(dataset, 'reconciliation/index.json'));
    const inventory = [];
    const descriptors = new Map(canonicalManifest.sourceFiles.map(row => [row.name, row]));
    for (const descriptor of [runtimeManifest.core, ...Object.values(runtimeManifest.guides), ...runtimeManifest.observationShards]) {
        const name = 'runtime/' + descriptor.name;
        within(dataset, name);
        const existing = descriptors.get(name);
        if (existing && (existing.sha256 !== descriptor.sha256 || existing.bytes !== descriptor.bytes)) throw new Error('Manifest disagreement: ' + name);
        descriptors.set(name, descriptor);
    }
    const names = await filesUnder(dataset);
    for (const name of descriptors.keys()) if (!names.includes(name)) throw new Error('Missing manifest artifact: ' + name);
    for (const name of names) {
        const bytes = await regularFile(dataset, name);
        const libraryPath = datasetName + '/' + name;
        const entry = committed.get(libraryPath);
        const matchesCommit = Boolean(entry && blobHash(bytes, entry.oid) === entry.oid);
        let retained = { archive: 'baseline.tar.gz', member: libraryPath };
        if (!matchesCommit) {
            const file = 'inputs/library/' + libraryPath;
            await fs.mkdir(path.dirname(within(output, file)), { recursive: true });
            await fs.writeFile(within(output, file), bytes, { flag: 'wx' });
            retained = { file };
        }
        inventory.push({ path: libraryPath, ...checkedDescriptor(bytes, descriptors.get(name), name),
            matchesCommit, retained, destinations: fileDestinations(name, byId) });
    }
    const checks = [];
    for (const args of [['--test', ...focusedTests], ['scripts/check-schemas.mjs']]) {
        execFileSync(process.execPath, args, { cwd: repository, windowsHide: true, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        checks.push({ command: 'node ' + args.join(' '), exitCode: 0, stage: 'before migration' });
    }
    const recovery = await restoreBaseline({ repository, revision, archive: within(output, 'baseline.tar.gz'), entries: tree });
    await writeJson(output, 'recovery.json', recovery);
    const pickerInventory = await inventoryPicker({ picker, output, heroes });
    await writeJson(output, 'picker.json', pickerInventory);
    await writeJson(output, 'heroes.json', heroes);
    await writeJson(output, 'files.json', inventory);

    const fields = await ledger(output, 'fields.jsonl.gz');
    const observations = await ledger(output, 'observations.jsonl.gz');
    const reviews = await ledger(output, 'reviews.jsonl.gz');
    const candidates = await ledger(output, 'profile-candidates.jsonl.gz');
    const fileCoverage = [];
    const observationIds = new Set();
    const observationCounts = {};
    const cohortGroups = new Map();
    const legacyIds = new Set([...core.sources, ...core.claims, ...Object.values(core.entities).flat()]
        .map(row => row.id).filter(id => /dotafix/i.test(id)));
    const aliases = new Map();
    let observationOccurrences = 0;
    let claimOccurrences = 0;
    let mappedLeaves = 0;
    try {
        for (const name of names.filter(name => name.endsWith('.json') && !name.startsWith('reconciliation/'))) {
            const file = datasetName + '/' + name;
            const document = JSON.parse(await regularFile(dataset, name));
            let rows;
            let match;
            if ((match = /^heroes\/(\d+)\.json$/.exec(name))) {
                const hero = byId.get(match[1]);
                if (document.hero.id !== hero.id || document.hero.key !== hero.key) throw new Error('Canonical/core identity disagreement: ' + file);
                rows = mapHeroDocument(file, document, hero);
                await reviews.append(document.claims.map((claim, index) => ({ file, pointer: '/claims/' + index,
                    destination: 'data/reviews/claims.json', ...claim })));
                claimOccurrences += document.claims.length;
            }
            else if (name === 'observations/index.json' || /^observations\/heroes\/(\d+)\.json$/.test(name)) {
                const records = Array.isArray(document) ? document : document.observations;
                rows = [];
                const details = [];
                for (const [index, record] of records.entries()) {
                    const pointer = (Array.isArray(document) ? '' : '/observations') + '/' + index;
                    const destination = observationDestination(record, byId);
                    rows.push(fieldRow(file, pointer, record, destination, record.id));
                    details.push(observationSummary(record, file, pointer, destination, sources));
                    if (!observationIds.has(record.id)) observationCounts[record.kind] = (observationCounts[record.kind] ?? 0) + 1;
                    observationIds.add(record.id);
                    observationOccurrences += 1;
                    if (/dotafix/i.test(record.id)) legacyIds.add(record.id);
                    const group = { kind: record.kind, sourceId: record.sourceId ?? null, cohortId: record.cohortId ?? null,
                        cohort: record.cohort ?? null, observedAt: record.observedAt ?? null, direction: record.direction ?? null };
                    const groupKey = stable(group);
                    const prior = cohortGroups.get(groupKey) ?? { ...group, occurrences: 0 };
                    prior.occurrences += 1;
                    cohortGroups.set(groupKey, prior);
                    if (record.kind === 'historical-profile') {
                        await candidates.append(Object.entries(record.sourceRecord ?? {}).map(([field, value]) => ({
                            ...fieldRow(file, pointer + '/sourceRecord/' + escapePointer(field), value,
                                field === 'ranks' ? destination : 'data/heroes/' + byId.get(record.heroId).key + '/profile.json', record.id),
                            resolution: 'Candidate only; historical ranks remain observations, static disagreements require explicit resolution.',
                        })));
                        for (const alias of record.sourceRecord?.aliases ?? []) {
                            const normalized = alias.trim().toLowerCase().replace(/\s+/g, ' ');
                            if (!aliases.has(normalized)) aliases.set(normalized, new Set());
                            aliases.get(normalized).add(byId.get(record.heroId).key);
                        }
                    }
                }
                if (!records.length) rows.push(fieldRow(file, Array.isArray(document) ? '' : '/observations', [], fileDestinations(name, byId)));
                await observations.append(details);
            }
            else if ((match = /^runtime\/guides\/(\d+)\.json$/.exec(name))) {
                const hero = byId.get(match[1]);
                rows = Object.entries(document).map(([field, value]) => fieldRow(file, '/' + escapePointer(field), value,
                    field === 'claims' || field === 'externalClaims' ? 'data/reviews/claims.json'
                        : ['sourceIdentities', 'liquipediaSource', 'officialDataset'].includes(field) ? 'data/reviews/sources.json'
                            : ['schemaVersion', 'version', 'createdAt', 'coreSha256'].includes(field) ? 'data/runtime/manifest.json'
                                : 'data/heroes/' + hero.key + '/guides/details.json', hero.id));
                for (const field of ['AttributePrimary', 'AttackRange', 'Complexity', 'Role', 'Rolelevels']) {
                    const value = document.native?.nativeStats?.[field];
                    if (value !== undefined) await candidates.append([{ ...fieldRow(file, '/native/nativeStats/' + field, value,
                        'data/heroes/' + hero.key + '/profile.json', hero.id), resolution: 'Preserve typed state and native declaration; provenance moves to review/evidence.' }]);
                }
            }
            else rows = [fieldRow(file, '', document, fileDestinations(name, byId))];
            const total = leafCount(document);
            const covered = rows.reduce((sum, row) => sum + row.leaves, 0);
            if (total !== covered) throw new Error('Incomplete field coverage: ' + file);
            mappedLeaves += covered;
            fileCoverage.push({ file, leaves: total, coveredLeaves: covered, mappingRows: rows.length });
            await fields.append(rows);
        }
        await Promise.all([fields.close(), observations.close(), reviews.close(), candidates.close()]);
    }
    catch (error) {
        await Promise.all([fields.abort(), observations.abort(), reviews.abort(), candidates.abort()]);
        throw error;
    }

    const evidence = [];
    const evidenceNames = new Set([reconciliation.evidenceManifest, ...reconciliation.sourceBundles.map(row => row.evidenceFile),
        ...reconciliation.recoveredNativeSources.map(row => row.evidenceFile),
        ...reconciliation.pickerSnapshots.filter(row => row.evidenceFile).map(row => row.evidenceFile)]);
    for (const name of [...evidenceNames].sort()) {
        evidence.push({ path: name, ...checkedDescriptor(await regularFile(repository, name)), disposition: 'retain immutable original bytes in place' });
    }
    const inherited = [];
    for (const bundle of reconciliation.sourceBundles) {
        const bytes = await regularFile(dataset, bundle.fieldFile);
        const map = JSON.parse(bundle.fieldFile.endsWith('.gz') ? gunzipSync(bytes) : bytes);
        const destinations = [...new Set(map.fields.flatMap(row => row.canonicalTargets))];
        inherited.push({ ...bundle, fieldMapSha256: hash(bytes), preservation: 'Every original field pointer remains resolvable in retained evidence.',
            targets: destinations.map(target => {
                const [filename, pointer = ''] = target.split('#');
                return { old: target, new: filename.includes('{heroId}')
                    ? heroes.map(hero => ({ heroId: hero.id, destinations: fileDestinations(filename.replace('{heroId}', hero.id), byId), pointer }))
                    : [{ destinations: fileDestinations(filename, byId), pointer }] };
            }),
        });
    }
    await writeJson(output, 'evidence.json', { files: evidence, inheritedFieldMaps: inherited,
        originalCoverage: reconciliation.coverage, unavailableOriginals: reconciliation.unavailableOriginals,
        pickerSnapshots: reconciliation.pickerSnapshots });
    const aliasRows = [...aliases].sort(([a], [b]) => a.localeCompare(b)).map(([alias, keys]) => ({ alias, keys: [...keys].sort() }));
    await writeJson(output, 'aliases.json', { normalization: 'trim + lowercase + collapse whitespace; candidate-only',
        entries: aliasRows, collisions: aliasRows.filter(row => row.keys.length > 1) });
    await writeJson(output, 'identities.json', {
        policy: 'Preserve every stable identity. No legacy ID rename is authorized by Phase A.',
        explicitRenames: [], legacyNameCandidates: [...legacyIds].sort().map(id => ({ oldId: id, newId: id, disposition: 'preserve until an explicit Phase F mapping is accepted' })),
        entities: Object.fromEntries(Object.entries(core.entities).map(([kind, records]) => [kind, records.map(record => record.id)])),
        claims: core.claims.map(record => record.id), observationIds: [...observationIds].sort(),
    });
    await writeJson(output, 'cohorts.json', [...cohortGroups.values()]);
    await writeJson(output, 'coverage.json', { mappedLeaves, files: fileCoverage, unassignedInputs: [],
        mappingSemantics: 'A pointer covers its complete subtree including ordered arrays and empty containers. Destination filenames are planned; original snapshots and stable identities remain authoritative until Phase B reconciliation.' });
    let performanceBaseline = null;
    if (measure) {
        performanceBaseline = JSON.parse(execFileSync(process.execPath, ['--expose-gc',
            path.join(packageRoot, 'scripts/consolidation/measure.mjs'), path.join(dataset, 'runtime/manifest.json')],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
        await writeJson(output, 'performance.json', performanceBaseline);
    }
    // Re-read only selected inputs. Concurrent edits abort the capture instead of certifying mixed revisions.
    for (const entry of inventory) checkedDescriptor(await regularFile(repository, entry.path), entry, entry.path);
    for (const entry of pickerInventory.entries) checkedDescriptor(await regularFile(picker, entry.path), entry, entry.path);
    for (const entry of evidence) checkedDescriptor(await regularFile(repository, entry.path), entry, entry.path);
    const counts = Object.fromEntries(Object.entries(core.entities).map(([kind, records]) => [kind, records.length]));
    const tooling = [];
    for (const name of ['scripts/audit-consolidation.mjs', 'scripts/consolidation/io.mjs', 'scripts/consolidation/policy.mjs', 'scripts/consolidation/measure.mjs']) {
        const bytes = await regularFile(packageRoot, name);
        const retainedFile = 'inputs/tooling/' + name;
        await fs.mkdir(path.dirname(within(output, retainedFile)), { recursive: true });
        await fs.writeFile(within(output, retainedFile), bytes, { flag: 'wx' });
        tooling.push({ path: name, retainedFile, ...checkedDescriptor(bytes) });
    }
    const report = { schemaVersion: 1, auditVersion: 'consolidation-phase-a-1', phase: 'A', state: 'complete', startedAt, completedAt: new Date().toISOString(),
        libraryRevision: revision, pickerRevision: pickerInventory.revision, workingTreeStatus: baselineStatus,
        canonicalManifest: inventory.find(row => row.path === datasetName + '/manifest.json'),
        runtimeManifest: inventory.find(row => row.path === datasetName + '/runtime/manifest.json'),
        core: inventory.find(row => row.path === datasetName + '/runtime/core.json'),
        counts: { ...counts, claims: core.claims.length, sources: core.sources.length, indexedObservations: core.observations.length,
            uniqueObservations: observationIds.size, observationOccurrences, detailedClaimOccurrences: claimOccurrences,
            observationKinds: observationCounts, reviewStatuses: countBy(core.claims, 'status'),
            pickerScripts: pickerInventory.scripts.length, pickerFixtures: pickerInventory.fixtures.length,
            pickerDataOutputs: pickerInventory.data.length, portraits: pickerInventory.images.length },
        sizes: { canonicalAndRuntimeBytes: inventory.reduce((sum, row) => sum + row.bytes, 0),
            runtimeBytes: inventory.filter(row => row.path.startsWith(datasetName + '/runtime/')).reduce((sum, row) => sum + row.bytes, 0),
            pickerBytes: pickerInventory.entries.reduce((sum, row) => sum + row.bytes, 0) },
        checks, tooling, recovery: 'recovery.json', performance: performanceBaseline ? 'performance.json' : { state: 'not measured' },
        gate: { unassignedInputs: 0, canonicalFiles: inventory.length, mappedLeaves,
            originalFieldPaths: reconciliation.coverage.selectedFieldPaths, originalFieldOccurrences: reconciliation.coverage.selectedBundleFields,
            limitation: 'Destination contract only. This does not establish migration parity, collector parity, image decoding or asset completeness.' },
        artifacts: ['files.json', 'heroes.json', 'identities.json', 'aliases.json', 'picker.json', 'evidence.json',
            'coverage.json', 'cohorts.json', 'fields.jsonl.gz', 'observations.jsonl.gz', 'reviews.jsonl.gz', 'profile-candidates.jsonl.gz', 'recovery.json'],
    };
    await writeJson(output, 'index.json', report);
    return { output, report };
}

async function main() {
    const { values } = parseArgs({ options: { picker: { type: 'string' }, output: { type: 'string' }, base: { type: 'string' },
        'skip-measurement': { type: 'boolean' }, 'legacy-archive': { type: 'string' }, help: { type: 'boolean' } }, strict: true });
    if (values.help) {
        process.stdout.write('Usage: node scripts/audit-consolidation.mjs [--output <new-directory>] [--skip-measurement] [--legacy-archive <phase-a-directory>] [--picker <checkout>] [--base <v1-revision>]\nOffline version-aware capture: canonical v2 by default, or reproduce Phase A using its verified archive and saved tooling. Existing outputs are never overwritten.\n');
        return;
    }
    const { output, report } = values['legacy-archive']
        ? await import('./consolidation/canonical-audit.mjs').then(module => module.reproducePhaseA({ audit: values['legacy-archive'], picker: values.picker,
            output: values.output, measure: !values['skip-measurement'] }))
        : await captureBaseline({ picker: values.picker, output: values.output, base: values.base, measure: !values['skip-measurement'] });
    process.stdout.write(JSON.stringify({ output: path.relative(packageRoot, output).split(path.sep).join('/'),
        revision: report.libraryRevision, counts: report.counts, gate: report.gate }, null, 2) + '\n');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => { process.stderr.write((error.stack ?? error) + '\n'); process.exitCode = 1; });
}

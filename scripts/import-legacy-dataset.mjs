import fs from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/sha256.mjs';
import { importLegacyKnowledge } from '../src/legacy-import.mjs';
import { writeCanonical, verifyManifest } from '../src/node/canonical.mjs';
import { publishDataset } from '../src/node/publish-dataset.mjs';
import { validateDataset } from './consolidation/validation.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = path.join(packageRoot, 'data');
const decoder = new TextDecoder('utf-8', { fatal: true });

function usage() {
    return `Usage: node scripts/import-legacy-dataset.mjs --mechanics <catalog-directory> --evidence <evidence-directory> [options]

Options:
  --mechanics <directory>   Selected mechanics catalog and annotations.
  --evidence <directory>    Selected compiled external evidence and hero guides.
  --output <directory>      Empty output directory (default: data).
  --version <label>         Stable current dataset label (default: knowledge-6957-current).
  --generated-at <date>     Reproducible generation time. Defaults to the UTC clock.
  --previous <manifest>     Prior canonical manifest (defaults to the output manifest when present).
  --replace                 Atomically replace an existing generated output directory.
  --help                    Print this help.

The importer preserves compiled records and source identities. It does not
reconstruct missing provider response bytes or refresh acquisition dates.`;
}

function parseJson(bytes, label) {
    try {
        return JSON.parse(decoder.decode(bytes));
    }
    catch (error) {
        throw new Error(`${label} is not valid UTF-8 JSON.`, { cause: error });
    }
}

async function readJson(filename, label = path.basename(filename)) {
    const bytes = await fs.readFile(filename);
    return { bytes, value: parseJson(bytes, label) };
}

function checkedRelative(root, name) {
    if (typeof name !== 'string' || !name || name.includes('\\') || path.isAbsolute(name)
        || name.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Input manifest contains an unsafe file name.');
    }
    const resolved = path.resolve(root, ...name.split('/'));
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Input manifest file escapes its bundle.');
    }
    return resolved;
}

async function verifiedBundleFile(root, manifest, name) {
    const descriptor = manifest.files?.find(file => file.name === name);
    if (!descriptor || descriptor.bytes !== undefined && (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1)
        || !/^[a-f0-9]{64}$/.test(descriptor.sha256 || '')) {
        throw new Error(`Input manifest has no valid checksum for ${name}.`);
    }
    const bytes = await fs.readFile(checkedRelative(root, descriptor.name));
    if (bytes.byteLength < 1 || bytes.byteLength > 256 * 1024 * 1024
        || descriptor.bytes !== undefined && bytes.byteLength !== descriptor.bytes
        || sha256Hex(bytes) !== descriptor.sha256) {
        throw new Error(`Input checksum mismatch for ${name}.`);
    }
    return { bytes, value: parseJson(bytes, name) };
}

async function collectInputs(mechanicsDirectory, evidenceDirectory) {
    const mechanicsRoot = path.resolve(mechanicsDirectory);
    const evidenceRoot = path.resolve(evidenceDirectory);
    const mechanicsManifestFile = await readJson(path.join(mechanicsRoot, 'hero_mechanics_manifest.json'));
    const externalManifestFile = await readJson(path.join(evidenceRoot, 'draft_evidence_manifest.json'));
    const mechanicsManifest = mechanicsManifestFile.value;
    const externalManifest = externalManifestFile.value;
    if (mechanicsManifest.schemaVersion !== 1 || externalManifest.schemaVersion !== 1
        || !Array.isArray(mechanicsManifest.files) || !Array.isArray(externalManifest.files)) {
        throw new Error('Input bundles use an unsupported manifest schema.');
    }
    const [mechanics, annotations, browserCatalog, externalEvidence] = await Promise.all([
        verifiedBundleFile(mechanicsRoot, mechanicsManifest, 'hero_mechanics.json'),
        verifiedBundleFile(mechanicsRoot, mechanicsManifest, 'hero_mechanics_annotations.json'),
        verifiedBundleFile(mechanicsRoot, mechanicsManifest, 'hero_mechanics_browser.json'),
        verifiedBundleFile(evidenceRoot, externalManifest, 'draft_evidence.json'),
    ]);
    if (externalManifest.version !== externalEvidence.value.version
        || externalManifest.createdAt !== externalEvidence.value.createdAt) {
        throw new Error('External evidence manifest and payload identity differ.');
    }
    const heroGuides = new Map();
    const heroGuideBytes = new Map();
    const guideHashes = new Map();
    const guideDescriptors = externalManifest.mechanicsKnowledge?.heroes ?? {};
    const heroIds = Object.keys(guideDescriptors).sort((left, right) => Number(left) - Number(right));
    for (const heroId of heroIds) {
        const descriptor = guideDescriptors[heroId];
        const expected = `hero_mechanics/${heroId}.json`;
        if (descriptor.name !== expected || !Number.isSafeInteger(descriptor.bytes)
            || descriptor.bytes < 1 || descriptor.bytes > 16 * 1024 * 1024
            || !/^[a-f0-9]{64}$/.test(descriptor.sha256 || '')) {
            throw new Error(`Input manifest has an invalid hero guide for ${heroId}.`);
        }
        const bytes = await fs.readFile(checkedRelative(evidenceRoot, descriptor.name));
        if (bytes.byteLength !== descriptor.bytes || sha256Hex(bytes) !== descriptor.sha256) {
            throw new Error(`Input checksum mismatch for ${expected}.`);
        }
        heroGuides.set(heroId, parseJson(bytes, expected));
        heroGuideBytes.set(heroId, bytes);
        guideHashes.set(heroId, descriptor.sha256);
    }
    if (heroIds.length !== browserCatalog.value.heroes?.length) {
        throw new Error('External hero guides and the selected mechanics roster differ.');
    }
    return { mechanics: mechanics.value, annotations: annotations.value, browserCatalog: browserCatalog.value,
        externalEvidence: externalEvidence.value, heroGuides,
        sourceBytes: { mechanics: mechanics.bytes, annotations: annotations.bytes,
            browserCatalog: browserCatalog.bytes, externalEvidence: externalEvidence.bytes,
            mechanicsManifest: mechanicsManifestFile.bytes, externalManifest: externalManifestFile.bytes,
            heroGuides: heroGuideBytes },
        inputFiles: { mechanics: mechanicsManifest, external: externalManifest }, guideHashes };
}

function jsonBytes(value) {
    return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function descriptor(name, bytes) {
    return { name, bytes: bytes.byteLength, sha256: sha256Hex(bytes) };
}

async function writeOrVerifyEvidence(filename, bytes, label) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    try {
        await fs.writeFile(filename, bytes, { flag: 'wx' });
    }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await fs.readFile(filename);
        if (sha256Hex(existing) !== sha256Hex(bytes) || existing.byteLength !== bytes.byteLength) {
            throw new Error(`Persistent evidence ${label} differs from its recorded hash.`);
        }
    }
}

async function persistLegacyInputs(inputs, inputSignature) {
    const evidenceRoot = path.join(packageRoot, 'evidence', 'legacy-inputs', inputSignature);
    const files = [
        ['mechanics/hero_mechanics_manifest.json', inputs.sourceBytes.mechanicsManifest],
        ['mechanics/hero_mechanics.json', inputs.sourceBytes.mechanics],
        ['mechanics/hero_mechanics_annotations.json', inputs.sourceBytes.annotations],
        ['mechanics/hero_mechanics_browser.json', inputs.sourceBytes.browserCatalog],
        ['external/draft_evidence_manifest.json', inputs.sourceBytes.externalManifest],
        ['external/draft_evidence.json', inputs.sourceBytes.externalEvidence],
        ...[...inputs.sourceBytes.heroGuides].map(([heroId, bytes]) => [`external/hero_mechanics/${heroId}.json`, bytes]),
    ];
    const descriptors = [];
    for (const [name, bytes] of files) {
        if (!(bytes instanceof Uint8Array)) throw new Error(`Missing original legacy input bytes for ${name}.`);
        await writeOrVerifyEvidence(path.join(evidenceRoot, ...name.split('/')), bytes, name);
        descriptors.push(descriptor(name, bytes));
    }
    const evidenceManifest = { schemaVersion: 1, inputSignature, storedAt: new Date().toISOString(),
        selectedMechanicsManifest: inputs.inputFiles.mechanics, selectedExternalManifest: inputs.inputFiles.external,
        files: descriptors.sort((left, right) => left.name.localeCompare(right.name)) };
    const manifestPath = path.join(evidenceRoot, 'manifest.json');
    try {
        const existing = (await readJson(manifestPath, 'persistent evidence manifest')).value;
        if (existing.inputSignature !== inputSignature
            || JSON.stringify(existing.files) !== JSON.stringify(evidenceManifest.files)) {
            throw new Error('Persistent evidence manifest differs from the current imported sources.');
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await writeOrVerifyEvidence(manifestPath, jsonBytes(evidenceManifest), 'manifest.json');
    }
    return path.relative(packageRoot, evidenceRoot).split(path.sep).join('/');
}

function inputFieldPaths(value, pointer = '#') {
    const counts = new Map();
    const add = currentPointer => counts.set(currentPointer, (counts.get(currentPointer) ?? 0) + 1);
    const visit = (current, currentPointer, record) => {
        if (record) add(currentPointer);
        if (Array.isArray(current)) {
            current.forEach(child => visit(child, `${currentPointer}/*`, true));
            return;
        }
        if (current !== null && typeof current === 'object') {
            for (const [key, child] of Object.entries(current)) {
                visit(child, `${currentPointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, true);
            }
            return;
        }
    };
    visit(value, pointer, false);
    return [...counts].map(([sourcePath, occurrences]) => ({ sourcePath, occurrences }))
        .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function reconciliationClaims(inputs) {
    const uniqueClaims = new Map();
    const add = ({ identity, category, sourcePath, targetClaimId, value, status }) => {
        const hash = sha256Hex(new TextEncoder().encode(JSON.stringify({ category, value })));
        const prior = uniqueClaims.get(hash) ?? { claimHash: hash, category, status,
            sourceOccurrences: [], targetClaimIds: [] };
        prior.sourceOccurrences.push({ identity, sourcePath });
        if (targetClaimId && !prior.targetClaimIds.includes(targetClaimId)) prior.targetClaimIds.push(targetClaimId);
        uniqueClaims.set(hash, prior);
    };
    for (const [index, effect] of (inputs.annotations.effects ?? []).entries()) {
        add({ identity: 'reviewed-annotations', category: 'mechanics-interpretation', sourcePath: `#/effects/${index}`,
            targetClaimId: `claim:review:${effect.effectId}`, value: effect, status: effect.review?.status ?? 'unknown' });
    }
    for (const [heroId, hero] of Object.entries(inputs.externalEvidence.heroes ?? {})) {
        for (const [category, claims] of Object.entries(hero.claims ?? {})) {
            for (const [index, value] of (Array.isArray(claims) ? claims : []).entries()) {
                add({ identity: 'compiled-provider-evidence', category: `provider-${category}`,
                    sourcePath: `#/heroes/${heroId}/claims/${category}/${index}`,
                    targetClaimId: `claim:provider:${heroId}:${category}:${index}`, value, status: 'proposed' });
            }
        }
        if (hero.dotafixProfile) add({ identity: 'compiled-provider-evidence', category: 'historical-dotafix-profile',
            sourcePath: `#/heroes/${heroId}/dotafixProfile`, targetClaimId: `observation:${heroId}:dotafixProfile`,
            value: hero.dotafixProfile, status: 'historical-unreviewed' });
    }
    return [...uniqueClaims.values()].map(row => ({ ...row,
        sourceOccurrences: row.sourceOccurrences.sort((left, right) => `${left.identity}:${left.sourcePath}`.localeCompare(`${right.identity}:${right.sourcePath}`)),
        targetClaimIds: row.targetClaimIds.sort() })).sort((left, right) => left.claimHash.localeCompare(right.claimHash));
}

async function writeReconciliation(stage, inputs, migrated, evidenceRoot, inputSignature) {
    const sources = [
        { id: 'mechanics-manifest', file: 'mechanics/hero_mechanics_manifest.json', value: inputs.inputFiles.mechanics,
            targets: ['runtime/manifest.json#/sourceIdentities', 'observations/sources.json#/'] },
        { id: 'mechanics', file: 'mechanics/hero_mechanics.json', value: inputs.mechanics,
            targets: ['heroes/{heroKey}/abilities.json#/abilities', 'mechanics/reference.json#/entities'] },
        { id: 'annotations', file: 'mechanics/hero_mechanics_annotations.json', value: inputs.annotations,
            targets: ['reviews/claims.json#/claims', 'runtime/heroes/{heroKey}/guide.json#/claims'] },
        { id: 'browser-catalog', file: 'mechanics/hero_mechanics_browser.json', value: inputs.browserCatalog,
            targets: ['runtime/core.json#/entities/effects', 'heroes/{heroKey}/mechanics.json#/effects'] },
        { id: 'external-manifest', file: 'external/draft_evidence_manifest.json', value: inputs.inputFiles.external,
            targets: ['runtime/manifest.json#/sourceIdentities', 'observations/sources.json#/'] },
        { id: 'external-evidence', file: 'external/draft_evidence.json', value: inputs.externalEvidence,
            targets: ['observations/index.json#/entries', 'runtime/heroes/{heroKey}/observations.json#/observations', 'runtime/heroes/{heroKey}/guide.json#/'] },
        ...[...inputs.heroGuides].map(([heroId, value]) => ({ id: `hero-guide-${heroId}`,
            file: `external/hero_mechanics/${heroId}.json`, value,
            targets: [`heroes/${migrated.graph.entities.heroes.find(hero => hero.id === heroId).key}/guides/details.json#/native`, 'reviews/bindings.json#/bindings'] })),
    ];
    const fieldFiles = [];
    const inputBytes = {
        'mechanics-manifest': inputs.sourceBytes.mechanicsManifest,
        mechanics: inputs.sourceBytes.mechanics,
        annotations: inputs.sourceBytes.annotations,
        'browser-catalog': inputs.sourceBytes.browserCatalog,
        'external-manifest': inputs.sourceBytes.externalManifest,
        'external-evidence': inputs.sourceBytes.externalEvidence,
    };
    const fieldsBySource = new Map();
    for (const source of sources) {
        const inputFields = inputFieldPaths(source.value);
        const fields = inputFields.map(({ sourcePath, occurrences }) => ({ sourcePath,
            evidenceFile: `${evidenceRoot}/${source.file}`,
            evidencePointer: sourcePath,
            occurrences,
            preservation: 'retained-byte-for-byte', canonicalTargets: source.targets }));
        fieldsBySource.set(source.id, fields);
        const name = `reconciliation/fields/${source.id}.json.gz`;
        const sourceBytes = source.id.startsWith('hero-guide-')
            ? inputs.sourceBytes.heroGuides.get(source.id.slice('hero-guide-'.length))
            : inputBytes[source.id];
        if (!(sourceBytes instanceof Uint8Array)) throw new Error(`Missing source bytes for reconciliation bundle ${source.id}.`);
        const fieldInventory = { schemaVersion: 1, inputSignature,
            sourceBundle: source.id, evidenceFile: `${evidenceRoot}/${source.file}`,
            evidenceSha256: sha256Hex(sourceBytes),
            fieldCount: fields.length, fieldOccurrences: fields.reduce((total, field) => total + field.occurrences, 0), fields };
        const fieldBytes = gzipSync(jsonBytes(fieldInventory), { level: 9, mtime: 0 });
        await fs.mkdir(path.dirname(path.join(stage, name)), { recursive: true });
        await fs.writeFile(path.join(stage, name), fieldBytes, { flag: 'wx' });
        const artifact = descriptor(name, fieldBytes);
        fieldFiles.push(artifact);
    }
    const nativeSourceRows = migrated.core.sources.filter(source => source.sourceKind === 'installed-game-resource')
        .map(source => ({ id: source.id, resource: source.resource, sha256: source.sha256 }))
        .sort((left, right) => left.id.localeCompare(right.id));
    const nativeRecoveryIdentity = sha256Hex(new TextEncoder().encode(JSON.stringify(nativeSourceRows)));
    const nativeRegistryPath = path.join(packageRoot, 'evidence', 'native-vpk', nativeRecoveryIdentity, 'manifest.json');
    let nativeRegistry = null;
    try {
        nativeRegistry = (await readJson(nativeRegistryPath, 'verified VPK recovery manifest')).value;
        if (nativeRegistry.sourceIdentity !== nativeRecoveryIdentity) throw new Error('Verified VPK recovery manifest has a different source identity.');
    }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const nativeRecoveryById = new Map((nativeRegistry?.records ?? []).map(record => [record.id, record]));
    const recoveredNativeSources = [];
    const unavailableOriginals = [];
    for (const source of nativeSourceRows) {
        const recovered = nativeRecoveryById.get(source.id);
        if (recovered?.state === 'recovered-hash-verified' && recovered.resource === source.resource
            && recovered.sha256 === source.sha256 && typeof recovered.evidenceFile === 'string') {
            const evidenceBytes = await fs.readFile(checkedRelative(packageRoot, recovered.evidenceFile));
            if (evidenceBytes.byteLength !== recovered.bytes || sha256Hex(evidenceBytes) !== source.sha256) {
                throw new Error(`Recovered native evidence failed digest verification: ${source.resource}`);
            }
            recoveredNativeSources.push({ sourceId: source.id, resource: source.resource, sha256: source.sha256,
                bytes: evidenceBytes.byteLength, evidenceFile: recovered.evidenceFile,
                recoveredAt: nativeRegistry.recoveredAt, state: 'recovered-hash-verified' });
        }
        else unavailableOriginals.push({ sourceId: source.id, resource: source.resource, recordedSha256: source.sha256 ?? null,
            state: 'original-bytes-unavailable', reason: recovered?.reason ?? 'The installed VPK bytes have not been recovered; any recovered bytes are accepted only after matching the recorded SHA-256.' });
    }

    const pickerSourceRows = migrated.core.sources.filter(source => source.id.startsWith('source:picker-'))
        .map(source => ({ id: source.id, repo: source.repo ?? null, revision: source.commit ?? source.revision ?? null,
            resource: source.resource, sha256: source.sha256 }))
        .sort((left, right) => left.id.localeCompare(right.id));
    const pickerRecoveryIdentity = sha256Hex(new TextEncoder().encode(JSON.stringify(pickerSourceRows)));
    const pickerRegistryPath = path.join(packageRoot, 'evidence', 'picker-snapshots', pickerRecoveryIdentity, 'manifest.json');
    let pickerRegistry = null;
    try {
        pickerRegistry = (await readJson(pickerRegistryPath, 'Picker recovery manifest')).value;
        if (pickerRegistry.sourceIdentity !== pickerRecoveryIdentity) throw new Error('Picker recovery manifest has a different source identity.');
    }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const pickerRecoveryById = new Map((pickerRegistry?.records ?? []).map(record => [record.id, record]));
    const pickerSnapshots = [];
    for (const source of pickerSourceRows) {
        const recovered = pickerRecoveryById.get(source.id);
        let state = recovered?.state === 'recovered-hash-verified' ? recovered.state : 'original-bytes-unavailable';
        let evidenceFile = null;
        let bytes = null;
        let reason = recovered?.reason ?? 'The selected compiled record remains available; its original Git snapshot has not been verified locally.';
        if (state === 'recovered-hash-verified' && recovered.repo === source.repo && recovered.revision === source.revision
            && recovered.resource === source.resource && recovered.sha256 === source.sha256
            && typeof recovered.evidenceFile === 'string') {
            const evidenceBytes = await fs.readFile(checkedRelative(packageRoot, recovered.evidenceFile));
            if (evidenceBytes.byteLength !== recovered.bytes || sha256Hex(evidenceBytes) !== source.sha256) {
                throw new Error(`Recovered Picker snapshot failed digest verification: ${source.id}`);
            }
            evidenceFile = recovered.evidenceFile;
            bytes = evidenceBytes.byteLength;
            reason = null;
        }
        else state = 'original-bytes-unavailable';
        pickerSnapshots.push({ sourceId: source.id, repo: source.repo, revision: source.revision,
            resource: source.resource, recordedSha256: source.sha256 ?? null,
            retrievedAt: migrated.core.sources.find(row => row.id === source.id)?.retrievedAt ?? null,
            state, bytes, evidenceFile, reason });
    }
    const uniqueClaims = reconciliationClaims(inputs);
    const index = { schemaVersion: 1, inputSignature, evidenceManifest: `${evidenceRoot}/manifest.json`,
        sourceBundles: sources.map(source => ({ id: source.id, evidenceFile: `${evidenceRoot}/${source.file}`,
            fieldFile: `reconciliation/fields/${source.id}.json.gz`, fieldCount: fieldsBySource.get(source.id).length,
            fieldOccurrences: fieldsBySource.get(source.id).reduce((total, field) => total + field.occurrences, 0),
            canonicalTargets: source.targets })),
        uniqueClaims, recoveredNativeSources, unavailableOriginals, pickerSnapshots,
        coverage: { selectedFieldPaths: [...fieldsBySource.values()].reduce((total, fields) => total + fields.length, 0),
            selectedBundleFields: [...fieldsBySource.values()].reduce((total, fields) => total
                + fields.reduce((subtotal, field) => subtotal + field.occurrences, 0), 0),
            reconciledClaims: uniqueClaims.length,
            recoveredNativeSourceBytes: recoveredNativeSources.reduce((total, source) => total + source.bytes, 0) } };
    const indexDescriptor = await writeArtifact(stage, 'reconciliation/index.json', index);
    return [indexDescriptor, ...fieldFiles];
}

async function writeArtifact(root, name, value) {
    const bytes = jsonBytes(value);
    const filename = path.join(root, ...name.split('/'));
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes, { flag: 'wx' });
    return descriptor(name, bytes);
}

function arg(args, key, fallback) {
    return args.values[key] ?? fallback;
}

async function listFiles(root, prefix = '') {
    const rows = [];
    for (const entry of await fs.readdir(path.join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error('Generated dataset trees cannot contain symbolic links.');
        if (entry.isDirectory()) rows.push(...await listFiles(root, relative));
        else if (entry.isFile()) rows.push(relative);
        else throw new Error('Generated dataset tree contains a non-regular entry.');
    }
    return rows;
}

async function importDataset(options) {
    const inputs = await collectInputs(options.mechanics, options.evidence);
    const canonical = path.resolve(options.output);
    const signature = values => sha256Hex(new TextEncoder().encode(JSON.stringify(values)));
    const guideHashes = [...inputs.guideHashes].sort(([left], [right]) => left.localeCompare(right));
    const legacyInputSignature = signature({
        mechanics: sha256Hex(inputs.sourceBytes.mechanics),
        annotations: sha256Hex(inputs.sourceBytes.annotations),
        browserCatalog: sha256Hex(inputs.sourceBytes.browserCatalog),
        externalEvidence: sha256Hex(inputs.sourceBytes.externalEvidence),
        guideHashes,
    });
    const inputSignature = signature({
        mechanics: sha256Hex(inputs.sourceBytes.mechanics),
        mechanicsManifest: sha256Hex(inputs.sourceBytes.mechanicsManifest),
        annotations: sha256Hex(inputs.sourceBytes.annotations),
        browserCatalog: sha256Hex(inputs.sourceBytes.browserCatalog),
        externalEvidence: sha256Hex(inputs.sourceBytes.externalEvidence),
        externalManifest: sha256Hex(inputs.sourceBytes.externalManifest),
        guideHashes,
    });
    const evidenceRoot = await persistLegacyInputs(inputs, inputSignature);
    let createdAt = options.generatedAt ?? new Date().toISOString();
    const previousPath = options.previous ?? path.join(canonical, 'manifest.json');
    try {
        const previous = (await readJson(previousPath, 'previous dataset manifest')).value;
        if ([inputSignature, legacyInputSignature].includes(previous.inputSignature)
            && Number.isFinite(Date.parse(previous.createdAt))) {
            createdAt = previous.createdAt;
        }
    }
    catch (error) {
        if (options.previous || error.code !== 'ENOENT') throw error;
    }
    const migrated = importLegacyKnowledge({ ...inputs, version: options.version, createdAt });
    const graph = migrated.graph;
    graph.metadata.inputSignature = inputSignature;
    let ownedFiles;
    try {
        const previous = await verifyManifest(canonical);
        ownedFiles = ['manifest.json', ...previous.sourceFiles.map(row => row.name)];
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = await publishDataset({ target: canonical, replace: options.replace, ownedFiles,
        build: async stage => {
            const support = path.join(path.dirname(stage), 'import-reconciliation');
            await fs.mkdir(support);
            await writeReconciliation(support, inputs, migrated, evidenceRoot, inputSignature);
            for (const name of await listFiles(support)) {
                const bytes = await fs.readFile(path.join(support, ...name.split('/')));
                if (name === 'reconciliation/index.json') {
                    const index = JSON.parse(bytes);
                    for (const row of index.sourceBundles) row.fieldFile = 'reviews/' + row.fieldFile;
                    graph.extras.set('reviews/' + name, jsonBytes(index));
                }
                else graph.extras.set('reviews/' + name, bytes);
            }
            await writeCanonical(stage, graph);
        }, validate: validateDataset });
    process.stdout.write(JSON.stringify({ ...result, heroes: graph.entities.heroes.length, effects: graph.entities.effects.length }) + '\n');
    return result;
}

async function main() {
    const { values } = parseArgs({ options: { mechanics: { type: 'string' }, evidence: { type: 'string' },
        output: { type: 'string' }, version: { type: 'string' }, 'generated-at': { type: 'string' },
        previous: { type: 'string' }, replace: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
    if (values.help) {
        process.stdout.write(usage());
        return;
    }
    if (!values.mechanics || !values.evidence) throw new Error(usage());
    await importDataset({ mechanics: values.mechanics, evidence: values.evidence,
        output: arg({ values }, 'output', defaultOutput), version: arg({ values }, 'version', 'knowledge-6957-current'),
        generatedAt: values['generated-at'], previous: values.previous, replace: values.replace === true });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exitCode = 1;
    });
}

export { importDataset, usage };

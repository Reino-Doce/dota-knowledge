import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { sha256Hex } from '../src/sha256.mjs';
import { validateDataset } from './consolidation/validation.mjs';
import { readCanonical } from '../src/node/canonical.mjs';
import { verifyReplacements } from './population/reconciliation.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const skipOriginalEvidence = args.includes('--skip-original-evidence');
const datasetArgument = args.find(value => !value.startsWith('--'));
const datasetRoot = path.resolve(datasetArgument ?? path.join(packageRoot, 'data'));
const schemaRoot = path.join(packageRoot, 'schema');
const schemaNames = (await fs.readdir(schemaRoot)).filter(name => name.endsWith('.schema.json')).sort();
const schemas = await Promise.all(schemaNames.map(async name => JSON.parse(await fs.readFile(path.join(schemaRoot, name), 'utf8'))));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
addFormats(ajv);
for (const schema of schemas) ajv.addSchema(schema);
for (const schema of schemas) ajv.getSchema(schema.$id) ?? ajv.compile(schema);

function validate(schemaId, value, label) {
    const validator = ajv.getSchema(schemaId);
    if (!validator) throw new Error(`Schema ${schemaId} was not registered.`);
    if (validator(value)) return;
    const details = (validator.errors ?? []).slice(0, 8).map(error => `${error.instancePath || '/'} ${error.message}`).join('; ');
    throw new Error(`${label} does not match ${schemaId}: ${details}`);
}

async function readJson(filename) {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
}

const schemaId = name => `https://github.com/devilesk/dota-interactive-map/dota-knowledge/${name}.schema.json`;
await validateDataset(datasetRoot);
const sourceManifest = await readJson(path.join(datasetRoot, 'manifest.json'));
validate(schemaId('canonical-manifest'), sourceManifest, 'Canonical manifest');
validate(schemaId('source-registry'), await readJson(path.join(datasetRoot, 'observations', 'sources.json')), 'Source registry');
validate(schemaId('claim-index'), await readJson(path.join(datasetRoot, 'reviews', 'claims.json')), 'Claim index');
validate(schemaId('observations-index'), await readJson(path.join(datasetRoot, 'observations', 'index.json')), 'Observation index');
validate(schemaId('mechanics-reference'), await readJson(path.join(datasetRoot, 'mechanics', 'reference.json')), 'Mechanics reference');
const reconciliationPath = path.join(datasetRoot, 'reviews', 'reconciliation', 'index.json');
const reconciliation = await readJson(reconciliationPath);
validate(schemaId('reconciliation-index'), reconciliation, 'Reconciliation inventory');
function resolveWithin(root, name) {
    if (typeof name !== 'string' || !name || name.includes('\\') || path.isAbsolute(name)
        || name.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error(`Unsafe dataset path: ${name}`);
    }
    const resolved = path.resolve(root, ...name.split('/'));
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Dataset path escapes its root: ${name}`);
    }
    return resolved;
}
const evidenceManifestPath = resolveWithin(packageRoot, reconciliation.evidenceManifest);
const evidenceManifest = skipOriginalEvidence ? null : await readJson(evidenceManifestPath);
if (evidenceManifest && evidenceManifest.inputSignature !== reconciliation.inputSignature) {
    throw new Error('Reconciliation inventory and persistent evidence manifest have different input signatures.');
}
const evidenceByName = new Map(evidenceManifest?.files.map(file => [file.name, file]) ?? []);
const evidenceDirectory = path.posix.dirname(reconciliation.evidenceManifest);
const sourceFilesByName = new Map(sourceManifest.sourceFiles.map(file => [file.name, file]));
const claimIds = new Set((await readJson(path.join(datasetRoot, 'reviews', 'claims.json'))).claims.map(claim => claim.id));
const observationIds = new Set((await readJson(path.join(datasetRoot, 'observations', 'index.json'))).entries.map(row => row.id));
const sourceRegistry = new Map((await readJson(path.join(datasetRoot, 'observations', 'sources.json'))).map(source => [source.id, source]));
let recoveredNativeByteCount = 0;
for (const recovered of reconciliation.recoveredNativeSources) {
    const source = sourceRegistry.get(recovered.sourceId);
    if (!source || source.resource !== recovered.resource || source.sha256 !== recovered.sha256) {
        throw new Error(`Recovered native source identity differs from the canonical source registry: ${recovered.sourceId}.`);
    }
    if (skipOriginalEvidence) recoveredNativeByteCount += recovered.bytes;
    else {
        const bytes = await fs.readFile(resolveWithin(packageRoot, recovered.evidenceFile));
        if (bytes.byteLength !== recovered.bytes || sha256Hex(bytes) !== recovered.sha256) {
            throw new Error(`Recovered native evidence is not hash verified: ${recovered.sourceId}.`);
        }
        recoveredNativeByteCount += bytes.byteLength;
    }
}
for (const snapshot of reconciliation.pickerSnapshots) {
    const source = sourceRegistry.get(snapshot.sourceId);
    if (!source || source.repo !== snapshot.repo || (source.commit ?? source.revision ?? null) !== snapshot.revision
        || source.resource !== snapshot.resource || (source.sha256 ?? null) !== snapshot.recordedSha256) {
        throw new Error(`Picker snapshot identity differs from the canonical source registry: ${snapshot.sourceId}.`);
    }
    if (snapshot.state === 'recovered-hash-verified') {
        if (!skipOriginalEvidence) {
            const bytes = await fs.readFile(resolveWithin(packageRoot, snapshot.evidenceFile));
            if (bytes.byteLength !== snapshot.bytes || sha256Hex(bytes) !== snapshot.recordedSha256) {
                throw new Error(`Picker snapshot is not hash verified: ${snapshot.sourceId}.`);
            }
        }
    }
    else if (snapshot.bytes !== null || snapshot.evidenceFile !== null || !snapshot.reason) {
        throw new Error(`Unavailable Picker snapshot must retain an explicit reason: ${snapshot.sourceId}.`);
    }
}
const decodePointerPart = part => part.replaceAll('~1', '/').replaceAll('~0', '~');
const pointerMatchCount = (value, pointer) => {
    if (pointer === '#') return 1;
    if (!pointer.startsWith('#/')) return 0;
    const parts = pointer.slice(2).split('/').map(decodePointerPart);
    const count = (current, index) => {
        if (index === parts.length) return 1;
        const key = parts[index];
        if (key === '*') return Array.isArray(current)
            ? current.reduce((total, child) => total + count(child, index + 1), 0) : 0;
        if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return 0;
        return count(current[key], index + 1);
    };
    return count(value, 0);
};
let reconciledFieldCount = 0;
let reconciledFieldPathCount = 0;
for (const bundle of reconciliation.sourceBundles) {
    const fieldPath = resolveWithin(datasetRoot, bundle.fieldFile);
    const fieldBytes = await fs.readFile(fieldPath);
    const decodedFieldBytes = bundle.fieldFile.endsWith('.gz')
        ? gunzipSync(fieldBytes, { maxOutputLength: 128 * 1024 * 1024 }) : fieldBytes;
    const fields = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodedFieldBytes));
    validate(schemaId('reconciliation-fields'), fields, `Reconciliation field map ${bundle.id}`);
    const sourceDescriptor = sourceFilesByName.get(bundle.fieldFile);
    const evidenceName = bundle.evidenceFile.startsWith(`${evidenceDirectory}/`)
        ? bundle.evidenceFile.slice(evidenceDirectory.length + 1) : null;
    const evidenceDescriptor = evidenceName ? evidenceByName.get(evidenceName) : null;
    if (!sourceDescriptor || (!skipOriginalEvidence && !evidenceDescriptor) || fields.sourceBundle !== bundle.id
        || fields.inputSignature !== reconciliation.inputSignature || fields.evidenceFile !== bundle.evidenceFile
        || (!skipOriginalEvidence && fields.evidenceSha256 !== evidenceDescriptor.sha256)
        || !/^[a-f0-9]{64}$/.test(fields.evidenceSha256 || '') || fields.fieldCount !== bundle.fieldCount
        || fields.fields.length !== bundle.fieldCount) {
        throw new Error(`Reconciliation descriptor mismatch for ${bundle.id}.`);
    }
    const evidenceBytes = skipOriginalEvidence ? null : await fs.readFile(resolveWithin(packageRoot, bundle.evidenceFile));
    const evidenceValue = evidenceBytes
        ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(evidenceBytes)) : null;
    if (evidenceBytes) {
        if (evidenceBytes.byteLength !== evidenceDescriptor.bytes || sha256Hex(evidenceBytes) !== evidenceDescriptor.sha256) {
            throw new Error(`Persistent evidence bytes do not match the acquisition manifest for ${bundle.id}.`);
        }
    }
    const targetSet = new Set(bundle.canonicalTargets);
    let fieldOccurrences = 0;
    for (const field of fields.fields) {
        if (field.evidenceFile !== bundle.evidenceFile || field.sourcePath !== field.evidencePointer
            || field.canonicalTargets.some(target => !targetSet.has(target))
            || evidenceValue && pointerMatchCount(evidenceValue, field.evidencePointer) !== field.occurrences) {
            throw new Error(`Field reconciliation does not resolve to retained evidence or a canonical target for ${bundle.id}:${field.sourcePath}.`);
        }
        fieldOccurrences += field.occurrences;
    }
    if (fields.fieldOccurrences !== fieldOccurrences || bundle.fieldOccurrences !== fieldOccurrences) {
        throw new Error(`Reconciliation occurrence count mismatch for ${bundle.id}.`);
    }
    if (sourceDescriptor.bytes !== fieldBytes.byteLength || sourceDescriptor.sha256 !== sha256Hex(fieldBytes)) {
        throw new Error(`Reconciliation field map hash mismatch for ${bundle.id}.`);
    }
    reconciledFieldCount += fieldOccurrences;
    reconciledFieldPathCount += fields.fields.length;
}
if (reconciliation.coverage.selectedFieldPaths !== reconciledFieldPathCount
    || reconciliation.coverage.selectedBundleFields !== reconciledFieldCount
    || reconciliation.coverage.reconciledClaims !== reconciliation.uniqueClaims.length
    || reconciliation.coverage.recoveredNativeSourceBytes !== recoveredNativeByteCount) {
    throw new Error('Reconciliation coverage totals do not match the complete inventory.');
}

const runtimeManifestPath = path.join(datasetRoot, 'runtime', 'manifest.json');
const runtimeManifest = await readJson(runtimeManifestPath);
validate(schemaId('manifest'), runtimeManifest, 'Runtime manifest');
validate(schemaId('core'), await readJson(path.join(datasetRoot, 'runtime', 'core.json')), 'Compiled core');
for (const [heroId, descriptor] of Object.entries(runtimeManifest.guides)) {
    validate(schemaId('guide'), await readJson(path.join(datasetRoot, 'runtime', ...descriptor.name.split('/'))), `Hero guide ${heroId}`);
}
for (const shard of runtimeManifest.observationShards) {
    validate(schemaId('observation-shard'), await readJson(path.join(datasetRoot, 'runtime', ...shard.name.split('/'))), `Observation shard ${shard.name}`);
}
const preservedReplacements = verifyReplacements(await readCanonical(datasetRoot));
for (const claim of reconciliation.uniqueClaims) {
    for (const targetId of claim.targetClaimIds) {
        if (!claimIds.has(targetId) && !observationIds.has(targetId) && !preservedReplacements.has(targetId)) {
            throw new Error(`Historical claim ${claim.claimHash} targets unknown canonical identity ${targetId}.`);
        }
    }
}

process.stdout.write(`Validated ${schemas.length} JSON schemas, ${Object.keys(runtimeManifest.guides).length} hero guides, and ${reconciledFieldCount} reconciled input fields${
    skipOriginalEvidence ? ' (original evidence byte checks skipped in this clean package worktree)' : ''}.\n`);

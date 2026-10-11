import { hash, semanticHash } from '../../src/canonical-model.mjs';
import { jsonBytes } from '../../src/node/canonical.mjs';
import { inspectPng } from '../../src/node/image-files.mjs';
import { isImageFile, validateImageCatalog, validateImageManifest } from '../../src/image-contracts.mjs';
import { createFileStorage } from '../population/storage.mjs';

export const createImageStorage = root => createFileStorage(root, { format: 'dota-images-1' });
export function runPath(runId) {
    if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(runId)) throw new Error('Unsafe image run ID.');
    return `runs/${runId}/manifest.json`;
}

/** Collection only writes owned evidence. A failed request is never a successful missing image. */
export async function collectImages({ runId, inventory, storage, readSource, decoder, clock, signal, logger, offline = false, fresh = false, verifySource }) {
    if (!storage || typeof clock !== 'function' || !signal || typeof logger !== 'function') throw new Error('Image collection dependencies must be explicit.');
    const name = runPath(runId);
    return storage.lock('images', async () => {
        let run = await storage.read(name);
        if (offline) {
            if (!run || run.state !== 'complete' || !run.normalized) throw new Error('Offline replay requires a completed image run.');
            if (inventory && semanticHash({ inventory, decoder: decoder?.identity ?? run.decoder }) !== run.inputSignature) throw new Error('Incompatible image replay inputs.');
            await verifiedRun(storage, run);
            logger({ event: 'replayed', runId }); return run;
        }
        if (!inventory || typeof readSource !== 'function' || typeof decoder?.decode !== 'function' || !decoder.identity) throw new Error('Image sources and decoder must be supplied.');
        const signature = semanticHash({ inventory, decoder: decoder.identity });
        if (run && (fresh || run.inputSignature !== signature)) throw new Error('Stale/incompatible image checkpoint; use a new run ID.');
        if (!run) {
            const generatedAt = clock();
            if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('Invalid image acquisition clock.');
            run = { schemaVersion: 1, runId, state: 'collecting', generatedAt, inputSignature: signature, inventory,
                decoder: decoder.identity, results: {}, normalized: null };
            await storage.write(name, run);
        }
        const groups = new Map();
        for (const request of inventory.requests) {
            if (!isImageFile(request.destination) || !request.destination.endsWith('.png')) throw new Error('Unsafe image destination.');
            if (request.resource && !request.source || request.source && (!/^[a-f0-9]{64}$/.test(request.source.sha256)
                || request.resource && request.resource !== request.source.resource)) throw new Error('Image source has no verified byte identity.');
            if (groups.has(request.source?.resource)) {
                if (groups.get(request.source.resource).sha256 !== request.source.sha256) throw new Error('Conflicting image source identities.');
                continue;
            }
            if (request.source) groups.set(request.source.resource, request.source);
        }
        try {
            const pending = [];
            for (const source of groups.values()) {
                signal.throwIfAborted();
                const saved = run.results[source.resource];
                if (saved?.state === 'available') {
                    await storage.bytes(saved.raw); inspectPng(await storage.bytes(saved.png)); continue;
                }
                try {
                    const bytes = saved?.raw ? await storage.bytes(saved.raw) : await readSource(source, signal);
                    if (!(bytes instanceof Uint8Array) || bytes.length > 64 * 1024 * 1024
                        || hash(bytes) !== source.sha256) throw new Error('Image source changed or exceeded limits.');
                    const raw = saved?.raw ?? await storage.artifact(bytes);
                    run.results[source.resource] = { state: 'captured', raw };
                    if (source.resource.endsWith('.png')) {
                        const metadata = inspectPng(bytes);
                        run.results[source.resource] = { state: 'available', raw, png: raw, metadata };
                    }
                    else pending.push({ resource: source.resource, bytes });
                }
                catch (error) {
                    if (signal.aborted) throw error;
                    run.results[source.resource] = { state: 'failed', reason: 'Source acquisition or PNG verification failed.' };
                    logger({ event: 'source-failed', resource: source.resource });
                }
                await storage.write(name, run);
            }
            for (let start = 0; start < pending.length; start += 64) {
                signal.throwIfAborted();
                const batch = pending.slice(start, start + 64);
                try {
                    const decoded = await decoder.decode(batch, signal);
                    for (const source of batch) {
                        const bytes = decoded.get(source.resource);
                        const metadata = inspectPng(bytes);
                        const png = await storage.artifact(bytes);
                        run.results[source.resource] = { ...run.results[source.resource], state: 'available', png, metadata };
                    }
                }
                catch (error) {
                    if (signal.aborted) throw error;
                    for (const source of batch) if (run.results[source.resource]?.state !== 'available') {
                        run.results[source.resource] = { ...run.results[source.resource], state: 'failed', reason: 'Texture decoding or PNG verification failed.' };
                    }
                    logger({ event: 'decode-failed', count: batch.length });
                }
                await storage.write(name, run);
                logger({ event: 'decoded', completed: Math.min(start + batch.length, pending.length), total: pending.length });
            }
            signal.throwIfAborted(); await verifySource?.();
            const failed = [...groups.keys()].filter(resource => run.results[resource]?.state !== 'available');
            if (failed.length) { run.state = 'partial'; await storage.write(name, run); return run; }
            const catalog = { schemaVersion: 1, entities: inventory.entities, exclusions: inventory.exclusions, assets: [], images: [] };
            const assets = new Map(); const paths = new Set(); const files = [];
            for (const request of inventory.requests) {
                const identity = { id: request.id, entityKind: request.entityKind, entityId: request.entityId, variant: request.variant };
                if (!request.source) { catalog.images.push({ ...identity, state: 'unavailable', reason: request.reason }); continue; }
                const result = run.results[request.source.resource];
                const digest = result.metadata.sha256;
                if (!assets.has(digest)) {
                    if (paths.has(request.destination)) throw new Error('Conflicting image destination.');
                    const asset = { id: 'asset:' + digest, path: request.destination, ...result.metadata };
                    assets.set(digest, asset); paths.add(asset.path); catalog.assets.push(asset);
                    files.push({ path: asset.path, artifact: result.png });
                }
                catalog.images.push({ ...identity, state: 'available', assetId: assets.get(digest).id });
            }
            validateImageCatalog(catalog);
            const catalogBytes = jsonBytes(catalog);
            const manifest = { schemaVersion: 1, generatedAt: run.generatedAt, inputSignature: signature,
                rosterSignature: inventory.rosterSignature, build: inventory.build,
                attribution: 'Dota 2 artwork belongs to Valve Corporation. See NOTICE.md.',
                catalog: { name: 'images/catalog.json', bytes: catalogBytes.length, sha256: hash(catalogBytes) } };
            validateImageManifest(manifest);
            run.normalized = await storage.artifact(jsonBytes({ manifest, catalog, files }), null, 'json');
            run.state = 'complete'; await storage.write(name, run);
            logger({ event: 'complete', assets: assets.size, images: catalog.images.length }); return run;
        }
        catch (error) {
            run.state = signal.aborted ? 'cancelled' : 'partial';
            await storage.write(name, run); throw error;
        }
    });
}

export async function verifiedRun(storage, run) {
    if (run?.schemaVersion !== 1 || run.state !== 'complete' || !run.normalized
        || run.inputSignature !== semanticHash({ inventory: run.inventory, decoder: run.decoder })) throw new Error('Incomplete or altered image run.');
    const normalized = JSON.parse(await storage.bytes(run.normalized));
    validateImageManifest(normalized.manifest);
    const { assets } = validateImageCatalog(normalized.catalog);
    if (normalized.manifest.inputSignature !== run.inputSignature || normalized.manifest.rosterSignature !== run.inventory.rosterSignature
        || normalized.manifest.generatedAt !== run.generatedAt || semanticHash(normalized.manifest.build) !== semanticHash(run.inventory.build)
        || semanticHash(normalized.catalog.entities) !== semanticHash(run.inventory.entities)
        || semanticHash(normalized.catalog.exclusions) !== semanticHash(run.inventory.exclusions)
        || hash(jsonBytes(normalized.catalog)) !== normalized.manifest.catalog.sha256) throw new Error('Altered normalized image catalog.');
    const bindings = new Map(normalized.catalog.images.map(row => [row.id, row]));
    if (bindings.size !== run.inventory.requests.length) throw new Error('Image binding inventory differs from acquisition.');
    for (const request of run.inventory.requests) {
        const binding = bindings.get(request.id);
        if (!binding || ['entityKind', 'entityId', 'variant'].some(key => binding[key] !== request[key])) throw new Error('Image identity differs from acquisition.');
        if (!request.source) {
            if (binding.state !== 'unavailable' || binding.reason !== request.reason) throw new Error('Image availability differs from acquisition.');
        }
        else {
            const result = run.results[request.source.resource];
            if (result?.state !== 'available' || result.raw.sha256 !== request.source.sha256
                || binding.state !== 'available' || assets.get(binding.assetId)?.sha256 !== result.png.sha256) throw new Error('Image artwork differs from its source binding.');
        }
    }
    const seen = new Set();
    for (const file of normalized.files) {
        if (seen.has(file.path)) throw new Error('Duplicate image output.');
        seen.add(file.path);
        const asset = [...assets.values()].find(row => row.path === file.path);
        const bytes = await storage.bytes(file.artifact); const metadata = inspectPng(bytes);
        if (!asset || Object.entries(metadata).some(([key, value]) => asset[key] !== value)) throw new Error('Image output differs from its descriptor.');
    }
    if (seen.size !== assets.size) throw new Error('Incomplete image outputs.');
    for (const result of Object.values(run.results)) if (result.raw) await storage.bytes(result.raw);
    for (const source of run.inventory.evidence ?? []) await storage.bytes(source.artifact);
    return normalized;
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openVpk } from '../../src/node/game-files.mjs';
import { regularBytes } from '../../src/node/canonical.mjs';
import { hash } from '../../src/canonical-model.mjs';
import { inspectPng } from '../../src/node/image-files.mjs';
import { inventoryImages, STANDARD_ITEM_POLICY } from './inventory.mjs';

const execute = promisify(execFile);
export async function readBuild(game) {
    const text = await fs.readFile(path.join(game, 'dota/steam.inf'), 'utf8');
    const field = name => new RegExp(`^${name}=([0-9]+)\\s*$`, 'm').exec(text)?.[1];
    const result = { clientVersion: field('ClientVersion'), serverVersion: field('ServerVersion'), sourceRevision: field('SourceRevision') };
    if (Object.values(result).some(value => !value)) throw new Error('Native build identity is incomplete.');
    return result;
}

export async function createSource2Decoder({ executable, workDirectory, timeoutMs = 120000 }) {
    executable = await fs.realpath(executable);
    await fs.mkdir(workDirectory, { recursive: true });
    const root = await fs.realpath(workDirectory);
    const { stdout } = await execute(executable, ['--version'], { windowsHide: true, timeout: 30000, maxBuffer: 65536, cwd: root });
    const version = /^Version:\s*(\S+)/m.exec(stdout)?.[1];
    if (!version) throw new Error('Source 2 Viewer did not identify its version.');
    const identity = { name: 'Source2Viewer-CLI', version, sha256: hash(await fs.readFile(executable)) };
    return {
        identity,
        async decode(resources, signal) {
            signal.throwIfAborted();
            const directory = await fs.mkdtemp(path.join(root, 'decode-'));
            try {
                const input = path.join(directory, 'input'); const output = path.join(directory, 'output');
                await fs.mkdir(input); await fs.mkdir(output);
                for (const resource of resources) {
                    if (!resource.resource.endsWith('.vtex_c')) throw new Error('Decoder accepts only native texture resources.');
                    await fs.writeFile(path.join(input, hash(resource.bytes) + '.vtex_c'), resource.bytes);
                }
                await execute(executable, ['-i', input, '-o', output, '-d', '--threads', '4'],
                    { cwd: directory, windowsHide: true, signal, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
                return new Map(await Promise.all(resources.map(async resource => [resource.resource,
                    await regularBytes(output, hash(resource.bytes) + '.png')])));
            }
            finally {
                const actual = await fs.realpath(directory);
                if (path.dirname(actual) !== root || !path.basename(actual).startsWith('decode-')) throw new Error('Unsafe decoder cleanup path.');
                await fs.rm(actual, { recursive: true });
            }
        },
    };
}

/** Optional network adapter. URLs are constructed only from checked engine names. */
export function createValveCdnReader({ fetch, timeoutMs = 15000, maxBytes = 16 * 1024 * 1024 }) {
    if (typeof fetch !== 'function') throw new Error('An explicit fetch adapter is required.');
    return async (kind, key, signal) => {
        if (!['heroes', 'abilities', 'items'].includes(kind) || !/^[a-z0-9_]+$/.test(key)) throw new Error('Invalid Valve image identity.');
        const resource = `apps/dota2/images/dota_react/${kind}/${key}.png`;
        const response = await fetch('https://cdn.cloudflare.steamstatic.com/' + resource, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), credentials: 'omit', redirect: 'error',
        });
        if (response.status === 404) { await response.body?.cancel(); return null; }
        if (!response.ok) { await response.body?.cancel(); throw new Error('Valve image request failed: HTTP ' + response.status); }
        const length = response.headers.get('content-length');
        if (length && (!/^[0-9]+$/.test(length) || BigInt(length) > BigInt(maxBytes))) {
            await response.body?.cancel(); throw new Error('Valve image response exceeds limit.');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Valve image response has no bytes.');
        let size = 0; const chunks = [];
        try {
            while (true) {
                signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
                size += value.length; if (size > maxBytes) throw new Error('Valve image response exceeds limit.');
                chunks.push(value);
            }
        }
        finally { await reader.cancel(); reader.releaseLock(); }
        const bytes = Buffer.concat(chunks); inspectPng(bytes);
        return { resource: 'valve-cdn/' + resource, bytes };
    };
}

/** Capture immutable source bytes before collection; recheck the installation before completion. */
export async function createNativeImageSource({ game, roster, storage, pickerDirectory, itemPolicy = STANDARD_ITEM_POLICY, cdnReader, signal }) {
    const build = await readBuild(game);
    const archiveFile = path.join(game, 'dota/pak01_dir.vpk');
    const archiveHash = hash(await fs.readFile(archiveFile));
    const archive = openVpk(archiveFile);
    const captured = new Map(); const artifacts = new Map();
    const capture = async (resource, bytes) => {
        if (!captured.has(resource)) { captured.set(resource, bytes); artifacts.set(resource, await storage.artifact(bytes)); }
        return captured.get(resource);
    };
    const readResource = async resource => {
        signal.throwIfAborted(); return captured.get(resource) ?? capture(resource, archive.read(resource));
    };
    const inventory = await inventoryImages({ roster, build, files: archive.files, readResource, itemPolicy });
    inventory.archive = { resource: 'dota/pak01_dir.vpk', sha256: archiveHash };
    for (const request of inventory.requests) {
        signal.throwIfAborted();
        if (pickerDirectory && request.entityKind === 'hero' && request.variant === 'profile' && request.providerSlug) {
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.providerSlug)) throw new Error('Unsafe portrait crosswalk slug.');
            try {
                const bytes = await regularBytes(pickerDirectory, request.providerSlug + '.png'); inspectPng(bytes);
                request.resource = 'picker/' + request.providerSlug + '.png';
                await capture(request.resource, bytes); request.mapping = 'preserved-picker-crosswalk';
            }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (!request.resource && cdnReader && !/Talent|Hidden|metadata field/.test(request.reason)) {
            const plural = request.entityKind === 'hero' ? 'heroes' : request.entityKind === 'ability' ? 'abilities' : 'items';
            const entity = inventory.entities[plural].find(row => row.id === request.entityId);
            // CDN hero portraits do not stand in for icons.
            if (request.entityKind !== 'hero' || request.variant === 'profile') {
                const response = await cdnReader(plural, entity.key ?? entity.engineId, signal);
                if (response) { request.resource = response.resource; await capture(response.resource, response.bytes); request.mapping = 'valve-cdn'; }
                else request.reason += ' The selected Valve CDN endpoint also returned 404.';
            }
        }
        if (request.resource) {
            const bytes = captured.get(request.resource) ?? await readResource(request.resource);
            request.source = { resource: request.resource, sha256: hash(bytes) };
        }
    }
    inventory.evidence = [...artifacts].map(([resource, artifact]) => ({ resource, artifact })).sort((a, b) => a.resource.localeCompare(b.resource));
    const verifySource = async () => {
        if (JSON.stringify(build) !== JSON.stringify(await readBuild(game)) || archiveHash !== hash(await fs.readFile(archiveFile))) throw new Error('Native resources changed during acquisition.');
    };
    await verifySource();
    return { inventory, verifySource, readSource: async source => {
        const artifact = artifacts.get(source.resource);
        if (!artifact) throw new Error('Uncaptured image source.');
        return storage.bytes(artifact);
    } };
}

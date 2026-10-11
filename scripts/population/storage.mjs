import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from '../../src/canonical-model.mjs';
import { regularBytes, within, jsonBytes } from '../../src/node/canonical.mjs';

async function guardedDirectory(directory) {
    const resolved = path.resolve(directory);
    const parent = path.dirname(resolved);
    if (parent !== resolved) await guardedDirectory(parent);
    try {
        const stat = await fs.lstat(resolved);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Evidence directories must not contain links.');
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; await fs.mkdir(resolved); }
}

/** Dedicated, caller-owned evidence tree. Session directories must be elsewhere. */
export async function createFileStorage(root, { format = 'dota-population-1' } = {}) {
    if (!['dota-population-1', 'dota-images-1'].includes(format)) throw new Error('Unknown evidence storage format.');
    root = path.resolve(root);
    await guardedDirectory(root);
    const marker = path.join(root, 'owner.json');
    try {
        const saved = JSON.parse(await regularBytes(root, 'owner.json'));
        if (saved.format !== format) throw new Error('Evidence root belongs to another workflow.');
    }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if ((await fs.readdir(root)).length) throw new Error('Evidence root must be empty or already owned.');
        await fs.writeFile(marker, jsonBytes({ format }), { flag: 'wx' });
    }
    const api = {
        root,
        async read(name) {
            try { return JSON.parse(await regularBytes(root, name)); }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        },
        async write(name, value) {
            const file = within(root, name);
            await guardedDirectory(path.dirname(file));
            try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Evidence file is a link.'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            const temporary = file + '.' + randomUUID() + '.tmp';
            await fs.writeFile(temporary, jsonBytes(value), { flag: 'wx' });
            await fs.rename(temporary, file);
        },
        async artifact(bytes, heroKey = null, extension = 'bin') {
            if (!(bytes instanceof Uint8Array) || !['bin', 'json'].includes(extension)
                || heroKey !== null && !/^[a-z][a-z0-9_]*$/.test(heroKey)) throw new Error('Invalid evidence artifact.');
            const sha256 = hash(bytes);
            const name = `artifacts/${heroKey ? 'heroes/' + heroKey : 'shared'}/${sha256}.${extension}`;
            const file = within(root, name);
            await guardedDirectory(path.dirname(file));
            try { await fs.writeFile(file, bytes, { flag: 'wx' }); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
            const descriptor = { name, sha256, bytes: bytes.length };
            await api.bytes(descriptor);
            return descriptor;
        },
        async bytes(descriptor) {
            if (!descriptor || !/^artifacts\/(heroes\/[a-z][a-z0-9_]*|shared)\/[a-f0-9]{64}\.(bin|json)$/.test(descriptor.name)) throw new Error('Unowned artifact descriptor.');
            const bytes = await regularBytes(root, descriptor.name);
            if (hash(bytes) !== descriptor.sha256 || bytes.length !== descriptor.bytes) throw new Error('Population artifact integrity mismatch.');
            return bytes;
        },
        async list(prefix) {
            const directory = within(root, prefix);
            const walk = async (dir, key) => {
                const out = [];
                for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
                    const name = key + '/' + entry.name;
                    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error('Unowned evidence path.');
                    if (entry.isDirectory()) out.push(...await walk(within(root, name), name));
                    else out.push(name);
                }
                return out;
            };
            try { return (await walk(directory, prefix)).sort(); }
            catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        },
        async removeArtifact(descriptor) {
            try { await api.bytes(descriptor); }
            catch (error) { if (error.code === 'ENOENT') return; throw error; }
            await fs.unlink(within(root, descriptor.name));
        },
        async lock(name, callback) {
            if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid lock.');
            const file = within(root, name + '.lock');
            const handle = await fs.open(file, 'wx').catch(() => { throw new Error('Population operation is locked; recover before retrying.'); });
            await handle.writeFile(jsonBytes({ pid: process.pid })); await handle.close();
            try { return await callback(); }
            finally { await fs.unlink(file); }
        },
        async recoverLock(name) {
            const value = await api.read(name + '.lock');
            if (!value) return;
            try { process.kill(value.pid, 0); throw new Error('Population operation is still active.'); }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
            await fs.unlink(within(root, name + '.lock'));
        },
    };
    return api;
}

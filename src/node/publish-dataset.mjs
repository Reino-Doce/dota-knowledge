import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hash } from '../canonical-model.mjs';
import { within, regularBytes, readJson, jsonBytes, verifyManifest } from './canonical.mjs';

async function exists(filename) {
    try { await fs.lstat(filename); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function inventory(root, prefix = '') {
    const rows = [];
    for (const entry of await fs.readdir(prefix ? within(root, prefix) : root, { withFileTypes: true })) {
        const name = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) rows.push(...await inventory(root, name));
        else if (entry.isFile()) {
            const bytes = await regularBytes(root, name);
            rows.push({ name, bytes: bytes.length, sha256: hash(bytes) });
        }
        else throw new Error('Publication cannot include symbolic links or special files.');
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
}
async function verifyFiles(root, files) {
    for (const row of files) {
        const bytes = await regularBytes(root, row.name);
        if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error('Concurrent edit or rollback integrity mismatch: ' + row.name);
    }
}
async function copyFile(from, to, name, { replace = false } = {}) {
    const bytes = await regularBytes(from, name);
    await fs.mkdir(path.dirname(within(to, name)), { recursive: true });
    await fs.writeFile(within(to, name), bytes, { flag: replace ? 'w' : 'wx' });
}
const stagingRoot = target => path.join(path.dirname(target), '.' + path.basename(target) + '-staging');
async function renameTree(from, to, before = async () => {}) {
    for (let attempt = 0; ; attempt += 1) {
        await before();
        try { await fs.rename(from, to); return; }
        catch (error) {
            if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
            await delay(50 * (attempt + 1));
        }
    }
}
async function journalWrite(root, journal) {
    const filename = path.join(root, 'journal.json');
    const handle = await fs.open(filename + '.next', 'w');
    try { await handle.writeFile(jsonBytes(journal)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(filename + '.next', filename);
}
async function cleanup(root, operationId, lockName = `lock-${operationId}.json`) {
    const owner = await readJson(root, lockName);
    if (owner.operationId !== operationId || path.basename(root).endsWith('-staging') === false
        || (await fs.lstat(root)).isSymbolicLink()) throw new Error('Refusing cleanup outside the owned publication root.');
    // inventory rejects links before recursive deletion. The resolved root is checked again.
    await inventory(root);
    if (await fs.realpath(root) !== path.resolve(root)) throw new Error('Staging root changed during publication.');
    await fs.rm(root, { recursive: true });
}

/** Recovery verifies the promoted manifest, or restores the byte-verified previous tree. */
export async function recoverPublication(target, { validate = verifyManifest, interruptAt } = {}) {
    target = path.resolve(target);
    const root = stagingRoot(target);
    if (await fs.realpath(root) !== root) throw new Error('Recovery root must be the owned staging directory.');
    const locks = (await fs.readdir(root)).filter(name => /^lock-[a-f0-9-]+\.json$/.test(name) || /^recovery-lock-\d+-[a-f0-9-]+\.json$/.test(name));
    if (locks.length !== 1) throw new Error('Recovery requires exactly one publication lock.');
    const lock = await readJson(root, locks[0]);
    const activePid = /^recovery-lock-(\d+)-/.exec(locks[0])?.[1] ?? lock.pid;
    if (activePid) {
        let running = true;
        try { process.kill(Number(activePid), 0); } catch (error) { if (error.code === 'ESRCH') running = false; else throw error; }
        if (running) throw new Error('Publication lock belongs to a running process.');
    }
    // Rename the one immutable lock atomically. A PID in its name establishes
    // ownership immediately, including a crash before any journal update.
    const lockName = `recovery-lock-${process.pid}-${randomUUID()}.json`;
    try { await fs.rename(path.join(root, locks[0]), path.join(root, lockName)); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Another recovery owns the publication lock.'); throw error; }
    try { return await recoverLocked(target, root, lock, lockName, { validate, interruptAt }); }
    finally {
        if (await exists(path.join(root, lockName))) await fs.rename(path.join(root, lockName), path.join(root, `lock-${lock.operationId}.json`));
    }
}

async function recoverLocked(target, root, lock, lockName, { validate, interruptAt }) {
    const journal = await readJson(root, 'journal.json');
    if (journal.target !== target || journal.operationId !== lock.operationId) throw new Error('Unowned publication journal.');
    const rollback = path.join(root, 'rollback');
    const hasRollback = await exists(rollback);
    const hasStage = await exists(path.join(root, 'stage'));
    if (!hasRollback && (hasStage || ['building', 'prepared'].includes(journal.state))) {
        // No tree was promoted. A target created or edited since preparation is
        // independent work, even when its names overlap the planned artifacts.
        await cleanup(root, lock.operationId, lockName);
        return { state: 'restored' };
    }
    let promoted = false;
    if (await exists(path.join(target, 'manifest.json')) && journal.manifestSha256) {
        try {
            if (hash(await regularBytes(target, 'manifest.json')) !== journal.manifestSha256) throw new Error('Manifest differs.');
            await verifyFiles(target, journal.nextFiles.filter(row => journal.generatedFiles.includes(row.name)));
            await validate(target);
            promoted = true;
        }
        catch { /* Restore below, retaining concurrent unowned files. */ }
    }
    if (!promoted && (hasRollback || !journal.previousFiles.length)) {
        if (hasRollback) await verifyFiles(rollback, journal.previousFiles);
        const restore = path.join(root, 'restore');
        const failed = path.join(root, 'failed');
        if (await exists(restore)) { await inventory(restore); await fs.rm(restore, { recursive: true }); }
        if (hasRollback) await fs.cp(rollback, restore, { recursive: true, errorOnExist: true, force: false });
        else await fs.mkdir(restore);
        const currentRoot = await exists(target) ? target : await exists(failed) ? failed : null;
        let current = [];
        if (currentRoot) {
            const owned = new Set(hasStage ? [] : journal.generatedFiles);
            current = await inventory(currentRoot);
            const currentNames = new Set(current.map(row => row.name));
            for (const row of current) {
                if (!owned.has(row.name)) await copyFile(currentRoot, restore, row.name, { replace: true });
            }
            // A user's deletion of a carried file is a concurrent change too.
            if (!hasStage) for (const name of journal.unrelatedFiles) if (!currentNames.has(name)) await fs.unlink(within(restore, name));
            await verifyFiles(currentRoot, current);
        }
        await verifyFiles(restore, journal.previousFiles.filter(row => !journal.unrelatedFiles.includes(row.name)));
        if (interruptAt === 'restore-prepared') throw new Error('Interrupted recovery at restore-prepared.');
        if (await exists(target)) {
            if (currentRoot !== target) throw new Error('Concurrent changes to recovery target.');
            if (await exists(failed)) { await inventory(failed); await fs.rm(failed, { recursive: true }); }
            // Keep the failed tree inside this operation until restoration has succeeded.
            await renameTree(target, failed, async () => {
                if (stableInventory(await inventory(target)) !== stableInventory(current)) throw new Error('Concurrent changes to recovery target.');
            });
            if (stableInventory(await inventory(failed)) !== stableInventory(current)) throw new Error('Concurrent changes to recovery target.');
        }
        if (interruptAt === 'failed-moved') throw new Error('Interrupted recovery at failed-moved.');
        if (hasRollback || (await inventory(restore)).length) await renameTree(restore, target);
        await verifyFiles(target, journal.previousFiles.filter(row => !journal.unrelatedFiles.includes(row.name)));
    }
    else if (!promoted && journal.previousFiles.length) {
        await verifyFiles(target, journal.previousFiles);
    }
    await cleanup(root, lock.operationId, lockName);
    return { state: promoted ? 'verified-promoted' : 'restored' };
}

/** One exclusive staging root; caller must identify exactly the superseded generated files. */
export async function publishDataset({ target, build, validate, ownedFiles, replace = false, interruptAt }) {
    target = path.resolve(target);
    const root = stagingRoot(target);
    const operationId = randomUUID();
    const lockName = `lock-${operationId}.json`;
    await fs.mkdir(path.dirname(root), { recursive: true });
    try { await fs.mkdir(root); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Publication lock exists; use recovery before retrying.'); throw error; }
    await fs.writeFile(path.join(root, lockName), jsonBytes({ operationId, pid: process.pid }), { flag: 'wx' });
    const stage = path.join(root, 'stage');
    const rollback = path.join(root, 'rollback');
    const journal = { operationId, target, state: 'building', previousFiles: [], nextFiles: [], generatedFiles: [], unrelatedFiles: [], manifestSha256: null };
    await journalWrite(root, journal);
    const interrupt = async state => {
        journal.state = state; await journalWrite(root, journal);
        if (interruptAt === state) {
            await fs.writeFile(path.join(root, lockName), jsonBytes({ operationId, pid: null }));
            const error = new Error('Simulated interrupted promotion: ' + state); error.interrupted = true; throw error;
        }
    };
    let moved = false;
    let promoted = false;
    try {
        const hadTarget = await exists(target);
        if (hadTarget) {
            journal.previousFiles = await inventory(target);
            if (journal.previousFiles.length && !replace) throw new Error('Output exists; explicit replacement is required.');
        }
        await journalWrite(root, journal);
        await fs.mkdir(stage);
        await build(stage);
        const generated = new Set((await inventory(stage)).map(row => row.name));
        const owned = new Set(ownedFiles ?? []);
        journal.generatedFiles = [...generated];
        journal.unrelatedFiles = journal.previousFiles.filter(row => !owned.has(row.name)).map(row => row.name);
        if (journal.previousFiles.length && !ownedFiles) throw new Error('Replacement requires an explicit owned-file inventory.');
        for (const row of journal.previousFiles) {
            if (owned.has(row.name)) continue;
            if (generated.has(row.name)) throw new Error('Publication would overwrite unrelated work: ' + row.name);
            await copyFile(target, stage, row.name);
        }
        await validate(stage);
        journal.nextFiles = await inventory(stage);
        journal.manifestSha256 = hash(await regularBytes(stage, 'manifest.json'));
        await interrupt('prepared');
        if (hadTarget) {
            await renameTree(target, rollback, async () => {
                if (stableInventory(await inventory(target)) !== stableInventory(journal.previousFiles)) throw new Error('Concurrent changes to publication target.');
            });
            moved = true;
            await verifyFiles(rollback, journal.previousFiles);
        }
        await interrupt('prior-moved');
        await renameTree(stage, target);
        promoted = true;
        await interrupt('promoted');
        await verifyFiles(target, journal.nextFiles);
        await validate(target);
        await interrupt('verified');
        await cleanup(root, operationId);
        return { state: 'verified-promoted', manifestSha256: journal.manifestSha256 };
    }
    catch (error) {
        if (error.interrupted) throw error;
        if (moved || promoted) {
            await fs.writeFile(path.join(root, lockName), jsonBytes({ operationId, pid: null }));
            await recoverPublication(target, { validate }).catch(recovery => { throw new AggregateError([error, recovery], 'Promotion and recovery failed; staging retained.'); });
        }
        else await cleanup(root, operationId);
        throw error;
    }
}
const stableInventory = rows => JSON.stringify(rows);

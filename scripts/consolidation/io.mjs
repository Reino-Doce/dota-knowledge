import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => JSON.stringify(value, null, 2) + '\n';
export const escapePointer = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
export const git = (root, args, encoding = 'utf8') => execFileSync('git', ['-C', root, ...args], {
    encoding, maxBuffer: 128 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});

export function within(root, name) {
    if (typeof name !== 'string' || !name || /[\\:\x00-\x1f]/.test(name)
        || name.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Unsafe relative path: ' + name);
    }
    const resolved = path.resolve(root, ...name.split('/'));
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('Path escapes root: ' + name);
    }
    return resolved;
}

export async function regularFile(root, name) {
    const target = within(root, name);
    let current = root;
    for (const part of name.split('/')) {
        current = path.join(current, part);
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symlink input is not allowed: ' + name);
    }
    if (!(await fs.stat(target)).isFile()) throw new Error('Expected a regular file: ' + name);
    return fs.readFile(target);
}

export async function filesUnder(root, prefix = '') {
    const result = [];
    for (const entry of await fs.readdir(prefix ? within(root, prefix) : root, { withFileTypes: true })) {
        const name = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isSymbolicLink()) throw new Error('Symlink input is not allowed: ' + name);
        if (entry.isDirectory()) result.push(...await filesUnder(root, name));
        else if (entry.isFile()) result.push(name);
    }
    return result.sort();
}

export async function writeJson(root, name, value) {
    const target = within(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, json(value), { flag: 'wx' });
}

export async function reserveOutput(repository, picker, output) {
    const contains = (parent, child) => {
        const relative = path.relative(parent, child);
        return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    const validate = target => {
        if (contains(target, repository) || picker && (contains(target, picker) || contains(picker, target))
            || contains(repository, target) && !contains(path.join(repository, 'evidence/consolidation'), target)) {
            throw new Error('Audit output must be outside the source checkouts or under library evidence/consolidation.');
        }
    };
    validate(output);
    // Resolve the existing ancestor before creating anything, including junctions.
    let ancestor = path.dirname(output);
    const suffix = [path.basename(output)];
    for (;;) {
        try {
            const resolved = path.join(await fs.realpath(ancestor), ...suffix);
            validate(resolved);
            await fs.mkdir(path.dirname(resolved), { recursive: true });
            await fs.mkdir(resolved);
            return resolved;
        }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            suffix.unshift(path.basename(ancestor));
            ancestor = path.dirname(ancestor);
        }
    }
}

export function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
        .map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    return JSON.stringify(value);
}

// Empty containers are leaves too, so explicit absence is part of coverage.
export function leafCount(value) {
    if (!value || typeof value !== 'object') return 1;
    const values = Object.values(value);
    return values.length ? values.reduce((total, child) => total + leafCount(child), 0) : 1;
}

export function fieldRow(file, pointer, value, destination, identity = null) {
    return { file, pointer, identity, destination, scope: 'entire-subtree',
        leaves: leafCount(value), semanticSha256: hash(stable(value)) };
}

export function gitTree(root, revision) {
    return git(root, ['ls-tree', '-r', '-z', revision]).split('\0').filter(Boolean).map(line => {
        const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
        if (!match || match[2] !== 'blob' || !['100644', '100755'].includes(match[1])) {
            throw new Error('Baseline contains an unsupported tree entry.');
        }
        within(root, match[4]);
        return { name: match[4], oid: match[3], mode: match[1] };
    });
}

export function blobHash(bytes, oid) {
    return createHash(oid.length === 64 ? 'sha256' : 'sha1')
        .update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
}

export async function restoreBaseline({ repository, revision, archive, entries }) {
    // No checkout/reset: archive expansion and cleanup are confined to our new directory.
    git(repository, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar.gz', '--output=' + archive, revision]);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dota-knowledge-restore-'));
    const owned = await fs.realpath(temporary);
    try {
        execFileSync('tar', ['-xzf', archive, '-C', owned], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const names = await filesUnder(owned);
        if (names.length !== entries.length) throw new Error('Restored baseline file count differs from Git.');
        let bytes = 0;
        for (const entry of entries) {
            const contents = await regularFile(owned, entry.name);
            if (blobHash(contents, entry.oid) !== entry.oid) throw new Error('Restored baseline differs: ' + entry.name);
            bytes += contents.length;
        }
        const tests = ['tests/semantic-diff.test.mjs', 'tests/population-import.test.mjs', 'tests/store.test.mjs']
            .filter(name => names.includes(name));
        if (tests.length) execFileSync(process.execPath, ['--test', ...tests], {
            cwd: owned, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const archived = await fs.readFile(archive);
        return { state: 'verified', revision, files: entries.length, bytes,
            archive: { name: path.basename(archive), bytes: archived.length, sha256: hash(archived) },
            verification: 'Every restored file matched its committed Git blob; isolated focused tests passed.', tests };
    }
    finally {
        const parent = await fs.realpath(os.tmpdir());
        if (path.dirname(owned) !== parent || !path.basename(owned).startsWith('dota-knowledge-restore-')
            || await fs.realpath(temporary) !== owned) throw new Error('Refusing unsafe restoration cleanup.');
        await fs.rm(owned, { recursive: true });
    }
}

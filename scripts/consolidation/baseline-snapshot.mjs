import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readJson } from '../../src/node/canonical.mjs';
import { hash } from '../../src/canonical-model.mjs';
import { gitTree, git, blobHash, regularFile as regularBytes, within } from './io.mjs';

/** Exact archive recovery, always isolated from active data and persistent acquisitions. */
export async function withBaselineSnapshot({ audit, repository, tooling = false, evidence = false, clone = false }, use) {
    const report = await readJson(audit, 'index.json');
    const recovery = await readJson(audit, 'recovery.json');
    const archive = await regularBytes(audit, 'baseline.tar.gz');
    if (report.state !== 'complete' || recovery.state !== 'verified' || hash(archive) !== recovery.archive.sha256
        || archive.length !== recovery.archive.bytes) throw new Error('Baseline recovery archive integrity mismatch.');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-baseline-'));
    const snapshot = path.join(temporary, 'snapshot');
    try {
        if (clone) {
            execFileSync('git', ['clone', '--shared', '--no-checkout', '--quiet', repository, snapshot], { windowsHide: true, stdio: 'pipe' });
            git(snapshot, ['update-ref', 'HEAD', report.libraryRevision]);
            git(snapshot, ['read-tree', report.libraryRevision]);
        }
        else await fs.mkdir(snapshot);
        execFileSync('tar', ['-xzf', path.resolve(audit, 'baseline.tar.gz'), '-C', snapshot], { windowsHide: true, stdio: 'pipe' });
        const entries = gitTree(repository, report.libraryRevision);
        for (const entry of entries) {
            if (blobHash(await regularBytes(snapshot, entry.name), entry.oid) !== entry.oid) throw new Error('Restored baseline blob differs: ' + entry.name);
        }
        if (tooling) for (const file of report.tooling) {
            const bytes = await regularBytes(audit, file.retainedFile);
            if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Phase A tooling differs.');
            const destination = within(snapshot, file.path);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, bytes);
        }
        if (evidence) {
            for (const file of (await readJson(audit, 'evidence.json')).files) {
                const bytes = await regularBytes(repository, file.path);
                if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Acquisition evidence differs: ' + file.path);
                const destination = within(snapshot, file.path);
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.writeFile(destination, bytes, { flag: 'wx' });
            }
            await fs.symlink(path.resolve(repository, 'node_modules'), path.join(snapshot, 'node_modules'), 'junction');
        }
        return await use(snapshot, { revision: report.libraryRevision, files: entries.length, archiveSha256: recovery.archive.sha256 });
    }
    finally {
        if (path.dirname(await fs.realpath(temporary)) !== await fs.realpath(os.tmpdir()) || !path.basename(temporary).startsWith('knowledge-baseline-')) throw new Error('Unsafe baseline cleanup.');
        await fs.rm(temporary, { recursive: true });
    }
}

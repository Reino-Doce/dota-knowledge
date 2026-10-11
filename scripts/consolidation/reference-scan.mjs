import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { hash } from '../../src/canonical-model.mjs';
import { filesUnder } from './io.mjs';
import { regularBytes, within } from '../../src/node/canonical.mjs';

/** Terms and exact, hash-bound exceptions live in a caller-supplied archival policy. */
export async function scanReferences({ root, policy, roots = policy.roots }) {
    if (policy.schemaVersion !== 1 || !Array.isArray(policy.terms) || !policy.terms.length
        || policy.terms.some(term => typeof term !== 'string' || !term.trim()) || !Array.isArray(roots) || !roots.length) throw new Error('Invalid reference-scan policy.');
    const names = new Set();
    for (const name of roots) {
        if (name === '.') { for (const file of await filesUnder(root)) names.add(file); continue; }
        const stat = await fs.lstat(within(root, name));
        if (stat.isSymbolicLink()) throw new Error('Reference scan cannot follow links.');
        if (stat.isDirectory()) for (const file of await filesUnder(path.join(root, name))) names.add(name + '/' + file);
        else names.add(name);
    }
    const hits = []; const exceptions = []; const used = new Set(); let decompressed = 0;
    for (const name of [...names].sort()) {
        const bytes = await regularBytes(root, name);
        const decoded = name.endsWith('.gz') ? gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }) : bytes;
        if (name.endsWith('.gz')) decompressed++;
        const content = decoded.toString('utf8').toLowerCase();
        const terms = policy.terms.filter(term => name.toLowerCase().includes(term.toLowerCase()) || content.includes(term.toLowerCase()));
        if (!terms.length) continue;
        const hit = { path: name, terms, sha256: hash(bytes) };
        const allowed = (policy.exceptions ?? []).find(row => row.path === name && row.sha256 === hit.sha256 && row.reason
            && Array.isArray(row.terms) && terms.every(term => row.terms.includes(term)));
        if (allowed) { exceptions.push({ ...hit, reason: allowed.reason }); used.add(allowed); }
        else hits.push(hit);
    }
    if ((policy.exceptions ?? []).some(row => !used.has(row))) throw new Error('Unused or stale reference-scan exception.');
    return { state: hits.length ? 'failed' : 'passed', files: names.size, decompressed, hits, exceptions };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const { values } = parseArgs({ options: { policy: { type: 'string' }, root: { type: 'string' } }, strict: true });
    if (!values.policy) throw new Error('Supply --policy <archived-policy.json>.');
    const result = await scanReferences({ root: path.resolve(values.root ?? '.'), policy: JSON.parse(await fs.readFile(values.policy)) });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.state !== 'passed') process.exitCode = 1;
}

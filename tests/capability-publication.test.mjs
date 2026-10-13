import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { graphFixture } from './fixtures/canonical-graph.mjs';
import { readCanonical, writeCanonical, readJson, jsonBytes } from '../src/node/canonical.mjs';
import { hash } from '../src/canonical-model.mjs';
import { compileCanonical } from '../scripts/compile-canonical.mjs';

test('compilation repairs stale valid-hash tag and category scores from fresh generated tags', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dota-profile-capabilities-'));
    t.after(async () => {
        assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(root).startsWith('dota-profile-capabilities-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    const graph = graphFixture();
    graph.entities.heroes[0].capabilities = { heal: 99 };
    await writeCanonical(root, graph);
    const record = graph.heroIndex.find(row => row.id === graph.entities.heroes[0].id).profile;
    const correct = await readJson(root, record);
    assert.deepEqual(correct.capabilities, {});
    const stale = { ...correct, capabilities: { sustain: 99 } };
    const bytes = jsonBytes(stale);
    await fs.writeFile(path.join(root, record), bytes);
    const manifest = await readJson(root, 'manifest.json');
    Object.assign(manifest.sourceFiles.find(row => row.name === record), { bytes: bytes.length, sha256: hash(bytes) });
    await fs.writeFile(path.join(root, 'manifest.json'), jsonBytes(manifest));
    await assert.rejects(readCanonical(root), /capabilit/i);
    await compileCanonical({ dataset: root });
    assert.deepEqual((await readJson(root, record)).capabilities, {});
    assert.deepEqual((await readCanonical(root)).entities.heroes[0].capabilities, {});
});

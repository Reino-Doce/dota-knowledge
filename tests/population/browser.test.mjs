import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildCollector, createElectronClient } from '../../scripts/population/browser.mjs';
import { parseMatchupsExact } from '../../scripts/population/parse.mjs';

test('generated browser request executes with fixture responses and shares the exact Node parser', async () => {
    const html = await fs.readFile(new URL('./fixtures/matchups.html', import.meta.url), 'utf8');
    const script = buildCollector({ provider: 'dotabuff', operation: 'matchups', slug: 'bristleback' });
    const paths = [];
    const result = await vm.runInNewContext(script, { location: { origin: 'https://www.dotabuff.com' },
        fetch: async (url, options) => { paths.push(url); assert.equal(options.credentials, 'include'); return new Response(html); } });
    assert.deepEqual(paths, ['/heroes/bristleback/matchups']);
    assert.deepEqual(parseMatchupsExact(result.text), parseMatchupsExact(html));
    await assert.rejects(vm.runInNewContext(script, { location: { origin: 'https://dotabuff.com.attacker.invalid' } }), /origin/);
    assert.throws(() => buildCollector({ provider: 'dotabuff', operation: 'matchups', slug: '../escape' }), /Unsupported/);
});

test('optional browser uses a separate session, sandbox, human challenge and owned-window cleanup', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'population-browser-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const evidence = path.join(root, 'evidence'); await fs.mkdir(evidence);
    let win; let shown = 0; let challenged = 0; let evaluated = 0; let options; let usedSession;
    const electron = { app: { whenReady: async () => {} }, session: { fromPath: directory => {
        usedSession = directory; return { setPermissionRequestHandler() {} };
    } }, BrowserWindow: class {
        constructor(input) { options = input; win = this; this.destroyed = false;
            this.webContents = { setWindowOpenHandler() {}, on() {}, executeJavaScript: async () => ++evaluated === 1
                ? { status: 403, challenged: true, text: 'challenge' } : { status: 200, text: 'fixture' } }; }
        async loadURL(url) { assert.equal(url, 'https://www.dotabuff.com/heroes'); }
        isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; } show() { shown++; }
    } };
    const controller = new AbortController(); let clock = 0;
    const input = { electron, sessionDirectory: path.join(root, 'session'), evidenceDirectory: evidence,
        clock: () => new Date(clock), sleep: async ms => { clock += ms; }, signal: controller.signal, logger: () => {},
        onChallenge: async () => { challenged++; }, challengeTimeoutMs: 10000 };
    const client = await createElectronClient(input);
    const response = await client({ provider: 'dotabuff', operation: 'hero-stats' }, { signal: controller.signal });
    assert.equal(await response.text(), 'fixture'); assert.equal(challenged, 1); assert.equal(shown, 1);
    assert.equal(usedSession, path.join(root, 'session')); assert.equal(options.webPreferences.sandbox, true);
    assert.equal(options.webPreferences.nodeIntegration, false); assert.equal(options.webPreferences.contextIsolation, true);
    controller.abort(); assert.equal(win.destroyed, true); await client.close();
    electron.session.fromPath = () => ({ setPermissionRequestHandler() { throw new Error('setup failure'); } });
    await assert.rejects(createElectronClient({ ...input, signal: new AbortController().signal }), /setup failure/);
    assert.equal(win.destroyed, true);
    await assert.rejects(createElectronClient({ ...input, signal: new AbortController().signal, sessionDirectory: path.join(evidence, 'session') }), /separate/);
});

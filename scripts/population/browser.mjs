import path from 'node:path';
import fs from 'node:fs/promises';
import { checkSignal, PopulationError } from './request.mjs';

const ORIGIN = 'https://www.dotabuff.com';
export function dotabuffPath(request) {
    if (request.provider !== 'dotabuff') throw new Error('Browser collector only supports Dotabuff.');
    if (request.operation === 'hero-stats') return '/heroes';
    if (request.operation === 'matchups' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.slug)) return `/heroes/${request.slug}/matchups`;
    if (request.operation === 'lane-table' && ['mid', 'safe', 'off', 'jungle', 'roaming'].includes(request.lane)) return '/heroes/lanes?lane=' + request.lane;
    throw new Error('Unsupported browser request.');
}
/** One response at a time; parsing and durable progress remain outside the page. */
export function buildCollector(request) {
    const resource = dotabuffPath(request);
    return `(async () => {
        if (location.origin !== ${JSON.stringify(ORIGIN)}) throw new Error('Unexpected collector origin.');
        const response = await fetch(${JSON.stringify(resource)}, { credentials: 'include', headers: { Accept: 'text/html' } });
        return { status: response.status, text: await response.text(), challenged: response.headers.get('cf-mitigated') === 'challenge' };
    })()`;
}

/** Electron is injected and never imported by ordinary runtime or collector imports. */
export async function createElectronClient({ electron, sessionDirectory, evidenceDirectory, clock, sleep, signal, logger,
    onChallenge, challengeTimeoutMs }) {
    if (!electron?.BrowserWindow || !path.isAbsolute(sessionDirectory ?? '') || !path.isAbsolute(evidenceDirectory ?? '')
        || typeof onChallenge !== 'function' || typeof clock !== 'function' || typeof sleep !== 'function'
        || typeof logger !== 'function' || !(signal instanceof AbortSignal) || !Number.isSafeInteger(challengeTimeoutMs) || challengeTimeoutMs < 1) throw new Error('Browser collection requires explicit session, challenge and lifetime inputs.');
    await fs.mkdir(sessionDirectory, { recursive: true });
    const sessionRoot = await fs.realpath(sessionDirectory); const evidenceRoot = await fs.realpath(evidenceDirectory);
    if (sessionRoot === evidenceRoot || sessionRoot.startsWith(evidenceRoot + path.sep) || evidenceRoot.startsWith(sessionRoot + path.sep)) throw new Error('Browser sessions must be separate from population evidence.');
    checkSignal(signal); await electron.app.whenReady(); checkSignal(signal);
    const session = electron.session.fromPath(sessionRoot);
    const win = new electron.BrowserWindow({ show: false, width: 1280, height: 900,
        webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const close = () => { if (!win.isDestroyed()) win.destroy(); };
    try {
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== ORIGIN) event.preventDefault(); });
        session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        signal.addEventListener('abort', close, { once: true });
    }
    catch (error) { signal.removeEventListener('abort', close); close(); throw error; }
    let ready = false; let busy = false;
    const client = async (request, { signal: requestSignal }) => {
        if (busy) throw new Error('Browser client is serial.');
        const requestAbort = () => close();
        busy = true; requestSignal.addEventListener('abort', requestAbort, { once: true });
        try {
            checkSignal(signal); checkSignal(requestSignal);
            if (!ready) { await win.loadURL(ORIGIN + '/heroes'); ready = true; }
            const deadline = clock().getTime() + challengeTimeoutMs;
            let prompted = false;
            for (;;) {
                checkSignal(signal); checkSignal(requestSignal);
                if (win.isDestroyed()) throw new PopulationError('browser-closed', { fatal: true });
                const result = await win.webContents.executeJavaScript(buildCollector(request), true);
                if (!result.challenged && result.status !== 403 && !/cf-chl-|Just a moment/i.test(result.text)) return new Response(result.text, { status: result.status, headers: { 'content-type': 'text/html' } });
                if (!prompted) {
                    prompted = true; win.show(); logger({ event: 'human-challenge-required', provider: 'dotabuff' });
                    await onChallenge({ window: win, signal: requestSignal });
                }
                if (clock().getTime() >= deadline) throw new PopulationError('challenge', { fatal: true });
                await sleep(1000, requestSignal);
            }
        }
        finally { busy = false; requestSignal.removeEventListener('abort', requestAbort); }
    };
    client.close = async () => { signal.removeEventListener('abort', close); close(); };
    return client;
}

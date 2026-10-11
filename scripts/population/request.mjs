import { parseResponseJson } from './exact.mjs';

export class PopulationError extends Error {
    constructor(code, { fatal = false } = {}) { super('Population request failed: ' + code); this.code = code; this.fatal = fatal; }
}
export function checkSignal(signal) { if (signal.aborted) throw new PopulationError('cancelled', { fatal: true }); }
export const timestamp = clock => {
    const date = clock();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('Invalid injected clock.');
    return date.toISOString();
};

/** Only safe request descriptors leave the library. Credentials stay in client closures. */
export async function requestBytes(request, { clients, signal, clock, sleep, limits, logger }) {
    const client = clients[request.provider];
    if (typeof client !== 'function') throw new PopulationError('client-missing', { fatal: true });
    for (let attempt = 0; attempt <= limits.retries; attempt++) {
        checkSignal(signal);
        const controller = new AbortController();
        let timer;
        let abort;
        const interrupted = new Promise((_, reject) => {
            abort = () => { controller.abort(); reject(new PopulationError('cancelled', { fatal: true })); };
            signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => { controller.abort(); reject(new PopulationError('timeout')); }, limits.timeoutMs);
        });
        let retryMs = Math.min(limits.maxWaitMs, 1000 * 2 ** (attempt + 1));
        try {
            const operation = (async () => {
                const response = await client(structuredClone(request), { signal: controller.signal });
                if (controller.signal.aborted) { await response?.body?.cancel().catch(() => {}); throw new PopulationError('timeout'); }
                const status = response?.status;
                if (status === 401 || status === 403) {
                    await response.body?.cancel().catch(() => {});
                    throw new PopulationError(response.headers?.get('cf-mitigated') === 'challenge' ? 'challenge' : 'authentication', { fatal: true });
                }
                if (status === 429 || status >= 500) {
                    const raw = response.headers?.get('retry-after');
                    const wait = raw && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - clock().getTime() : null;
                    if (wait !== null && Number.isFinite(wait)) retryMs = Math.max(0, wait);
                    const spent = ['day', 'hour'].some(unit => response.headers?.get('x-ratelimit-remaining-' + unit) === '0');
                    await response.body?.cancel().catch(() => {});
                    throw new PopulationError('rate-or-server', { fatal: spent || retryMs > limits.maxWaitMs });
                }
                if (status !== 200) { await response?.body?.cancel().catch(() => {}); throw new PopulationError('http', { fatal: true }); }
                if (!response.body?.getReader) throw new PopulationError('missing-body');
                const reader = response.body.getReader();
                const chunks = []; let size = 0;
                const cancel = () => { void reader.cancel().catch(() => {}); };
                controller.signal.addEventListener('abort', cancel, { once: true });
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (!(value instanceof Uint8Array) || value.length > limits.maxBytes - size) throw new PopulationError('size', { fatal: true });
                        size += value.length; chunks.push(value);
                    }
                }
                finally { controller.signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
                const bytes = Buffer.concat(chunks);
                if (!bytes.length) throw new PopulationError('empty-body');
                const text = bytes.toString('utf8');
                if (/cf-chl-|Just a moment|cf-error-details/i.test(text)) throw new PopulationError('challenge', { fatal: true });
                // Never save provider error envelopes (which may echo credentials).
                if (request.format === 'json') {
                    const body = parseResponseJson(bytes);
                    if (body?.errors?.length || body?.err || body?.error) throw new PopulationError('provider-error', { fatal: true });
                }
                return { bytes, retrievedAt: timestamp(clock) };
            })();
            const result = await Promise.race([operation, interrupted]);
            clearTimeout(timer);
            checkSignal(signal);
            await sleep(limits.spacingMs, signal);
            return result;
        }
        catch (error) {
            const safe = error instanceof PopulationError ? error : new PopulationError('transport');
            if (signal.aborted) checkSignal(signal);
            if (safe.fatal || attempt === limits.retries) throw safe;
            logger({ event: 'retry', provider: request.provider, code: safe.code, attempt: attempt + 1 });
        }
        finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
        await sleep(retryMs, signal);
    }
}

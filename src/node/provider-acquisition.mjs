import { sha256Hex } from '../sha256.mjs';

/** Acquire one provider artifact through a caller-owned client and credential set. */
export async function acquireProviderArtifact({ providerId, client, request, credentials, timeoutMs = 15000,
    maxBytes = 16 * 1024 * 1024, clock = () => new Date() } = {}) {
    if (typeof providerId !== 'string' || !providerId || typeof client !== 'function'
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024
        || typeof clock !== 'function') throw new TypeError('Provider acquisition requires an injected client and bounded request options.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Provider acquisition timed out.')), timeoutMs);
    try {
        const response = await client(request, { signal: controller.signal, credentials });
        if (!response?.ok || !response.body?.getReader) throw new Error(`Provider ${providerId} response is unavailable.`);
        const declared = response.headers?.get('content-length');
        if (declared !== null && declared !== undefined) {
            if (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maxBytes)) {
                await response.body.cancel().catch(() => {});
                throw new Error(`Provider ${providerId} response exceeds its byte limit.`);
            }
        }
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!(value instanceof Uint8Array) || value.byteLength > maxBytes - length) {
                    await reader.cancel().catch(() => {});
                    throw new Error(`Provider ${providerId} response exceeds its byte limit.`);
                }
                chunks.push(value);
                length += value.byteLength;
            }
        }
        finally {
            reader.releaseLock();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        const retrievedAt = clock();
        if (!(retrievedAt instanceof Date) || !Number.isFinite(retrievedAt.getTime())) {
            throw new TypeError('Provider acquisition clock must return a valid Date.');
        }
        return Object.freeze({ providerId, bytes, byteLength: bytes.byteLength,
            sha256: sha256Hex(bytes), retrievedAt: retrievedAt.toISOString(),
            contentType: response.headers?.get('content-type') ?? null });
    }
    finally {
        clearTimeout(timer);
    }
}

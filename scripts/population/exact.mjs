/** Response bytes must reach this parser before any numeric JSON decoding. */
export function parseResponseJson(bytes) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text, (_key, value, context) => {
        if (typeof value !== 'number') return value;
        if (/^-?\d+$/.test(context.source)) return context.source;
        if (!Number.isFinite(value)) throw new Error('Non-finite response number.');
        return value;
    });
}

export function decimal(value) {
    if (typeof value === 'bigint') value = value.toString();
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Expected an exact non-negative decimal integer.');
        value = String(value);
    }
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new Error('Expected an exact non-negative decimal integer.');
    return value;
}
export const addCounts = (...values) => values.reduce((sum, value) => sum + BigInt(decimal(value)), 0n).toString();
export function compareIds(a, b) {
    a = decimal(a); b = decimal(b);
    // Canonical unsigned decimal strings sort numerically by length, then lexically.
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}
export function boundedInteger(value, min, max) {
    const n = Number(decimal(value));
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('Integer is outside the supported range.');
    return n;
}
export function counts(games, wins) {
    games = decimal(games); wins = decimal(wins);
    if (BigInt(wins) > BigInt(games)) throw new Error('Wins exceed games.');
    return { games, wins };
}
export function safeCount(value) {
    const n = BigInt(decimal(value));
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}
export const unavailable = () => ({ state: 'unavailable', reason: 'Counts exceed the exact floating-point recipe domain.' });
export function numericCounts(value) {
    if (Array.isArray(value)) return value.map(numericCounts);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, numericCounts(child)]));
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        const n = safeCount(value);
        if (n === null) throw new Error('Counts exceed the exact floating-point recipe domain.');
        return n;
    }
    return value;
}

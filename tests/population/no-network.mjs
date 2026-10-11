import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const local = value => /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(value);
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!local(url.hostname)) throw new Error('Unexpected network access in tests.');
    return originalFetch(input, options);
};
for (const module of [http, https]) for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = (...args) => {
        const input = args[0];
        const host = typeof input === 'string' || input instanceof URL ? new URL(input).hostname : input.hostname ?? input.host ?? 'localhost';
        if (!local(host)) throw new Error('Unexpected network access in tests.');
        return original(...args);
    };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const input = Array.isArray(args[0]) ? args[0] : args;
    const host = typeof input[0] === 'object' ? input[0].host : typeof input[1] === 'string' ? input[1] : 'localhost';
    if (host && !local(host)) throw new Error('Unexpected socket access in tests.');
    return connect.apply(this, args);
};
syncBuiltinESMExports();

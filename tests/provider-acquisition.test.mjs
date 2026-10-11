import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { heroSourcePath } from '../scripts/collect-valve-hero-data.mjs';

test('new provider hero artifacts use canonical keys while original acquisitions keep their names', () => {
    const hero = { heroId: '1', key: 'antimage', heroKey: 'npc_dota_hero_antimage', name: 'Anti-Mage' };
    assert.equal(heroSourcePath(hero), 'sources/heroes/antimage.json');
    assert.equal(heroSourcePath(hero, { legacy: true }), 'sources/heroes/1.json');
    assert.throws(() => heroSourcePath({ ...hero, key: 'anti-mage' }), /Invalid/);
    assert.throws(() => heroSourcePath({ ...hero, key: '../escape' }), /Invalid/);
});
import { acquireProviderArtifact } from '../src/node/provider-acquisition.mjs';

test('provider acquisition uses only injected client and credentials and records exact bytes', async () => {
    const expected = new TextEncoder().encode('{"ok":true}');
    let received;
    const result = await acquireProviderArtifact({ providerId: 'test-provider', request: { query: 'sample' },
        credentials: { token: 'injected' }, client: async (request, options) => {
            received = { request, options };
            return new Response(expected, { headers: { 'content-type': 'application/json' } });
        }, clock: () => new Date('2026-10-11T00:00:00.000Z') });
    assert.equal(received.request.query, 'sample');
    assert.equal(received.options.credentials.token, 'injected');
    assert.ok(received.options.signal instanceof AbortSignal);
    assert.equal(result.providerId, 'test-provider');
    assert.equal(result.byteLength, expected.byteLength);
    assert.equal(result.sha256, createHash('sha256').update(expected).digest('hex'));
    assert.equal(result.retrievedAt, '2026-10-11T00:00:00.000Z');
    assert.equal(result.contentType, 'application/json');
});

test('provider acquisition bounds streamed bytes and rejects malformed clocks', async () => {
    await assert.rejects(acquireProviderArtifact({ providerId: 'bounded', request: {}, maxBytes: 3,
        client: async () => new Response(new Uint8Array([1, 2, 3, 4])) }), /byte limit/);
    await assert.rejects(acquireProviderArtifact({ providerId: 'clock', request: {},
        client: async () => new Response('ok'), clock: () => 'not-a-date' }), /valid Date/);
});

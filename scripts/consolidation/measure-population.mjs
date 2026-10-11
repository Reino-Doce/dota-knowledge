// Dedicated, offline frozen-fixture worker. Audit source bytes are verified before import.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hash, semanticHash } from '../../src/canonical-model.mjs';
import { createRoster } from '../population/identity.mjs';
import { foldSynergy } from '../population/normalize.mjs';
import { parseMatchupsExact } from '../population/parse.mjs';

const { values } = parseArgs({ options: { audit: { type: 'string' }, kind: { type: 'string' } } });
if (!values.audit || !['baseline', 'population'].includes(values.kind) || !global.gc) throw new Error('Supply --audit, --kind and --expose-gc.');
const audit = path.resolve(values.audit);
const inventory = JSON.parse(await fs.readFile(path.join(audit, 'picker.json')));
for (const name of ['synergy.mjs', 'synergy-math.mjs', 'assign.mjs', 'progress.mjs', 'parse.mjs']) {
    const descriptor = inventory.entries.find(row => row.path === 'scripts/' + name);
    if (hash(await fs.readFile(path.join(audit, descriptor.retainedFile))) !== descriptor.sha256) throw new Error('Frozen source integrity mismatch.');
}
const baseline = await import(pathToFileURL(path.join(audit, 'inputs/picker/scripts/synergy.mjs')));
const parser = await import(pathToFileURL(path.join(audit, 'inputs/picker/scripts/parse.mjs')));
const fixture = inventory.entries.find(row => row.path === 'scripts/fixtures/matchups.html');
const html = await fs.readFile(path.join(audit, fixture.retainedFile), 'utf8');
if (hash(Buffer.from(html)) !== fixture.sha256) throw new Error('Frozen fixture integrity mismatch.');
const heroes = Array.from({ length: 40 }, (_, i) => ({ id: String(i + 1), key: 'hero' + (i + 1), sourceKey: 'npc_dota_hero_hero' + (i + 1) }));
const roster = createRoster(heroes);
const rows = Array.from({ length: 100000 }, (_, i) => ({ t: Array.from({ length: 5 }, (_, j) => (i * 7 + j * 3) % 40 + 1), w: i % 3 === 0 }));
const priors = new Map(heroes.map(hero => [Number(hero.id), Object.fromEntries([1,2,3,4,5].map(pos => [pos, pos === Number(hero.id) % 5 + 1 ? .8 : .05]))]));
const stringPriors = Object.fromEntries(priors);
const convert = value => {
    if (value instanceof Map) return [...value].map(([key, child]) => [String(key), convert(child)]).sort(([a], [b]) => a.localeCompare(b));
    if (Array.isArray(value)) return value.map(convert);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, ['a','b','games','wins','ambiguous'].includes(key) ? String(child) : convert(child)]));
    return value;
};
global.gc(); const before = process.memoryUsage(); let result;
const started = performance.now();
if (values.kind === 'baseline') { result = { heroes: new Map(), pairs: new Map(), ambiguous: 0 }; baseline.fold(rows, result, priors); }
else result = foldSynergy(rows, roster, stringPriors);
const foldMs = performance.now() - started;
const resultSha256 = semanticHash(convert(result));
global.gc(); const retained = process.memoryUsage();
const parseStart = performance.now(); let parsed;
for (let i = 0; i < 1000; i++) parsed = values.kind === 'baseline' ? parser.parseMatchups(html).map(row => ({ ...row, matches: String(row.matches) })) : parseMatchupsExact(html);
console.log(JSON.stringify({ kind: values.kind, teamRows: rows.length, parsingIterations: 1000, foldMs,
    parseMs: performance.now() - parseStart, resultSha256, parserSha256: semanticHash(parsed),
    retainedHeapBytes: retained.heapUsed - before.heapUsed, peakRssBytes: process.resourceUsage().maxRSS * 1024 }));

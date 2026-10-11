import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crosswalk, parseRoster, classifyScript, observationDestination, fileDestinations, heroFieldDestination, mapPickerData } from '../scripts/consolidation/policy.mjs';
import { within, regularFile, fieldRow, git, gitTree, restoreBaseline, reserveOutput } from '../scripts/consolidation/io.mjs';

const heroes = [
    { id: '1', heroId: '1', key: 'antimage', heroKey: 'npc_dota_hero_antimage', name: 'Anti-Mage', enabled: true },
    { id: '127', heroId: '127', key: 'target_dummy', heroKey: 'npc_dota_hero_target_dummy', name: 'Target dummy', enabled: false },
];
const roster = [{ slug: 'anti-mage', steam: 'antimage', name: 'Anti-Mage', attr: 'agi' }];

test('crosswalk uses existing keys, preserves IDs and exposes missing provider identities', () => {
    const rows = crosswalk(heroes, roster);
    assert.equal(rows[0].providerSlug, 'anti-mage');
    assert.equal(rows[0].key, 'antimage');
    assert.equal(rows[1].providerState, 'unavailable');
    assert.throws(() => crosswalk([...heroes, heroes[0]], roster), /identity/);
    assert.throws(() => crosswalk([{ ...heroes[0], key: '../axe' }], roster), /Unsafe/);
    assert.throws(() => crosswalk([{ ...heroes[0], heroKey: 'npc_dota_hero_axe' }], roster), /identity/);
    assert.throws(() => crosswalk(heroes, [...roster, { ...roster[0], slug: 'am' }]), /Duplicate/);
    assert.throws(() => crosswalk(heroes, [...roster, { slug: 'axe', steam: 'axe' }]), /Unmapped/);
    assert.deepEqual(parseRoster('  { slug: "anti-mage", name: "Anti-Mage", attr: "agi", steam: "antimage" },'), roster);
    assert.throws(() => parseRoster('  { slug: "anti-mage", steam: "antimage" },'), /Unrecognized/);
});

test('paths, scripts and observation kinds fail closed when not inventoried', () => {
    for (const name of ['../escape', 'a/../b', 'a\\b', 'C:/data', '/data', 'a//b', 'a/./b']) {
        assert.throws(() => within(os.tmpdir(), name), /path/i);
    }
    assert.equal(classifyScript('collector.test.mjs').owner, 'build-collector');
    assert.equal(classifyScript('calibrate.mjs').fate, 'split');
    assert.equal(classifyScript('readme-images.mjs').fate, 'retain in Picker');
    assert.throws(() => classifyScript('new-collector.mjs'), /Unclassified/);
    const byId = new Map(crosswalk(heroes, roster).map(hero => [hero.id, hero]));
    assert.equal(observationDestination({ heroId: '1', kind: 'historical-profile' }, byId), 'data/heroes/antimage/statistics.json');
    assert.equal(observationDestination({ heroId: '1', kind: 'synergy' }, byId), 'data/heroes/antimage/matchups/synergies.json');
    assert.throws(() => observationDestination({ heroId: '1', kind: 'future-kind' }, byId), /Unmapped/);
    assert.throws(() => observationDestination({ heroId: '999', kind: 'matchup' }, byId), /unknown hero/);
    assert.deepEqual(fileDestinations('runtime/guides/1.json', byId), [
        'data/heroes/antimage/guides/details.json', 'data/runtime/heroes/antimage/guide.json',
    ]);
    assert.throws(() => fileDestinations('new-data.json', byId), /Unmapped/);
    assert.equal(heroFieldDestination('effects', 'review', 'antimage'), 'data/reviews/bindings.json');
});

test('field digests bind exact counts, ordered ranks, unknowns and empty containers', () => {
    const value = { matchCount: '9007199254740993', ranks: [3, 1, 2], missing: null, empty: [], conflict: { state: 'conflicted' } };
    const row = fieldRow('old.json', '/record', value, 'data/heroes/antimage/statistics.json', 'observation:1');
    assert.equal(row.leaves, 7);
    assert.equal(row.scope, 'entire-subtree');
    assert.notEqual(row.semanticSha256, fieldRow('old.json', '/record', { ...value, ranks: [1, 2, 3] }, 'new.json').semanticSha256);
    assert.notEqual(row.semanticSha256, fieldRow('old.json', '/record', { ...value, matchCount: '9007199254740992' }, 'new.json').semanticSha256);
});

test('Picker pair mappings preserve direction, exact counts, calibration and both lane sides', () => {
    const mapping = crosswalk(heroes, roster);
    const data = { against: { 'anti-mage': { '1': { 'anti-mage': ['9007199254740993', 1, 0, 0, 1] } } },
        with: { 'anti-mage': { '5': { 'anti-mage': [10, 5, 0, 5, 5] } } } };
    const rows = mapPickerData('lanes.json', data, mapping);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.identity.direction), ['against', 'with']);
    assert.equal(rows[0].destination, 'data/heroes/antimage/statistics.json');
    assert.equal(rows[0].identity.position, '1');
    assert.throws(() => mapPickerData('lanes.json', { ...data, unaccounted: true }, mapping), /Unmapped Picker field/);
    assert.throws(() => mapPickerData('lanes.json', { against: { unknown: {} } }, mapping), /Unmapped Picker data hero/);
    const calibration = mapPickerData('calibration.json', { weights: { matchup: 0.25 }, se: { matchup: null }, inputs: { matchups: 'old-clock' } }, mapping);
    assert.ok(calibration.every(row => row.destination === 'data/observations/calibration.json'));
});

test('committed baseline restores exact bytes without touching dirty or untracked files', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dota-knowledge-audit-test-'));
    t.after(async () => {
        assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
        await fs.rm(root, { recursive: true });
    });
    const repository = path.join(root, 'repo');
    await fs.mkdir(repository);
    const picker = path.join(root, 'picker');
    await fs.mkdir(picker);
    await assert.rejects(reserveOutput(repository, picker, path.join(repository, 'data/bad')), /outside the source/);
    await assert.rejects(reserveOutput(repository, picker, path.join(picker, 'bad')), /outside the source/);
    const output = path.join(repository, 'evidence/consolidation/fixture');
    await reserveOutput(repository, picker, output);
    await assert.rejects(reserveOutput(repository, picker, output), { code: 'EEXIST' });
    await fs.writeFile(path.join(repository, '.gitignore'), 'evidence/\n');
    git(repository, ['init', '--quiet']);
    git(repository, ['config', 'core.autocrlf', 'true']);
    await fs.writeFile(path.join(repository, '.gitattributes'), 'record.json -text\n');
    await fs.writeFile(path.join(repository, 'record.json'), '{"count":"9007199254740993"}\n');
    git(repository, ['add', '.']);
    git(repository, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test baseline']);
    const revision = git(repository, ['rev-parse', 'HEAD']).trim();
    await fs.writeFile(path.join(repository, 'record.json'), 'uncommitted change');
    await fs.writeFile(path.join(repository, 'unrelated.txt'), 'preserve');
    const status = git(repository, ['status', '--porcelain']);
    const recovery = await restoreBaseline({ repository, revision, archive: path.join(root, 'baseline.tar.gz'), entries: gitTree(repository, revision) });
    assert.equal(recovery.state, 'verified');
    assert.equal(recovery.files, 3);
    assert.equal(git(repository, ['status', '--porcelain']), status);
    assert.equal((await regularFile(repository, 'record.json')).toString(), 'uncommitted change');
    assert.equal((await regularFile(repository, 'unrelated.txt')).toString(), 'preserve');
    await assert.rejects(regularFile(repository, '../escape'), /path/i);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { graphFixture } from './fixtures/canonical-graph.mjs';
import { mergeRecord, separateAttribution } from '../src/canonical-model.mjs';
import { validateImageDescriptor } from '../src/record-contracts.mjs';
import { writeCanonical, readCanonical, readJson } from '../src/node/canonical.mjs';
import { publishDataset, recoverPublication, inventory } from '../src/node/publish-dataset.mjs';
import { validateDataset, schemaValidators } from '../scripts/consolidation/validation.mjs';
import { compareGraphs } from '../scripts/compare-current.mjs';
import { loadKnowledgeDirectory } from '../src/node.mjs';

async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-migration-test-'));
    t.after(async () => {
        assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
        await fs.rm(root, { recursive: true });
    });
    return root;
}

test('profiles select native facts, retain historical aliases and every alias collision', () => {
    const graph = graphFixture();
    const hero = graph.entities.heroes[0];
    assert.equal(hero.primaryAttribute, 1);
    assert.equal(hero.complexity, 1);
    assert.deepEqual(hero.roles, [{ role: 'carry', level: 3 }, { role: 'escape', level: 2 }]);
    assert.ok(hero.aliases.includes('Magina'));
    assert.equal(graph.heroIndex[0].providerSlug, 'anti-mage');
    assert.equal(graph.heroIndex[0].profile, 'heroes/antimage/profile.json');
    assert.deepEqual(graph.aliases.find(row => row.alias === 'es').keys, ['antimage', 'earthshaker', 'target_dummy']);
    assert.equal(graph.entities.heroes[2].complexity, null);
    assert.equal(graph.entities.heroes[2].coverage.fields.complexity.state, 'unknown');
    assert.equal(graph.history[0].officialHero.primaryAttribute, 0);
    assert.equal(graph.observations[1].sourceRecord.complexity, 1.5);
});

test('duplicate observations merge only agreeing fields and retain exact counts and stored order', () => {
    const graph = graphFixture();
    assert.equal(graph.reconciliation.duplicateOccurrences, 1);
    assert.equal(graph.observations[0].matchCount, '9007199254740993');
    assert.deepEqual(graph.observations[0].storedHeroIds, ['7', '1']);
    assert.deepEqual(graph.observations[0].sourceRecord, ['7', '1', '9007199254740993']);
    assert.throws(() => mergeRecord({ id: 'same', cohort: { ranks: [3, 1] } }, { id: 'same', cohort: { ranks: [1, 3] } }), /Conflicting duplicate/);
    assert.throws(() => mergeRecord({ matchCount: '9007199254740993' }, { matchCount: '9007199254740992' }), /Conflicting duplicate/);
});

test('field bindings separate conflict attribution without erasing candidate values or typed states', () => {
    const bindings = [];
    const record = separateAttribution({ id: 'effect:x', values: { damage: { state: 'conflicted', unit: 'damage', conflicts: [
        { value: [1, 2], sourceId: 'source:a', claimId: 'claim:a' }, { value: [2, 3], sourceId: 'source:b' },
    ] } } }, bindings);
    assert.equal(record.values.damage.state, 'conflicted');
    assert.deepEqual(record.values.damage.conflicts[0], { value: [1, 2] });
    assert.deepEqual(bindings.map(row => row.field), ['/values/damage/conflicts/0/sourceId', '/values/damage/conflicts/0/claimId', '/values/damage/conflicts/1/sourceId']);
    const reviewBindings = [];
    const reviewed = separateAttribution({ id: 'effect:x', declarationReview: { version: 'audit-2', complete: false,
        corrections: [{ field: 'damage', reason: 'Native declaration correction.', sourceRefs: [] }] } }, reviewBindings);
    assert.equal(reviewed.declarationReview, undefined);
    assert.equal(reviewBindings[0].field, '/declarationReview');
    assert.equal(reviewBindings[0].value.version, 'audit-2');
});

test('identity comparison detects deletion, counts, effect order, cohorts and review promotion', () => {
    const graph = graphFixture();
    assert.equal(compareGraphs(graph, structuredClone(graph)).equivalent, true);
    const mutations = [
        copy => copy.observations.pop(),
        copy => { copy.observations[0].matchCount = '9007199254740994'; },
        copy => copy.entities.heroes[0].effectIds.reverse(),
        copy => { copy.observations[0].cohort.ranks = [1, 7]; },
        copy => { copy.claims[0].status = 'reviewed'; },
        copy => copy.entities.heroes.pop(),
        copy => copy.runtimeProjection.delete('observation:pair'),
    ];
    for (const mutate of mutations) { const copy = structuredClone(graph); mutate(copy); assert.equal(compareGraphs(graph, copy).equivalent, false); }
});

test('available and unavailable image contracts reject unsafe paths and invented availability', async () => {
    const schema = (await schemaValidators()).get('image-descriptor');
    const available = { id: 'image:1', entityKind: 'hero', entityId: '1', variant: 'portrait', state: 'available', path: 'heroes/antimage/images/profile.png',
        mediaType: 'image/png', width: 256, height: 144, bytes: 200, sha256: 'a'.repeat(64) };
    validateImageDescriptor(available); assert.equal(schema(available), true);
    for (const patch of [{ path: '../escape.png' }, { width: 0 }, { bytes: 1e20 }, { sha256: 'bad' }, { mediaType: 'text/html' }]) {
        assert.throws(() => validateImageDescriptor({ ...available, ...patch })); assert.equal(schema({ ...available, ...patch }), false);
    }
    const unavailable = { id: 'image:1', entityKind: 'hero', entityId: '1', variant: 'portrait', state: 'unavailable', reason: 'No asset acquired.' };
    validateImageDescriptor(unavailable); assert.equal(schema(unavailable), true);
    assert.throws(() => validateImageDescriptor({ ...unavailable, path: available.path }));
});

test('canonical serialization, offline recompilation and runtime lazy records round trip deterministically', async t => {
    const root = await temporary(t);
    const first = path.join(root, 'first'); const second = path.join(root, 'second');
    const graph = graphFixture();
    await writeCanonical(first, graph);
    const counts = await validateDataset(first); assert.equal(counts.observations, 2);
    const recovered = await readCanonical(first);
    assert.equal(compareGraphs(graph, recovered).equivalent, true);
    await writeCanonical(second, recovered);
    assert.deepEqual(await inventory(first), await inventory(second));
    const store = await loadKnowledgeDirectory(path.join(first, 'runtime/manifest.json'));
    assert.equal(store.hero('127').complexity, null);
    assert.deepEqual(store.effectsForHero('1').map(row => row.id), ['effect:one', 'effect:two']);
    assert.equal((await store.loadObservations({ kind: 'synergy', heroId: '1' }))[0].matchCount, '9007199254740993');
    assert.equal((await store.loadHeroEvidence('1')).claims[0].status, 'proposed');
    store.retire();
});

test('canonical gates reject duplicate keys, identity mappings, malformed profiles and unbound decisions', async t => {
    const root = await temporary(t);
    for (const [name, mutate] of [
        ['duplicate', graph => { graph.entities.heroes[1].key = 'antimage'; graph.entities.heroes[1].sourceKey = 'npc_dota_hero_antimage'; }],
        ['mapping', graph => { graph.heroIndex[0].id = '7'; }],
        ['path', graph => { graph.heroIndex[0].profile = '../escape'; }],
        ['complexity', graph => { graph.entities.heroes[0].complexity = 1.5; }],
        ['binding', graph => { graph.bindings.push({ subjectId: 'missing', field: '/sourceIdentity', value: 'missing-source' }); }],
        ['history', graph => { graph.history[0].historicalObservationIds = ['observation:missing']; }],
        ['duplicate-history', graph => { graph.history.push(graph.history[0]); }],
    ]) {
        const graph = graphFixture(); mutate(graph);
        await assert.rejects(writeCanonical(path.join(root, name), graph));
    }
    const graph = graphFixture(); graph.claims[0].status = 'reviewed';
    await writeCanonical(path.join(root, 'unbound'), graph);
    await assert.rejects(validateDataset(path.join(root, 'unbound')), /review|Schema/i);
});

test('guarded publication restores or verifies each interruption and preserves unrelated files', async t => {
    const root = await temporary(t);
    for (const state of ['prepared', 'prior-moved', 'promoted']) {
        const target = path.join(root, state);
        const original = await writeCanonical(target, graphFixture());
        await fs.writeFile(path.join(target, 'unrelated.txt'), 'preserve my work');
        const before = await inventory(target);
        const graph = graphFixture(); graph.entities.heroes[0].name = 'New name';
        await assert.rejects(publishDataset({ target, replace: true,
            ownedFiles: ['manifest.json', ...original.sourceFiles.map(row => row.name)],
            build: stage => writeCanonical(stage, graph), validate: validateDataset, interruptAt: state }), /interrupted/);
        await assert.rejects(publishDataset({ target, build: () => {}, validate: validateDataset }), /lock exists/);
        const result = await recoverPublication(target, { validate: validateDataset });
        assert.equal(result.state, state === 'promoted' ? 'verified-promoted' : 'restored');
        assert.equal(await fs.readFile(path.join(target, 'unrelated.txt'), 'utf8'), 'preserve my work');
        if (state !== 'promoted') assert.deepEqual(await inventory(target), before);
    }
});

test('invalid promotion rolls back and never overwrites unowned destination files', async t => {
    const root = await temporary(t); const target = path.join(root, 'data');
    const manifest = await writeCanonical(target, graphFixture()); const before = await inventory(target);
    let validations = 0;
    await assert.rejects(publishDataset({ target, replace: true, ownedFiles: ['manifest.json', ...manifest.sourceFiles.map(row => row.name)],
        build: stage => writeCanonical(stage, graphFixture()), validate: async stage => {
            if (++validations > 1) throw new Error('Injected post-promotion failure.');
            await validateDataset(stage);
        } }), /Injected/);
    assert.deepEqual(await inventory(target), before);
    await assert.rejects(publishDataset({ target, replace: true, ownedFiles: [], build: stage => writeCanonical(stage, graphFixture()), validate: validateDataset }), /unrelated work/);
    assert.deepEqual(await inventory(target), before);
});

test('rollback preserves concurrent edits, additions and deletions of unrelated work', async t => {
    const root = await temporary(t); const target = path.join(root, 'data');
    const manifest = await writeCanonical(target, graphFixture());
    await fs.writeFile(path.join(target, 'notes.txt'), 'before');
    await fs.writeFile(path.join(target, 'deleted.txt'), 'before');
    await assert.rejects(publishDataset({ target, replace: true, ownedFiles: ['manifest.json', ...manifest.sourceFiles.map(row => row.name)],
        build: stage => writeCanonical(stage, graphFixture()), validate: validateDataset, interruptAt: 'promoted' }), /interrupted/);
    await fs.writeFile(path.join(target, 'notes.txt'), 'edited during interruption');
    await fs.writeFile(path.join(target, 'new.txt'), 'new work');
    await fs.unlink(path.join(target, 'deleted.txt'));
    await fs.writeFile(path.join(target, 'manifest.json'), 'invalid interrupted output');
    for (const interruptAt of ['restore-prepared', 'failed-moved']) {
        await assert.rejects(recoverPublication(target, { validate: validateDataset, interruptAt }), /Interrupted recovery/);
    }
    assert.equal((await recoverPublication(target, { validate: validateDataset })).state, 'restored');
    assert.equal(await fs.readFile(path.join(target, 'notes.txt'), 'utf8'), 'edited during interruption');
    assert.equal(await fs.readFile(path.join(target, 'new.txt'), 'utf8'), 'new work');
    await assert.rejects(fs.access(path.join(target, 'deleted.txt')), { code: 'ENOENT' });
});

test('failed first publication restores absence and retains concurrently created unrelated work', async t => {
    const root = await temporary(t); const target = path.join(root, 'data');
    let validations = 0;
    await assert.rejects(publishDataset({ target, build: stage => writeCanonical(stage, graphFixture()), validate: async stage => {
        if (++validations > 1) {
            await fs.writeFile(path.join(stage, 'manifest.json'), 'incomplete');
            await fs.writeFile(path.join(stage, 'new.txt'), 'concurrent work');
            throw new Error('First publication failure.');
        }
        await validateDataset(stage);
    } }), /First publication failure/);
    await assert.rejects(fs.access(path.join(target, 'manifest.json')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(target, 'new.txt'), 'utf8'), 'concurrent work');
    await assert.rejects(fs.access(path.join(root, '.data-staging')), { code: 'ENOENT' });
});

test('first-publication rollback survives interruption after moving the failed tree', async t => {
    const root = await temporary(t); const target = path.join(root, 'data');
    await assert.rejects(publishDataset({ target, build: stage => writeCanonical(stage, graphFixture()),
        validate: validateDataset, interruptAt: 'promoted' }), /interrupted/);
    await fs.writeFile(path.join(target, 'notes.txt'), 'keep this work');
    await fs.writeFile(path.join(target, 'manifest.json'), 'invalid');
    await assert.rejects(recoverPublication(target, { validate: validateDataset, interruptAt: 'failed-moved' }), /Interrupted recovery/);
    assert.equal((await recoverPublication(target, { validate: validateDataset })).state, 'restored');
    assert.equal(await fs.readFile(path.join(target, 'notes.txt'), 'utf8'), 'keep this work');
    await assert.rejects(fs.access(path.join(target, 'manifest.json')), { code: 'ENOENT' });
});

test('only one recovery may examine or mutate an interrupted publication', async t => {
    const root = await temporary(t); const target = path.join(root, 'data');
    await assert.rejects(publishDataset({ target, build: stage => writeCanonical(stage, graphFixture()),
        validate: validateDataset, interruptAt: 'promoted' }), /interrupted/);
    let release; let entered;
    const waiting = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const first = recoverPublication(target, { validate: async stage => { entered(); await waiting; await validateDataset(stage); } });
    await started;
    await assert.rejects(recoverPublication(target), /running process|lock/);
    release();
    assert.equal((await first).state, 'verified-promoted');
});

test('recovery does not claim files independently created before first promotion', async t => {
    const root = await temporary(t);
    for (const interruptAt of ['prepared', 'prior-moved']) {
        const target = path.join(root, interruptAt);
        await assert.rejects(publishDataset({ target, build: stage => writeCanonical(stage, graphFixture()),
            validate: validateDataset, interruptAt }), /interrupted/);
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, 'manifest.json'), 'independent work using the same filename');
        await fs.writeFile(path.join(target, 'notes.txt'), 'independent notes');
        const before = await inventory(target);
        assert.equal((await recoverPublication(target)).state, 'restored');
        assert.deepEqual(await inventory(target), before);
    }
});

test('recovery keeps edits made while a directory rename is temporarily locked', async t => {
    const root = await temporary(t); const target = path.join(root, 'data');
    await assert.rejects(publishDataset({ target, build: stage => writeCanonical(stage, graphFixture()),
        validate: validateDataset, interruptAt: 'promoted' }), /interrupted/);
    await fs.writeFile(path.join(target, 'manifest.json'), 'invalid');
    await fs.writeFile(path.join(target, 'notes.txt'), 'before');
    const rename = fs.rename; let injected = false;
    const mock = t.mock.method(fs, 'rename', async (from, to) => {
        if (from === target && !injected) {
            injected = true;
            await fs.writeFile(path.join(target, 'notes.txt'), 'edited during rename retry');
            throw Object.assign(new Error('Temporary lock.'), { code: 'EPERM' });
        }
        return rename(from, to);
    });
    await assert.rejects(recoverPublication(target), /Concurrent changes/);
    mock.mock.restore();
    assert.equal((await recoverPublication(target)).state, 'restored');
    assert.equal(await fs.readFile(path.join(target, 'notes.txt'), 'utf8'), 'edited during rename retry');
});

test('a delayed recoverer cannot acquire a later publication lock', async t => {
    const root = await temporary(t); const target = path.join(root, 'data');
    await assert.rejects(publishDataset({ target, build: stage => writeCanonical(stage, graphFixture()),
        validate: validateDataset, interruptAt: 'promoted' }), /interrupted/);
    const staging = path.join(root, '.data-staging');
    const originalLock = path.join(staging, (await fs.readdir(staging)).find(name => name.startsWith('lock-')));
    let release; let entered; let delayed = false;
    const waiting = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const rename = fs.rename;
    const mock = t.mock.method(fs, 'rename', async (from, to) => {
        if (from === originalLock && !delayed) { delayed = true; entered(); await waiting; }
        return rename(from, to);
    });
    const obsolete = recoverPublication(target);
    await started;
    assert.equal((await recoverPublication(target)).state, 'verified-promoted');
    const manifest = await readJson(target, 'manifest.json');
    await assert.rejects(publishDataset({ target, replace: true,
        ownedFiles: ['manifest.json', ...manifest.sourceFiles.map(row => row.name)],
        build: stage => writeCanonical(stage, graphFixture()), validate: validateDataset, interruptAt: 'prepared' }), /interrupted/);
    const replacementLocks = (await fs.readdir(staging)).filter(name => name.startsWith('lock-'));
    release();
    await assert.rejects(obsolete, /Another recovery/);
    mock.mock.restore();
    assert.deepEqual((await fs.readdir(staging)).filter(name => name.startsWith('lock-')), replacementLocks);
    assert.equal((await recoverPublication(target)).state, 'restored');
});

test('publication accepts an existing empty destination', async t => {
    const root = await temporary(t); const target = path.join(root, 'data');
    await fs.mkdir(target);
    assert.equal((await publishDataset({ target, build: stage => writeCanonical(stage, graphFixture()), validate: validateDataset })).state,
        'verified-promoted');
    assert.equal((await readCanonical(target)).entities.heroes.length, 3);
});

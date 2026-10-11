import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openVpk, parseKeyValues, resolveGameDirectory } from '../src/node/game-files.mjs';

test('reads VPK embedded and split resources with preload bytes and rejects truncation', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-knowledge-vpk-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const entry = (archive, offset, length, preload) => {
        const record = Buffer.alloc(18);
        record.writeUInt16LE(preload.length, 4);
        record.writeUInt16LE(archive, 6);
        record.writeUInt32LE(offset, 8);
        record.writeUInt32LE(length, 12);
        record.writeUInt16LE(0xffff, 16);
        return Buffer.concat([record, Buffer.from(preload)]);
    };
    const tree = Buffer.concat([
        Buffer.from('txt\0scripts\0embedded\0'), entry(0x7fff, 0, 4, 'pre'),
        Buffer.from('external\0'), entry(0, 0, 6, ''), Buffer.from('\0\0\0'),
    ]);
    const header = Buffer.alloc(28);
    header.writeUInt32LE(0x55aa1234, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(tree.length, 8);
    const filename = path.join(directory, 'pak01_dir.vpk');
    fs.writeFileSync(filename, Buffer.concat([header, tree, Buffer.from('load')]));
    fs.writeFileSync(path.join(directory, 'pak01_000.vpk'), 'packed');

    const archive = openVpk(filename);
    assert.deepEqual(archive.files, ['scripts/embedded.txt', 'scripts/external.txt']);
    assert.equal(archive.read('scripts/embedded.txt').toString(), 'preload');
    assert.equal(archive.read('scripts/external.txt').toString(), 'packed');
    assert.throws(() => archive.read('missing'), /not found/);
    fs.truncateSync(filename, 10);
    assert.throws(() => openVpk(filename), /beyond/);
});

test('parses KeyValues safely and resolves an explicit installation directory', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-knowledge-install-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'dota'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dota', 'pak01_dir.vpk'), Buffer.alloc(12));
    const parsed = parseKeyValues('// comment\nplain "a \\"quote\\"" nested { value 1 }');
    assert.equal(parsed.plain, 'a "quote"');
    assert.equal(parsed.nested.value, '1');
    assert.equal(Object.getPrototypeOf(parsed), null);
    assert.equal(resolveGameDirectory(root), root);
    assert.throws(() => parseKeyValues('root { key }'), /Missing/);
    assert.throws(() => parseKeyValues('root { key value'), /Unclosed/);
});

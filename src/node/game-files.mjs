import fs from 'node:fs';
import path from 'node:path';

function readAt(filename, offset, length) {
    const descriptor = fs.openSync(filename, 'r');
    try {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
            || offset < 0 || length < 0 || offset + length > fs.fstatSync(descriptor).size) {
            throw new Error('VPK resource extends beyond its archive.');
        }
        const bytes = Buffer.alloc(length);
        if (fs.readSync(descriptor, bytes, 0, length, offset) !== length) throw new Error('Truncated VPK resource.');
        return bytes;
    }
    finally {
        fs.closeSync(descriptor);
    }
}

/** Open a VPK directory archive for bounded, read-only resource access. */
export function openVpk(filename) {
    const header = readAt(filename, 0, 12);
    if (header.readUInt32LE(0) !== 0x55aa1234) throw new Error('Invalid VPK signature.');
    const version = header.readUInt32LE(4);
    if (![1, 2].includes(version)) throw new Error(`Unsupported VPK version ${version}.`);
    const headerSize = version === 2 ? 28 : 12;
    const treeSize = header.readUInt32LE(8);
    const tree = readAt(filename, headerSize, treeSize);
    const entries = new Map();
    let cursor = 0;
    const string = () => {
        const end = tree.indexOf(0, cursor);
        if (end < 0) throw new Error('Unterminated VPK directory string.');
        const value = tree.toString('utf8', cursor, end);
        cursor = end + 1;
        return value;
    };
    for (let extension = string(); extension; extension = string()) {
        for (let directory = string(); directory; directory = string()) {
            for (let name = string(); name; name = string()) {
                if (cursor + 18 > tree.length) throw new Error('Truncated VPK directory entry.');
                const preloadSize = tree.readUInt16LE(cursor + 4);
                const archive = tree.readUInt16LE(cursor + 6);
                const offset = tree.readUInt32LE(cursor + 8);
                const length = tree.readUInt32LE(cursor + 12);
                if (tree.readUInt16LE(cursor + 16) !== 0xffff) throw new Error('Invalid VPK entry terminator.');
                cursor += 18;
                if (cursor + preloadSize > tree.length) throw new Error('Truncated VPK preload data.');
                const preload = tree.subarray(cursor, cursor + preloadSize);
                cursor += preloadSize;
                const key = `${directory === ' ' ? '' : `${directory}/`}${name}${extension === ' ' ? '' : `.${extension}`}`;
                if (entries.has(key)) throw new Error(`Duplicate VPK resource: ${key}`);
                entries.set(key, { archive, offset, length, preload });
            }
        }
    }
    return {
        files: [...entries.keys()],
        read(key) {
            const entry = entries.get(key);
            if (!entry) throw new Error(`Resource not found in VPK: ${key}`);
            const archiveFile = entry.archive === 0x7fff ? filename
                : filename.replace(/(?:_dir)?\.vpk$/i, `_${String(entry.archive).padStart(3, '0')}.vpk`);
            const offset = entry.offset + (entry.archive === 0x7fff ? headerSize + treeSize : 0);
            return Buffer.concat([entry.preload, readAt(archiveFile, offset, entry.length)]);
        },
    };
}

/** Parse Valve KeyValues text without assigning prototype semantics to keys. */
export function parseKeyValues(text) {
    const tokens = text.match(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|[{}]|[^\s{}"]+/g) || [];
    let cursor = 0;
    const next = () => {
        while (tokens[cursor]?.startsWith('//')) cursor += 1;
        const token = tokens[cursor];
        cursor += 1;
        if (!token?.startsWith('"')) return token;
        return token.slice(1, -1).replace(/\\(["\\])/g, '$1');
    };
    const object = (nested = false) => {
        const result = Object.create(null);
        while (cursor < tokens.length) {
            const key = next();
            if (key === undefined) break;
            if (key === '}' && nested) return result;
            if (key === '{' || key === '}') throw new Error('Unexpected KeyValues brace.');
            const value = next();
            if (value === undefined || value === '}') throw new Error(`Missing KeyValues value: ${key}`);
            result[key] = value === '{' ? object(true) : value;
        }
        if (nested) throw new Error('Unclosed KeyValues object.');
        return result;
    };
    return object();
}

/** Resolve a Dota installation without consulting application configuration. */
export function resolveGameDirectory(input = process.env.DOTA_GAME_DIR) {
    const candidates = input ? [input, path.join(input, 'game')] : [
        path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Steam/steamapps/common/dota 2 beta/game'),
        path.join(process.env.HOME || '', '.steam/steam/steamapps/common/dota 2 beta/game'),
        path.join(process.env.HOME || '', '.local/share/Steam/steamapps/common/dota 2 beta/game'),
    ];
    const game = candidates.find(candidate => fs.existsSync(path.join(candidate, 'dota/pak01_dir.vpk')));
    if (!game) throw new Error('Dota installation not found. Pass --game <dota-installation/game> or set DOTA_GAME_DIR.');
    return path.resolve(game);
}

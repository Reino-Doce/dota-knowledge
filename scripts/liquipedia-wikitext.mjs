const clean = value => value.replace(/<!--[\s\S]*?-->/g, '').trim();

// Positions refer to UTF-16 offsets in the exact revision's wikitext, not rendered HTML.
// Nested templates, links, comments and nowiki spans must not split a parameter.
export function parseLiquipediaTemplates(content, { legacy = false } = {}) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error('Invalid Liquipedia revision content.');
    const stack = [];
    const records = [];
    let links = 0;
    for (let cursor = 0; cursor < content.length; cursor += 1) {
        if (content.startsWith('<!--', cursor)) {
            const end = content.indexOf('-->', cursor + 4);
            if (end < 0) throw new Error('Unclosed Liquipedia comment.');
            cursor = end + 2; continue;
        }
        if (content.slice(cursor, cursor + 7).toLowerCase() === '<nowiki') {
            const open = content.indexOf('>', cursor);
            if (open < 0) throw new Error('Unclosed Liquipedia nowiki.');
            const end = content.slice(cursor, open + 1).endsWith('/>') ? open : content.toLowerCase().indexOf('</nowiki>', open);
            if (end < 0) throw new Error('Unclosed Liquipedia nowiki.');
            cursor = end === open ? open : end + 8; continue;
        }
        if (content.startsWith('[[', cursor)) {
            links += 1; cursor += 1; continue;
        }
        if (content.startsWith(']]', cursor)) {
            links = Math.max(0, links - 1); cursor += 1; continue;
        }
        // MediaWiki tables escape their pipe as {{!}}: {{{!}} is a literal { followed by that template.
        if (!legacy && content.startsWith('{{{!}}', cursor)) continue;
        if (content.startsWith('{{', cursor)) {
            if (stack.length >= 128) throw new Error('Liquipedia template depth exceeds limit.');
            const width = content.startsWith('{{{', cursor) ? 3 : 2;
            stack.push({ start: cursor, width, links, separators: [] }); cursor += width - 1; continue;
        }
        const current = stack.at(-1);
        if (!current) continue;
        if (content.startsWith('}'.repeat(current.width), cursor)) {
            stack.pop();
            const end = cursor + current.width;
            if (current.width === 2) {
                const edges = [current.start + 2, ...current.separators.map(value => value + 1), cursor + 1];
                const nameEnd = current.separators[0] ?? cursor;
                const name = clean(content.slice(current.start + 2, nameEnd));
                const fields = [];
                for (let index = 1; index < edges.length - 1; index += 1) {
                    const start = edges[index]; const finish = edges[index + 1] - 1;
                    const raw = content.slice(start, finish); const equals = raw.indexOf('=');
                    const key = equals < 0 ? String(index) : clean(raw.slice(0, equals));
                    const valueStart = equals < 0 ? start : start + equals + 1;
                    fields.push({ name: key, value: content.slice(valueStart, finish), start: valueStart, end: finish });
                }
                records.push({ name, start: current.start, end, fields });
                if (records.length > 50000) throw new Error('Liquipedia template count exceeds limit.');
            }
            cursor = end - 1; continue;
        }
        if (content[cursor] === '|' && links === current.links) current.separators.push(cursor);
    }
    if (stack.length) throw new Error('Unclosed Liquipedia template.');
    return records.sort((a, b) => a.start - b.start);
}

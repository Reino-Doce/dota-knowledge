import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyHeroDataBundle } from './generate-hero-data.mjs';
import { sha256 } from '../src/provider-records.mjs';

const API = 'https://liquipedia.net/dota2/api.php';
const ARTICLE = 'https://liquipedia.net/dota2/';
const USER_AGENT = 'DotaInteractiveMapHeroData/1.0 (https://github.com/devilesk/dota-interactive-map; read-only hero mechanics research)';
const VERSION = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[1-9]\d{0,5}$/;
const ENGINE = /^npc_dota_hero_[a-z0-9_]+$/;
const MAX_BYTES = 8 * 1024 * 1024;
const LIMITATIONS = [
    'Liquipedia statements are attributed community documentation, not observed or exhaustively verified engine behavior.',
    'Page patch declarations and revision dates do not establish compatibility with the installed game build.',
    'Wikitext, conditional notes, formulas and template references are retained without executing MediaWiki templates or Lua.',
    'The wiki hid field is a wiki-local identifier, not the Dota engine hero ID; joins use exact intern engine keys.',
    'Unmatched, missing and historical ability declarations remain available as source claims, separate from native declarations.',
];
const INDEX_EXPANSION_LIMITATION = 'The current collector fetches one-hop topic links from the two retained mechanics indexes, bounded at 500 unique titles; it does not recursively follow article links.';
const LICENSE = { id: 'CC-BY-SA-3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/',
    attribution: 'Liquipedia contributors', termsUrl: 'https://liquipedia.net/api-terms-of-use',
    sourceUrl: 'https://liquipedia.net/commons/Liquipedia:Copyrights', scope: 'Text only; media licenses are separate.' };
const MECHANICS_TITLES = ['Debuff Immunity', 'Spell Immunity', 'Spell Block', 'Spell Reflection', 'Dispel', 'Break',
    'Illusions', 'Invulnerability', 'Invisibility', 'Damage types', 'Taunt', 'Silence', 'Root', 'Leash', 'Status resistance'];
const INTERACTION_TITLES = ['Debuff Immunity/Ally Interactions', 'Debuff Immunity/Enemy Interactions'];
const COLLECTOR_VERSION = 'liquipedia-hero-data-6';
const PREVIOUS_COLLECTOR_VERSION = 'liquipedia-hero-data-5';
const MECHANICS_INDEX_TITLES = ['Portal:Game_Mechanics', 'Mechanics'];
const MAX_INDEX_LINKED_TITLES = 500;
// Manually reviewed against Mechanics revision 2412992. This is a fixed reference set, not a crawl queue.
// Healing is a related health topic; the API retains any redirect to its canonical article.
const VERSION4_REFERENCE_TITLES = [...MECHANICS_TITLES, ...INTERACTION_TITLES,
    'Mechanics', 'Health', 'Health Regeneration', 'Restoration Manipulation', 'Healing', 'Channeling', 'Attack modifier',
    'Stun', 'Hex', 'Disarm', 'Mute', 'Slow', 'Fear (Game Mechanic)', 'Hypnosis', 'Forced movement',
    'Attack immunity', 'Ethereal', 'Disjoint', 'True Sight', 'Lifesteal', 'Spell lifesteal', 'Critical strike', 'Bash'];
export const LIQUIPEDIA_MECHANICS_REFERENCE_TITLES = Object.freeze([...VERSION4_REFERENCE_TITLES, 'Portal:Game_Mechanics']);
const titleKey = title => title.trim().replaceAll('_', ' ').toLowerCase();
const uniqueTitles = titles => {
    const seen = new Set();
    return titles.filter(title => {
        const key = titleKey(title);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};
const mechanicsTitlesForVersion = (version, linkedTitles = []) => {
    if (version === COLLECTOR_VERSION) return uniqueTitles([...LIQUIPEDIA_MECHANICS_REFERENCE_TITLES, ...linkedTitles]);
    if (version === PREVIOUS_COLLECTOR_VERSION) return LIQUIPEDIA_MECHANICS_REFERENCE_TITLES;
    if (version === 'liquipedia-hero-data-4') return VERSION4_REFERENCE_TITLES;
    if (version === 'liquipedia-hero-data-3') return [...MECHANICS_TITLES, ...INTERACTION_TITLES];
    return MECHANICS_TITLES;
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value > 0;
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : object(value)
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const equal = (first, second) => stable(first) === stable(second);
const clean = value => value.replace(/<!--[\s\S]*?-->/g, '').trim();
const articleUrl = title => `${ARTICLE}${encodeURIComponent(title.replaceAll(' ', '_'))}`;
const revisionUrl = (title, revision) => `${ARTICLE}index.php?${new URLSearchParams({ title, oldid: String(revision) })}`;
const titleValid = title => typeof title === 'string' && title.length > 0 && title.length <= 256
    && !title.includes('|') && [...title].every(character => character.charCodeAt(0) >= 32);

function apiUrl(request) {
    const options = request.type === 'siteinfo' ? { meta: 'siteinfo', siprop: 'general|rightsinfo' }
        : { prop: 'revisions', rvprop: 'ids|timestamp|content', rvslots: 'main', redirects: '1', titles: request.titles.join('|') };
    return `${API}?${new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...options })}`;
}

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

function singular(template, key) {
    const values = template.fields.filter(field => field.name.toLowerCase() === key);
    if (values.length > 1) throw new Error(`Duplicate Liquipedia identity field: ${key}.`);
    return values.length ? clean(values[0].value) : null;
}

function claimCategories(field) {
    const key = field.name.toLowerCase(); const text = `${key} ${field.value}`;
    const result = [];
    for (const [category, pattern] of [['immunity', /immun|piercesdbfim/i], ['dispel', /dispel/i], ['break', /passivebreak|\bBreaknotes\b/i],
        ['spell-block', /spellblocked|Splblocknotes|spell block/i], ['spell-reflection', /spellreflect|Splreflectnotes|spell reflection/i],
        ['illusions', /illusion/i], ['targeting', /^(?:target|affect)\d|invulnerab|invisib|fogged|hidden|courier|ward-type|buildings/i],
        ['modifier', /^(?:buff|debuff)\d|MODIFIER_/i], ['upgrade', /aghnote|shdnote|talnote|upgrade/i]]) {
        if (pattern.test(text)) result.push(category);
    }
    if (['mechanics', 'interacts', 'miscnotes'].includes(key)) result.push('interaction-notes');
    if (/^desc\d/.test(key)) result.push('description');
    return [...new Set(result)];
}

function validatePage(page) {
    const revision = page?.revisions?.[0];
    if (!object(page) || !integer(page.pageid) || !titleValid(page.title) || !Number.isSafeInteger(page.ns)
        || !Array.isArray(page.revisions) || page.revisions.length !== 1 || !integer(revision?.revid)
        || !validDate(revision.timestamp) || revision.slots?.main?.contentmodel !== 'wikitext'
        || typeof revision.slots.main.content !== 'string') throw new Error('Malformed Liquipedia revision.');
    return revision;
}

/** Keeps exact source fields; identifying a claim never certifies its gameplay semantics. */
export function normalizeLiquipediaHero(page, native, provenance = {}, { legacy = false } = {}) {
    const revision = validatePage(page);
    const content = revision.slots.main.content;
    const templates = parseLiquipediaTemplates(content, { legacy });
    const infoboxes = templates.filter(template => template.name.toLowerCase() === 'hero infobox');
    if (infoboxes.length !== 1 || page.ns !== 0) throw new Error('Liquipedia hero infobox is missing or ambiguous.');
    const infobox = infoboxes[0]; const intern = singular(infobox, 'intern');
    const nativeIds = new Set((native?.abilities || []).map(row => row.abilityId));
    const spellcards = templates.filter(template => template.name.toLowerCase() === 'spellcard');
    const matchedIdentityAbilities = [...new Set(spellcards.map(template => singular(template, 'intern')).filter(id => nativeIds.has(id)))];
    const exactEngine = `npc_dota_hero_${intern}` === native.heroKey;
    const nameAndAbilities = !legacy && intern === null && page.title === native.name && matchedIdentityAbilities.length >= 2;
    if (!ENGINE.test(native?.heroKey || '') || !ID.test(native?.heroId || '') || !exactEngine && !nameAndAbilities) throw new Error('Liquipedia engine hero identity conflicts with native hero.');
    const pageSource = { title: page.title, pageId: page.pageid, revisionId: revision.revid, editedAt: revision.timestamp,
        url: articleUrl(page.title), revisionUrl: revisionUrl(page.title, revision.revid), ...provenance,
        wikitextSha256: sha256(content), attribution: LICENSE.attribution, license: LICENSE.id };
    const claim = (field, template) => ({ field: field.name, value: field.value, categories: claimCategories(field),
        source: { start: field.start, end: field.end, templateStart: template.start, offsetUnit: 'utf16-wikitext' },
        evidenceKind: 'wiki-statement', mechanicsVerified: false });
    const abilities = spellcards.map(template => {
        const abilityId = singular(template, 'intern');
        return { abilityId, name: singular(template, 'name'), wikiAbilityId: singular(template, 'id'),
            nativeMatched: abilityId !== null && nativeIds.has(abilityId), fields: template.fields,
            source: { start: template.start, end: template.end, offsetUnit: 'utf16-wikitext' },
            claims: template.fields.filter(field => claimCategories(field).length).map(field => claim(field, template)) };
    });
    const identified = abilities.filter(row => row.abilityId !== null).map(row => row.abilityId);
    // Some pages deliberately describe multiple instances of one engine ability. Retain these rather than deduplicating.
    return { heroId: native.heroId, heroKey: native.heroKey, status: 'available', reason: null, page: pageSource,
        identity: { joinedBy: exactEngine ? 'exact-engine-key' : 'exact-native-name-and-ability-keys', intern, wikiHeroId: singular(infobox, 'hid'),
            ...(nameAndAbilities ? { matchedIdentityAbilities } : {}) },
        patch: { declaredVersion: singular(infobox, 'ctrlver'), checked: singular(infobox, 'ctrlcheck'), installedCompatibility: 'unverified' },
        infobox: infobox.fields, abilities, claims: infobox.fields.filter(field => claimCategories(field).length).map(field => claim(field, infobox)),
        nativeAbilitiesNotDocumented: [...nativeIds].filter(id => !identified.includes(id)),
        templateReferences: [...new Set(templates.map(template => template.name))], mechanicsVerified: false };
}

function nativeRoster(native) {
    const heroes = native?.heroes?.filter(hero => hero.enabled === true);
    if (!HASH.test(native?.sourceHash || '') || !object(native.build) || !heroes?.length || heroes.length > 512) throw new Error('Invalid native catalog.');
    const rows = heroes.map(hero => ({ heroId: hero.heroId, heroKey: hero.heroKey,
        name: hero.localization?.tokens?.[`${hero.heroKey}:n`] ?? hero.name,
        abilities: (hero.abilities || []).map(ability => ({ abilityId: ability.abilityId })) }));
    if (rows.some(row => !ID.test(row.heroId) || !ENGINE.test(row.heroKey) || !titleValid(row.name)
        || row.abilities.length > 512 || row.abilities.some(ability => !/^[a-z][a-z0-9_]+$/.test(ability.abilityId || '')))
        || new Set(rows.map(row => row.heroId)).size !== rows.length || new Set(rows.map(row => row.heroKey)).size !== rows.length) throw new Error('Invalid native roster.');
    return { nativeSourceHash: native.sourceHash, nativeBuild: native.build, heroes: rows };
}

function pagesFrom(payload) {
    if (payload?.error || !Array.isArray(payload?.query?.pages) || payload.query.pages.length > 50) throw new Error('Malformed Liquipedia query response.');
    const pages = payload.query.pages;
    if (pages.some(page => !object(page) || !titleValid(page.title)) || new Set(pages.map(page => page.title)).size !== pages.length
        || new Set(pages.filter(page => page.pageid).map(page => page.pageid)).size !== pages.filter(page => page.pageid).length) throw new Error('Duplicate or malformed Liquipedia page identity.');
    return pages;
}

function resolvePage(payload, requested) {
    let title = requested;
    const mappings = [...(payload.query.normalized || []), ...(payload.query.redirects || [])];
    if (mappings.length > 100 || mappings.some(row => !titleValid(row.from) || !titleValid(row.to))) throw new Error('Malformed Liquipedia redirects.');
    const visited = new Set();
    while (mappings.some(row => row.from === title)) {
        if (visited.has(title)) throw new Error('Cyclic Liquipedia redirect.');
        visited.add(title);
        const rows = mappings.filter(row => row.from === title);
        if (rows.length !== 1) throw new Error('Ambiguous Liquipedia redirect.');
        title = rows[0].to;
    }
    return payload.query.pages.find(page => page.title === title);
}

function sourceProvenance(source) {
    return { sourceFile: source.name, sourceSha256: source.sha256, retrievedAt: source.retrievedAt };
}

function unavailable(hero, reason, source = null) {
    return { heroId: hero.heroId, heroKey: hero.heroKey, status: 'unavailable', reason, page: null,
        sourceFile: source?.name ?? null, abilities: [], claims: [], mechanicsVerified: false };
}

function mechanicsIndexReferences(content) {
    // Keep offsets in the original revision while excluding literal examples and comments.
    const visible = content.replace(/<!--[\s\S]*?-->|<nowiki\b[^>]*\/>|<nowiki\b[^>]*>[\s\S]*?<\/nowiki\s*>/gi,
        span => ' '.repeat(span.length));
    const references = [];
    const add = (title, start, end, kind) => {
        const target = title.split('#')[0].trim().replaceAll('_', ' ');
        if (!titleValid(target) || /[{}[\]:]/.test(target)) return;
        references.push({ title: target, start, end, kind, raw: content.slice(start, end), offsetUnit: 'utf16-wikitext' });
    };
    for (const match of visible.matchAll(/\[\[([^\]\n[]+)\]\]/g)) add(match[1].split('|')[0], match.index, match.index + match[0].length, 'wikilink');
    for (const template of parseLiquipediaTemplates(visible)) {
        if (!['main', 'see also'].includes(template.name.toLowerCase())) continue;
        for (const field of template.fields.filter(field => /^\d+$/.test(field.name))) add(field.value, field.start, field.end, 'reference-template-argument');
    }
    return references;
}

function referenceSelection(title, index) {
    const links = index?.references.filter(reference => reference.title.toLowerCase() === title.toLowerCase()) || [];
    return { policy: 'reviewed-mechanics-allowlist-1', indexTitle: 'Mechanics',
        relation: title === 'Mechanics' ? 'index' : links.length ? 'linked-index-topic' : 'reviewed-related-topic',
        linkState: title === 'Mechanics' ? 'index' : !index ? 'index-unavailable' : links.length ? 'present' : 'not-seen-in-retained-index',
        indexSource: index ? { title: index.title, revisionId: index.revisionId, wikitextSha256: index.wikitextSha256,
            ...sourceProvenance(index.source) } : null,
        references: links, automaticLinkFollowing: false, templateExecution: false };
}

/** Literal index references; the collector may acquire these direct targets, but does not infer implementations. */
export function parseLiquipediaMechanicsTopics(content) {
    // Validate the same syntax/size bounds as the revision parser before scanning exact offsets.
    const templates = parseLiquipediaTemplates(content);
    const visible = content.replace(/<!--[\s\S]*?-->|<nowiki\b[^>]*\/>|<nowiki\b[^>]*>[\s\S]*?<\/nowiki\s*>/gi,
        span => span.replace(/[^\r\n]/g, ' '));
    const sections = [];
    for (const match of visible.matchAll(/^(={1,6})([^\r\n]+?)\1[ \t]*\r?$/gm)) {
        if (sections.length >= 2048) throw new Error('Liquipedia mechanics section limit exceeded.');
        const title = match[2].replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, '')
            .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label ?? target).replace(/'{2,5}/g, '').trim();
        const level = match[1].length;
        const parent = sections.findLast(section => section.level < level);
        sections.push({ id: sections.length, title, level, parentId: parent?.id ?? null, start: match.index,
            headingEnd: match.index + match[0].length, end: content.length, raw: content.slice(match.index, match.index + match[0].length), offsetUnit: 'utf16-wikitext' });
    }
    for (const [index, section] of sections.entries()) section.end = sections.slice(index + 1).find(next => next.level <= section.level)?.start ?? content.length;
    const references = [];
    const add = (target, start, end, kind, label = null) => {
        const normalized = target.trim().replace(/^:/, '').replaceAll('_', ' ');
        const [title, ...fragments] = normalized.split('#');
        if (!titleValid(title) || /[{}[\]]/.test(title) || /^(?:https?:|\/\/)/i.test(title)) return;
        if (references.length >= 20000) throw new Error('Liquipedia mechanics link limit exceeded.');
        const namespace = title.includes(':') ? title.slice(0, title.indexOf(':')) : null;
        const nonTopic = namespace && ['file', 'image', 'category', 'template', 'user', 'user talk', 'help'].includes(namespace.toLowerCase());
        const section = sections.findLast(value => value.headingEnd <= start && value.end > start);
        references.push({ title: title.trim(), fragment: fragments.length ? fragments.join('#') : null, label, namespace,
            classification: nonTopic ? 'non-topic-reference' : 'topic-link', archivedNamespace: namespace?.toLowerCase() === 'archive',
            sectionId: section?.id ?? null, start, end, kind, raw: content.slice(start, end), offsetUnit: 'utf16-wikitext' });
    };
    for (const match of visible.matchAll(/\[\[([^\]\n[]+)\]\]/g)) {
        const [target, ...labels] = match[1].split('|');
        add(target, match.index, match.index + match[0].length, 'wikilink', labels.length ? labels.join('|') : null);
    }
    for (const template of templates) {
        if (!['main', 'see also'].includes(template.name.toLowerCase())) continue;
        for (const field of template.fields.filter(field => /^\d+$/.test(field.name))) add(field.value, field.start, field.end, 'reference-template-argument');
    }
    references.sort((a, b) => a.start - b.start || a.end - b.end);
    return { sections, references, automaticLinkFollowing: false, templateExecution: false };
}

function mechanicsTopicInventory(documents, indexExpansion = false) {
    const indices = MECHANICS_INDEX_TITLES.map(requestedTitle => {
        const document = documents.find(row => row.requestedTitle === requestedTitle);
        if (document?.status !== 'available') return { requestedTitle, status: 'unavailable', reason: document?.reason ?? 'index-not-acquired', sections: [], references: [] };
        const { wikitext, ...source } = document;
        delete source.selection;
        try {
            return { ...source, ...parseLiquipediaMechanicsTopics(wikitext) };
        }
        catch (error) {
            return { ...source, status: 'unsupported', reason: error.message, sections: [], references: [] };
        }
    });
    return { version: 'liquipedia-mechanics-topic-inventory-1', indices,
        interpretation: indexExpansion
            ? 'Links and sections describe the retained index revisions. The collector expands one hop to directly linked topic pages; linked pages are not recursively crawled, current, modeled or engine-verified.'
            : 'Links and sections describe the retained index revisions. Linked articles are not automatically acquired, current, modeled or engine-verified.' };
}

function mechanicsIndexData(sourcePages) {
    const indices = MECHANICS_INDEX_TITLES.map(requestedTitle => {
        const entry = sourcePages.get(requestedTitle);
        if (!entry?.page || entry.page.missing || entry.page.invalid) return { requestedTitle, status: 'unavailable', reason: 'index-page-unavailable', sections: [], references: [] };
        try {
            const revision = validatePage(entry.page);
            const parsed = parseLiquipediaMechanicsTopics(revision.slots.main.content);
            return { requestedTitle, status: 'available', title: entry.page.title, pageId: entry.page.pageid, namespace: entry.page.ns,
                revisionId: revision.revid, editedAt: revision.timestamp, ...sourceProvenance(entry.source),
                wikitextSha256: sha256(revision.slots.main.content), ...parsed };
        }
        catch (error) {
            return { requestedTitle, status: 'unsupported', reason: error.message, sections: [], references: [] };
        }
    });
    const linkedTitles = uniqueTitles(indices.filter(index => index.status === 'available')
        .flatMap(index => index.references.filter(reference => reference.classification === 'topic-link').map(reference => reference.title)));
    if (linkedTitles.length > MAX_INDEX_LINKED_TITLES) throw new Error(`Liquipedia mechanics index exceeds the ${MAX_INDEX_LINKED_TITLES}-topic expansion limit.`);
    return { indices, linkedTitles };
}

function expandedReferenceSelection(title, indices) {
    const isIndex = MECHANICS_INDEX_TITLES.some(indexTitle => titleKey(indexTitle) === titleKey(title));
    const references = indices.flatMap(index => index.references.filter(reference => titleKey(reference.title) === titleKey(title))
        .map(reference => ({ ...reference, indexTitle: index.title ?? index.requestedTitle,
            indexRevisionId: index.revisionId ?? null, indexWikitextSha256: index.wikitextSha256 ?? null,
            indexSourceFile: index.sourceFile ?? null, indexSourceSha256: index.sourceSha256 ?? null })));
    const availableIndices = indices.filter(index => index.status === 'available');
    const indexSources = indices.map(index => ({ requestedTitle: index.requestedTitle, title: index.title ?? null,
        status: index.status, revisionId: index.revisionId ?? null, wikitextSha256: index.wikitextSha256 ?? null,
        sourceFile: index.sourceFile ?? null, sourceSha256: index.sourceSha256 ?? null }));
    return { policy: 'mechanics-index-expansion-1', relation: isIndex ? 'index' : references.length ? 'linked-index-topic' : 'reviewed-related-topic',
        linkState: isIndex ? 'index' : references.length ? 'present' : availableIndices.length ? 'not-seen-in-retained-index' : 'index-unavailable',
        indexSources, references, automaticLinkFollowing: references.length > 0, recursiveLinkFollowing: false, templateExecution: false };
}

function createIndex(roster, sources, payloads, header) {
    const legacy = header.collectorVersion === 'liquipedia-hero-data-1';
    const expandedReferences = ['liquipedia-hero-data-4', PREVIOUS_COLLECTOR_VERSION, COLLECTOR_VERSION].includes(header.collectorVersion);
    const expandsIndexTopics = header.collectorVersion === COLLECTOR_VERSION;
    const heroes = {}; const documents = []; const sourcePages = new Map();
    for (const source of sources.filter(row => row.request.type === 'pages')) {
        if (source.status !== 'available') continue;
        const payload = payloads.get(source.name); pagesFrom(payload);
        for (const title of source.request.titles) {
            const prior = sourcePages.get(title);
            if (prior?.page && !prior.page.missing && !prior.page.invalid) throw new Error('Duplicate Liquipedia requested title.');
            sourcePages.set(title, { source, page: resolvePage(payload, title) });
        }
    }
    const mechanicsIndex = expandsIndexTopics ? mechanicsIndexData(sourcePages) : null;
    const mechanicsTitles = mechanicsTitlesForVersion(header.collectorVersion, mechanicsIndex?.linkedTitles ?? []);
    for (const hero of roster.heroes) {
        const entry = sourcePages.get(hero.name);
        const failed = sources.find(source => source.request.titles?.includes(hero.name));
        if (!entry?.page || entry.page.missing || entry.page.invalid) {
            heroes[hero.heroId] = unavailable(hero, entry ? 'wiki-page-missing' : failed?.error ?? 'request-not-completed', failed); continue;
        }
        try {
            heroes[hero.heroId] = normalizeLiquipediaHero(entry.page, hero, sourceProvenance(entry.source), { legacy });
        }
        catch (error) {
            heroes[hero.heroId] = unavailable(hero, error.message, entry.source);
        }
    }
    let referenceIndex = null;
    if (expandedReferences && !expandsIndexTopics) {
        const entry = sourcePages.get('Mechanics');
        if (entry?.page && !entry.page.missing && !entry.page.invalid) {
            try {
                const revision = validatePage(entry.page);
                referenceIndex = { title: entry.page.title, revisionId: revision.revid, source: entry.source,
                    wikitextSha256: sha256(revision.slots.main.content), references: mechanicsIndexReferences(revision.slots.main.content) };
            }
            catch {
                // Raw revisions remain retained even if index link parsing is unsupported.
            }
        }
    }
    for (const title of mechanicsTitles) {
        const entry = sourcePages.get(title);
        const selection = expandsIndexTopics ? { selection: expandedReferenceSelection(title, mechanicsIndex.indices) }
            : expandedReferences ? { selection: referenceSelection(title, referenceIndex) } : {};
        if (!entry?.page || entry.page.missing || entry.page.invalid) {
            documents.push({ requestedTitle: title, status: 'unavailable', reason: 'wiki-page-unavailable', ...selection }); continue;
        }
        try {
            const revision = validatePage(entry.page);
            documents.push({ requestedTitle: title, status: 'available', title: entry.page.title, pageId: entry.page.pageid,
                ...([PREVIOUS_COLLECTOR_VERSION, COLLECTOR_VERSION].includes(header.collectorVersion) ? { namespace: entry.page.ns } : {}),
                revisionId: revision.revid, editedAt: revision.timestamp, url: articleUrl(entry.page.title),
                revisionUrl: revisionUrl(entry.page.title, revision.revid), ...sourceProvenance(entry.source),
                wikitext: revision.slots.main.content, wikitextSha256: sha256(revision.slots.main.content),
                evidenceKind: 'wiki-statement', mechanicsVerified: false, license: LICENSE.id,
                ...(expandedReferences ? { attribution: LICENSE.attribution, installedCompatibility: 'unverified', ...selection } : {}) });
        }
        catch (error) {
            documents.push({ requestedTitle: title, status: 'unavailable', reason: error.message, ...selection });
        }
    }
    const available = Object.values(heroes).filter(hero => hero.status === 'available');
    const availableDocuments = documents.filter(document => document.status === 'available').length;
    const site = sources.find(source => source.request.type === 'siteinfo' && source.status === 'available');
    const availableTopicIndexes = mechanicsIndex?.indices.filter(index => index.status === 'available').length ?? 0;
    const topicIndexesComplete = !expandsIndexTopics || availableTopicIndexes === MECHANICS_INDEX_TITLES.length;
    const mechanicsDocumentsComplete = availableDocuments === mechanicsTitles.length;
    const mechanicsAcquisitionComplete = mechanicsDocumentsComplete && topicIndexesComplete;
    return { schemaVersion: 1, collectorVersion: COLLECTOR_VERSION, ...header,
        nativeSourceHash: roster.nativeSourceHash, nativeBuild: roster.nativeBuild, license: LICENSE,
        site: site ? { ...payloads.get(site.name).query, ...sourceProvenance(site) } : null,
        coverage: { state: available.length === roster.heroes.length && (!expandedReferences || mechanicsAcquisitionComplete)
            ? 'complete-acquisition' : 'partial-acquisition',
        expectedHeroes: roster.heroes.length, availableHeroes: available.length, unavailableHeroes: roster.heroes.length - available.length,
        documentedAbilities: available.reduce((sum, hero) => sum + hero.abilities.length, 0),
        matchedAbilities: available.reduce((sum, hero) => sum + hero.abilities.filter(ability => ability.nativeMatched).length, 0),
        mechanicsClaims: available.reduce((sum, hero) => sum + hero.claims.length + hero.abilities.reduce((count, ability) => count + ability.claims.length, 0), 0),
        availableMechanicsDocuments: availableDocuments, completeMechanics: false,
        ...(expandedReferences ? { expectedMechanicsDocuments: mechanicsTitles.length,
            unavailableMechanicsDocuments: mechanicsTitles.length - availableDocuments,
            heroAcquisitionState: available.length === roster.heroes.length ? 'complete-acquisition' : 'partial-acquisition',
            mechanicsAcquisitionState: mechanicsAcquisitionComplete ? 'complete-acquisition' : 'partial-acquisition',
            ...(expandsIndexTopics ? { expectedMechanicsTopicIndexes: MECHANICS_INDEX_TITLES.length,
                availableMechanicsTopicIndexes: availableTopicIndexes,
                mechanicsTopicIndexState: topicIndexesComplete ? 'complete-acquisition' : 'partial-acquisition',
                linkedMechanicsTopics: mechanicsIndex.linkedTitles.length } : {}) } : {}) },
        heroes, documents, ...(['liquipedia-hero-data-5', COLLECTOR_VERSION].includes(header.collectorVersion)
            ? { mechanicsTopicInventory: mechanicsTopicInventory(documents, expandsIndexTopics) } : {}),
        limitations: expandsIndexTopics ? [...LIMITATIONS, INDEX_EXPANSION_LIMITATION] : LIMITATIONS };
}

async function fetchResponse(url, { fetchImpl, timeoutMs, maxResponseBytes, userAgent }) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); let reader;
    try {
        const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal,
            headers: { 'User-Agent': userAgent, Accept: 'application/json', 'Accept-Encoding': 'gzip' } });
        const size = response.headers.get('content-length');
        if (size !== null && (!/^\d+$/.test(size) || Number(size) > maxResponseBytes)) throw new Error('Liquipedia response exceeds byte limit.');
        if (!response.body) throw new Error('Liquipedia response body is unavailable.');
        reader = response.body.getReader(); const chunks = []; let length = 0;
        while (true) {
            const next = await reader.read(); if (next.done) break;
            length += next.value.byteLength;
            if (length > maxResponseBytes) throw new Error('Liquipedia response exceeds byte limit.');
            chunks.push(Buffer.from(next.value));
        }
        return { bytes: Buffer.concat(chunks, length), httpStatus: response.status };
    }
    catch (error) {
        controller.abort(); if (reader) await reader.cancel().catch(() => {});
        if (/^Liquipedia /.test(error.message)) throw error;
        throw new Error(controller.signal.aborted && error?.name === 'AbortError' ? 'Liquipedia request timed out.' : 'Liquipedia network request failed.', { cause: error });
    }
    finally {
        clearTimeout(timer); reader?.releaseLock();
    }
}

function decodeSource(bytes, source) {
    if (source.httpStatus !== 200) throw new Error(`Liquipedia API HTTP ${source.httpStatus}.`);
    let payload;
    try {
        payload = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw new Error('Malformed Liquipedia API JSON.');
    }
    if (source.request.type === 'pages') {
        pagesFrom(payload);
        for (const title of source.request.titles) resolvePage(payload, title);
    }
    else if (payload?.error || !object(payload?.query?.general) || !object(payload?.query?.rightsinfo)
        || payload.query.general.server !== 'https://liquipedia.net' || payload.query.general.scriptpath !== '/dota2') throw new Error('Malformed Liquipedia site identity.');
    return payload;
}

/** Queries only the public API, sequentially, at least 2.1 seconds apart. Reuse is explicitly offline. */
export async function collectLiquipediaHeroData({ bundle, version, output, reuse, fillMissing = false, fetchImpl = fetch,
    sleepImpl = delay, timeoutMs = 20000, maxResponseBytes = MAX_BYTES, now = () => new Date().toISOString(), userAgent = USER_AGENT } = {}) {
    if (!bundle || !VERSION.test(version || '') || typeof fetchImpl !== 'function' || typeof sleepImpl !== 'function'
        || !integer(timeoutMs) || timeoutMs > 60000 || !integer(maxResponseBytes) || maxResponseBytes > MAX_BYTES
        || typeof userAgent !== 'string' || userAgent.length > 500 || !userAgent.includes('https://') || /[\r\n]/.test(userAgent)
        || typeof fillMissing !== 'boolean' || fillMissing && !reuse) throw new Error('Invalid Liquipedia collection options.');
    const destination = path.resolve(output ?? path.join('test-results', 'hero-data-liquipedia', version));
    if (fs.existsSync(destination)) throw new Error('Liquipedia data version already exists; choose a new output directory.');
    const bundleManifest = verifyHeroDataBundle(bundle);
    const nativeBytes = fs.readFileSync(path.join(bundle, 'hero_data.json'));
    const native = JSON.parse(nativeBytes); const roster = nativeRoster(native);
    if (native.sourceHash !== bundleManifest.sourceHash) throw new Error('Native source hash does not match verified bundle.');
    const sourceBundle = { version: bundleManifest.version, manifestSha256: sha256(fs.readFileSync(path.join(bundle, 'hero_data_manifest.json'))), heroDataSha256: sha256(nativeBytes) };
    const createdAt = now(); if (!validDate(createdAt)) throw new Error('Invalid Liquipedia collection clock.');
    const cached = reuse ? verifyLiquipediaHeroDataBundle(reuse) : null;
    const parent = path.dirname(destination); fs.mkdirSync(parent, { recursive: true });
    const staging = fs.mkdtempSync(path.join(parent, '.liquipedia-hero-data-'));
    const files = []; const sources = []; const payloads = new Map();
    const record = (name, bytes) => {
        fs.mkdirSync(path.dirname(path.join(staging, name)), { recursive: true }); fs.writeFileSync(path.join(staging, name), bytes);
        const entry = { name, bytes: bytes.length, sha256: sha256(bytes) }; files.push(entry); return entry;
    };
    try {
        record('sources/native_roster.json', Buffer.from(json(roster)));
        if (cached) {
            for (const prior of cached.manifest.sources) {
                const source = structuredClone(prior); sources.push(source);
                if (!source.sha256) continue;
                const bytes = fs.readFileSync(path.join(reuse, source.name)); record(source.name, bytes);
                if (source.status === 'available') payloads.set(source.name, decodeSource(bytes, source));
            }
        }
        const acquiredTitles = new Set(); let stop = false; let requestCount = 0;
        const acquire = async requests => {
            for (const request of requests) {
                const source = { name: `sources/api/${String(sources.length).padStart(3, '0')}.json`, request, url: apiUrl(request), status: 'unavailable',
                    httpStatus: null, retrievedAt: null, error: null };
                sources.push(source);
                if (request.type === 'pages') request.titles.forEach(title => acquiredTitles.add(titleKey(title)));
                if (stop) {
                    source.error = 'acquisition-stopped-after-access-restriction'; continue;
                }
                if (requestCount || cached) await sleepImpl(2100);
                requestCount += 1;
                try {
                    const result = await fetchResponse(source.url, { fetchImpl, timeoutMs, maxResponseBytes, userAgent });
                    source.httpStatus = result.httpStatus; source.retrievedAt = now();
                    if (!validDate(source.retrievedAt)) throw new Error('Invalid Liquipedia collection clock.');
                    Object.assign(source, record(source.name, result.bytes));
                    if ([401, 403, 429].includes(result.httpStatus)) stop = true;
                    const payload = decodeSource(result.bytes, source);
                    payloads.set(source.name, payload); source.status = 'available';
                }
                catch (error) {
                    source.error = error.message;
                }
            }
        };
        const retainedTitles = () => {
            const retained = new Set();
            for (const source of sources.filter(row => row.status === 'available' && row.request.type === 'pages')) {
                for (const title of source.request.titles) {
                    const page = resolvePage(payloads.get(source.name), title);
                    if (page && !page.missing && !page.invalid) retained.add(titleKey(title));
                }
            }
            return retained;
        };
        const pageRequests = titles => Array.from({ length: Math.ceil(titles.length / 10) }, (_, index) => ({
            type: 'pages', titles: titles.slice(index * 10, index * 10 + 10) }));
        if (!cached || fillMissing) {
            const retained = retainedTitles();
            const titles = uniqueTitles([...roster.heroes.map(hero => hero.name), ...LIQUIPEDIA_MECHANICS_REFERENCE_TITLES])
                .filter(title => !retained.has(titleKey(title)));
            const requests = sources.some(source => source.status === 'available' && source.request.type === 'siteinfo') ? [] : [{ type: 'siteinfo' }];
            requests.push(...pageRequests(titles));
            await acquire(requests);
        }
        const sourcePages = new Map();
        for (const source of sources.filter(row => row.status === 'available' && row.request.type === 'pages')) {
            for (const title of source.request.titles) sourcePages.set(title, { source, page: resolvePage(payloads.get(source.name), title) });
        }
        const linkedTitles = mechanicsIndexData(sourcePages).linkedTitles;
        const fixedTitles = new Set(LIQUIPEDIA_MECHANICS_REFERENCE_TITLES.map(titleKey));
        const retained = retainedTitles();
        const unacquiredLinkedTitles = linkedTitles.filter(title => !fixedTitles.has(titleKey(title))
            && !retained.has(titleKey(title)) && !acquiredTitles.has(titleKey(title)));
        if (unacquiredLinkedTitles.length) {
            const requests = pageRequests(unacquiredLinkedTitles);
            if (!cached || fillMissing) await acquire(requests);
            else {
                for (const request of requests) sources.push({ name: `sources/api/${String(sources.length).padStart(3, '0')}.json`, request,
                    url: apiUrl(request), status: 'unavailable', httpStatus: null, retrievedAt: null, error: 'article-not-retained-in-offline-cache' });
            }
        }
        const reusedFrom = cached ? { version: cached.manifest.version, manifestSha256: sha256(fs.readFileSync(path.join(reuse, 'liquipedia_hero_data_manifest.json'))) } : null;
        const header = { collectorVersion: COLLECTOR_VERSION, version, createdAt, sourceBundle, reusedFrom };
        const index = createIndex(roster, sources, payloads, header);
        record('liquipedia_hero_data.json', Buffer.from(json(index)));
        const manifest = { schemaVersion: 1, ...header, nativeSourceHash: native.sourceHash,
            nativeBuild: native.build, license: LICENSE, acquisition: { endpoint: API, userAgent, minimumIntervalMs: 2100,
                mode: reuse ? fillMissing ? 'api-query-with-cache' : 'offline-reuse' : 'api-query' },
            coverage: index.coverage, files: files.sort((a, b) => a.name.localeCompare(b.name)), sources };
        fs.writeFileSync(path.join(staging, 'liquipedia_hero_data_manifest.json'), json(manifest));
        verifyLiquipediaHeroDataBundle(staging, { nativeCatalog: native });
        fs.renameSync(staging, destination); return manifest;
    }
    finally {
        if (fs.existsSync(staging) && path.dirname(path.resolve(staging)) === parent && path.basename(staging).startsWith('.liquipedia-hero-data-')) fs.rmSync(staging, { recursive: true });
    }
}

export function verifyLiquipediaHeroDataBundle(directory, { nativeCatalog } = {}) {
    const root = fs.realpathSync(directory);
    const read = (name, maximum) => {
        const target = path.join(root, name); const resolved = fs.realpathSync(target); const relative = path.relative(root, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.lstatSync(target).isFile() || fs.statSync(target).size > maximum) throw new Error('Invalid Liquipedia bundle file.');
        return fs.readFileSync(target);
    };
    const manifest = JSON.parse(read('liquipedia_hero_data_manifest.json', 2 * 1024 * 1024));
    if (manifest.schemaVersion !== 1 || !['liquipedia-hero-data-1', 'liquipedia-hero-data-2', 'liquipedia-hero-data-3', 'liquipedia-hero-data-4', PREVIOUS_COLLECTOR_VERSION, COLLECTOR_VERSION].includes(manifest.collectorVersion) || !VERSION.test(manifest.version || '')
        || !validDate(manifest.createdAt) || !HASH.test(manifest.nativeSourceHash || '') || !object(manifest.nativeBuild)
        || !VERSION.test(manifest.sourceBundle?.version || '') || !HASH.test(manifest.sourceBundle?.manifestSha256 || '')
        || !HASH.test(manifest.sourceBundle?.heroDataSha256 || '') || !equal(manifest.license, LICENSE)
        || !Array.isArray(manifest.files) || manifest.files.length > 514 || !Array.isArray(manifest.sources) || manifest.sources.length > 512
        || new Set(manifest.files.map(file => file.name)).size !== manifest.files.length
        || new Set(manifest.sources.map(source => source.name)).size !== manifest.sources.length
        || manifest.reusedFrom !== null && (!VERSION.test(manifest.reusedFrom?.version || '') || !HASH.test(manifest.reusedFrom?.manifestSha256 || ''))
        || manifest.acquisition?.endpoint !== API || manifest.acquisition.minimumIntervalMs !== 2100
        || !['api-query', 'api-query-with-cache', 'offline-reuse'].includes(manifest.acquisition.mode)
        || typeof manifest.acquisition.userAgent !== 'string' || manifest.acquisition.userAgent.length > 500) throw new Error('Invalid Liquipedia manifest.');
    const bytesByName = new Map();
    for (const file of manifest.files) {
        if (!/^(liquipedia_hero_data\.json|sources\/native_roster\.json|sources\/api\/\d{3}\.json)$/.test(file.name || '')
            || !HASH.test(file.sha256 || '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid Liquipedia source file identity.');
        const bytes = read(file.name, file.name === 'liquipedia_hero_data.json' ? 64 * 1024 * 1024 : MAX_BYTES);
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('Liquipedia source checksum mismatch.');
        bytesByName.set(file.name, bytes);
    }
    if (!bytesByName.has('sources/native_roster.json') || !bytesByName.has('liquipedia_hero_data.json')) throw new Error('Unverified Liquipedia index or native roster.');
    const roster = JSON.parse(bytesByName.get('sources/native_roster.json'));
    const canonicalRoster = nativeRoster({ sourceHash: roster.nativeSourceHash, build: roster.nativeBuild, heroes: roster.heroes?.map(hero => ({ ...hero, enabled: true })) });
    if (!equal(roster, canonicalRoster) || roster.nativeSourceHash !== manifest.nativeSourceHash || !equal(roster.nativeBuild, manifest.nativeBuild)) throw new Error('Liquipedia native roster identity mismatch.');
    if (nativeCatalog && !equal(nativeRoster(nativeCatalog), roster)) throw new Error('Liquipedia snapshot does not match supplied native catalog.');
    const payloads = new Map(); const sourceFiles = new Set([...bytesByName.keys()].filter(name => name.startsWith('sources/api/')));
    let siteCount = 0;
    for (const source of manifest.sources) {
        if (!/^sources\/api\/\d{3}\.json$/.test(source.name || '') || !['available', 'unavailable'].includes(source.status)
            || !object(source.request) || !['siteinfo', 'pages'].includes(source.request.type)
            || source.request.type === 'pages' && (!Array.isArray(source.request.titles) || !source.request.titles.length
                || source.request.titles.length > 10 || source.request.titles.some(title => !titleValid(title)))
            || source.url !== apiUrl(source.request)) throw new Error('Invalid Liquipedia source provenance.');
        if (source.request.type === 'siteinfo') siteCount += 1;
        const bytes = bytesByName.get(source.name);
        if (bytes) {
            if (source.sha256 !== sha256(bytes) || source.bytes !== bytes.length || !validDate(source.retrievedAt)
                || !Number.isSafeInteger(source.httpStatus) || source.httpStatus < 100 || source.httpStatus > 599) throw new Error('Liquipedia source metadata mismatch.');
            let payload; let failure;
            try {
                payload = decodeSource(bytes, source);
            }
            catch (error) {
                failure = error;
            }
            if (failure) {
                if (source.status !== 'unavailable' || source.error !== failure.message) throw new Error('Liquipedia failure status does not match retained response.', { cause: failure });
            }
            else {
                if (source.status !== 'available' || source.error !== null) throw new Error('Liquipedia successful source status mismatch.');
                payloads.set(source.name, payload);
            }
        }
        else if (source.status !== 'unavailable' || source.sha256 !== undefined || source.bytes !== undefined || source.httpStatus !== null
            || typeof source.error !== 'string' || source.error.length > 500) throw new Error('Unverified Liquipedia source status.');
        sourceFiles.delete(source.name);
    }
    if (sourceFiles.size || !siteCount || manifest.sources.filter(source => source.request.type === 'siteinfo' && source.status === 'available').length > 1) throw new Error('Incomplete Liquipedia source registry.');
    const index = JSON.parse(bytesByName.get('liquipedia_hero_data.json'));
    const rebuilt = createIndex(roster, manifest.sources, payloads, { collectorVersion: manifest.collectorVersion, version: manifest.version, createdAt: manifest.createdAt,
        sourceBundle: manifest.sourceBundle, reusedFrom: manifest.reusedFrom });
    const indexDifferences = Object.keys({ ...index, ...rebuilt }).filter(field => !equal(index[field], rebuilt[field]));
    const documentDifferences = (index.documents || []).filter((document, position) => !equal(document, rebuilt.documents?.[position]))
        .slice(0, 3).map(document => {
            const expected = rebuilt.documents?.find(row => row.requestedTitle === document.requestedTitle) ?? {};
            const fields = Object.keys({ ...document, ...expected }).filter(field => !equal(document[field], expected[field]));
            return `${document.requestedTitle}.${fields.join('+')}`;
        });
    if (indexDifferences.length || !equal(index.coverage, manifest.coverage)) throw new Error(`Liquipedia index differs from retained revisions${indexDifferences.length ? `: ${indexDifferences.join(', ')}${documentDifferences.length ? ` (${documentDifferences.join(', ')})` : ''}` : ': coverage'}.`);
    return { manifest, index, verification: { nativeCatalogMatched: Boolean(nativeCatalog), claimsRecomputed: true, engineMechanicsVerified: false } };
}

export async function main(argv = process.argv.slice(2)) {
    const { values } = parseArgs({ args: argv, options: { bundle: { type: 'string' }, version: { type: 'string' }, output: { type: 'string' }, reuse: { type: 'string' },
        'fill-missing': { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) {
        console.log('node scripts/collect-liquipedia-hero-data.mjs --bundle VERIFIED-HERO-BUNDLE --version NEW-VERSION [--output NEW-DIR] [--reuse VERIFIED-LIQUIPEDIA-SNAPSHOT [--fill-missing]]');
        console.log('Collector v6 also acquires one hop of topic links from Mechanics and Portal:Game_Mechanics (maximum 500 unique titles; no recursive crawl).');
        return;
    }
    const manifest = await collectLiquipediaHeroData({ ...values, fillMissing: values['fill-missing'] ?? false });
    console.log(JSON.stringify({ version: manifest.version, ...manifest.coverage, files: manifest.files.length }));
    if (manifest.coverage.unavailableHeroes || manifest.coverage.unavailableMechanicsDocuments) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message); process.exitCode = 1;
    });
}

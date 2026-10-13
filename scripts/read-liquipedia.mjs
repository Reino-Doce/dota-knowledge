import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLiquipediaTemplates } from './liquipedia-wikitext.mjs';
import { abilityTagCatalog } from '../src/tags/catalog.mjs';

const API = 'https://liquipedia.net/dota2/api.php';
const ARTICLE = 'https://liquipedia.net/dota2/';
const API_TERMS = 'https://liquipedia.net/api-terms-of-use';
const USER_AGENT = 'DotaKnowledgeLiquipediaReader/1.0 (https://github.com/devilesk/dota-interactive-map; contact: https://github.com/devilesk/dota-interactive-map/issues)';
const CACHE_VERSION = 1;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MIN_REQUEST_INTERVAL_MS = 2100;
const MIN_PARSE_REQUEST_INTERVAL_MS = 30000;
const LOCK_STALE_MS = 120000;
const LOCK_TIMEOUT_MS = 180000;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let cachedHeroCatalog;

function defaultCacheDirectory() {
    const root = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    return path.join(root, 'dota-knowledge', 'liquipedia');
}

function source(retrievedAt, cacheHit) {
    return {
        wiki: 'Liquipedia Dota 2 Wiki',
        attribution: 'Liquipedia contributors',
        license: 'CC-BY-SA-3.0',
        termsUrl: API_TERMS,
        retrievedAt,
        cacheHit,
    };
}

function apiUrl(parameters) {
    return `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...parameters })}`;
}

function isValidTitle(title) {
    return typeof title === 'string' && title.trim().length > 0 && title.length <= 255
        && !title.includes('|') && !/[\u0000-\u001f\u007f]/u.test(title);
}

function apiError(payload) {
    if (!payload?.error) return;
    const code = String(payload.error.code ?? 'unknown').replace(/[\r\n]/gu, ' ').slice(0, 100);
    const info = String(payload.error.info ?? 'Unknown API error').replace(/[\r\n]/gu, ' ').slice(0, 300);
    const error = new Error(`Liquipedia API error ${code}: ${info}`);
    error.apiCode = code;
    throw error;
}

async function readCache(cacheFile, url) {
    try {
        const entry = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
        if (!entry || entry.version !== CACHE_VERSION || entry.url !== url || !Number.isFinite(Date.parse(entry.retrievedAt))
            || entry.payload === null || typeof entry.payload !== 'object') return null;
        return entry;
    }
    catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
    }
}

async function reserveRequestStart(cacheDirectory, { parseRequest = false } = {}) {
    await fs.mkdir(cacheDirectory, { recursive: true });
    const lockPath = path.join(cacheDirectory, 'request.lock');
    const statePath = path.join(cacheDirectory, 'request-state.json');
    const token = randomUUID();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (true) {
        try {
            await fs.writeFile(lockPath, token, { flag: 'wx' });
            break;
        }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try {
                const lock = await fs.stat(lockPath);
                if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) {
                    await fs.unlink(lockPath);
                    continue;
                }
            }
            catch (statError) {
                if (statError.code === 'ENOENT') continue;
                throw statError;
            }
            if (Date.now() >= deadline) throw new Error('Timed out waiting for the Liquipedia request limiter.');
            await delay(100);
        }
    }

    try {
        let lastRequestStartedAt = 0;
        let lastParseRequestStartedAt = 0;
        try {
            const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
            if (Number.isSafeInteger(state?.lastRequestStartedAt) && state.lastRequestStartedAt > 0) {
                lastRequestStartedAt = state.lastRequestStartedAt;
            }
            if (Number.isSafeInteger(state?.lastParseRequestStartedAt) && state.lastParseRequestStartedAt > 0) {
                lastParseRequestStartedAt = state.lastParseRequestStartedAt;
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }

        const nextRequestAt = lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS;
        const nextParseRequestAt = parseRequest ? lastParseRequestStartedAt + MIN_PARSE_REQUEST_INTERVAL_MS : 0;
        const waitMs = Math.max(nextRequestAt, nextParseRequestAt) - Date.now();
        if (waitMs > 0) await delay(waitMs);
        const startedAt = Date.now();
        await fs.writeFile(statePath, JSON.stringify({
            lastRequestStartedAt: startedAt,
            lastParseRequestStartedAt: parseRequest ? startedAt : lastParseRequestStartedAt,
        }));
    }
    finally {
        try {
            if ((await fs.readFile(lockPath, 'utf8')) === token) await fs.unlink(lockPath);
        }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
}

async function readResponse(response) {
    if (!response.body) throw new Error('Liquipedia API response body is unavailable.');
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            length += result.value.byteLength;
            if (length > MAX_RESPONSE_BYTES) throw new Error('Liquipedia API response exceeds the 8 MiB limit.');
            chunks.push(Buffer.from(result.value));
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, length).toString('utf8');
}

async function requestJson(url, {
    cacheDirectory,
    requestLimiterDirectory = defaultCacheDirectory(),
    refresh = false,
    parseRequest = false,
    fetchImpl = fetch,
} = {}) {
    const key = createHash('sha256').update(url).digest('hex');
    const cacheFile = path.join(cacheDirectory, `${key}.json`);
    if (!refresh) {
        const cached = await readCache(cacheFile, url);
        if (cached) {
            apiError(cached.payload);
            return { payload: cached.payload, retrievedAt: cached.retrievedAt, cacheHit: true };
        }
    }

    await reserveRequestStart(requestLimiterDirectory, { parseRequest });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let payload;
    try {
        const response = await fetchImpl(url, {
            redirect: 'error',
            signal: controller.signal,
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'application/json',
                'Accept-Encoding': 'gzip',
            },
        });
        if (response.status !== 200) throw new Error(`Liquipedia API HTTP ${response.status}.`);
        try {
            payload = JSON.parse(await readResponse(response));
        }
        catch (error) {
            if (/Liquipedia API response exceeds/u.test(error.message)) throw error;
            throw new Error('Liquipedia API returned malformed JSON.', { cause: error });
        }
        apiError(payload);
    }
    catch (error) {
        if (error.message.startsWith('Liquipedia API')) throw error;
        throw new Error(controller.signal.aborted ? 'Liquipedia API request timed out.' : 'Liquipedia API request failed.', { cause: error });
    }
    finally {
        clearTimeout(timer);
    }

    const retrievedAt = new Date().toISOString();
    await fs.mkdir(cacheDirectory, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify({ version: CACHE_VERSION, url, retrievedAt, payload }));
    return { payload, retrievedAt, cacheHit: false };
}

function resolvedPage(payload, requestedTitle) {
    const pages = payload?.query?.pages;
    if (!Array.isArray(pages) || pages.length > 1) throw new Error('Liquipedia returned a malformed page response.');
    const mappings = [...(payload.query.normalized ?? []), ...(payload.query.redirects ?? [])];
    if (mappings.length > 100 || mappings.some(row => !isValidTitle(row.from) || !isValidTitle(row.to))) {
        throw new Error('Liquipedia returned malformed title redirects.');
    }
    let title = requestedTitle;
    const visited = new Set();
    while (true) {
        const next = mappings.filter(row => row.from === title);
        if (!next.length) break;
        if (next.length !== 1 || visited.has(title)) throw new Error('Liquipedia returned an ambiguous or cyclic title redirect.');
        visited.add(title);
        title = next[0].to;
    }
    return pages.find(page => page.title === title) ?? pages[0] ?? null;
}

function articleUrl(title) {
    const encoded = title.replaceAll(' ', '_').split('/').map(encodeURIComponent).join('/');
    return `${ARTICLE}${encoded}`;
}

function pageResult(payload, requestedTitle, retrieval) {
    const page = resolvedPage(payload, requestedTitle);
    if (!page || page.missing || page.invalid) {
        return {
            status: 'missing',
            requestedTitle,
            title: page?.title ?? requestedTitle,
            pageId: null,
            namespace: page?.ns ?? null,
            articleUrl: page ? articleUrl(page.title) : null,
            revision: null,
            contentModel: null,
            wikitext: null,
            source: source(retrieval.retrievedAt, retrieval.cacheHit),
        };
    }

    const revision = page.revisions?.[0];
    const content = revision?.slots?.main?.content ?? revision?.slots?.main?.['*'];
    if (!Number.isSafeInteger(page.pageid) || page.pageid < 1 || !Number.isSafeInteger(page.ns)
        || !Number.isSafeInteger(revision?.revid) || revision.revid < 1
        || !Number.isFinite(Date.parse(revision.timestamp)) || typeof content !== 'string') {
        throw new Error('Liquipedia returned a malformed page revision.');
    }
    return {
        status: 'available',
        requestedTitle,
        title: page.title,
        pageId: page.pageid,
        namespace: page.ns,
        articleUrl: articleUrl(page.title),
        revision: {
            id: revision.revid,
            timestamp: revision.timestamp,
            url: `${ARTICLE}index.php?${new URLSearchParams({ title: page.title, oldid: String(revision.revid) })}`,
        },
        contentModel: revision.slots.main.contentmodel ?? 'wikitext',
        wikitext: content,
        source: source(retrieval.retrievedAt, retrieval.cacheHit),
    };
}

async function readPage(title, options) {
    if (!isValidTitle(title)) throw new Error('Page titles must be non-empty, at most 255 characters, and cannot contain pipes or control characters.');
    const url = apiUrl({
        action: 'query',
        prop: 'revisions',
        redirects: '1',
        rvprop: 'ids|timestamp|content',
        rvslots: 'main',
        titles: title,
    });
    const retrieval = await requestJson(url, options);
    return pageResult(retrieval.payload, title, retrieval);
}

function heroAliasVariants(value) {
    if (typeof value !== 'string' || value.trim().length === 0) return [];
    const normalized = value.trim().toLowerCase().replace(/\s+/gu, ' ');
    return [...new Set([
        normalized,
        normalized.replaceAll(' ', '_'),
        normalized.replaceAll(' ', '-'),
        normalized.replaceAll('_', ' '),
        normalized.replaceAll('_', '-'),
        normalized.replaceAll('-', ' '),
        normalized.replaceAll('-', '_'),
    ])];
}

async function loadHeroCatalog() {
    if (cachedHeroCatalog) return cachedHeroCatalog;
    let data;
    try {
        data = JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, 'data', 'runtime', 'core.json'), 'utf8'));
    }
    catch (error) {
        if (error instanceof SyntaxError) throw new Error('The local Dota hero index is malformed.');
        if (error.code === 'ENOENT') throw new Error('The local Dota hero index is unavailable: data/runtime/core.json.');
        throw error;
    }
    const heroes = data?.entities?.heroes;
    const aliases = data?.aliases;
    if (!Array.isArray(heroes) || heroes.length === 0 || heroes.length > 512
        || aliases === null || typeof aliases !== 'object' || Array.isArray(aliases)) {
        throw new Error('The local Dota hero index is malformed.');
    }

    const byKey = new Map();
    const aliasMatches = new Map();
    for (const hero of heroes) {
        if (!hero || typeof hero.id !== 'string' || !/^[1-9]\d{0,5}$/u.test(hero.id)
            || typeof hero.key !== 'string' || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(hero.key)
            || !isValidTitle(hero.name)) throw new Error('The local Dota hero index is malformed.');
        if (byKey.has(hero.key)) throw new Error('The local Dota hero index contains duplicate hero keys.');
        byKey.set(hero.key, hero);
        for (const value of [hero.id, hero.key, hero.name, hero.sourceKey, ...(Array.isArray(hero.aliases) ? hero.aliases : [])]) {
            for (const alias of heroAliasVariants(value)) {
                const matches = aliasMatches.get(alias) ?? new Map();
                matches.set(hero.id, hero);
                aliasMatches.set(alias, matches);
            }
        }
    }
    for (const [alias, key] of Object.entries(aliases)) {
        const hero = byKey.get(key);
        if (!hero) continue;
        for (const variant of heroAliasVariants(alias)) {
            const matches = aliasMatches.get(variant) ?? new Map();
            matches.set(hero.id, hero);
            aliasMatches.set(variant, matches);
        }
    }
    cachedHeroCatalog = { heroes, aliasMatches };
    return cachedHeroCatalog;
}

async function resolveHeroSelector(selector) {
    if (!isValidTitle(selector)) throw new Error('Hero selectors must be non-empty and cannot contain pipes or control characters.');
    const catalog = await loadHeroCatalog();
    let matches;
    if (/^[1-9]\d{0,5}$/u.test(selector.trim())) {
        matches = catalog.heroes.filter(hero => hero.id === selector.trim());
    }
    else {
        const ids = new Set(heroAliasVariants(selector).flatMap(alias => [...(catalog.aliasMatches.get(alias)?.keys() ?? [])]));
        matches = catalog.heroes.filter(hero => ids.has(hero.id));
    }
    if (matches.length === 0) throw new Error(`Hero not found in the local Dota hero index: ${selector}.`);
    if (matches.length > 1) throw new Error(`Hero selector is ambiguous in the local Dota hero index: ${selector}.`);
    return matches[0];
}

function templateField(template, key) {
    const rows = template.fields.filter(field => field.name.toLowerCase() === key.toLowerCase());
    if (rows.length > 1) throw new Error(`Liquipedia Spellcard has duplicate ${key} fields.`);
    return rows.length ? rows[0].value.replace(/<!--[\s\S]*?-->/gu, '').trim() : null;
}

function numericQuantity(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) return undefined;
    const parts = value.split('/').map(part => part.trim());
    if (parts.length > 16 || parts.some(part => !/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(part))) return undefined;
    const numbers = parts.map(Number);
    if (numbers.some(number => !Number.isFinite(number) || number < 0)) return undefined;
    return numbers.length === 1 ? numbers[0] : numbers;
}

function templateQuantity(template, keys) {
    for (const key of keys) {
        const value = templateField(template, key);
        if (value !== null) return numericQuantity(value);
    }
    return undefined;
}

function castTypeFromTarget(value) {
    if (!value) return 'unknown';
    const targets = value.split(/[;,]/u).map(target => target.trim().toLowerCase()).filter(Boolean);
    if (targets.some(target => target.includes('passive'))) return 'passive';
    if (targets.some(target => target.includes('autocast') || target.includes('toggle'))) return 'toggle';
    if (targets.some(target => target.includes('vector'))) return 'vector';
    if (targets.some(target => /^(?:unit|unit target)$/u.test(target))
        && targets.some(target => /^(?:point|point target)$/u.test(target))) return 'target-or-point';
    if (targets.some(target => /(?:unit|target).*point|point.*(?:unit|target)/u.test(target))) return 'target-or-point';
    if (targets.some(target => /^(?:point|point target)$/u.test(target))) return 'point';
    if (targets.some(target => /^(?:unit|unit target)$/u.test(target))) return 'target';
    if (targets.some(target => /^(?:no|no target|self|self target)$/u.test(target))) return 'self-target';
    return 'unknown';
}

const affectTargets = new Map([
    ['self', 'self'],
    ['ally hero', 'ally_hero'], ['ally heroes', 'ally_hero'], ['allied hero', 'ally_hero'], ['allied heroes', 'ally_hero'],
    ['enemy hero', 'enemy_hero'], ['enemy heroes', 'enemy_hero'],
    ['ally creep', 'ally_creep'], ['ally creeps', 'ally_creep'], ['allied creep', 'ally_creep'], ['allied creeps', 'ally_creep'],
    ['enemy creep', 'enemy_creep'], ['enemy creeps', 'enemy_creep'],
    ['neutral creep', 'neutral_creep'], ['neutral creeps', 'neutral_creep'],
    ['enemy creep hero', 'enemy_creep_hero'], ['enemy creep heroes', 'enemy_creep_hero'],
    ['ally building', 'ally_building'], ['ally buildings', 'ally_building'], ['allied building', 'ally_building'], ['allied buildings', 'ally_building'],
    ['enemy building', 'enemy_building'], ['enemy buildings', 'enemy_building'],
    ['tree', 'tree'], ['trees', 'tree'],
    ['ally courier', 'ally_courier'], ['ally couriers', 'ally_courier'], ['allied courier', 'ally_courier'], ['allied couriers', 'ally_courier'],
    ['enemy courier', 'enemy_courier'], ['enemy couriers', 'enemy_courier'],
]);

function targetsFromAffect(value) {
    if (!value) return undefined;
    const parts = value.split(/;|,|<br\s*\/?\s*>/iu).map(part => part.trim().toLowerCase().replace(/\s+/gu, ' '));
    if (!parts.length || parts.some(part => !affectTargets.has(part))) return undefined;
    return [...new Set(parts.map(part => affectTargets.get(part)))];
}

function affectsFromText(value) {
    if (!value) return undefined;
    const parts = value.split(/;|,|<br\s*\/?\s*>/iu).map(part => part.trim().toLowerCase().replace(/\s+/gu, ' '));
    const result = new Set();
    let team = null;
    const addTeam = (side, kind) => {
        team = side;
        if (kind === 'hero') result.add(side === 'friendly' ? 'allied-heroes' : 'enemy-heroes');
        else if (kind === 'unit') result.add(side === 'friendly' ? 'allied-units' : 'enemy-units');
        else if (kind === 'creep') result.add(side === 'friendly' ? 'allied-units' : 'enemy-creeps');
        else if (kind === 'building') result.add(side === 'friendly' ? 'allied-buildings' : 'enemy-buildings');
    };
    for (const part of parts) {
        if (!part || part === 'self' || part === 'the self') continue;
        if (/^(?:allied|ally) units? and buildings$/u.test(part)) {
            result.add('allied-units'); result.add('allied-buildings'); team = 'friendly'; continue;
        }
        if (/^enemy units? and buildings$/u.test(part)) {
            result.add('enemy-units'); result.add('enemy-buildings'); team = 'enemy'; continue;
        }
        if (part === 'units' || part === 'unit') { result.add('units'); team = 'both'; continue; }
        if (part === 'allies' || part === 'ally') { result.add('allies'); team = 'friendly'; continue; }
        if (part === 'enemies' || part === 'enemy') { result.add('enemy-units'); team = 'enemy'; continue; }
        if (part === 'heroes' || part === 'hero') {
            result.add('allied-heroes'); result.add('enemy-heroes'); team = 'both'; continue;
        }
        if (part === 'buildings' || part === 'building') {
            if (team === 'friendly' || team === 'both') result.add('allied-buildings');
            if (team === 'enemy' || team === 'both') result.add('enemy-buildings');
            continue;
        }
        if (part === 'creeps' || part === 'creep') {
            if (team === 'friendly') result.add('allied-units');
            else if (team === 'enemy') result.add('enemy-creeps');
            else if (team === 'both') result.add('units');
            continue;
        }
        if (part === 'tree' || part === 'trees') { result.add('trees'); continue; }
        const teamTarget = part.match(/^(allied|ally|enemy) (heroes?|units?|creeps?|buildings?)$/u);
        if (teamTarget) {
            const side = teamTarget[1] === 'enemy' ? 'enemy' : 'friendly';
            const kind = teamTarget[2].startsWith('hero') ? 'hero' : teamTarget[2].startsWith('creep') ? 'creep'
                : teamTarget[2].startsWith('building') ? 'building' : 'unit';
            addTeam(side, kind);
        }
    }
    return result.size ? [...result].sort() : undefined;
}

function behaviorsFromTarget(value, affectText) {
    if (!value) return [];
    const parts = value.split(/[;,]/u).map(part => part.trim().toLowerCase()).filter(Boolean);
    const has = (...labels) => parts.some(part => labels.includes(part));
    const treeVector = parts.some(part => /tree.*vector|vector.*tree/u.test(part));
    const vector = treeVector || has('vector', 'point vector', 'point-vector', 'vector target', 'point vector target');
    const result = new Set();
    if (has('unit', 'unit target')) result.add('unit-target');
    if (has('passive')) result.add('passive');
    if (!vector && has('point', 'point target')) result.add('point-target');
    if (has('no', 'no target', 'self', 'self target')) result.add('no-target');
    if (parts.some(part => part.startsWith('autocast') || part === 'auto-cast')) result.add('auto-cast');
    if (has('channel', 'channeling', 'channeled', 'channelled', 'channled')) result.add('channeled');
    if (vector) result.add(treeVector || affectsFromText(affectText)?.includes('trees') ? 'tree-vector-target' : 'point-vector-target');
    if (has('toggle')) result.add('toggle');
    return [...result].sort();
}

function dispelMetadata(template) {
    const values = template.fields.filter(field => /^(?:buff|debuff)\d+dispel$/iu.test(field.name))
        .map(field => field.value.trim().toLowerCase());
    if (!values.length || new Set(values).size !== 1) return {};
    const [value] = values;
    if (value === 'any') return { dispellable: 'yes', dispelType: 'basic' };
    if (value === 'strong') return { dispellable: 'strong-only', dispelType: 'strong' };
    if (value === 'none') return { dispellable: 'no' };
    return {};
}

function spellcardMetadata(row) {
    const metadata = {};
    const behavior = behaviorsFromTarget(row.targetText, row.affectText);
    if (behavior.length) metadata.behavior = behavior;
    const affects = affectsFromText(row.affectText);
    if (affects) metadata.affects = affects;
    if (!row.template) return metadata;

    const damageTypes = new Set(row.template.fields.filter(field => /^damage\d+$/iu.test(field.name))
        .flatMap(field => field.value.split(/[;,]/u).map(value => value.trim().toLowerCase()))
        .filter(value => ['physical', 'magical', 'pure'].includes(value)));
    if (damageTypes.size === 1) metadata.damageType = [...damageTypes][0];

    const pierces = templateField(row.template, 'is_piercesdbfim')?.trim().toLowerCase();
    if (pierces === 'yes') metadata.piercesDebuffImmunity = 'yes';
    else if (pierces === 'no') metadata.piercesDebuffImmunity = 'no';

    const breakable = templateField(row.template, 'is_passivebreak')?.trim().toLowerCase();
    if (breakable === 'yes') metadata.breakable = true;
    else if (breakable === 'no') metadata.breakable = false;
    return { ...metadata, ...dispelMetadata(row.template) };
}

function abilityIdentityRows(template) {
    const intern = templateField(template, 'intern');
    if (!intern) return [];
    const ids = intern.split(',').map(id => id.trim());
    if (ids.length > 32 || ids.some(id => !/^[a-z][a-z0-9_]*$/u.test(id))) {
        throw new Error('Liquipedia Spellcard has a malformed intern ability ID.');
    }
    const name = templateField(template, 'name');
    const wikiType = (templateField(template, 'type0') ?? '').toLowerCase();
    return ids.map(id => ({ id, name, wikiType, targetText: templateField(template, 'target0'), affectText: templateField(template, 'affect0') }));
}

const allowedAbilityTags = new Set(abilityTagCatalog.categories.flatMap(category => category.tags));
const liquipediaTagRules = [
    ['ability_copy', /\b(?:copy|copies|copied|steal|steals|stealing) (?:an? |the )?(?:enemy |opponent'?s )?(?:ability|spell)s?\b/iu],
    ['ability_damage_bonus', /\b(?:bonus ability damage|ability damage bonus|bonus spell damage)\b/iu],
    ['anti_heal', /\b(?:healing|heal) (?:amplification|amplification reduction|reduction|reduced)\b/iu],
    ['aoe', /\b(?:area of effect|aoe|radius|in an? area|nearby units|around the target)\b/iu],
    ['armor_reduction', /\b(?:armor reduction|reduces? (?:the target'?s? )?armor|decreases? (?:the target'?s? )?armor)\b/iu],
    ['aura', /\baura\b/iu],
    ['attack_bounce', /\b(?:bounce|bounces|bouncing)\b/iu],
    ['attack_modifier', /\battack modifier\b|\bon attack(?:ing)?\b/iu],
    ['attack_stun', /\b(?:bash|bash(?:es|ing)|attack stun)\b/iu],
    ['barrier', /\b(?:barrier|damage shield)\b/iu],
    ['blink', /\bblink\b/iu],
    ['bkb_pierce', /\b(?:pierce|piercing)\b[^.\n]{0,50}\b(?:debuff )?immunit|\b(?:debuff )?immunit\b[^.\n]{0,50}\b(?:pierce|piercing)\b/iu],
    ['break', /\bbreak(?:s|ing)?\b/iu],
    ['channeled', /\b(?:channel(?:s|ed|ing)?|channeled)\b/iu],
    ['cleave', /\bcleave\b/iu],
    ['clone_creation', /\b(?:clone|clones|creates? (?:an? )?copy of (?:the )?hero)\b/iu],
    ['concealment', /\b(?:conceal|conceals|concealed|hide|hides|hidden)\b/iu],
    ['cooldown_reduction', /\bcooldown (?:reduction|reduced|decrease|decreased|refresh|refreshed|reset|resets)\b/iu],
    ['creep_conversion', /\b(?:convert|converts|control|controls|enslave|enslaves)\b[^.\n]{0,80}\b(?:creep|neutral)\b|\b(?:creep|neutral)\b[^.\n]{0,80}\b(?:convert|converts|control|controls|enslave|enslaves)\b/iu],
    ['cyclone', /\bcyclone\b/iu],
    ['cast_range', /\bcast range\b/iu],
    ['damage_block', /\b(?:block|blocks|blocked|blocking)\b[^.\n]{0,50}\bdamage\b/iu],
    ['damage_immunity', /\b(?:immune to|immunity to|invulnerable to)\b[^.\n]{0,50}\bdamage\b/iu],
    ['damage_over_time', /\b(?:damage over time|damage per second|\bdps\b|each second|every second)\b/iu],
    ['damage_over_distance', /\b(?:damage|deals? damage)\b[^.\n]{0,50}\b(?:distance|farther|further)\b|\b(?:distance|farther|further)\b[^.\n]{0,50}\bdamage\b/iu],
    ['damage_reflection', /\b(?:reflect|reflects|reflected|reflection)\b[^.\n]{0,50}\bdamage\b/iu],
    ['damage_sharing', /\b(?:share|shares|shared|sharing)\b[^.\n]{0,50}\bdamage\b/iu],
    ['damage_reduction', /\b(?:damage reduction|reduces? (?:incoming )?damage|less damage)\b/iu],
    ['delayed_damage', /\b(?:delayed|delay(?:s|ing) the)\b[^.\n]{0,40}\bdamage\b/iu],
    ['disarm', /\bdisarm(?:s|ed|ing)?\b/iu],
    ['dispel', /\bdispel(?:s|led|ling)?\b/iu],
    ['disjoint', /\bdisjoint(?:s|ed|ing)?\b/iu],
    ['duration_extension', /\b(?:extend|extends|extension|increase[sd]?|increased)\b[^.\n]{0,40}\bduration\b/iu],
    ['enemy_attack_speed_reduction', /\b(?:attack speed slow|reduces? (?:the target'?s? )?attack speed|decreases? (?:the target'?s? )?attack speed)\b/iu],
    ['enemy_displacement', /\b(?:knock(?:s|ed)? back|push(?:es|ed)? back|pull(?:s|ed)?|displace(?:s|d|ment)?)\b/iu],
    ['escape', /\b(?:escape|escapes|escaping)\b/iu],
    ['evasion', /\bevasion\b|\bevad(?:e|es|ing) attacks\b/iu],
    ['fear', /\bfear(?:s|ed|ing)?\b/iu],
    ['forced_movement_immunity', /\bimmune to\b[^.\n]{0,50}\b(?:knockback|forced movement|displacement)\b/iu],
    ['global_delivery', /\b(?:global range|global cast|global effect|map[- ]wide)\b/iu],
    ['heal', /\b(?:heal|heals|healing|restore health|health restoration)\b/iu],
    ['hex', /\bhex(?:es|ed|ing)?\b/iu],
    ['illusions', /\billusion(?:s)?\b/iu],
    ['immediate_damage', /\b(?:deal|deals|dealing|takes?|take|inflict|inflicts)\b[^.\n]{0,70}\bdamage\b|\bdamage\b[^.\n]{0,70}\b(?:instantly|immediately)\b/iu],
    ['invisibility', /\binvisib(?:le|ility)\b/iu],
    ['lifesteal', /\blifesteal\b|\blife steal\b/iu],
    ['magic_resistance', /\bmagic resistance\b/iu],
    ['mana_burn', /\bmana burn(?:s|ed|ing)?\b|\bburn(?:s|ed|ing)?\b[^.\n]{0,40}\bmana\b/iu],
    ['mana_restoration_prevention', /\b(?:prevent|prevents|preventing|disable|disables|disabling)\b[^.\n]{0,40}\bmana (?:restore|restoration|regeneration|regen)\b/iu],
    ['mobility', /\b(?:dash|dashes|leap|leaps|jump|jumps|teleport|teleports|travel to)\b/iu],
    ['mute', /\bmute(?:s|d|ing)?\b/iu],
    ['outgoing_damage_amplification', /\b(?:damage amp(?:lification)?|amplif(?:y|ies|ied|ication))\b|\bincreases? (?:the target'?s? )?damage dealt\b/iu],
    ['outgoing_damage_reduction', /\breduces? (?:the target'?s? )?damage (?:output|dealt)\b/iu],
    ['root', /\broot(?:s|ed|ing)?\b/iu],
    ['self_armor', /\b(?:self|caster|hero)'?s? armor\b/iu],
    ['self_attack_damage', /\b(?:self|caster|hero)'?s? attack damage\b/iu],
    ['self_attack_speed', /\b(?:self|caster|hero)'?s? attack speed\b/iu],
    ['self_heal', /\bheals? (?:the caster|itself|self)\b/iu],
    ['self_health_regen', /\b(?:self|caster|hero)'?s? health regeneration\b/iu],
    ['self_mana_regen', /\b(?:self|caster|hero)'?s? mana regeneration\b/iu],
    ['self_movement_speed', /\b(?:self|caster|hero)'?s? movement speed\b/iu],
    ['silence', /\bsilence(?:s|d|ing)?\b/iu],
    ['single_target', /\bsingle[- ]target\b/iu],
    ['slow', /\bslow(?:s|ed|ing)?\b|\bmovement speed reduction\b/iu],
    ['slow_resistance', /\bslow resistance\b/iu],
    ['spell_amplification', /\bspell amplification\b|\bspell amp(?:lification)?\b/iu],
    ['spell_lifesteal', /\bspell lifesteal\b|\bspell life steal\b/iu],
    ['status_resistance', /\bstatus resistance\b/iu],
    ['stun', /\bstun(?:s|ned|ning)?\b/iu],
    ['summons', /\b(?:summon|summons|summoned|summoning)\b/iu],
    ['taunt', /\btaunt(?:s|ed|ing)?\b/iu],
    ['target_health_scaling', /\b(?:missing|current|maximum) health\b[^.\n]{0,50}\b(?:damage|scal(?:e|es|ing))\b|\b(?:damage|scal(?:e|es|ing))\b[^.\n]{0,50}\b(?:missing|current|maximum) health\b/iu],
    ['terrain_block', /\b(?:block|blocks|blocking)\b[^.\n]{0,40}\b(?:path|passage|area|terrain)\b/iu],
    ['trap', /\btrap(?:s|ped|ping)?\b/iu],
    ['true_strike', /\btrue strike\b|\bcannot miss\b/iu],
    ['vision', /\b(?:grant|grants|provide|provides|reveal|reveals)\b[^.\n]{0,40}\bvision\b|\bvision of\b/iu],
    ['vision_denial', /\b(?:reduce|reduces|deny|denies|remove|removes)\b[^.\n]{0,40}\bvision\b|\bvision reduction\b/iu],
];

function spellcardTagText(template, row) {
    const informationalField = /^(?:desc\d*|mechanics|miscnotes|basic\d+(?: [a-z]+)?|buff\d+(?:text|mp\d+)?|debuff\d+(?:text|mp\d+)?|trait\d+|value\d+|type\d+ trait\d+|type\d+ value\d+(?: [a-z]+)?)$/iu;
    return [row.name, row.targetText, row.affectText,
        ...template.fields.filter(field => informationalField.test(field.name.trim())).map(field => field.value),
    ].filter(Boolean).join(' ');
}

function liquipediaTags(text, affectText = '') {
    const tags = liquipediaTagRules.filter(([tag, pattern]) => allowedAbilityTags.has(tag) && pattern.test(text)).map(([tag]) => tag);
    const recipients = affectText.toLowerCase();
    const positive = /\b(?:bonus|increase[sd]?|gain(?:s|ed)?|grant(?:s|ed)?|improv(?:e|es|ed))\b/iu.test(text);
    if (positive && /\bself\b/iu.test(recipients)) {
        if (/\barmor\b/iu.test(text)) tags.push('self_armor');
        if (/\battack damage\b/iu.test(text)) tags.push('self_attack_damage');
        if (/\battack speed\b/iu.test(text)) tags.push('self_attack_speed');
        if (/\bhealth (?:regeneration|regen)\b/iu.test(text)) tags.push('self_health_regen');
        if (/\bmana (?:regeneration|regen)\b/iu.test(text)) tags.push('self_mana_regen');
        if (/\bmovement speed\b/iu.test(text)) tags.push('self_movement_speed');
        if (/\bmax(?:imum)? health\b/iu.test(text)) tags.push('self_max_health');
        if (/\bmax(?:imum)? mana\b/iu.test(text)) tags.push('self_max_mana');
    }
    if (positive && /\b(?:ally|allied)\b/iu.test(recipients)) {
        if (/\barmor\b/iu.test(text)) tags.push('ally_armor');
        if (/\battack damage\b/iu.test(text)) tags.push('ally_attack_damage');
        if (/\battack speed\b/iu.test(text)) tags.push('ally_attack_speed');
        if (/\bhealth (?:regeneration|regen)\b/iu.test(text)) tags.push('ally_health_regen');
        if (/\bmana (?:regeneration|regen)\b/iu.test(text)) tags.push('ally_mana_regen');
        if (/\bmovement speed\b/iu.test(text)) tags.push('ally_movement_speed');
        if (/\bmax(?:imum)? health\b/iu.test(text)) tags.push('ally_max_health');
        if (/\bmax(?:imum)? mana\b/iu.test(text)) tags.push('ally_max_mana');
        if (/\bbarrier\b|\bdamage shield\b/iu.test(text)) tags.push('ally_barrier');
    }
    if (/\b(?:heal|heals|healing|health restoration)\b/iu.test(text)) {
        if (/\bself\b/iu.test(recipients)) tags.push('self_heal');
        if (/\b(?:ally|allied)\b/iu.test(recipients)) tags.push('ally_heal');
    }
    return [...new Set(tags)].sort();
}

function normalizeSpellcardAbility(row, { order, includeOrder = true, includeType = true } = {}) {
    const ability = { id: row.id, tags: liquipediaTags(spellcardTagText(row.template, row), row.affectText) };
    Object.assign(ability, spellcardMetadata(row));
    if (row.name) ability.Name = row.name;
    if (includeOrder) ability.order = order;
    if (includeType) ability.type = /(?:^|_)empty\d*$/u.test(row.id) ? 'placeholder' : castTypeFromTarget(row.targetText);
    const targets = targetsFromAffect(row.affectText);
    if (targets) ability.target = targets;
    const manaCost = templateQuantity(row.template, ['manacost', 'mana cost', 'manacost0', 'mana0', 'mana']);
    const cooldown = templateQuantity(row.template, ['cooldown', 'cooldown0', 'cd0', 'cd']);
    if (manaCost !== undefined) ability.manaCost = manaCost;
    if (cooldown !== undefined) ability.cooldown = cooldown;
    return ability;
}

function normalizeAbilityBonus(row) {
    const bonus = { id: row.id, tags: row.template ? liquipediaTags(spellcardTagText(row.template, row), row.affectText) : [] };
    Object.assign(bonus, spellcardMetadata(row));
    if (row.name) bonus.Name = row.name;
    return bonus;
}

function templateVisibleText(value) {
    let output = value.replace(/<!--[\s\S]*?-->/gu, ' ');
    // Resolve common visible-link syntax before simplifying templates.
    output = output.replace(/\[\[([^\]]+)\]\]/gu, (_match, target) => {
        const pieces = target.split('|');
        return pieces.at(-1).trim();
    });
    for (let pass = 0; pass < 32 && output.includes('{{'); pass += 1) {
        const templates = parseLiquipediaTemplates(output).filter(template => template.end - template.start >= 4);
        const outer = templates.filter(template => !templates.some(parent => parent !== template && parent.start < template.start && parent.end > template.end));
        if (!outer.length) break;
        for (const template of outer.sort((a, b) => b.start - a.start)) {
            const namedText = template.fields.find(field => ['text', 'label', 'name'].includes(field.name.toLowerCase()))?.value;
            const positional = template.fields.filter(field => /^\d+$/u.test(field.name)).sort((a, b) => Number(a.name) - Number(b.name));
            const shortName = template.name.toLowerCase().replace(/^template:/u, '');
            const isVisibleLabel = /^(?:a|ability|m|mechanic|u|unit|h|hero|spell|item|modifier|status|s|skill)$/u.test(shortName);
            const replacement = namedText?.trim() || (isVisibleLabel ? positional.at(-1)?.value.trim() : '') || '';
            output = output.slice(0, template.start) + replacement + output.slice(template.end);
        }
    }
    const decodeCodepoint = (raw, radix) => {
        const codepoint = Number.parseInt(raw, radix);
        return codepoint <= 0x10ffff && !(codepoint >= 0xd800 && codepoint <= 0xdfff) ? String.fromCodePoint(codepoint) : '';
    };
    return output.replace(/<\s*(?:hr|br)\s*\/?\s*>/giu, ' ; ')
        .replace(/<[^>]*>/gu, ' ')
        .replace(/&nbsp;|&#160;/giu, ' ')
        .replace(/&amp;/giu, '&')
        .replace(/&ndash;/giu, '–')
        .replace(/&mdash;/giu, '—')
        .replace(/&quot;/giu, '"')
        .replace(/&apos;|&#39;/giu, "'")
        .replace(/&lt;/giu, '<')
        .replace(/&gt;/giu, '>')
        .replace(/&#x([\da-f]{1,6});/giu, (_match, hex) => decodeCodepoint(hex, 16))
        .replace(/&#(\d{1,7});/gu, (_match, decimal) => decodeCodepoint(decimal, 10))
        .replace(/\s*;\s*/gu, '; ')
        .replace(/[{}<>]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .replace(/\s+([,.;])/gu, '$1')
        .trim();
}

function talentName(text, value) {
    const valueText = value ? templateVisibleText(value) : '';
    const numericValues = valueText.split('/').map(part => part.trim()).filter(Boolean);
    let nextValueIndex = 0;
    let placeholderCount = 0;
    let rendered = text.replace(/([+-]?x?)s:value([a-z0-9]*)?(%)?/giu, (_match, sign, suffix, percent) => {
        placeholderCount += 1;
        const explicitIndex = /^\d+$/u.test(suffix) ? Number(suffix) - 1 : undefined;
        const index = explicitIndex ?? nextValueIndex++;
        nextValueIndex = Math.max(nextValueIndex, index + 1);
        let raw = numericValues[index] ?? (numericValues.length === 1 ? numericValues[0] : '');
        if (!raw) return '';
        const prefix = sign === '+' || sign === '-' ? sign : '';
        if (prefix && !/^[+-]/u.test(raw)) raw = prefix + raw;
        if (percent && !raw.includes('%')) raw += '%';
        return raw;
    });
    rendered = templateVisibleText(rendered);
    if (!placeholderCount && valueText && rendered) {
        const valuePrefix = /^\d+(?:\.\d+)?$/u.test(valueText) && Number(valueText) > 0 && /^strength$/iu.test(rendered)
            ? `+${valueText}` : valueText;
        rendered = `${valuePrefix} ${rendered}`;
    }
    rendered = rendered.replace(/\bstrength\b/giu, 'Strength');
    return rendered.replace(/\s+/gu, ' ').trim();
}

function talentGridRows(templates) {
    const rows = [];
    const talentTemplate = templates.find(template => template.name.toLowerCase() === 'talents'
        && template.fields.some(field => /^t[1-9][lr]$/iu.test(field.name.trim())));
    if (!talentTemplate) return rows;
    for (let tier = 4; tier >= 1; tier -= 1) {
        for (const side of ['l', 'r']) {
            const label = templateField(talentTemplate, `t${tier}${side}`);
            if (!label) continue;
            const value = templateField(talentTemplate, `v${tier}${side}`);
            const name = talentName(label, value);
            if (name) rows.push({ tier, side, name });
        }
    }
    return rows;
}

function normalizeTalent(row, heroKey) {
    return {
        id: `liquipedia_talent_${heroKey}_t${row.tier}${row.side}`,
        Name: row.name,
        tags: liquipediaTags(row.name, row.affectText),
    };
}

function formatHeroAbilities(wikitext, heroKey = 'unknown') {
    const allTemplates = parseLiquipediaTemplates(wikitext);
    const spellcards = allTemplates.filter(template => template.name.toLowerCase() === 'spellcard');
    const rows = spellcards.flatMap(template => abilityIdentityRows(template).map(row => ({ ...row, template })));
    if (rows.length === 0) throw new Error('Liquipedia hero page contains no identified Spellcard abilities.');

    const innate = [];
    const skills = [];
    const talentCards = [];
    const bonusAttributes = [];
    for (const row of rows) {
        if (row.id === 'special_bonus_attributes') {
            bonusAttributes.push(normalizeAbilityBonus(row));
        }
        else if (row.wikiType === 'inn') {
            innate.push(normalizeSpellcardAbility(row, { includeType: false, includeOrder: false }));
        }
        else if (row.wikiType === 'tal' || row.id.startsWith('special_bonus_')) {
            talentCards.push(row);
        }
        else {
            skills.push(normalizeSpellcardAbility(row, { order: skills.length }));
        }
    }
    const gridRows = talentGridRows(allTemplates);
    const talents = gridRows.length
        ? gridRows.map(row => normalizeTalent(row, heroKey))
        : talentCards.map(normalizeAbilityBonus);
    return {
        innate: innate.length === 0 ? null : innate.length === 1 ? innate[0] : innate,
        skills,
        talents,
        bonus_attributes: bonusAttributes.length === 0 ? null : bonusAttributes.length === 1 ? bonusAttributes[0] : bonusAttributes,
    };
}

async function readHeroResult(selector, options) {
    const hero = await resolveHeroSelector(selector);
    const page = await readPage(hero.name, options);
    if (page.status !== 'available') throw new Error(`Liquipedia hero page not found: ${hero.name}.`);
    return {
        hero: { id: hero.id, key: hero.key, sourceKey: hero.sourceKey, name: hero.name },
        page,
        abilities: formatHeroAbilities(page.wikitext, hero.key),
    };
}

export async function readHeroAbilities(selector, options = {}) {
    const requestOptions = {
        ...options,
        cacheDirectory: path.resolve(options.cacheDirectory ?? defaultCacheDirectory()),
        requestLimiterDirectory: path.resolve(options.requestLimiterDirectory ?? defaultCacheDirectory()),
    };
    return (await readHeroResult(selector, requestOptions)).abilities;
}

function splitPageSelector(selector) {
    const separator = selector.indexOf('#');
    if (separator < 0) return { title: selector, anchor: null };

    const title = selector.slice(0, separator);
    const encodedAnchor = selector.slice(separator + 1);
    let anchor;
    try {
        anchor = decodeURIComponent(encodedAnchor);
    }
    catch {
        throw new Error('Section anchors must use valid URL-fragment encoding.');
    }
    if (!isValidTitle(title)) throw new Error('A section selector must include a valid page title before #.');
    if (anchor.trim().length === 0 || anchor.length > 512 || /[\u0000-\u001f\u007f]/u.test(anchor)) {
        throw new Error('Section anchors must be non-empty, at most 512 characters, and cannot contain control characters.');
    }
    return { title, anchor };
}

function wikitextValue(value) {
    if (typeof value === 'string') return value;
    return typeof value?.['*'] === 'string' ? value['*'] : null;
}

function codepointOffsetToStringIndex(value, codepointOffset) {
    if (!Number.isSafeInteger(codepointOffset) || codepointOffset < 0) return null;
    let stringIndex = 0;
    let currentOffset = 0;
    for (const character of value) {
        if (currentOffset === codepointOffset) return stringIndex;
        stringIndex += character.length;
        currentOffset += 1;
    }
    return currentOffset === codepointOffset ? stringIndex : null;
}

function utf8ByteOffsetToCodepointOffset(value, byteOffset) {
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) return null;
    const bytes = Buffer.from(value, 'utf8');
    if (byteOffset > bytes.length) return null;
    const prefix = bytes.subarray(0, byteOffset).toString('utf8');
    if (prefix.includes('\ufffd')) return null;
    return [...prefix].length;
}

function normalizeSectionMetadata(rows, wikitext) {
    if (!Array.isArray(rows) || rows.length > 10000) {
        throw new Error('Liquipedia returned malformed section metadata.');
    }
    return rows.map((row) => {
        const byteOffset = Number.isSafeInteger(row?.byteoffset)
            ? utf8ByteOffsetToCodepointOffset(wikitext, row.byteoffset)
            : null;
        const rawIndex = row?.index;
        return {
            anchor: typeof row?.anchor === 'string' ? row.anchor : null,
            index: typeof rawIndex === 'string' || Number.isSafeInteger(rawIndex) ? String(rawIndex) : null,
            headingHtml: typeof row?.line === 'string' ? row.line : null,
            hLevel: Number.isSafeInteger(row?.hLevel) ? row.hLevel : Number.isSafeInteger(row?.level) ? row.level : null,
            codepointOffset: Number.isSafeInteger(row?.codepointOffset) ? row.codepointOffset : byteOffset,
        };
    });
}

function extractSectionWikitext(wikitext, sections, selectedPosition) {
    const selected = sections[selectedPosition];
    if (!selected || !Number.isSafeInteger(selected.hLevel) || selected.hLevel < 1 || selected.hLevel > 6) return null;
    const start = codepointOffsetToStringIndex(wikitext, selected.codepointOffset);
    if (start === null) return null;

    const nextSection = sections.slice(selectedPosition + 1).find(section => (
        Number.isSafeInteger(section.hLevel)
        && section.hLevel <= selected.hLevel
        && Number.isSafeInteger(section.codepointOffset)
    ));
    const end = nextSection
        ? codepointOffsetToStringIndex(wikitext, nextSection.codepointOffset)
        : wikitext.length;
    if (end === null || end <= start) return null;
    return wikitext.slice(start, end);
}

async function readApiSection(title, revisionId, sectionIndex, options) {
    const url = apiUrl({
        action: 'parse',
        oldid: String(revisionId),
        prop: 'wikitext|revid',
        section: sectionIndex,
    });
    const retrieval = await requestJson(url, { ...options, parseRequest: true });
    const parsed = retrieval.payload?.parse;
    const content = wikitextValue(parsed?.wikitext);
    if (typeof content !== 'string' || parsed?.revid !== revisionId) {
        throw new Error('Liquipedia returned malformed section wikitext.');
    }
    return { content, retrieval };
}

async function readSection(title, anchor, options) {
    if (!isValidTitle(title)) throw new Error('Page titles must be non-empty, at most 255 characters, and cannot contain pipes or control characters.');
    const url = apiUrl({
        action: 'parse',
        page: title,
        redirects: '1',
        prop: 'wikitext|tocdata|revid',
    });
    const retrieval = await requestJson(url, { ...options, parseRequest: true });
    const parsed = retrieval.payload?.parse;
    const pageTitle = parsed?.title;
    const pageId = parsed?.pageid;
    const revisionId = parsed?.revid;
    const fullWikitext = wikitextValue(parsed?.wikitext);
    if (!isValidTitle(pageTitle) || !Number.isSafeInteger(pageId) || pageId < 1
        || !Number.isSafeInteger(revisionId) || revisionId < 1 || typeof fullWikitext !== 'string') {
        throw new Error('Liquipedia returned a malformed parsed page.');
    }

    const sectionRows = parsed?.tocdata?.sections ?? parsed?.sections;
    const sections = normalizeSectionMetadata(sectionRows, fullWikitext);
    const matches = sections.map((section, position) => ({ section, position }))
        .filter(({ section }) => section.anchor === anchor);
    if (matches.length > 1) throw new Error(`Liquipedia returned an ambiguous section anchor: ${anchor}`);
    const match = matches[0];
    const revision = {
        id: revisionId,
        url: `${ARTICLE}index.php?${new URLSearchParams({ title: pageTitle, oldid: String(revisionId) })}`,
    };
    if (!match) {
        return {
            status: 'missing-section',
            requestedTitle: title,
            requestedSection: anchor,
            title: pageTitle,
            pageId,
            articleUrl: articleUrl(pageTitle),
            revision,
            section: null,
            contentModel: 'wikitext',
            wikitext: null,
            source: source(retrieval.retrievedAt, retrieval.cacheHit),
        };
    }

    let content = extractSectionWikitext(fullWikitext, sections, match.position);
    let sectionRetrieval = retrieval;
    if (content === null) {
        if (!match.section.index) throw new Error(`Liquipedia did not provide a source offset for section ${anchor}.`);
        const fetched = await readApiSection(pageTitle, revisionId, match.section.index, options);
        content = fetched.content;
        sectionRetrieval = fetched.retrieval;
    }

    return {
        status: 'available',
        requestedTitle: title,
        requestedSection: anchor,
        title: pageTitle,
        pageId,
        articleUrl: articleUrl(pageTitle),
        revision,
        section: {
            anchor: match.section.anchor,
            index: match.section.index,
            headingHtml: match.section.headingHtml,
            level: match.section.hLevel,
        },
        contentModel: 'wikitext',
        wikitext: content,
        source: source(sectionRetrieval.retrievedAt, retrieval.cacheHit && sectionRetrieval.cacheHit),
    };
}

async function searchPages(query, limit, options) {
    if (typeof query !== 'string' || query.trim().length === 0 || query.length > 256) {
        throw new Error('Search queries must be non-empty and no longer than 256 characters.');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Search limit must be between 1 and 50.');
    const url = apiUrl({
        action: 'query',
        list: 'search',
        srnamespace: '0',
        srsearch: query,
        srlimit: String(limit),
        utf8: '1',
    });
    const retrieval = await requestJson(url, options);
    const results = retrieval.payload?.query?.search;
    if (!Array.isArray(results) || results.length > limit || results.some(row => !isValidTitle(row.title))) {
        throw new Error('Liquipedia returned malformed search results.');
    }
    return {
        query,
        namespace: 0,
        results: results.map(row => ({
            title: row.title,
            pageId: Number.isSafeInteger(row.pageid) ? row.pageid : null,
            wordCount: Number.isSafeInteger(row.wordcount) ? row.wordcount : null,
            snippet: typeof row.snippet === 'string' ? row.snippet : null,
            timestamp: typeof row.timestamp === 'string' ? row.timestamp : null,
            articleUrl: articleUrl(row.title),
        })),
        source: source(retrieval.retrievedAt, retrieval.cacheHit),
    };
}

function writeJson(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            format: { type: 'string', default: 'json' },
            refresh: { type: 'boolean', default: false },
            limit: { type: 'string', default: '10' },
            'cache-dir': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    if (values.help) {
        console.log('node scripts/read-liquipedia.mjs page <title[#section-anchor]> [--format json|wikitext] [--refresh] [--cache-dir PATH]');
        console.log('node scripts/read-liquipedia.mjs hero <Hero-Name|Hero-Id|Hero-Slug|Hero-Alias> [--format json|abilities] [--refresh] [--cache-dir PATH]');
        console.log('node scripts/read-liquipedia.mjs search <query> [--limit 1..50] [--cache-dir PATH]');
        console.log('Reads the Liquipedia Dota 2 MediaWiki API. Responses are cached locally; --refresh fetches again.');
        return;
    }
    if (positionals.length !== 2) throw new Error('Provide a command (page, hero, or search) and one title, hero selector, or query. Use --help for usage.');
    if (!['json', 'wikitext', 'abilities'].includes(values.format)) throw new Error('Format must be json, wikitext, or abilities.');
    const options = {
        cacheDirectory: path.resolve(values['cache-dir'] ?? defaultCacheDirectory()),
        requestLimiterDirectory: defaultCacheDirectory(),
        refresh: values.refresh,
    };
    const [command, term] = positionals;
    if (command === 'hero') {
        if (values.format === 'wikitext') throw new Error('Hero output supports json or abilities format.');
        const result = await readHeroResult(term, options);
        if (values.format === 'abilities') writeJson(result.abilities);
        else writeJson({ ...result.page, requestedHero: term, hero: result.hero });
        return;
    }
    if (command === 'page') {
        if (values.format === 'abilities') throw new Error('The abilities format is available only for the hero command.');
        const selector = splitPageSelector(term);
        const page = selector.anchor === null
            ? await readPage(selector.title, options)
            : await readSection(selector.title, selector.anchor, options);
        if (values.format === 'wikitext') {
            if (page.status === 'missing-section') throw new Error(`Liquipedia section not found: ${selector.title}#${selector.anchor}`);
            if (page.status !== 'available') throw new Error(`Liquipedia page not found: ${selector.title}`);
            process.stdout.write(page.wikitext);
            return;
        }
        writeJson(page);
        return;
    }
    if (command === 'search') {
        if (values.format !== 'json') throw new Error('Search results support JSON output only.');
        const limit = Number(values.limit);
        writeJson(await searchPages(term, limit, options));
        return;
    }
    throw new Error(`Unknown command: ${command}. Use page, hero, or search.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

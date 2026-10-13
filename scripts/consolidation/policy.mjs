import { fieldRow, escapePointer, leafCount } from './io.mjs';

// Phase A destinations are a preservation contract, not a second runtime schema.
export const scriptGroups = [
    ['normalization', 'migrate', ['roster', 'parse', 'matchups-file'],
        'Inject roster and storage; preserve identity crosswalks and partial-run clocks.'],
    ['acquisition', 'migrate', ['scrape', 'scrape-electron', 'build-collector', 'collector-body'],
        'Inject fetch, roster, paths, clocks and logging; make browser collection optional and human-operated.'],
    ['acquisition', 'migrate', ['positions', 'lanes', 'stratz', 'synergy', 'timings', 'progress'],
        'Inject clients, credentials, storage, clocks, retry budgets and cancellation; retain counts and cohorts.'],
    ['derived population analysis', 'migrate', ['roles', 'assign', 'synergy-math', 'calibrate-math'],
        'Version inference, smoothing and fitting recipes; accept explicit statistical/model inputs.'],
    ['application policy', 'split', ['calibrate'],
        'Retain model features, thresholds, sanity drafts and runtime estimates in Picker; extract acquisition and injected fitting.'],
    ['acquisition', 'split', ['refresh'],
        'Move explicit data-stage orchestration; retain app calibration and README refresh in Picker.'],
    ['presentation', 'retain in Picker', ['readme', 'readme-status', 'readme-images', 'readme-banner', 'app-scheme'],
        'Keep app documentation, badges, screenshots and serving helpers; extract window logic only when needed.'],
    ['application policy', 'retain in Picker', ['register-ts-resolve', 'ts-resolve'],
        'Keep app TypeScript loaders; migrated tests must use an independent library harness.'],
];

const testOwners = {
    collector: 'build-collector', diagnostics: 'scrape', 'synergy-priors': 'synergy',
    'synergy-pipeline': 'synergy', 'readme-sync': 'readme',
};

export function classifyScript(filename) {
    const test = filename.endsWith('.test.mjs');
    const stem = filename.replace(/(?:\.test)?\.(?:mjs|js|html)$/, '');
    const owner = testOwners[stem] ?? stem;
    const group = scriptGroups.find(([, , names]) => names.includes(owner));
    if (!group) throw new Error('Unclassified Picker script: ' + filename);
    const [category, fate, , requirement] = group;
    return { category, fate, test, owner, requirement,
        destination: fate === 'retain in Picker' ? 'picker:scripts/' + filename
            : (test ? 'tests/population/' : 'scripts/population/') + filename };
}

export function safeKey(key) {
    if (typeof key !== 'string' || !/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(key)) {
        throw new Error('Unsafe hero key: ' + key);
    }
    return key;
}

export function crosswalk(heroes, roster) {
    const ids = new Set();
    const keys = new Set();
    const engines = new Set();
    const slugs = new Set();
    const picker = new Map();
    for (const entry of roster) {
        safeKey(entry.slug);
        if (slugs.has(entry.slug) || picker.has(entry.steam)) throw new Error('Duplicate Picker identity: ' + entry.slug);
        slugs.add(entry.slug);
        picker.set(entry.steam, entry);
    }
    const rows = heroes.map(hero => {
        safeKey(hero.key);
        if (!/^[1-9][0-9]*$/.test(hero.id) || ids.has(hero.id) || keys.has(hero.key)
            || engines.has(hero.heroKey) || hero.heroId !== hero.id || hero.heroKey !== 'npc_dota_hero_' + hero.key) {
            throw new Error('Duplicate or inconsistent hero identity: ' + hero.id);
        }
        ids.add(hero.id);
        keys.add(hero.key);
        engines.add(hero.heroKey);
        const provider = picker.get(hero.key);
        return { id: hero.id, key: hero.key, sourceKey: hero.heroKey, name: hero.name,
            enabled: hero.enabled, providerSlug: provider?.slug ?? null,
            providerState: provider ? 'matched-engine-key' : 'unavailable',
            reason: provider ? null : 'No matching engine identity in selected Picker roster.' };
    });
    for (const entry of roster) if (!keys.has(entry.steam)) throw new Error('Unmapped Picker hero: ' + entry.slug);
    return rows;
}

export function parseRoster(text) {
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
        if (!/^\s*\{\s*slug:/.test(line)) continue;
        const match = /^\s*\{\s*slug:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*attr:\s*"([^"]+)",\s*steam:\s*"([^"]+)"\s*\},?\s*$/.exec(line);
        if (!match) throw new Error('Unrecognized Picker roster entry.');
        rows.push({ slug: match[1], name: match[2], attr: match[3], steam: match[4] });
    }
    if (!rows.length) throw new Error('Empty Picker roster.');
    return rows;
}

const statisticsKinds = new Set(['provider-profile', 'historical-profile', 'position-outcome', 'lane-outcome',
    'duration-outcome', 'population-duration', 'population-overall', 'item-build', 'model-estimate']);

export function observationDestination(record, byId) {
    const hero = byId.get(record.heroId);
    if (!hero) throw new Error('Observation refers to an unknown hero: ' + record.heroId);
    const prefix = 'data/heroes/' + hero.key + '/';
    if (record.kind === 'native-classification') return prefix + 'profile.json';
    if (record.kind === 'tag-claim') return 'data/reviews/claims.json';
    if (record.kind === 'matchup' || record.kind === 'population-matchup') return prefix + 'matchups/counters.json';
    if (record.kind === 'synergy') return prefix + 'matchups/synergies.json';
    if (statisticsKinds.has(record.kind)) return prefix + 'statistics.json';
    throw new Error('Unmapped observation kind: ' + record.kind);
}

export function fileDestinations(name, byId) {
    let match;
    if ((match = /^heroes\/(\d+)\.json$/.exec(name))) {
        const key = byId.get(match[1])?.key;
        if (!key) throw new Error('Unknown hero file: ' + name);
        return ['profile.json', 'abilities.json', 'mechanics.json'].map(file => 'data/heroes/' + key + '/' + file)
            .concat('data/mechanics/abilities.json', 'data/reviews/claims.json', 'data/heroes/' + key + '/guides/details.json');
    }
    if ((match = /^(?:runtime\/)?observations\/heroes\/(\d+)\.json$/.exec(name))) {
        const key = byId.get(match[1])?.key;
        if (!key) throw new Error('Unknown observation file: ' + name);
        return name.startsWith('runtime/') ? ['data/runtime/heroes/' + key + '/observations.json']
            : ['statistics.json', 'matchups/counters.json', 'matchups/synergies.json'].map(file => 'data/heroes/' + key + '/' + file);
    }
    if ((match = /^runtime\/guides\/(\d+)\.json$/.exec(name))) {
        const key = byId.get(match[1])?.key;
        if (!key) throw new Error('Unknown guide file: ' + name);
        return ['data/heroes/' + key + '/guides/details.json', 'data/runtime/heroes/' + key + '/guide.json'];
    }
    const shared = {
        'manifest.json': ['data/manifest.json'], 'sources.json': ['data/observations/sources.json', 'data/reviews/sources.json'],
        'claims/index.json': ['data/reviews/claims.json'], 'observations/index.json': ['data/observations/index.json'],
        'mechanics/reference.json': ['data/mechanics/reference.json', 'data/reviews/bindings.json'],
        'runtime/manifest.json': ['data/runtime/manifest.json'], 'runtime/core.json': ['data/runtime/core.json'],
    };
    if (shared[name]) return shared[name];
    if (name.startsWith('reconciliation/')) return ['evidence:baseline/' + name];
    throw new Error('Unmapped canonical file: ' + name);
}

export function heroFieldDestination(section, field, key) {
    const base = 'data/heroes/' + key + '/';
    if (section === 'claims') return 'data/reviews/claims.json';
    if (['sourceIds', 'sourceIdentity', 'sourceRefs', 'review', 'compatibility'].includes(field)) return 'data/reviews/bindings.json';
    if (section === 'hero') return field === 'detailRecord' ? 'data/heroes/index.json' : base + 'profile.json';
    if (section === 'abilities' || section === 'activations') return 'data/mechanics/abilities.json';
    if (section === 'effects' || section === 'conditions') return base + 'mechanics.json';
    if (section === 'evidence') return field === 'guidePath' ? base + 'guides/details.json' : 'data/reviews/sources.json';
    throw new Error('Unmapped hero section: ' + section);
}

export const pickerDataPolicy = {
    'matchups.json': { provider: 'Dotabuff', fields: ['generatedAt', 'source', 'note', 'heroes', 'matchups'],
        destinations: ['data/heroes/{key}/statistics.json', 'data/heroes/{key}/matchups/counters.json'],
        preserve: 'Directional [disadvantage, winRate, matches]; lane tables, derived positions and rates; carry-over clocks stay unknown when absent.' },
    'positions.json': { provider: 'STRATZ', fields: ['generatedAt', 'source', 'note', 'weeks', 'period', 'gameModes', 'bands', 'heroes'],
        destinations: ['data/heroes/{key}/statistics.json'],
        preserve: 'Every rank band and position 1-5 [games, wins], week IDs, period and ranked All Pick scope.' },
    'lanes.json': { provider: 'STRATZ', fields: ['generatedAt', 'source', 'note', 'weeks', 'period', 'brackets', 'minLanes', 'against', 'with'],
        destinations: ['data/heroes/{key}/statistics.json'],
        preserve: 'Both against and with, in stored hero/position/pair direction; [lanes,wins,draws,losses,gameWins], coverage gap and threshold.' },
    'synergies.json': { provider: 'OpenDota', fields: ['generatedAt', 'source', 'note', 'matches', 'matchIdRange', 'minRank', 'minGames', 'positionsFrom', 'synergies'],
        destinations: ['data/heroes/{key}/matchups/synergies.json'],
        preserve: 'Stored a-then-b order, cc/cs/sc/ss cell order, sample counts, shrinkage results and inferred-position recipe; absent cells stay absent.' },
    'timings.json': { provider: 'OpenDota', fields: ['generatedAt', 'source', 'note', 'matches', 'matchIdRange', 'minRank', 'minGames', 'buckets', 'timings'],
        destinations: ['data/heroes/{key}/statistics.json'],
        preserve: 'Ordered duration buckets [games,winRate,skew], bounds, sample window, count and shrinkage recipe; no minute-specific power inference.' },
    'calibration.json': { provider: 'OpenDota', fields: ['generatedAt', 'source', 'note', 'matches', 'matchIdRange', 'rankBand', 'inputs',
        'tau', 'weights', 'se', 'side', 'holdout', 'reliability', 'range'],
    destinations: ['data/observations/calibration.json'],
    preserve: 'All weights, standard errors including null, side, tau, holdout, reliability bins, range, sample count/range and input generation clocks; app owns model policy.' },
};

export function mapPickerData(name, value, heroes) {
    const policy = pickerDataPolicy[name];
    if (!policy) throw new Error('Unmapped Picker output: ' + name);
    const bySlug = new Map(heroes.filter(hero => hero.providerSlug).map(hero => [hero.providerSlug, hero]));
    const heroFor = slug => {
        const hero = bySlug.get(slug);
        if (!hero) throw new Error('Unmapped Picker data hero: ' + slug);
        return hero;
    };
    const rows = [];
    const file = 'picker:public/data/' + name;
    const add = (pointer, child, destination, identity) => rows.push(fieldRow(file, pointer, child, destination, identity));
    for (const [field, child] of Object.entries(value)) {
        if (!policy.fields.includes(field)) throw new Error('Unmapped Picker field: ' + file + '#/' + field);
        const pointer = '/' + escapePointer(field);
        if (name === 'calibration.json') {
            add(pointer, child, 'data/observations/calibration.json', 'picker:calibration');
        }
        else if (field === 'heroes' && Array.isArray(child)) {
            const seen = new Set();
            for (const [index, record] of child.entries()) {
                const hero = heroFor(record.slug);
                if (seen.has(hero.id)) throw new Error('Duplicate Picker data hero: ' + record.slug);
                seen.add(hero.id);
                add(pointer + '/' + index, record, 'data/heroes/' + hero.key + '/statistics.json', hero.id);
            }
            if (!child.length) add(pointer, child, 'data/observations/index.json');
        }
        else if (['heroes', 'timings', 'matchups', 'synergies', 'against', 'with'].includes(field)) {
            for (const [slug, record] of Object.entries(child)) {
                const hero = heroFor(slug);
                const base = 'data/heroes/' + hero.key + '/';
                const heroPointer = pointer + '/' + escapePointer(slug);
                if (field === 'matchups' || field === 'synergies') {
                    for (const [otherSlug, pair] of Object.entries(record)) {
                        const other = heroFor(otherSlug);
                        add(heroPointer + '/' + escapePointer(otherSlug), pair, base + 'matchups/' + (field === 'matchups' ? 'counters' : 'synergies') + '.json',
                            { heroId: hero.id, otherHeroId: other.id, storedSlugs: [slug, otherSlug], direction: field === 'matchups' ? 'hero-vs-opponent' : 'stored-a-then-b' });
                    }
                    if (!Object.keys(record).length) add(heroPointer, record, base + 'matchups/' + (field === 'matchups' ? 'counters' : 'synergies') + '.json', hero.id);
                }
                else if (field === 'against' || field === 'with') {
                    for (const [position, pairs] of Object.entries(record)) {
                        for (const [otherSlug, pair] of Object.entries(pairs)) {
                            const other = heroFor(otherSlug);
                            add(heroPointer + '/' + escapePointer(position) + '/' + escapePointer(otherSlug), pair, base + 'statistics.json',
                                { heroId: hero.id, otherHeroId: other.id, position, direction: field });
                        }
                        if (!Object.keys(pairs).length) add(heroPointer + '/' + escapePointer(position), pairs, base + 'statistics.json', hero.id);
                    }
                    if (!Object.keys(record).length) add(heroPointer, record, base + 'statistics.json', hero.id);
                }
                else add(heroPointer, record, base + 'statistics.json', hero.id);
            }
            if (!Object.keys(child).length) add(pointer, child, 'data/observations/index.json');
        }
        else add(pointer, child, 'data/observations/sources.json', 'picker:' + name);
    }
    if (rows.reduce((sum, row) => sum + row.leaves, 0) !== leafCount(value)) throw new Error('Incomplete Picker field coverage: ' + name);
    return rows;
}

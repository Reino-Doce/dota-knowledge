import { decimal } from './exact.mjs';

/** Display names are evidence, never a join key or a native profile update. */
export function createRoster(roster) {
    if (!Array.isArray(roster) || !roster.length) throw new Error('An explicit canonical roster is required.');
    const indexes = Object.fromEntries(['id', 'key', 'sourceKey', 'providerSlug'].map(key => [key, new Map()]));
    for (const hero of roster) {
        if (decimal(hero.id) !== hero.id || hero.id === '0' || !/^[a-z][a-z0-9_]*$/.test(hero.key)
            || hero.sourceKey !== 'npc_dota_hero_' + hero.key) throw new Error('Invalid canonical hero identity.');
        for (const [field, index] of Object.entries(indexes)) {
            const value = hero[field];
            if (value === null || value === undefined) continue;
            if (field === 'providerSlug' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error('Unsafe provider slug.');
            if (index.has(value)) throw new Error('Ambiguous roster identity: ' + field);
            index.set(value, hero);
        }
    }
    return {
        heroes: structuredClone(roster),
        resolve(field, value) {
            if (field === 'id') value = decimal(value);
            const hero = indexes[field]?.get(value);
            if (!hero) throw new Error('Unknown provider identity.');
            return hero;
        },
        providerRows(rows, provider) {
            if (!Array.isArray(rows) || !rows.length) throw new Error('Missing provider roster.');
            const seen = new Set();
            const result = rows.map(row => {
                const engine = provider === 'stratz' ? 'npc_dota_hero_' + row.shortName : row.name;
                const hero = this.resolve('sourceKey', engine);
                if (decimal(row.id) !== hero.id || seen.has(hero.id)) throw new Error('Ambiguous provider crosswalk.');
                seen.add(hero.id);
                return { heroId: hero.id, heroKey: hero.key, provider, providerName: row.displayName ?? row.localized_name ?? null, sourceRecord: row };
            });
            if (roster.some(hero => hero.enabled !== false && !seen.has(hero.id))) throw new Error('Incomplete provider roster.');
            return result;
        },
    };
}

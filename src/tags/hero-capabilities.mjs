import { isHeroCapabilities } from '../record-contracts.mjs';
import { abilityTagCatalog } from './catalog.mjs';

const tagPattern = /^[a-z][a-z0-9_]{0,63}$/;
const identity = value => typeof value === 'string' && value.length > 0;
const tagCategories = new Map(abilityTagCatalog.tags.map(tag => [tag.key, tag.categories]));

/** Each distinct owned ability tag adds one point to every catalog category it belongs to. */
export function deriveHeroCapabilities(heroes, abilities) {
    if (!Array.isArray(heroes) || !Array.isArray(abilities)) {
        throw new Error('Capability aggregation requires hero and ability arrays.');
    }
    const counts = new Map();
    for (const hero of heroes) {
        if (!identity(hero?.id)) throw new Error('Invalid capability hero identity.');
        if (counts.has(hero.id)) throw new Error('Duplicate capability hero: ' + hero.id);
        counts.set(hero.id, new Map());
    }
    const seenAbilities = new Set();
    for (const ability of abilities) {
        if (!identity(ability?.id)) throw new Error('Invalid capability ability identity.');
        if (seenAbilities.has(ability.id)) throw new Error('Duplicate capability ability: ' + ability.id);
        seenAbilities.add(ability.id);
        const heroCounts = counts.get(ability.heroId);
        if (!heroCounts) throw new Error('Orphan capability ability: ' + ability.id);
        if (!Array.isArray(ability.tags) || [...ability.tags].some(tag => typeof tag !== 'string' || !tagPattern.test(tag))) {
            throw new Error('Invalid capability ability tags: ' + ability.id);
        }
        for (const tag of new Set(ability.tags)) {
            const categories = tagCategories.get(tag);
            if (!categories) throw new Error('Unrecognized capability ability tag: ' + ability.id + ': ' + tag);
            for (const category of categories) {
                const count = (heroCounts.get(category) ?? 0) + 1;
                if (!Number.isSafeInteger(count)) throw new Error('Capability count exceeds the safe integer range: ' + category);
                heroCounts.set(category, count);
            }
        }
    }
    return heroes.map(hero => ({
        ...hero,
        capabilities: Object.fromEntries([...counts.get(hero.id)].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
    }));
}

/** Legacy profiles may omit scores; present scores must match their ability tag category sums. */
export function assertHeroCapabilities(heroes, abilities) {
    const scoredHeroes = heroes.filter(hero => Object.hasOwn(hero, 'capabilities'));
    if (!scoredHeroes.length) return;
    const scoredIds = new Set(scoredHeroes.map(hero => hero.id));
    const derived = deriveHeroCapabilities(scoredHeroes, abilities.filter(ability => scoredIds.has(ability.heroId)));
    for (let index = 0; index < scoredHeroes.length; index++) {
        const hero = scoredHeroes[index];
        const expected = derived[index].capabilities;
        if (!isHeroCapabilities(hero.capabilities)
            || Object.keys(hero.capabilities).length !== Object.keys(expected).length
            || Object.entries(expected).some(([category, count]) => !Object.hasOwn(hero.capabilities, category) || hero.capabilities[category] !== count)) {
            throw new Error('Hero capabilities do not match ability tags: ' + hero.id);
        }
    }
}

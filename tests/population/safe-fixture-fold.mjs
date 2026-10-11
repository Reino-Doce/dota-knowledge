// The upstream simulations use safe numeric counters. Convert only at this test boundary.
import { foldSynergy } from '../../scripts/population/normalize.mjs';
import { numericCounts } from '../../scripts/population/exact.mjs';
import { synergySql } from '../../scripts/population/queries.mjs';
import { createRoster } from '../../scripts/population/identity.mjs';
export const windowSql = (lo, hi) => synergySql(String(lo), String(hi), { minRank: 0 });
export function fold(rows, totals, priors) {
    const ids = [...new Set(rows.flatMap(row => row.t))].map(String);
    const roster = createRoster(ids.map(id => ({ id, key: 'hero' + id, sourceKey: 'npc_dota_hero_hero' + id })));
    const previous = { heroes: new Map([...totals.heroes].map(([id, row]) => [String(id), row])),
        pairs: new Map([...totals.pairs].map(([key, row]) => [key, { ...row, a: String(row.a), b: String(row.b) }])), ambiguous: totals.ambiguous ?? 0 };
    const result = foldSynergy(rows, roster, priors ? Object.fromEntries(priors) : null, previous);
    totals.heroes = new Map([...result.heroes].map(([id, row]) => [Number(id), numericCounts(row)]));
    totals.pairs = new Map([...result.pairs].map(([key, row]) => [key, numericCounts(row)]));
    totals.ambiguous = Number(result.ambiguous);
    return Math.round(rows.length / 2);
}

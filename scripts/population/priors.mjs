import { addCounts, decimal, safeCount, unavailable } from './exact.mjs';
export const bandForMinRank = minRank => minRank >= 80 ? 'immortal' : minRank >= 70 ? 'divine' : 'all';

/** Explicit prior construction; collection never chooses a source implicitly. */
export function positionPriorsFromCounts(rows, { band }) {
    const byHero = new Map();
    for (const row of rows) {
        if (row.kind !== 'position-outcome' || row.cohort.band !== band) continue;
        const cells = byHero.get(row.heroId) ?? {};
        if (cells[row.position] !== undefined) throw new Error('Overlapping position inputs.');
        cells[row.position] = decimal(row.matchCount); byHero.set(row.heroId, cells);
    }
    const priors = {}; const unavailableHeroes = {};
    for (const [id, cells] of byHero) {
        const total = safeCount(addCounts(...Object.values(cells)));
        if (total === null) { unavailableHeroes[id] = unavailable(); continue; }
        if (!total) continue;
        priors[id] = Object.fromEntries([1, 2, 3, 4, 5].map(position => [position, Number(cells[position] ?? 0) / total]));
    }
    return { priors, unavailable: unavailableHeroes };
}

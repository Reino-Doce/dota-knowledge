export const BUCKETS = [
  { key: "early", label: "Before 25′", short: "<25", maxSeconds: 1500 },
  { key: "mid", label: "25–35′", short: "25–35", maxSeconds: 2100 },
  { key: "late", label: "35–45′", short: "35–45", maxSeconds: 2700 },
  { key: "veryLate", label: "45′ and up", short: "45+", maxSeconds: null },
];

/**
 * How hard a thin sample is pulled back towards "no skew at all".
 *
 * A hero with 40 games in the 45-minute bucket will show a wild number by
 * chance alone. Halving the skew at 400 games keeps the bucket honest without
 * flattening heroes that genuinely swing.
 */
const SHRINK_GAMES = 400;

export function buildTimings(totals, byId, { minGames = 200 } = {}) {
  /** slug -> bucket index -> {games, wins} */
  const heroes = new Map();
  for (const row of totals.values()) {
    const slug = byId.get(row.hero);
    if (!slug) continue;
    const buckets = heroes.get(slug) ?? BUCKETS.map(() => ({ games: 0, wins: 0 }));
    const cell = buckets[row.bucket];
    if (!cell) continue;
    cell.games += row.games;
    cell.wins += row.wins;
    heroes.set(slug, buckets);
  }

  const table = {};
  let kept = 0;
  let thin = 0;

  for (const [slug, buckets] of heroes) {
    const games = buckets.reduce((sum, b) => sum + b.games, 0);
    const wins = buckets.reduce((sum, b) => sum + b.wins, 0);
    if (games < minGames) {
      thin++;
      continue;
    }
    const overall = (wins / games) * 100;

    table[slug] = buckets.map((b) => {
      if (!b.games) return [0, 0, 0];
      const winRate = (b.wins / b.games) * 100;
      // Shrink towards the hero's own baseline, hard when the bucket is thin.
      const skew = (winRate - overall) * (b.games / (b.games + SHRINK_GAMES));
      return [
        b.games,
        Math.round(winRate * 100) / 100,
        Math.round(skew * 1000) / 1000,
      ];
    });
    kept++;
  }

  return { table, kept, thin };
}


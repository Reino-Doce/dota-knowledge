/**
 * Turns Dotabuff's per-lane tables into position 1-5 weights.
 *
 * Dotabuff's own position filter is a Plus feature, but the lane pages are
 * free and carry everything needed to reconstruct positions:
 *
 *   - which lane a hero stands in  -> `presence`
 *   - whether they are the core or the support in that lane -> `gpm`
 *
 * A pos 1 and a pos 5 both live in the safe lane; their gold per minute does
 * not overlap. So for each lane we split the GPM distribution in two and read
 * the lane + side of the split as a position.
 *
 * Pure functions only — see roles.test.mjs.
 */

export const LANES = ["mid", "safe", "off", "jungle", "roaming"];
export const POSITIONS = [1, 2, 3, 4, 5];

/** Lanes too thin to say anything about a hero. */
const MIN_PRESENCE = 2;
/** Positions below this share of a hero's games are not worth listing. */
const MIN_POSITION_WEIGHT = 0.12;

/**
 * How each lane's presence is split between a core and a support position.
 * `[corePosition, supportPosition]`.
 */
const LANE_SPLIT = {
  mid: [2, 4],
  safe: [1, 5],
  off: [3, 4],
  jungle: [1, 4],
  // Roaming is a support behaviour on both sides of the map; there is no core
  // half to split, so it is shared between the two support positions.
  roaming: [4, 5],
};

/** Roamers lean pos 4 rather than pos 5. */
const ROAMING_SPLIT = 0.7;

/**
 * Used only when there is not enough data to learn a lane's core/support
 * boundary — a mid-lane hero is overwhelmingly likely to be the core there,
 * a safe-lane one is a coin flip between pos 1 and pos 5.
 */
const FALLBACK_CORE_SHARE = { mid: 0.9, safe: 0.55, off: 0.65, jungle: 0.6, roaming: ROAMING_SPLIT };

/** A lane needs at least this many heroes before its own split is trusted. */
const MIN_SAMPLES_FOR_SPLIT = 4;

/**
 * How much of a hero's play must sit in a position before that position's win
 * rate is believed over the hero's overall one.
 *
 * Dotabuff publishes one win rate per *lane*, not per position, so a lane's
 * figure is handed to both the core and the support standing in it. For a hero
 * who really does play both that is fine. For one who does not, it is a number
 * describing somebody else: Earth Spirit spends 0.15% of their games as pos 1
 * and 18% as pos 5, yet both inherited the safe lane's 44.53% — so the app
 * docked a hero it had already excluded from the role, using the hard support's
 * win rate to do it.
 *
 * Splitting the lane figure properly is not possible from this data, and
 * measurement says there is nothing there to split: regressing lane win rate on
 * the GPM-derived core share across every hero gives a slope of −0.18 points in
 * the safe lane (r = −0.04) and −0.26 in the off lane (r = −0.05). Cores and
 * supports in a lane win at the same rate; the spread is per hero, not per role.
 *
 * So instead of inventing a split, each position's win rate is pulled towards
 * the hero's overall figure in proportion to how thin the position is:
 *
 *     wr = (share · laneWinRate + K · overallWinRate) / (share + K)
 *
 * At K = 0.15 a position carrying 15% of a hero's games weighs as much as the
 * prior, a main role is left almost untouched, and a role the hero never plays
 * collapses to their overall win rate — which is the honest answer.
 */
const POSITION_WR_PRIOR = 0.15;

/**
 * How cleanly a lane's GPM must fall into two groups before we believe the
 * split is core-vs-support rather than an arbitrary line through one crowd.
 *
 * Measured Fisher-style: (mean gap) / (sum of the two standard deviations).
 * Real Dotabuff data, August 2026:
 *
 *   safe  2.33  carries ~600 next to hard supports ~330 — obviously two groups
 *   off   1.61  offlaners ~500 next to pos 4s ~350     — still two groups
 *   mid   1.11  almost entirely cores; Otsu's cut lands *between cores* and
 *               would file a 544 GPM Invoker as a support
 *
 * Below the threshold the lane borrows the boundary computed across all lanes,
 * where the two populations genuinely do exist.
 */
const MIN_SEPARATION = 1.4;

/**
 * Each side of a lane's split must hold at least this share of it.
 *
 * Otsu always returns *a* cut. Given one crowd plus an outlier — a 767 GPM
 * Alchemist among midlaners — it happily fences off the outlier, and that split
 * scores a wonderful separation while meaning nothing. A boundary between two
 * populations has to have a population on both sides of it.
 */
const MIN_CLASS_SHARE = 0.15;

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

const stdDev = (values) => {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
};

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/**
 * Otsu's method: the cut that minimises the variance inside the two halves.
 * Used because carry GPM and support GPM form two clear humps, and the gap
 * between them moves between patches — a fixed number would go stale.
 */
export function otsuThreshold(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 4) return sorted.length ? quantile(sorted, 0.5) : 0;

  const total = sorted.reduce((a, b) => a + b, 0);
  let bestScore = -1;
  let best = quantile(sorted, 0.5);
  let sumBelow = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    sumBelow += sorted[i];
    const nBelow = i + 1;
    const nAbove = sorted.length - nBelow;
    const meanBelow = sumBelow / nBelow;
    const meanAbove = (total - sumBelow) / nAbove;
    // Between-class variance; maximising it minimises the within-class one.
    const score = nBelow * nAbove * (meanBelow - meanAbove) ** 2;
    if (score > bestScore) {
      bestScore = score;
      best = (sorted[i] + sorted[i + 1]) / 2;
    }
  }
  return best;
}

/**
 * Soft core/support membership. A hero right on the threshold counts half for
 * each position rather than being forced to one side.
 */
const logistic = (value, threshold, scale) => 1 / (1 + Math.exp(-(value - threshold) / scale));

/**
 * @param {Map<string, Record<string, {presence:number, winRate:number, gpm:number}>>} heroLanes
 * @param {Map<string, number>} [overallWinRate] Each hero's win rate across all
 *   games, used as the prior a thin position's win rate is shrunk towards. Omit
 *   it and the raw lane figures are handed through unchanged.
 * @returns {Map<string, {positions: Record<number, number>, positionWinRate: Record<number, number>, topPositions: number[]}>}
 */
export function derivePositions(heroLanes, overallWinRate = new Map()) {
  const splitOf = (gpms) => {
    if (gpms.length < MIN_SAMPLES_FOR_SPLIT) return null;
    const threshold = otsuThreshold(gpms);
    const below = gpms.filter((g) => g < threshold);
    const above = gpms.filter((g) => g >= threshold);
    const smallestSide = Math.min(below.length, above.length) / gpms.length;
    if (!below.length || !above.length || smallestSide < MIN_CLASS_SHARE) return null;

    const sorted = [...gpms].sort((a, b) => a - b);
    const spread = quantile(sorted, 0.9) - quantile(sorted, 0.1);
    return {
      threshold,
      // Wide enough to keep the blend smooth, narrow enough to stay decisive.
      scale: Math.max(15, spread / 8),
      separation: (mean(above) - mean(below)) / (stdDev(below) + stdDev(above) || 1),
    };
  };

  const gpmsIn = (lane) => {
    const out = [];
    for (const lanes of heroLanes.values()) {
      const stats = lanes[lane];
      if (stats && stats.presence >= MIN_PRESENCE) out.push(stats.gpm);
    }
    return out;
  };

  // One core/support boundary per lane — but only where that lane really does
  // hold both. A lane that is nearly all cores (mid) borrows the boundary
  // computed across every lane, where both populations exist.
  const globalSplit = splitOf(LANES.flatMap(gpmsIn));
  const boundary = {};
  for (const lane of LANES) {
    const own = splitOf(gpmsIn(lane));
    boundary[lane] = own && own.separation >= MIN_SEPARATION ? own : globalSplit;
  }

  const out = new Map();
  for (const [slug, lanes] of heroLanes) {
    const weights = Object.fromEntries(POSITIONS.map((p) => [p, 0]));
    const winAcc = Object.fromEntries(POSITIONS.map((p) => [p, { sum: 0, weight: 0 }]));

    const add = (position, weight, winRate) => {
      if (weight <= 0) return;
      weights[position] += weight;
      if (Number.isFinite(winRate)) {
        winAcc[position].sum += winRate * weight;
        winAcc[position].weight += weight;
      }
    };

    for (const lane of LANES) {
      const stats = lanes[lane];
      if (!stats || stats.presence < MIN_PRESENCE) continue;
      const [corePos, supportPos] = LANE_SPLIT[lane];

      const coreShare = lane === "roaming"
        ? ROAMING_SPLIT
        : boundary[lane]
          ? logistic(stats.gpm, boundary[lane].threshold, boundary[lane].scale)
          : FALLBACK_CORE_SHARE[lane];

      add(corePos, stats.presence * coreShare, stats.winRate);
      add(supportPos, stats.presence * (1 - coreShare), stats.winRate);
    }

    const total = POSITIONS.reduce((sum, p) => sum + weights[p], 0);
    if (!total) continue;

    const prior = overallWinRate.get(slug);
    const hasPrior = Number.isFinite(prior);

    const positions = {};
    const positionWinRate = {};
    for (const p of POSITIONS) {
      const share = weights[p] / total;
      const rounded = round(share, 4);
      if (rounded > 0) positions[p] = rounded;
      if (winAcc[p].weight <= 0) continue;

      const laneMean = winAcc[p].sum / winAcc[p].weight;
      positionWinRate[p] = round(
        hasPrior
          ? (share * laneMean + POSITION_WR_PRIOR * prior) / (share + POSITION_WR_PRIOR)
          : laneMean,
        2,
      );
    }

    const topPositions = POSITIONS
      .filter((p) => (positions[p] ?? 0) >= MIN_POSITION_WEIGHT)
      .sort((a, b) => positions[b] - positions[a]);

    out.set(slug, {
      positions,
      positionWinRate,
      // Never leave a hero role-less: fall back to their single best lane.
      topPositions: topPositions.length
        ? topPositions
        : [POSITIONS.reduce((best, p) => ((positions[p] ?? 0) > (positions[best] ?? 0) ? p : best), 1)],
    });
  }
  return out;
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

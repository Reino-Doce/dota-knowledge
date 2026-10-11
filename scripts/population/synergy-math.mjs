/**
 * Turning raw pair counts into a synergy number you can trust.
 *
 * The naive version — "win rate of A and B together" — is close to useless for
 * drafting. Two 55% heroes win 59% of games side by side simply because they
 * are both good, and a pair that only ever showed up 40 times can read +8%
 * purely from noise. Both problems have to go before the number means anything.
 *
 * So we do two things:
 *
 *   1. Subtract what the pair was *expected* to do. Hero strength is additive
 *      on the log-odds scale, so the expectation for A+B is
 *      `logit(p_a) + logit(p_b)`, and synergy is whatever the pair beat that by.
 *
 *   2. Shrink that residual towards zero in proportion to how noisy it is. The
 *      shrinkage strength is not a magic constant: it is estimated from the
 *      spread of the residuals themselves, so a dataset with 3× the matches
 *      shrinks 3× less. See `estimateSpread`.
 *
 * One known bias, left in deliberately. A hero's own win rate is measured over
 * all their games, including the ones where their partner was on the team, so
 * each hero quietly absorbs part of the pairing's effect before we subtract it.
 * With 127 heroes a pair shares roughly 4/126 of each hero's games, so about 6%
 * of every synergy is swallowed this way. Removing it means solving all 8,000
 * pairs jointly for a 6% correction that is far smaller than the sampling noise
 * — so the numbers here run about 6% conservative, and that is the whole of it.
 * (The effect scales with 1/pool size, which matters when testing against a
 * small synthetic roster.)
 */

/** Guarded against 0 and 1, which have infinite log-odds. */
export const logit = (p) => {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(q / (1 - q));
};

export const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Win rate with a Jeffreys prior (add half a win and half a loss).
 *
 * Keeps a pair that went 12-0 from reading as an infinitely good pairing, and
 * costs nothing once the sample is large.
 */
export const rate = (wins, games) => (wins + 0.5) / (games + 1);

/**
 * Sampling variance of `logit(rate(wins, games))`, by the delta method.
 *
 * This is the "how much of what I'm seeing is just noise" term, and it is what
 * drives the shrinkage below.
 */
export const logitVariance = (wins, games) => {
  const p = rate(wins, games);
  return 1 / Math.max(1e-9, (games + 1) * p * (1 - p));
};

/**
 * Estimate how much *real* synergy varies across pairs, by method of moments.
 *
 * Each observed residual is `signal + noise`. We know the noise variance for
 * every pair (it follows from its sample size), so the signal variance is
 * whatever spread is left over once the average noise is subtracted:
 *
 *     var(observed) = var(signal) + mean(var(noise))
 *
 * If that comes out at zero or below, the data is pure noise at this sample
 * size and everything collapses to zero synergy — which is the honest answer.
 */
export function estimateSpread(residuals, variances) {
  const n = residuals.length;
  if (!n) return { mean: 0, signalVar: 0, noiseVar: 0 };

  const mean = residuals.reduce((s, x) => s + x, 0) / n;
  const observedVar = residuals.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const noiseVar = variances.reduce((s, v) => s + v, 0) / n;
  return { mean, signalVar: Math.max(0, observedVar - noiseVar), noiseVar };
}

/**
 * Convert a log-odds residual into the percentage points the app speaks in.
 *
 * Measured at a 50% baseline, so `+2` reads as "this pairing is worth about two
 * extra win-rate points" — directly comparable to the matchup advantages that
 * already drive the suggestions.
 */
export const toPercentagePoints = (delta) => 100 * (sigmoid(delta) - 0.5);

/**
 * Cells a pair's games are split into, by whether each hero farmed. Ordered,
 * and read in the pair's stored `a < b` order — see `scripts/assign.mjs`.
 */
export const CELLS = ["cc", "cs", "sc", "ss"];

/**
 * How many games a single core/support cell needs before it is allowed to
 * disagree with the pair's blended number at all.
 *
 * Lower than `minGames` for the pair itself, because a cell is not measured
 * from scratch: it starts at the pair's overall figure and is only moved by
 * what its own games actually show. The shrinkage below does the real work of
 * deciding how far it gets to move.
 */
const MIN_CELL_GAMES = 150;

/**
 * A cell only earns a place in the output if it lands this far from the pair's
 * overall synergy. Anything closer is what the reader would have used anyway,
 * and writing it would trebles the size of synergies.json to say nothing.
 */
const MIN_CELL_GAP = 0.05;

/**
 * @param {Map<number|string, {games:number, wins:number}>} heroes solo totals
 * @param {Map<string, {a:*, b:*, games:number, wins:number, cells?:Record<string,{games:number,wins:number}>}>} pairs
 * @param {{minGames?:number}} [options]
 */
export function buildSynergies(heroes, pairs, options = {}) {
  const minGames = options.minGames ?? 50;

  const solo = new Map();
  for (const [key, { games, wins }] of heroes) {
    if (!games) continue;
    solo.set(key, { games, wins, logit: logit(rate(wins, games)) });
  }

  // Pass 1 — the residual for every pair with a usable sample.
  const rows = [];
  const residuals = [];
  const variances = [];
  let skipped = 0;

  for (const { a, b, games, wins, cells } of pairs.values()) {
    const ha = solo.get(a);
    const hb = solo.get(b);
    if (!ha || !hb || games < minGames) {
      skipped++;
      continue;
    }
    // Hero-level samples are 30-100× the pair's, so their own noise is a
    // rounding error next to the pair term and is left out of the variance.
    const residual = logit(rate(wins, games)) - ha.logit - hb.logit;
    const variance = logitVariance(wins, games);

    rows.push({ a, b, games, wins, residual, variance, cells });
    residuals.push(residual);
    variances.push(variance);
  }

  const { mean, signalVar, noiseVar } = estimateSpread(residuals, variances);

  // Pass 2 — shrink each residual by its own signal-to-noise ratio. A pair seen
  // 5,000 times keeps most of what it measured; one seen 60 times keeps almost
  // nothing.
  for (const row of rows) {
    row.shrink = signalVar > 0 ? signalVar / (signalVar + row.variance) : 0;
    row.delta = row.shrink * (row.residual - mean);
  }

  /*
   * Pass 3 — the same idea one level down, for the core/support cells.
   *
   * A pair's headline number averages over every way the two were played. Most
   * of them really are mixed: across the live table the median pair blends 3.45
   * different position pairings, and only 0.3% are 90% one arrangement. So the
   * question a cell answers is not "how good is this pair" but "how much does
   * this pair change when one of them is farming".
   *
   * That is measured as a deviation from the pair's own residual rather than
   * from scratch, and shrunk on the spread of those deviations. A cell with
   * little to say returns its pair's number, which is exactly the behaviour
   * before any of this existed.
   */
  const cellRows = [];
  const cellDeviations = [];
  const cellVariances = [];

  for (const row of rows) {
    for (const cell of CELLS) {
      const stats = row.cells?.[cell];
      if (!stats || stats.games < MIN_CELL_GAMES) continue;
      const deviation =
        logit(rate(stats.wins, stats.games)) - solo.get(row.a).logit - solo.get(row.b).logit - row.residual;
      /*
       * The deviation is cell − pair, and the cell's games are a *subset* of
       * the pair's — the two readings share every one of the cell's games, so
       * their errors are correlated, not independent. For a subset mean,
       * cov(cell, pair) equals var(pair), which collapses the usual sum to
       *
       *     var(cell − pair) = var(cell) − var(pair)
       *
       * Using var(cell) alone overstated the noise — badly for exactly the
       * cells with the most data (a cell holding 2/3 of its pair's games was
       * charged 3× its true noise). That fed an inflated noiseVar into
       * `estimateSpread`, which deflated `signalVar`, which over-shrank every
       * cell a second time — so real core/support splits were flattened and
       * many never cleared MIN_CELL_GAP to be written at all. The floor only
       * guards the degenerate cell that *is* the whole pair, where the
       * deviation is 0 by construction and the variance is too.
       */
      const variance = Math.max(
        1e-9,
        logitVariance(stats.wins, stats.games) - logitVariance(row.wins, row.games),
      );
      cellRows.push({ row, cell, games: stats.games, wins: stats.wins, deviation, variance });
      cellDeviations.push(deviation);
      cellVariances.push(variance);
    }
  }

  const cellSpread = estimateSpread(cellDeviations, cellVariances);

  for (const c of cellRows) {
    const shrink =
      cellSpread.signalVar > 0 ? cellSpread.signalVar / (cellSpread.signalVar + c.variance) : 0;
    const delta = c.row.delta + shrink * (c.deviation - cellSpread.mean);
    const synergy = toPercentagePoints(delta);
    if (Math.abs(synergy - toPercentagePoints(c.row.delta)) < MIN_CELL_GAP) continue;
    (c.row.cellSynergy ??= {})[c.cell] = { synergy, games: c.games, confidence: shrink };
  }

  const out = rows.map((row) => ({
    a: row.a,
    b: row.b,
    games: row.games,
    wins: row.wins,
    winRate: (100 * row.wins) / row.games,
    /** Percentage points of win rate this pairing adds beyond the two heroes alone. */
    synergy: toPercentagePoints(row.delta),
    /** Same number before shrinkage — useful for spotting how noisy a pair is. */
    rawSynergy: toPercentagePoints(row.residual - mean),
    confidence: row.shrink,
    /**
     * Per core/support cell, where the games said something the pair's overall
     * number does not. Absent cells fall back to `synergy`.
     */
    cells: row.cellSynergy ?? null,
  }));

  out.sort((x, y) => y.synergy - x.synergy);
  return {
    pairs: out,
    skipped,
    /** Diagnostics: how much real signal there was, and how much noise. */
    signalSd: toPercentagePoints(Math.sqrt(signalVar)),
    noiseSd: toPercentagePoints(Math.sqrt(noiseVar)),
    baseline: mean,
  };
}

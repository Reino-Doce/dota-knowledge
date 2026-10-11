/**
 * Version-one calibration arithmetic — pure, no network, no
 * files, so it can be tested against simulated games with known answers.
 *
 * `calibration.mjs` hands it one sample per real game, from Radiant's
 * side, and a `vectorize` that turns a sample into the model's features at a
 * given role-deficit threshold. The model itself lives in src/lib/winModel.ts;
 * nothing here knows what a feature means.
 */

export const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Solve `A x = b` by Gaussian elimination with partial pivoting. `A` is k×k. */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    if (M[col][col] === 0) throw new Error("singular system — a feature is constant or duplicated");
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Logistic regression by iteratively reweighted least squares.
 *
 * @param {number[][]} X one row per game; the caller includes any intercept
 * @param {number[]} y 1 for a win, 0 for a loss
 * @returns {{ weights: number[], se: number[], iterations: number }}
 */
export function fitLogistic(X, y, { maxIterations = 50, tolerance = 1e-10 } = {}) {
  const k = X[0].length;
  let w = new Array(k).fill(0);
  let H = null;
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations++;
    const g = new Array(k).fill(0);
    H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < X.length; i++) {
      const x = X[i];
      let z = 0;
      for (let j = 0; j < k; j++) z += w[j] * x[j];
      const p = sigmoid(z);
      const v = p * (1 - p);
      const e = y[i] - p;
      for (let j = 0; j < k; j++) {
        g[j] += e * x[j];
        const vx = v * x[j];
        for (let l = 0; l <= j; l++) H[j][l] += vx * x[l];
      }
    }
    for (let j = 0; j < k; j++) for (let l = 0; l < j; l++) H[l][j] = H[j][l];
    const step = solve(H, g);
    w = w.map((value, j) => value + step[j]);
    if (Math.max(...step.map(Math.abs)) < tolerance) break;
  }
  // Standard errors from the inverse of the information matrix at the fit.
  const se = w.map((_, j) => {
    const unit = new Array(k).fill(0);
    unit[j] = 1;
    return Math.sqrt(solve(H, unit)[j]);
  });
  return { weights: w, se, iterations };
}

/** Mean log-loss of log-odds `zs` against outcomes `ys`. */
export function logLoss(zs, ys) {
  let total = 0;
  for (let i = 0; i < zs.length; i++) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(zs[i])));
    total -= ys[i] ? Math.log(p) : Math.log(1 - p);
  }
  return total / zs.length;
}

/** Area under the ROC curve: the chance a random win is scored above a random loss. */
export function auc(scores, ys) {
  const order = scores.map((s, i) => [s, ys[i]]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  let positives = 0;
  // Average ranks across ties, so equal scores count as a coin flip.
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let r = i; r <= j; r++) {
      if (order[r][1]) {
        rankSum += rank;
        positives++;
      }
    }
    i = j + 1;
  }
  const negatives = order.length - positives;
  if (!positives || !negatives) return 0.5;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * The reliability table: predictions binned by `width`, each bin's games, mean
 * prediction and actual win rate. Empty bins are kept, so the table always has
 * the same shape.
 *
 * @param {Array<{ p: number, y: number }>} predictions
 * @returns {Array<[number, number, number, number, number]>} `[from, to, games, predicted, actual]`
 */
export function reliability(predictions, width = 0.05) {
  const bins = Math.round(1 / width);
  const table = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  for (const { p, y } of predictions) {
    // The epsilon puts a prediction sitting on an edge in the bin that edge opens.
    const i = Math.min(bins - 1, Math.max(0, Math.floor(p * bins + 1e-9)));
    table[i].n++;
    table[i].p += p;
    table[i].y += y;
  }
  return table.map((b, i) => [
    round6(i * width),
    round6((i + 1) * width),
    b.n,
    b.n ? b.p / b.n : 0,
    b.n ? b.y / b.n : 0,
  ]);
}

/**
 * The widest span around an even game in which every bin holds at least
 * `minGames`, or null when the bins next to even do not. The table is read from
 * both seats, so the span comes out symmetric.
 */
export function calibratedRange(table, minGames = 200) {
  const below = table.findIndex(([, to]) => Math.abs(to - 0.5) < 1e-9);
  if (below < 0 || below + 1 >= table.length) return null;
  let low = null;
  for (let i = below; i >= 0 && table[i][2] >= minGames; i--) low = table[i][0];
  let high = null;
  for (let i = below + 1; i < table.length && table[i][2] >= minGames; i++) high = table[i][1];
  if (low === null || high === null) return null;
  // Never all the way to the ends: 0% and 100% are not chances.
  return [Math.max(low, 0.01), Math.min(high, 0.99)];
}

/**
 * The whole fit: τ by two-fold held-out log-loss, then the weights on every game.
 *
 * @param {Array<{ id: number, y: number }>} samples one per game, from Radiant's side
 * @param {{
 *   keys: string[],
 *   taus: number[],
 *   vectorize: (sample: object, tau: number) => Record<string, number>,
 *   nonPositive?: string[],
 * }} spec
 */
export function fitCalibration(samples, { keys, taus, vectorize, nonPositive = [] }) {
  const folds = [samples.filter((s) => BigInt(s.id) % 2n === 0n), samples.filter((s) => BigInt(s.id) % 2n !== 0n)];
  const pairs = [
    [folds[0], folds[1]],
    [folds[1], folds[0]],
  ];

  /**
   * A fit with the side term and every key — except that a weight that may not
   * be positive and comes out positive anyway is pinned at zero and the rest
   * refitted. That is the constrained maximum, and what a one-sided effect's
   * estimate should be when the sample points the impossible way.
   */
  const fit = (rows, tau) => {
    const pinned = new Set();
    const vectors = rows.map((s) => vectorize(s, tau));
    const outcomes = rows.map((s) => s.y);
    for (;;) {
      const free = keys.filter((key) => !pinned.has(key));
      const X = vectors.map((v) => [1, ...free.map((key) => v[key])]);
      const result = fitLogistic(X, outcomes);
      const offending = free.find((key, i) => nonPositive.includes(key) && result.weights[i + 1] > 0);
      if (offending) {
        pinned.add(offending);
        continue;
      }
      const weights = {};
      const se = {};
      for (const key of keys) {
        const i = free.indexOf(key);
        weights[key] = i < 0 ? 0 : result.weights[i + 1];
        se[key] = i < 0 ? null : result.se[i + 1];
      }
      return { side: result.weights[0], weights, se };
    }
  };
  const predict = (model, vector) => keys.reduce((z, key) => z + model.weights[key] * vector[key], 0);

  const heldOut = (tau) => {
    const zs = [];
    const ys = [];
    for (const [train, test] of pairs) {
      const model = fit(train, tau);
      for (const s of test) {
        zs.push(model.side + predict(model, vectorize(s, tau)));
        ys.push(s.y);
      }
    }
    return logLoss(zs, ys);
  };

  const grid = taus.map((tau) => ({ tau, logLoss: heldOut(tau) }));
  const best = grid.reduce((a, b) => (b.logLoss < a.logLoss ? b : a));

  // The side term alone: the baseline any draft read has to beat.
  const baselineZ = [];
  const baselineY = [];
  for (const [train, test] of pairs) {
    const side = fitLogistic(train.map(() => [1]), train.map((s) => s.y)).weights[0];
    for (const s of test) {
      baselineZ.push(side);
      baselineY.push(s.y);
    }
  }

  // Out-of-fold predictions at the chosen τ, for the reliability table and AUC.
  const neutral = [];
  const withSide = [];
  const outcomes = [];
  for (const [train, test] of pairs) {
    const model = fit(train, best.tau);
    for (const s of test) {
      const z = predict(model, vectorize(s, best.tau));
      neutral.push(z);
      withSide.push(z + model.side);
      outcomes.push(s.y);
    }
  }
  // Read from both seats: the table is about drafts, not about which side of the map they started on.
  const table = reliability(
    neutral.flatMap((z, i) => [
      { p: sigmoid(z), y: outcomes[i] },
      { p: sigmoid(-z), y: 1 - outcomes[i] },
    ]),
  );

  const final = fit(samples, best.tau);
  return {
    matches: samples.length,
    tau: best.tau,
    grid,
    side: final.side,
    weights: final.weights,
    se: final.se,
    holdout: {
      logLoss: best.logLoss,
      baseline: logLoss(baselineZ, baselineY),
      auc: auc(withSide, outcomes),
    },
    reliability: table,
    range: calibratedRange(table),
  };
}

/**
 * Why a fit must not be written, or an empty list when it may.
 *
 * Each check answers a different way the step could quietly ship a bad file: a
 * thin sample, a model no better than knowing which side you are on, a table
 * that says the chances are wrong where it has the games to say so, and a
 * weight whose sign no draft could explain.
 */
export function calibrationProblems(
  result,
  { minMatches = 100_000, minGain = 0.005, maxBinError = 0.03, minBinGames = 1_000, positive = [] } = {},
) {
  const problems = [];
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  if (result.matches < minMatches) {
    problems.push(
      `only ${result.matches.toLocaleString("en-US")} usable games; at least ` +
        `${minMatches.toLocaleString("en-US")} are needed`,
    );
  }
  if (!(result.holdout.logLoss <= result.holdout.baseline - minGain)) {
    problems.push(
      `held-out log-loss ${result.holdout.logLoss.toFixed(5)} is not ${minGain} below ` +
        `the side term's ${result.holdout.baseline.toFixed(5)}`,
    );
  }
  for (const [from, to, games, predicted, actual] of result.reliability) {
    if (games >= minBinGames && Math.abs(predicted - actual) > maxBinError) {
      problems.push(
        `drafts rated ${pct(from)}–${pct(to)} were predicted ${pct(predicted)} and won ` +
          `${pct(actual)} over ${games.toLocaleString("en-US")} team-games`,
      );
    }
  }
  for (const [key, weight] of Object.entries(result.weights)) {
    if (!Number.isFinite(weight)) problems.push(`the ${key} weight is not a number`);
  }
  for (const key of positive) {
    if (!(result.weights[key] > 0)) {
      problems.push(`the ${key} weight came out ${result.weights[key]}, and it can only be positive`);
    }
  }
  if (!result.range) problems.push("no bin next to an even game holds enough games to vouch for any figure");
  return problems;
}

/**
 * The highest match id the calibration may use, exclusive: the lower edge of
 * the synergy and the timing samples, whichever is older. Null when neither
 * file records one.
 */
export function calibrationWindow(synergies, timings) {
  const lows = [synergies?.matchIdRange?.[0], timings?.matchIdRange?.[0]]
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  return lows.length ? Math.min(...lows) : null;
}

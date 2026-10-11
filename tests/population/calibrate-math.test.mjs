import test from "node:test";
import assert from "node:assert/strict";
import {
  auc,
  calibratedRange,
  calibrationProblems,
  calibrationWindow,
  fitCalibration,
  fitLogistic,
  logLoss,
  reliability,
  sigmoid,
  solve,
} from "../../scripts/population/calibrate-math.mjs";

/** A seeded generator, so the simulated games are the same on every run. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

test("solve inverts a small system", () => {
  const [a, b] = solve([[2, 1], [1, 3]], [3, 5]);
  assert.ok(Math.abs(a - 0.8) < 1e-12 && Math.abs(b - 1.4) < 1e-12);
});

test("logistic regression recovers the weights the games were drawn from", () => {
  const rand = random(7);
  const X = [];
  const y = [];
  for (let i = 0; i < 20_000; i++) {
    const row = [1, normal(rand), rand() * 2 - 1];
    X.push(row);
    y.push(rand() < sigmoid(0.1 + 0.8 * row[1] - 0.5 * row[2]) ? 1 : 0);
  }
  const { weights, se } = fitLogistic(X, y);
  [0.1, 0.8, -0.5].forEach((truth, j) => {
    assert.ok(Math.abs(weights[j] - truth) < 4 * se[j], `weight ${j}: ${weights[j]} ± ${se[j]} against ${truth}`);
  });
  assert.ok(se.every((s) => s > 0 && s < 0.1), "and it knows roughly how sure it is");
});

test("log-loss and AUC score what they should", () => {
  assert.ok(Math.abs(logLoss([0, 0], [1, 0]) - Math.log(2)) < 1e-12, "a coin flip costs ln 2");
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5, "ties count as a coin flip");
});

test("the reliability table bins, averages and keeps its shape", () => {
  const table = reliability([...Array(100)].map((_, i) => ({ p: 0.12, y: i < 12 ? 1 : 0 })));
  assert.equal(table.length, 20);
  const bin = table.find(([from]) => from === 0.1);
  assert.equal(bin[1], 0.15);
  assert.equal(bin[2], 100);
  assert.ok(Math.abs(bin[3] - 0.12) < 1e-12);
  assert.equal(bin[4], 0.12);
  assert.equal(table.filter(([, , n]) => n > 0).length, 1);
  const edge = reliability([{ p: 0.15, y: 1 }]).find(([, , n]) => n > 0);
  assert.deepEqual(edge.slice(0, 2), [0.15, 0.2], "an edge belongs to the bin it opens");
});

test("the calibrated range is the span around even where every bin has the games", () => {
  const table = reliability([]).map(([from, to]) => [from, to, from >= 0.15 && to <= 0.85 ? 500 : 50, 0, 0]);
  assert.deepEqual(calibratedRange(table), [0.15, 0.85]);
  const thin = table.map((row) => (row[0] === 0.45 ? [row[0], row[1], 10, 0, 0] : row));
  assert.equal(calibratedRange(thin), null, "nothing next to even, nothing to vouch for");
});

/** Games drawn from a model with a convex role deficit past a known threshold. */
function simulated(n, { tau = 2, deficit = -0.3, seed = 11 } = {}) {
  const rand = random(seed);
  return Array.from({ length: n }, (_, id) => {
    const a = normal(rand);
    const seats = -rand() * 6;
    const z = 0.1 + 0.5 * a + deficit * Math.min(0, seats + tau) ** 2;
    return { id, y: rand() < sigmoid(z) ? 1 : 0, a, seats };
  });
}

const spec = {
  keys: ["a", "d"],
  taus: [0.5, 1, 2, 3],
  vectorize: (sample, tau) => ({ a: sample.a, d: Math.min(0, sample.seats + tau) ** 2 }),
  nonPositive: ["d"],
};

test("the fit finds the threshold and the weights it was planted with", () => {
  const result = fitCalibration(simulated(60_000), spec);
  assert.equal(result.tau, 2);
  assert.ok(Math.abs(result.weights.a - 0.5) < 0.05, `a ${result.weights.a}`);
  assert.ok(Math.abs(result.weights.d + 0.3) < 0.05, `d ${result.weights.d}`);
  assert.ok(result.holdout.logLoss < result.holdout.baseline - 0.005, "better than knowing the side");
  assert.ok(result.range, "and there is a range to show figures in");
  assert.equal(result.matches, 60_000);
});

test("a weight that can only cost is pinned at zero when the games point the other way", () => {
  const result = fitCalibration(simulated(20_000, { deficit: 0.05 }), { ...spec, taus: [2] });
  assert.equal(result.weights.d, 0);
  assert.equal(result.se.d, null);
  assert.ok(Math.abs(result.weights.a - 0.5) < 0.06);
});

test("each guardrail stops the write it exists for", () => {
  const good = {
    matches: 300_000,
    holdout: { logLoss: 0.672, baseline: 0.691, auc: 0.61 },
    reliability: [[0.4, 0.45, 5_000, 0.425, 0.43]],
    weights: { matchups: 0.046, roleDeficit: -0.08 },
    range: [0.15, 0.85],
  };
  const check = (result) => calibrationProblems(result, { positive: ["matchups"] });
  assert.deepEqual(check(good), []);
  assert.match(check({ ...good, matches: 50_000 })[0], /usable games/);
  assert.match(check({ ...good, holdout: { ...good.holdout, logLoss: 0.689 } })[0], /log-loss/);
  assert.match(
    check({ ...good, reliability: [[0.4, 0.45, 5_000, 0.425, 0.47]] })[0],
    /were predicted 42\.5% and won 47\.0%/,
  );
  assert.match(check({ ...good, weights: { ...good.weights, matchups: -0.01 } })[0], /can only be positive/);
  assert.match(check({ ...good, range: null })[0], /vouch/);
});

test("the calibration window starts below both samples", () => {
  assert.equal(
    calibrationWindow(
      { matchIdRange: [9_010_415_463, 9_011_795_463] },
      { matchIdRange: [9_009_935_463, 9_011_795_463] },
    ),
    9_009_935_463,
  );
  assert.equal(calibrationWindow({ matchIdRange: [500, 900] }, null), 500);
  assert.equal(calibrationWindow(null, {}), null);
});

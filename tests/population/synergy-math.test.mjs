import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSynergies,
  estimateSpread,
  logit,
  logitVariance,
  rate,
  sigmoid,
  toPercentagePoints,
} from "../../scripts/population/synergy-math.mjs";

const close = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message ?? "value"}: ${actual} is not within ${tolerance} of ${expected}`,
  );

test("logit and sigmoid round-trip", () => {
  for (const p of [0.1, 0.35, 0.5, 0.72, 0.95]) close(sigmoid(logit(p)), p, 1e-9);
});

test("logit is finite at the extremes", () => {
  assert.ok(Number.isFinite(logit(0)));
  assert.ok(Number.isFinite(logit(1)));
});

test("rate pulls tiny samples towards 50%", () => {
  close(rate(2, 2), 0.833, 0.001, "2-0");
  close(rate(500, 1000), 0.5, 1e-6, "500-1000");
  assert.ok(rate(20, 20) < 1, "a clean sweep must stay under 100%");
});

test("logit variance falls as the sample grows", () => {
  assert.ok(logitVariance(50, 100) > logitVariance(500, 1000));
  close(logitVariance(500, 1000), 4 / 1001, 1e-4);
});

test("estimateSpread separates signal from noise", () => {
  // Residuals with a spread of 0.3, observed through noise of variance 0.01.
  const residuals = [-0.3, -0.1, 0, 0.1, 0.3];
  const variances = residuals.map(() => 0.01);
  const { signalVar, noiseVar, mean } = estimateSpread(residuals, variances);
  close(mean, 0, 1e-9, "mean");
  close(noiseVar, 0.01, 1e-9, "noise");
  close(signalVar, 0.04 - 0.01, 1e-9, "signal");
});

test("estimateSpread reports no signal when noise explains everything", () => {
  const residuals = [-0.1, 0, 0.1];
  const variances = residuals.map(() => 1);
  assert.equal(estimateSpread(residuals, variances).signalVar, 0);
});

test("estimateSpread handles an empty dataset", () => {
  assert.deepEqual(estimateSpread([], []), { mean: 0, signalVar: 0, noiseVar: 0 });
});

// --------------------------------------------------------------- buildSynergies

/**
 * Two 55% heroes winning 59.5% together is exactly what independence predicts,
 * so that pair must not read as synergy. Only the pair that beats its own
 * expectation should.
 */
test("strong heroes alone do not count as synergy", () => {
  const heroes = new Map([
    ["a", { games: 100_000, wins: 55_000 }],
    ["b", { games: 100_000, wins: 55_000 }],
  ]);
  const expected = sigmoid(logit(rate(55_000, 100_000)) * 2);
  const games = 20_000;
  const pairs = new Map([
    ["a|b", { a: "a", b: "b", games, wins: Math.round(expected * games) }],
  ]);

  const { pairs: rows } = buildSynergies(heroes, pairs);
  assert.equal(rows.length, 1);
  close(rows[0].winRate, 100 * expected, 0.1, "raw pair win rate");
  close(rows[0].rawSynergy, 0, 0.2, "synergy after removing hero strength");
});

test("a genuinely good pairing survives, a noisy one is shrunk away", () => {
  const heroes = new Map();
  const pairs = new Map();
  for (const slug of ["a", "b", "c", "d"]) {
    heroes.set(slug, { games: 200_000, wins: 100_000 });
  }
  // a+b: +5pp over 40,000 games — far too consistent to be luck.
  pairs.set("a|b", { a: "a", b: "b", games: 40_000, wins: 22_000 });
  // c+d: the same +5pp, but over 60 games.
  pairs.set("c|d", { a: "c", b: "d", games: 60, wins: 33 });
  // Two anti-synergies of equal size, so the average pairing sits at zero and
  // the centring step has nothing to remove.
  pairs.set("a|c", { a: "a", b: "c", games: 40_000, wins: 18_000 });
  pairs.set("b|d", { a: "b", b: "d", games: 40_000, wins: 18_000 });

  const { pairs: rows } = buildSynergies(heroes, pairs);
  const by = new Map(rows.map((r) => [`${r.a}|${r.b}`, r]));

  const solid = by.get("a|b");
  const noisy = by.get("c|d");
  close(solid.rawSynergy, 5, 0.5, "raw synergy of the large sample");
  close(noisy.rawSynergy, 5, 1.5, "raw synergy of the small sample");

  assert.ok(solid.confidence > 0.9, `large sample should keep its signal (${solid.confidence})`);
  assert.ok(noisy.confidence < 0.3, `small sample should be shrunk hard (${noisy.confidence})`);
  assert.ok(
    solid.synergy > noisy.synergy * 3,
    `shrinkage should rank the trustworthy pair far higher (${solid.synergy} vs ${noisy.synergy})`,
  );
});

test("pairs below minGames are skipped, not shrunk", () => {
  const heroes = new Map([
    ["a", { games: 10_000, wins: 5_000 }],
    ["b", { games: 10_000, wins: 5_000 }],
  ]);
  const pairs = new Map([["a|b", { a: "a", b: "b", games: 10, wins: 9 }]]);
  const { pairs: rows, skipped } = buildSynergies(heroes, pairs, { minGames: 50 });
  assert.equal(rows.length, 0);
  assert.equal(skipped, 1);
});

test("a pair referencing an unknown hero is skipped", () => {
  const heroes = new Map([["a", { games: 10_000, wins: 5_000 }]]);
  const pairs = new Map([["a|ghost", { a: "a", b: "ghost", games: 5_000, wins: 2_600 }]]);
  assert.equal(buildSynergies(heroes, pairs).pairs.length, 0);
});

test("output is sorted best pairing first", () => {
  const heroes = new Map();
  const pairs = new Map();
  for (const slug of ["a", "b", "c", "d"]) heroes.set(slug, { games: 100_000, wins: 50_000 });
  pairs.set("a|b", { a: "a", b: "b", games: 20_000, wins: 11_000 });
  pairs.set("a|c", { a: "a", b: "c", games: 20_000, wins: 10_000 });
  pairs.set("b|d", { a: "b", b: "d", games: 20_000, wins: 9_000 });

  const rows = buildSynergies(heroes, pairs).pairs;
  assert.deepEqual(rows.map((r) => `${r.a}|${r.b}`), ["a|b", "a|c", "b|d"]);
  assert.ok(rows[0].synergy > 0 && rows[2].synergy < 0);
});

test("percentage points read at the 50% baseline", () => {
  close(toPercentagePoints(0), 0, 1e-9);
  close(toPercentagePoints(logit(0.55)), 5, 1e-9);
});

// ------------------------------------------------------------- cell variance

/**
 * Six pairs of 50% heroes, each pair 800 games split into two 400-game cells
 * planted at exactly ±0.12 log-odds around a dead-neutral pair figure — no
 * sampling noise at all, the wins are set to the planted rates.
 *
 * What this pins down is the *variance model*: a cell's deviation is measured
 * against its own pair, whose games contain the cell's, so its noise is
 * var(cell) − var(pair), not var(cell). Charging the full var(cell) here
 * roughly triples the supposed noise, and a noise-free ±3pp split comes back
 * at barely 30% of its planted size. With the overlap accounted for, the same
 * data keeps about 65% — still conservative, but conservative once, not twice.
 */
function plantedCellWorld() {
  const heroes = new Map();
  const pairs = new Map();
  const d = 0.12;
  for (let i = 0; i < 12; i++) heroes.set(`h${i}`, { games: 100_000, wins: 50_000 });
  for (let i = 0; i < 6; i++) {
    const [a, b] = [`h${2 * i}`, `h${2 * i + 1}`];
    const up = Math.round(sigmoid(d) * 400);
    const down = Math.round(sigmoid(-d) * 400);
    pairs.set(`${a}|${b}`, {
      a,
      b,
      games: 800,
      wins: up + down,
      cells: { cc: { games: 400, wins: up }, ss: { games: 400, wins: down } },
    });
  }
  return { heroes, pairs, d };
}

test("a planted core/support split keeps most of its size", () => {
  const { heroes, pairs, d } = plantedCellWorld();
  const { pairs: rows } = buildSynergies(heroes, pairs);

  const truthGap = toPercentagePoints(d) - toPercentagePoints(-d);
  for (const row of rows) {
    assert.ok(row.cells?.cc && row.cells?.ss, "both planted cells should be written");
    const gap = row.cells.cc.synergy - row.cells.ss.synergy;
    assert.ok(
      gap / truthGap > 0.5,
      `a noise-free split should keep over half its size (kept ${((100 * gap) / truthGap).toFixed(0)}%)`,
    );
    assert.ok(gap / truthGap < 1, "and shrinkage must never enlarge it");
  }
});

test("a cell that is the whole pair says nothing and is not written", () => {
  const { heroes, pairs } = plantedCellWorld();
  // Every game of this pair sits in one cell, so cell − pair is 0 by
  // construction and its corrected noise variance is 0 too. That must come
  // out as "no position-specific signal", not a division blow-up.
  pairs.set("h0|h3", {
    a: "h0",
    b: "h3",
    games: 800,
    wins: 400,
    cells: { cs: { games: 800, wins: 400 } },
  });

  const { pairs: rows } = buildSynergies(heroes, pairs);
  const degenerate = rows.find((r) => r.a === "h0" && r.b === "h3");
  assert.ok(degenerate, "the pair itself is kept");
  assert.equal(degenerate.cells, null, "but its all-of-the-pair cell moved nothing");
  for (const row of rows) {
    if (row.cells) {
      for (const cell of Object.values(row.cells)) {
        assert.ok(Number.isFinite(cell.synergy), "every written cell stays finite");
      }
    }
  }
});

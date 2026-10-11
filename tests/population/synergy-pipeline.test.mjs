/**
 * End-to-end check of the synergy pipeline against simulated drafts.
 *
 * The collector's SQL cannot be executed here, so instead we generate matches
 * from a known truth — fixed hero strengths plus a handful of planted pairings
 * — reduce them to exactly the rows that query returns, and push those through
 * the real `fold` and `buildSynergies`. If the numbers that come out the far
 * end match what went in, the aggregation and the statistics agree.
 *
 * The planted values are recovered from the win/loss outcomes alone; nothing in
 * the pipeline is told which pairs are special.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fold, windowSql } from "./safe-fixture-fold.mjs";
import { assignPositions } from "../../scripts/population/assign.mjs";
import { buildSynergies, logit, sigmoid } from "../../scripts/population/synergy-math.mjs";

// Small deterministic PRNG, so a failure is always reproducible.
function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HERO_COUNT = 40;
const STRENGTH = new Map();
for (let id = 1; id <= HERO_COUNT; id++) {
  // Win-rate contributions spread across roughly 47%-53%.
  STRENGTH.set(id, logit(0.47 + 0.06 * ((id - 1) / (HERO_COUNT - 1))));
}

const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * Chemistry for every pair, in log-odds: a third of them genuinely matter and
 * the rest are exactly neutral.
 *
 * Planting a whole distribution rather than two special pairs is the point. The
 * shrinkage estimates how much real synergy exists in the population, so a
 * world where only two pairings out of hundreds mean anything is one where it
 * is correct to disbelieve nearly everything — and the test would be measuring
 * a straw man.
 */
const PLANTED = (() => {
  const random = mulberry32(7);
  const out = new Map();
  for (let a = 1; a <= HERO_COUNT; a++) {
    for (let b = a + 1; b <= HERO_COUNT; b++) {
      // Box-Muller, so the planted effects are normally distributed.
      const gauss =
        Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random());
      out.set(pairKey(a, b), random() < 0.33 ? 0.18 * gauss : 0);
    }
  }
  // Two guaranteed extremes, so the ordering assertions have a known answer.
  out.set(pairKey(3, 7), 0.6);
  out.set(pairKey(11, 19), -0.6);
  return out;
})();

function teamStrength(team) {
  let total = 0;
  for (const hero of team) total += STRENGTH.get(hero);
  for (let i = 0; i < team.length; i++) {
    for (let j = i + 1; j < team.length; j++) {
      total += PLANTED.get(pairKey(team[i], team[j])) ?? 0;
    }
  }
  return total;
}

function drawTeam(random, taken) {
  const team = [];
  while (team.length < 5) {
    const hero = 1 + Math.floor(random() * HERO_COUNT);
    if (!taken.has(hero)) {
      taken.add(hero);
      team.push(hero);
    }
  }
  return team;
}

/**
 * The rows the collector's query returns: one per team, five hero ids and who
 * won. `fold` does the aggregating now, because the pair counts have to be cut
 * by position and only the intact line-up can say what those positions were.
 */
function teamRows(matches) {
  const rows = [];
  for (const { radiant, dire, radiantWin } of matches) {
    rows.push({ t: radiant, w: radiantWin });
    rows.push({ t: dire, w: !radiantWin });
  }
  return rows;
}

function simulate(count, seed = 20260816) {
  const random = mulberry32(seed);
  const matches = [];
  for (let i = 0; i < count; i++) {
    const taken = new Set();
    const radiant = drawTeam(random, taken);
    const dire = drawTeam(random, taken);
    const p = sigmoid(teamStrength(radiant) - teamStrength(dire));
    matches.push({ radiant, dire, radiantWin: random() < p });
  }
  return matches;
}

// ---------------------------------------------------------------------- tests

test("fold turns line-ups into hero and pair totals", () => {
  const matches = simulate(2_000);
  const totals = { heroes: new Map(), pairs: new Map() };
  const counted = fold(teamRows(matches), totals);

  assert.equal(counted, matches.length, "match count is recovered from the team rows");

  // Every match puts ten heroes and twenty same-team pairs on the board.
  const heroGames = [...totals.heroes.values()].reduce((s, t) => s + t.games, 0);
  const pairGames = [...totals.pairs.values()].reduce((s, t) => s + t.games, 0);
  assert.equal(heroGames, matches.length * 10);
  assert.equal(pairGames, matches.length * 20);

  // Exactly half of all hero-slots are on the winning side.
  const heroWins = [...totals.heroes.values()].reduce((s, t) => s + t.wins, 0);
  assert.equal(heroWins, matches.length * 5);
});

test("fold accumulates across windows exactly as one big window would", () => {
  const matches = simulate(1_500);
  const half = matches.length / 2;

  const oneGo = { heroes: new Map(), pairs: new Map() };
  fold(teamRows(matches), oneGo);

  const chunked = { heroes: new Map(), pairs: new Map() };
  fold(teamRows(matches.slice(0, half)), chunked);
  fold(teamRows(matches.slice(half)), chunked);

  assert.deepEqual([...chunked.heroes].sort(), [...oneGo.heroes].sort());
  assert.deepEqual([...chunked.pairs].sort(), [...oneGo.pairs].sort());
});

/** One run of the whole pipeline, reused by the tests that need real volume. */
let cached = null;
function pipeline() {
  if (cached) return cached;
  const totals = { heroes: new Map(), pairs: new Map() };
  fold(teamRows(simulate(250_000)), totals);

  const heroes = new Map([...totals.heroes].map(([id, t]) => [String(id), t]));
  const pairs = new Map(
    [...totals.pairs.values()].map((p) => [
      `${p.a}|${p.b}`,
      { a: String(p.a), b: String(p.b), games: p.games, wins: p.wins },
    ]),
  );
  cached = buildSynergies(heroes, pairs, { minGames: 200 });
  return cached;
}

/** Planted effect for a row, in the percentage points the pipeline reports. */
const plantedPp = (row) => 100 * (sigmoid(PLANTED.get(`${row.a}:${row.b}`) ?? 0) - 0.5);

test("recovered synergies track the planted ones", () => {
  const rows = pipeline().pairs;
  assert.ok(rows.length > 700, `most pairs should clear the sample filter (${rows.length})`);

  const truth = rows.map(plantedPp);
  const found = rows.map((r) => r.synergy);
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const mt = mean(truth);
  const mf = mean(found);

  let cov = 0;
  let vt = 0;
  let vf = 0;
  for (let i = 0; i < rows.length; i++) {
    cov += (truth[i] - mt) * (found[i] - mf);
    vt += (truth[i] - mt) ** 2;
    vf += (found[i] - mf) ** 2;
  }
  const correlation = cov / Math.sqrt(vt * vf);
  const slope = cov / vt;

  assert.ok(correlation > 0.85, `correlation with the truth was only ${correlation.toFixed(3)}`);
  // Deliberately conservative: shrinkage and the marginal-absorption bias both
  // pull towards zero, and neither is allowed to overshoot into exaggeration.
  assert.ok(slope > 0.4, `synergies came out far too flat (slope ${slope.toFixed(3)})`);
  assert.ok(slope < 1, `synergies must never be overstated (slope ${slope.toFixed(3)})`);
});

test("the extremes come out at the extremes", () => {
  const rows = pipeline().pairs;
  const top = rows.slice(0, 10);
  const bottom = rows.slice(-10);

  assert.ok(
    top.some((r) => `${r.a}:${r.b}` === "3:7"),
    "the strongest planted pairing should be in the top ten",
  );
  assert.ok(
    bottom.some((r) => `${r.a}:${r.b}` === "11:19"),
    "the worst planted pairing should be in the bottom ten",
  );
  assert.ok(
    top.every((r) => plantedPp(r) > 0),
    "nothing with negative chemistry should reach the top ten",
  );
  assert.ok(
    bottom.every((r) => plantedPp(r) < 0),
    "nothing with positive chemistry should reach the bottom ten",
  );
});

test("pairs planted as neutral stay quiet", () => {
  const rows = pipeline().pairs.filter((r) => PLANTED.get(`${r.a}:${r.b}`) === 0);
  assert.ok(rows.length > 300, `expected plenty of neutral pairs (${rows.length})`);

  const loudest = Math.max(...rows.map((r) => Math.abs(r.synergy)));
  const drift = rows.reduce((s, r) => s + r.synergy, 0) / rows.length;
  assert.ok(loudest < 3, `a neutral pair read as ${loudest.toFixed(2)}pp of synergy`);
  assert.ok(Math.abs(drift) < 0.3, `neutral pairs drifted to ${drift.toFixed(2)}pp on average`);
});

test("hero strength alone does not leak into synergy", () => {
  const rows = pipeline().pairs;

  // The last hero is the strongest and the first the weakest. Averaged over
  // their neutral pairings, their raw win rates differ a lot; their synergies
  // must not, because being good is not the same as pairing well.
  const top = String(HERO_COUNT);
  const neutral = (r) => PLANTED.get(`${r.a}:${r.b}`) === 0;
  const strongest = rows.filter((r) => (r.a === top || r.b === top) && neutral(r));
  const weakest = rows.filter((r) => (r.a === "1" || r.b === "1") && neutral(r));
  const mean = (xs, pick) => xs.reduce((s, x) => s + pick(x), 0) / xs.length;

  const winRateGap = mean(strongest, (r) => r.winRate) - mean(weakest, (r) => r.winRate);
  const synergyGap = mean(strongest, (r) => r.synergy) - mean(weakest, (r) => r.synergy);

  assert.ok(winRateGap > 3, `the strong hero should win more outright (${winRateGap.toFixed(2)}pp)`);
  assert.ok(
    Math.abs(synergyGap) < 0.5,
    `but that must not show up as synergy (${synergyGap.toFixed(2)}pp)`,
  );
});

/*
 * ------------------------------------------------------------------ positions
 *
 * The tests above plant chemistry that is the same however the two heroes were
 * played. This one plants chemistry that is *not*, and checks the pipeline
 * finds it — which is the whole point of collecting line-ups instead of
 * pre-aggregated pairs.
 *
 * A second little world, deliberately clean: fifteen heroes who only ever farm,
 * fifteen who never do, and ten who go either way. Draft three heroes into core
 * slots and two into support slots, and the assignment has exactly one sensible
 * answer — so the recovered cells can be checked against a truth we control.
 */
const CORE_IDS = Array.from({ length: 15 }, (_, i) => i + 1);
const SUPPORT_IDS = Array.from({ length: 15 }, (_, i) => i + 16);
const FLEX_IDS = Array.from({ length: 10 }, (_, i) => i + 31);

const POSITION_PRIORS = new Map([
  ...CORE_IDS.map((id) => [id, { 1: 0.34, 2: 0.33, 3: 0.33 }]),
  ...SUPPORT_IDS.map((id) => [id, { 4: 0.5, 5: 0.5 }]),
  ...FLEX_IDS.map((id) => [id, { 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2, 5: 0.2 }]),
]);

/** The pair whose chemistry depends on what the flex hero was doing. */
const FLEX_HERO = 31;
const PARTNER = 5; // a pure core, so the cell turns entirely on FLEX_HERO
const CORE_BONUS = 0.6; // together as two cores
const SUPPORT_MALUS = -0.6; // together as core + support

function drawFrom(pool, count, random, taken) {
  const out = [];
  while (out.length < count) {
    const hero = pool[Math.floor(random() * pool.length)];
    if (!taken.has(hero)) {
      taken.add(hero);
      out.push(hero);
    }
  }
  return out;
}

function positionalMatches(count, seed = 424242) {
  const random = mulberry32(seed);
  const corePool = [...CORE_IDS, ...FLEX_IDS];
  const supportPool = [...SUPPORT_IDS, ...FLEX_IDS];
  const matches = [];

  const strengthOf = (cores, supports) => {
    const team = [...cores, ...supports];
    let total = 0;
    for (const hero of team) total += STRENGTH.get(hero);
    // The planted effect fires only for this pair, and its sign is decided by
    // which group the flex hero was drafted into.
    if (team.includes(FLEX_HERO) && team.includes(PARTNER)) {
      total += cores.includes(FLEX_HERO) ? CORE_BONUS : SUPPORT_MALUS;
    }
    return total;
  };

  for (let i = 0; i < count; i++) {
    const taken = new Set();
    const rCore = drawFrom(corePool, 3, random, taken);
    const rSup = drawFrom(supportPool, 2, random, taken);
    const dCore = drawFrom(corePool, 3, random, taken);
    const dSup = drawFrom(supportPool, 2, random, taken);
    const p = sigmoid(strengthOf(rCore, rSup) - strengthOf(dCore, dSup));
    matches.push({
      radiant: [...rCore, ...rSup],
      dire: [...dCore, ...dSup],
      radiantWin: random() < p,
    });
  }
  return matches;
}

let positionalCache = null;
function positionalPipeline() {
  if (positionalCache) return positionalCache;
  const totals = { heroes: new Map(), pairs: new Map() };
  fold(teamRows(positionalMatches(250_000)), totals, POSITION_PRIORS);

  const heroes = new Map([...totals.heroes].map(([id, t]) => [String(id), t]));
  const pairs = new Map(
    [...totals.pairs.values()].map((p) => [
      `${p.a}|${p.b}`,
      { a: String(p.a), b: String(p.b), games: p.games, wins: p.wins, cells: p.cells },
    ]),
  );
  positionalCache = buildSynergies(heroes, pairs, { minGames: 200 });
  return positionalCache;
}

/** Whichever way round the pair ended up stored. */
const findPair = (rows, x, y) =>
  rows.find(
    (r) =>
      (r.a === String(x) && r.b === String(y)) || (r.a === String(y) && r.b === String(x)),
  );

test("fold cuts every pair's games into core/support cells", () => {
  const totals = { heroes: new Map(), pairs: new Map() };
  fold(teamRows(positionalMatches(2_000)), totals, POSITION_PRIORS);

  for (const p of totals.pairs.values()) {
    const cellGames = Object.values(p.cells).reduce((s, c) => s + c.games, 0);
    assert.equal(cellGames, p.games, `cells for ${p.a}:${p.b} must account for every game`);
  }

  // Two pure supports can never be seen as anything but two supports.
  const twoSupports = totals.pairs.get(`${SUPPORT_IDS[0]}:${SUPPORT_IDS[1]}`);
  assert.ok(twoSupports.games > 0);
  assert.equal(twoSupports.cells.cc.games, 0, "pure supports are never both cores");
  assert.equal(twoSupports.cells.ss.games, twoSupports.games);
});

test("without priors the cells stay empty and the totals are unchanged", () => {
  const withPriors = { heroes: new Map(), pairs: new Map() };
  const without = { heroes: new Map(), pairs: new Map() };
  const rows = teamRows(positionalMatches(1_000));
  fold(rows, withPriors, POSITION_PRIORS);
  fold(rows, without);

  for (const [key, p] of without.pairs) {
    assert.equal(p.games, withPriors.pairs.get(key).games, "same pair totals either way");
    assert.equal(Object.values(p.cells).reduce((s, c) => s + c.games, 0), 0);
  }
});

test("a pairing that only works when the flex hero farms is split apart", () => {
  const row = findPair(positionalPipeline().pairs, PARTNER, FLEX_HERO);
  assert.ok(row, "the planted pair should survive the sample filter");
  assert.ok(row.cells, "and it should carry cells — its chemistry is position-dependent");

  // Cells read in the stored a-then-b order, so which letter describes the flex
  // hero depends on which end of the pair it landed on. The partner is a pure
  // core either way, so only the flex hero's letter actually varies.
  const flexIsA = row.a === String(FLEX_HERO);
  const asCore = row.cells.cc;
  const asSupport = flexIsA ? row.cells.sc : row.cells.cs;
  assert.ok(asCore, "the two-cores cell should be present");
  assert.ok(asSupport, "the support-plus-core cell should be present");

  assert.ok(
    asCore.synergy > asSupport.synergy + 2,
    `farming should read far better (${asCore.synergy.toFixed(2)} vs ${asSupport.synergy.toFixed(2)})`,
  );
  assert.ok(asCore.synergy > 0, `the good half should be positive, got ${asCore.synergy.toFixed(2)}`);
  assert.ok(asSupport.synergy < 0, `the bad half should be negative, got ${asSupport.synergy.toFixed(2)}`);

  // The blended figure is the average the old pipeline would have reported, and
  // it has to sit between the two halves rather than outside them.
  assert.ok(
    row.synergy > asSupport.synergy && row.synergy < asCore.synergy,
    `the overall number should sit between the cells, got ${row.synergy.toFixed(2)}`,
  );
});

test("pairs with no position-dependent chemistry are left alone", () => {
  const rows = positionalPipeline().pairs;
  // Two pure cores whose chemistry was never planted: nothing should move them
  // off their blended number by more than noise.
  const quiet = rows.filter(
    (r) =>
      r.cells &&
      Number(r.a) !== FLEX_HERO && Number(r.b) !== FLEX_HERO &&
      CORE_IDS.includes(Number(r.a)) && CORE_IDS.includes(Number(r.b)),
  );
  const worst = Math.max(
    0,
    ...quiet.flatMap((r) => Object.values(r.cells).map((c) => Math.abs(c.synergy - r.synergy))),
  );
  assert.ok(worst < 1.5, `a flat pair's cell wandered ${worst.toFixed(2)}pp from its overall`);
});

/*
 * ------------------------------------------------------------- ambiguity
 *
 * A near-tied line-up is *reported*, never dropped. Refusing those games was
 * tried and measured: gating at 0.5 rejected 46% of line-ups and turned an 11%
 * RMSE improvement over having no cells at all into a 7% regression, because
 * the surviving cells were too thin for the write threshold to select on
 * anything but noise. These tests pin the behaviour that measurement chose.
 */

test("a line-up that is a coin flip to position is counted, and flagged", () => {
  // Five heroes who play everything: the best split is barely likelier than
  // the next, and `assignPositions` still returns one because a maximum exists.
  const team = FLEX_IDS.slice(0, 5);
  const priors = new Map(team.map((id) => [id, { 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2, 5: 0.2 }]));

  const totals = { heroes: new Map(), pairs: new Map() };
  assert.equal(fold([{ t: team, w: true }], totals, priors), 1);

  for (const p of totals.pairs.values()) {
    assert.equal(
      Object.values(p.cells).reduce((s, c) => s + c.games, 0),
      p.games,
      "the game is still filed — a diluted cell beats a starved one",
    );
  }
  assert.equal(totals.ambiguous, 1, "but the guess is counted so the run can say so");
});

test("a decisive line-up is not flagged as ambiguous", () => {
  // Three heroes who only farm and two who never do: which of them are cores
  // is not in doubt, even though which core plays 1 versus 2 nearly is.
  const team = [...CORE_IDS.slice(0, 3), ...SUPPORT_IDS.slice(0, 2)];
  const totals = { heroes: new Map(), pairs: new Map() };
  fold([{ t: team, w: true }], totals, POSITION_PRIORS);

  assert.ok(!totals.ambiguous, "the core/support split is obvious here");
});

test("ambiguity is measured on the split, not on the exact five positions", () => {
  // The distinction the cells actually care about. These three cores are
  // interchangeable among positions 1-3, so `margin` is almost nothing — but
  // no rearrangement moves anybody across the core/support line.
  const team = [...CORE_IDS.slice(0, 3), ...SUPPORT_IDS.slice(0, 2)];
  const { margin, cellMargin } = assignPositions(team, POSITION_PRIORS);

  assert.ok(margin < 0.05, `the exact permutation is nearly a tie (${margin.toFixed(3)})`);
  assert.ok(cellMargin > 1, `but the split is not (${cellMargin.toFixed(3)})`);
});

test("the window query filters to complete ranked all-draft games", () => {
  const sql = windowSql(100, 200);
  assert.match(sql, /lobby_type = 7/, "ranked lobbies only");
  assert.match(sql, /game_mode = 22/, "all draft only");
  assert.match(sql, /array_length\(radiant_team, 1\) = 5/, "complete line-ups only");
  assert.match(sql, /match_id > 100 AND match_id <= 200/, "bounded to the requested window");
  // Both teams are read, so a pair is counted whichever side it turned up on.
  assert.match(sql, /radiant_team AS t/);
  assert.match(sql, /SELECT dire_team, NOT radiant_win/);
  // Half-open windows: consecutive ranges must not double-count a match.
  assert.ok(!/match_id >= /.test(sql), "the lower bound is exclusive");
});

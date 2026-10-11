import test from "node:test";
import assert from "node:assert/strict";
import { BUCKETS, buildTimings } from "../../scripts/population/timings-math.mjs";
import { bucketCase, timingSql } from "../../scripts/population/queries.mjs";
const windowSql = (lo, hi) => timingSql(String(lo), String(hi), { minRank: 0 });

// Run with: node --test scripts/*.test.mjs

test("the SQL buckets are generated from the bucket table itself", () => {
  const sql = bucketCase();
  for (const bucket of BUCKETS) {
    if (bucket.maxSeconds === null) continue;
    assert.match(sql, new RegExp(`duration < ${bucket.maxSeconds}`));
  }
  // The open-ended last bucket is the ELSE arm, not a comparison.
  assert.match(sql, new RegExp(`ELSE ${BUCKETS.length - 1} END$`));
  assert.equal(
    (sql.match(/WHEN/g) ?? []).length,
    BUCKETS.length - 1,
    "one arm per bounded bucket",
  );
});

test("the window query reads both sides of every game", () => {
  const sql = windowSql(100, 200);
  assert.match(sql, /radiant_team AS team, radiant_win AS won/);
  assert.match(sql, /dire_team AS team, NOT radiant_win AS won/);
  assert.match(sql, /match_id > 100 AND match_id <= 200/);
  // Ranked all-draft, full teams, and nothing that ended before the game began.
  assert.match(sql, /lobby_type = 7 AND game_mode = 22/);
  assert.match(sql, /duration > 600/);
  assert.match(sql, /array_length\(radiant_team, 1\) = 5/);
});

/** Build a totals map the way `fold` would have. */
const totalsFrom = (rows) =>
  new Map(rows.map(([hero, bucket, games, wins]) => [`${hero}:${bucket}`, { hero, bucket, games, wins }]));

test("skew is measured against the hero's own baseline, not against 50%", () => {
  // A hero who wins 60% overall but only 55% in the long games is a *falling*
  // hero, even though 55% still looks strong on its own.
  const totals = totalsFrom([
    [1, 0, 100_000, 65_000],
    [1, 1, 100_000, 60_000],
    [1, 2, 100_000, 60_000],
    [1, 3, 100_000, 55_000],
  ]);
  const { table } = buildTimings(totals, new Map([[1, "faller"]]));
  const rows = table.faller;

  assert.equal(rows.length, BUCKETS.length);
  const [, winRate, skew] = rows[0];
  assert.equal(winRate, 65, "raw win rate is kept for context");
  // Overall is 60%; the early bucket is five points above it, barely shrunk at
  // 100k games.
  assert.ok(skew > 4.9 && skew <= 5, `expected ~+5, got ${skew}`);
  assert.ok(rows.at(-1)[2] < -4.9, "and the long games are five points below");
});

test("a thin bucket is pulled towards no skew at all", () => {
  const totals = totalsFrom([
    [1, 0, 100_000, 50_000],
    [1, 1, 0, 0],
    [1, 2, 0, 0],
    // 40 games at 100%: real in the arithmetic, meaningless in the draft.
    [1, 3, 40, 40],
  ]);
  const { table } = buildTimings(totals, new Map([[1, "lucky"]]));
  const [games, winRate, skew] = table.lucky.at(-1);

  assert.equal(games, 40);
  assert.equal(winRate, 100);
  assert.ok(skew < 5, `a 50-point raw gap must not survive 40 games, got ${skew}`);
  assert.deepEqual(table.lucky[1], [0, 0, 0], "an empty bucket says nothing");
});

test("heroes below the sample floor are dropped rather than published", () => {
  const totals = totalsFrom([
    [1, 0, 10_000, 5_000],
    [2, 0, 30, 15],
  ]);
  const { table, kept, thin } = buildTimings(totals, new Map([[1, "solid"], [2, "rare"]]), {
    minGames: 200,
  });
  assert.deepEqual(Object.keys(table), ["solid"]);
  assert.equal(kept, 1);
  assert.equal(thin, 1);
});

test("heroes OpenDota knows and we do not are skipped quietly", () => {
  const { table } = buildTimings(totalsFrom([[999, 0, 10_000, 5_000]]), new Map());
  assert.deepEqual(table, {});
});

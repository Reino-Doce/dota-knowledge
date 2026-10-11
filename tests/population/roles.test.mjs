import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLaneTable } from "../../scripts/population/parse.mjs";
import { derivePositions, otsuThreshold } from "../../scripts/population/roles.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("parseLaneTable reads presence, win rate, KDA, GPM and XPM", async () => {
  const table = parseLaneTable(await readFile(join(HERE, "fixtures", "lanes-mid.html"), "utf8"));
  assert.equal(table.size, 5);

  const storm = table.get("storm-spirit");
  assert.deepEqual(storm, { presence: 93.26, winRate: 47.94, kda: 3.34, gpm: 539, xpm: 738 });

  // Row without data-value attributes must fall back to the cell text.
  assert.deepEqual(table.get("pudge"), {
    presence: 16.34, winRate: 51.71, kda: 2.81, gpm: 461, xpm: 636,
  });
  assert.equal(table.get("natures-prophet").gpm, 669, "hyphenated slugs survive");
});

test("otsuThreshold lands between two clusters", () => {
  // Supports around 300 gpm, cores around 600.
  const cut = otsuThreshold([280, 300, 310, 325, 590, 610, 640, 700]);
  assert.ok(cut > 325 && cut < 590, `expected a cut inside the gap, got ${cut}`);
});

test("otsuThreshold copes with tiny and uniform inputs", () => {
  assert.equal(otsuThreshold([]), 0);
  assert.equal(otsuThreshold([500]), 500);
  assert.ok(Number.isFinite(otsuThreshold([500, 500, 500, 500])));
});

/**
 * A miniature meta: safe lane holds carries (~600 gpm) and hard supports
 * (~300 gpm), the off lane holds offlaners (~500) and pos 4s (~330), plus a
 * mid, a roamer and a flex hero who splits time between safe lane and mid.
 */
function miniMeta() {
  return new Map(Object.entries({
    carry:      { safe: { presence: 92, winRate: 52, gpm: 610 } },
    carry2:     { safe: { presence: 88, winRate: 50, gpm: 580 } },
    hardSupport:{ safe: { presence: 85, winRate: 51, gpm: 300 } },
    support2:   { safe: { presence: 80, winRate: 49, gpm: 315 } },
    offlaner:   { off:  { presence: 90, winRate: 50, gpm: 520 } },
    offlaner2:  { off:  { presence: 86, winRate: 49, gpm: 495 } },
    pos4:       { off:  { presence: 70, winRate: 48, gpm: 330 } },
    pos4b:      { off:  { presence: 65, winRate: 50, gpm: 345 } },
    midder:     { mid:  { presence: 90, winRate: 51, gpm: 570 } },
    roamer:     { roaming: { presence: 60, winRate: 50, gpm: 340 } },
    flex:       {
      safe: { presence: 45, winRate: 53, gpm: 600 },
      mid:  { presence: 40, winRate: 47, gpm: 560 },
    },
    noise:      { safe: { presence: 0.5, winRate: 50, gpm: 610 } },
  }));
}

test("derivePositions separates the safe lane into pos 1 and pos 5", () => {
  const roles = derivePositions(miniMeta());
  assert.deepEqual(roles.get("carry").topPositions, [1]);
  assert.deepEqual(roles.get("hardSupport").topPositions, [5]);
  assert.ok(roles.get("carry").positions[1] > 0.9);
  assert.ok(roles.get("hardSupport").positions[5] > 0.9);
});

test("derivePositions separates the off lane into pos 3 and pos 4", () => {
  const roles = derivePositions(miniMeta());
  assert.deepEqual(roles.get("offlaner").topPositions, [3]);
  assert.deepEqual(roles.get("pos4").topPositions, [4]);
});

test("derivePositions reads mid as pos 2 and roaming as a support", () => {
  const roles = derivePositions(miniMeta());
  assert.deepEqual(roles.get("midder").topPositions, [2]);
  const roamer = roles.get("roamer");
  assert.equal(roamer.topPositions[0], 4);
  assert.ok(roamer.positions[5] > 0, "roaming also feeds pos 5");
});

test("a flex hero keeps both of its positions", () => {
  const flex = derivePositions(miniMeta()).get("flex");
  assert.deepEqual([...flex.topPositions].sort(), [1, 2]);
  assert.ok(Math.abs(flex.positions[1] - 0.53) < 0.1, `pos1 share was ${flex.positions[1]}`);
  assert.ok(Math.abs(flex.positions[2] - 0.47) < 0.1, `pos2 share was ${flex.positions[2]}`);
});

test("position weights are normalised and negligible lanes are dropped", () => {
  const roles = derivePositions(miniMeta());
  for (const [slug, r] of roles) {
    const total = Object.values(r.positions).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-3, `${slug} weights sum to ${total}`);
    assert.ok(r.topPositions.length >= 1, `${slug} must have at least one position`);
  }
  assert.equal(roles.has("noise"), false, "0.5% lane presence is not a position");
});

test("per-position win rates come from the contributing lanes", () => {
  const flex = derivePositions(miniMeta()).get("flex");
  assert.equal(flex.positionWinRate[1], 53, "safe-lane win rate feeds pos 1");
  assert.equal(flex.positionWinRate[2], 47, "mid win rate feeds pos 2");
});

/**
 * The Earth Spirit bug: a lane's win rate belongs to whoever actually stands
 * there, so handing the safe lane's figure to a hero who plays pos 1 in 0.15%
 * of their games describes the hard support, not the carry.
 */
test("a position the hero barely plays falls back to their overall win rate", () => {
  const lanes = new Map([
    ...miniMeta(),
    // 40 → mid (pos 2), 50 → off (pos 3), and a sliver of safe lane at support
    // GPM, which lands almost entirely on pos 5 and barely at all on pos 1.
    ["spirit", {
      mid:  { presence: 40, winRate: 50.5, gpm: 480 },
      off:  { presence: 50, winRate: 47.9, gpm: 360 },
      safe: { presence: 10, winRate: 44.5, gpm: 320 },
    }],
  ]);
  const overall = new Map([["spirit", 48.7]]);

  const raw = derivePositions(lanes).get("spirit");
  const shrunk = derivePositions(lanes, overall).get("spirit");

  assert.equal(raw.positionWinRate[1], 44.5, "without a prior the lane figure passes through");
  assert.ok(shrunk.positions[1] < 0.02, `pos 1 share was ${shrunk.positions[1]}`);
  assert.ok(
    Math.abs(shrunk.positionWinRate[1] - 48.7) < 0.2,
    `a role played 0.15% of the time should read as the overall 48.7%, got ${shrunk.positionWinRate[1]}`,
  );
});

test("shrinkage leaves a main role almost untouched and is monotonic in share", () => {
  const lanes = new Map([
    ...miniMeta(),
    ["main", { off: { presence: 95, winRate: 47, gpm: 355 } }],
  ]);
  const main = derivePositions(lanes, new Map([["main", 53]])).get("main");

  assert.ok(main.positions[4] > 0.85, `pos 4 share was ${main.positions[4]}`);
  assert.ok(
    main.positionWinRate[4] < 48,
    `a hero who only plays pos 4 keeps that lane's win rate, got ${main.positionWinRate[4]}`,
  );

  // Same lane figure and prior, thinner share -> closer to the prior.
  const shares = [90, 40, 8].map((presence) => {
    const one = new Map([
      ...miniMeta(),
      ["probe", {
        off:  { presence, winRate: 44, gpm: 355 },
        mid:  { presence: 100 - presence, winRate: 50, gpm: 570 },
      }],
    ]);
    return derivePositions(one, new Map([["probe", 50]])).get("probe").positionWinRate[4];
  });
  assert.ok(
    shares[0] < shares[1] && shares[1] < shares[2],
    `thinner roles must sit nearer the 50% prior, got ${shares.join(" < ")}`,
  );
});

/**
 * Regression for the real failure this caught on live data (Aug 2026):
 * the mid lane is almost entirely cores, so Otsu's cut landed *between cores*
 * at 548 GPM and filed Invoker (74% mid presence, 544 GPM) as a support.
 * Numbers below are the actual Dotabuff figures.
 */
function realisticMeta() {
  const lane = (presence, gpm, winRate = 50) => ({ presence, winRate, kda: 3, gpm, xpm: gpm + 180 });
  const meta = new Map([
    // Mid: a dense band of cores, plus the two supports that stray there.
    ["invoker", { mid: lane(74.4, 544), off: lane(17.02, 394), safe: lane(7.53, 394) }],
    ["shadow-fiend", { mid: lane(73.31, 590), safe: lane(21.6, 617) }],
    ["storm-spirit", { mid: lane(93.26, 539) }],
    ["puck", { mid: lane(86.39, 553) }],
    ["tinker", { mid: lane(83.58, 578) }],
    ["ember-spirit", { mid: lane(83.1, 549) }],
    ["void-spirit", { mid: lane(82.72, 521) }],
    ["queen-of-pain", { mid: lane(75.35, 549) }],
    ["meepo", { mid: lane(74.14, 617) }],
    ["templar-assassin", { mid: lane(60.7, 584) }],
    ["leshrac", { mid: lane(60.46, 569) }],
    ["huskar", { mid: lane(59.39, 516) }],
    ["alchemist", { mid: lane(29.07, 767) }],
    // A support who occasionally turns up mid; the safe lane is his real home.
    ["bane", { safe: lane(70, 330), mid: lane(6.65, 426) }],
    // Safe lane: carries and hard supports, genuinely two groups.
    ["anti-mage", { safe: lane(91.66, 648) }],
    ["spectre", { safe: lane(92.02, 578) }],
    ["phantom-assassin", { safe: lane(88, 610) }],
    ["juggernaut", { safe: lane(85, 600) }],
    ["luna", { safe: lane(80, 590) }],
    ["crystal-maiden", { safe: lane(74.36, 333), off: lane(19.61, 342) }],
    ["lion", { safe: lane(60.63, 322), off: lane(29.76, 332), mid: lane(7.27, 465) }],
    ["witch-doctor", { safe: lane(75, 340) }],
    ["dazzle", { safe: lane(72, 350) }],
    ["shadow-shaman", { safe: lane(70, 345) }],
    // Offlane: offlaners and pos 4s.
    ["axe", { off: lane(88.67, 495), jungle: lane(5.33, 431) }],
    ["tidehunter", { off: lane(82, 470) }],
    ["legion-commander", { off: lane(80, 505) }],
    ["underlord", { off: lane(78, 460) }],
    ["mars", { off: lane(76, 480) }],
    ["pudge", { off: lane(50.23, 393), safe: lane(25.2, 370), mid: lane(16.34, 461), roaming: lane(7.28, 355) }],
    ["earth-spirit", { off: lane(55, 360) }],
    ["tusk", { off: lane(52, 355) }],
    ["snapfire", { off: lane(50, 365) }],
  ]);
  return meta;
}

test("a lane that is nearly all cores does not get split down the middle", () => {
  const roles = derivePositions(realisticMeta());

  // The bug: Invoker came out as 4/2 because 544 GPM sat under the mid-only cut.
  assert.equal(roles.get("invoker").topPositions[0], 2, "Invoker is a mid, not a support");
  assert.ok(roles.get("invoker").positions[2] > 0.6, "and clearly so");

  for (const slug of ["shadow-fiend", "storm-spirit", "puck", "tinker", "meepo"]) {
    assert.equal(roles.get(slug).topPositions[0], 2, `${slug} should read as a mid core`);
  }
  // Supports who visit mid must still read as supports.
  assert.equal(roles.get("bane").topPositions[0], 5, "Bane is a hard support who roams mid");
  assert.equal(roles.get("bane").topPositions.includes(2), false, "not a pos 2");
  assert.equal(roles.get("lion").topPositions[0], 5);
});

test("an outlier cannot pass itself off as a class boundary", () => {
  // One 767 GPM Alchemist among a crowd of ~550 midlaners: Otsu will happily
  // fence him off, and that split scores a superb separation while meaning
  // nothing. Everyone below must not become a support.
  const roles = derivePositions(realisticMeta());
  const midCores = ["storm-spirit", "puck", "ember-spirit", "void-spirit", "queen-of-pain", "huskar"];
  for (const slug of midCores) {
    assert.equal(roles.get(slug).topPositions[0], 2, `${slug} is a mid core, not a support`);
  }
  assert.equal(roles.get("alchemist").topPositions[0], 2, "and the outlier is still a mid");
});

test("lanes that really are bimodal keep their own boundary", () => {
  const roles = derivePositions(realisticMeta());

  assert.equal(roles.get("anti-mage").topPositions[0], 1);
  assert.equal(roles.get("spectre").topPositions[0], 1);
  assert.equal(roles.get("crystal-maiden").topPositions[0], 5);
  assert.equal(roles.get("witch-doctor").topPositions[0], 5);

  // The offlane cut (~424) is below the all-lane cut (~468); borrowing the
  // global one here would misfile mid-farm offlaners like Underlord.
  assert.equal(roles.get("axe").topPositions[0], 3);
  assert.equal(roles.get("underlord").topPositions[0], 3, "460 GPM in the offlane is a core");
  assert.equal(roles.get("tidehunter").topPositions[0], 3);
  assert.equal(roles.get("tusk").topPositions[0], 4);
  assert.equal(roles.get("earth-spirit").topPositions[0], 4);
});

test("derivePositions tolerates an empty or single-hero meta", () => {
  assert.equal(derivePositions(new Map()).size, 0);
  const solo = derivePositions(new Map([["a", { mid: { presence: 90, winRate: 50, gpm: 500 } }]]));
  assert.deepEqual(solo.get("a").topPositions, [2]);
});

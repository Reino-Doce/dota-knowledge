import test from "node:test";
import assert from "node:assert/strict";
import {
  CELLS,
  assignPositions,
  cellIndex,
  cellOf,
  flipCell,
  isCore,
} from "../../scripts/population/assign.mjs";

/** Shares for a hero who only ever plays one position. */
const locked = (position) => ({ [position]: 1 });

/** An even split across several positions. */
const flex = (...positions) =>
  Object.fromEntries(positions.map((p) => [p, 1 / positions.length]));

const priors = (spec) => new Map(Object.entries(spec));

test("a line-up of five specialists lands on the obvious assignment", () => {
  const p = priors({
    jugg: locked(1), invoker: locked(2), axe: locked(3), mirana: locked(4), lich: locked(5),
  });
  const { positions } = assignPositions(["jugg", "invoker", "axe", "mirana", "lich"], p);
  assert.deepEqual(positions, [1, 2, 3, 4, 5]);
});

/**
 * The whole reason for solving the team rather than each hero: Windranger's own
 * history is split three ways and says nothing decisive, but four of her team
 * mates are pinned, so only one position is left for her.
 */
test("the exclusion constraint resolves a flex hero the marginals cannot", () => {
  const p = priors({
    jugg: locked(1), invoker: locked(2), axe: locked(3), lich: locked(5),
    windranger: flex(2, 4, 5),
  });
  const team = ["jugg", "invoker", "axe", "lich", "windranger"];
  const { positions } = assignPositions(team, p);
  assert.equal(positions[team.indexOf("windranger")], 4, "only pos 4 is left");
});

test("the same flex hero reads differently in a different line-up", () => {
  const p = priors({
    jugg: locked(1), axe: locked(3), mirana: locked(4), lich: locked(5),
    windranger: flex(2, 4, 5),
  });
  const team = ["jugg", "axe", "mirana", "lich", "windranger"];
  const { positions } = assignPositions(team, p);
  assert.equal(
    positions[team.indexOf("windranger")], 2,
    "with pos 4 and 5 taken she is the mid",
  );
});

test("two carries cannot both be pos 1", () => {
  const p = priors({
    jugg: { 1: 0.97, 2: 0.03 },
    spectre: { 1: 0.94, 3: 0.06 },
    axe: locked(3), mirana: locked(4), lich: locked(5),
  });
  const team = ["jugg", "spectre", "axe", "mirana", "lich"];
  const { positions } = assignPositions(team, p);
  assert.equal(new Set(positions).size, 5, "every position is used exactly once");
  assert.ok(positions.includes(1));
  // Spectre gives up the safe lane more cheaply than Juggernaut does, but Axe
  // holds pos 3 outright, so the pair has to split 1 and 2 between them.
  const [jugg, spectre] = [positions[0], positions[1]];
  assert.deepEqual([jugg, spectre].sort(), [1, 2]);
});

test("an unknown hero can still be given the leftover position", () => {
  const p = priors({
    jugg: locked(1), invoker: locked(2), axe: locked(3), lich: locked(5),
  });
  const team = ["jugg", "invoker", "axe", "lich", "brand-new-hero"];
  const { positions } = assignPositions(team, p);
  assert.equal(positions[4], 4);
  assert.equal(new Set(positions).size, 5);
});

test("margin reports how decisive the assignment was", () => {
  const sure = priors({
    jugg: locked(1), invoker: locked(2), axe: locked(3), mirana: locked(4), lich: locked(5),
  });
  const muddle = priors({
    a: flex(4, 5), b: flex(4, 5), c: locked(1), d: locked(2), e: locked(3),
  });
  const clear = assignPositions(["jugg", "invoker", "axe", "mirana", "lich"], sure);
  const vague = assignPositions(["a", "b", "c", "d", "e"], muddle);

  assert.ok(clear.margin > 1, `a pinned line-up should be decisive, got ${clear.margin}`);
  assert.equal(vague.margin, 0, "two interchangeable supports are a genuine tie");
});

test("assignPositions insists on five heroes", () => {
  assert.throws(() => assignPositions(["a", "b"], priors({})), /five heroes/);
});

test("cells are ordered, and flipping swaps only the mixed pair", () => {
  assert.equal(cellOf(1, 5), "cs");
  assert.equal(cellOf(5, 1), "sc");
  assert.equal(cellOf(2, 3), "cc");
  assert.equal(cellOf(4, 5), "ss");

  assert.equal(flipCell("cs"), "sc");
  assert.equal(flipCell("sc"), "cs");
  assert.equal(flipCell("cc"), "cc");
  assert.equal(flipCell("ss"), "ss");

  assert.deepEqual(CELLS, ["cc", "cs", "sc", "ss"]);
  assert.equal(cellIndex(3, 4), CELLS.indexOf("cs"));
});

test("positions 1-3 are cores and 4-5 are not", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(isCore), [true, true, true, false, false]);
});

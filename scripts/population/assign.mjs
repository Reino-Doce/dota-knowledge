/**
 * Reading positions off a finished line-up.
 *
 * OpenDota's `public_matches` gives us five hero ids per team and nothing else
 * — no lanes, no roles, no per-player rows. (The parsed tables that *do* carry
 * `lane_role` cover about 80 player rows per million match ids against roughly
 * 330,000 matches in the same range, so they are not a source.)
 *
 * But a line-up is not five independent heroes: exactly one of them plays each
 * position. That constraint is worth a great deal. On its own Windranger's
 * history says pos 2 / 4 / 5 and little more; standing next to a locked-mid
 * Invoker and a locked-pos-5 Lich, she is the pos 4. So rather than reading
 * each hero's own history in isolation, we ask which of the 120 ways to hand
 * out the five positions the team as a whole is most likely to have played.
 *
 * Scored as the sum of log shares, i.e. the most likely assignment under the
 * (deliberately naive) assumption that players choose positions independently.
 * The prior comes from `derivePositions`, so this inherits Dotabuff's lane data
 * and nothing else.
 *
 * Pure functions only — see assign.test.mjs.
 */

export const POSITIONS = [1, 2, 3, 4, 5];

/** Positions 1-3 farm, 4-5 do not. The split the synergy buckets are cut on. */
export const CORE_POSITIONS = new Set([1, 2, 3]);
export const isCore = (position) => CORE_POSITIONS.has(position);

/**
 * A hero who has never been recorded at a position still cannot be ruled out of
 * it — the assignment has to be able to put *somebody* there. This is the floor
 * on any single share, small enough that a real 30% always wins.
 */
const MIN_SHARE = 1e-4;

/** Every ordering of five positions, computed once. */
const PERMUTATIONS = (() => {
  const out = [];
  const walk = (chosen, left) => {
    if (!left.length) return out.push(chosen);
    for (let i = 0; i < left.length; i++) {
      walk([...chosen, left[i]], [...left.slice(0, i), ...left.slice(i + 1)]);
    }
  };
  walk([], POSITIONS);
  return out;
})();

/**
 * Build the 5x5 log-share matrix for one team.
 *
 * @param {Array<string|number>} team five hero keys
 * @param {Map<string|number, Record<number, number>>} priors hero -> position shares
 */
function logShares(team, priors) {
  return team.map((hero) => {
    const shares = priors.get(hero);
    return POSITIONS.map((p) => Math.log(Math.max(MIN_SHARE, shares?.[p] ?? 0)));
  });
}

/** Which of the five slots ended up core, as a bitmask — the cells' whole view. */
const coreSignature = (perm) => {
  let mask = 0;
  for (let i = 0; i < 5; i++) if (isCore(perm[i])) mask |= 1 << i;
  return mask;
};

/**
 * The most likely position for each of five heroes, parallel to `team`.
 *
 * Brute force over all 120 permutations. An assignment problem this small does
 * not need the Hungarian algorithm, and enumerating leaves no doubt that the
 * answer really is the maximum.
 *
 * @returns {{positions: number[], score: number, margin: number, cellMargin: number}}
 *   `margin` is the log-likelihood gap to the next-best assignment of all five
 *   positions. `cellMargin` is the gap to the best assignment that puts a
 *   *different set of heroes* in the farming slots.
 *
 *   The two answer different questions and only the second one matters to the
 *   synergy cells. A team of three dedicated cores and two dedicated supports
 *   has a `margin` near zero — swapping which core plays 1 and which plays 2
 *   is very nearly a coin flip — while its core/support split is not in doubt
 *   at all. Gating the cells on `margin` would throw away exactly the clean
 *   drafts they are built from.
 */
export function assignPositions(team, priors) {
  if (team.length !== 5) throw new Error(`expected five heroes, got ${team.length}`);
  const cost = logShares(team, priors);

  let best = null;
  let bestScore = -Infinity;
  let runnerUp = -Infinity;
  /** Best score seen for each distinct core/support split. */
  const bySignature = new Map();

  for (const perm of PERMUTATIONS) {
    let score = 0;
    for (let i = 0; i < 5; i++) score += cost[i][perm[i] - 1];

    const signature = coreSignature(perm);
    const seen = bySignature.get(signature);
    if (seen === undefined || score > seen) bySignature.set(signature, score);

    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = perm;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  const bestSignature = coreSignature(best);
  let rivalSplit = -Infinity;
  for (const [signature, score] of bySignature) {
    if (signature !== bestSignature && score > rivalSplit) rivalSplit = score;
  }

  return {
    positions: best,
    score: bestScore,
    margin: Number.isFinite(runnerUp) ? bestScore - runnerUp : Infinity,
    cellMargin: Number.isFinite(rivalSplit) ? bestScore - rivalSplit : Infinity,
  };
}

/**
 * Which of the four core/support cells a pair falls in, given the two heroes in
 * a fixed order.
 *
 * Pairs are stored once under `a < b`, so the cell has to be read in that same
 * order and the two mixed cells are *not* interchangeable: (core, support)
 * means a farmed and b did not.
 */
export const CELLS = ["cc", "cs", "sc", "ss"];

export const cellOf = (positionA, positionB) =>
  `${isCore(positionA) ? "c" : "s"}${isCore(positionB) ? "c" : "s"}`;

export const cellIndex = (positionA, positionB) => CELLS.indexOf(cellOf(positionA, positionB));

/** Swap the two mixed cells — how the table reads from the other hero's side. */
export const flipCell = (cell) => (cell === "cs" ? "sc" : cell === "sc" ? "cs" : cell);

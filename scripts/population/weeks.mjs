export const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** STRATZ week numbers count whole weeks since the Unix epoch, which began on a Thursday. */
export const weekOf = (ms) => Math.floor(ms / 1000 / WEEK_SECONDS);
export const weekStartMs = (week) => week * WEEK_SECONDS * 1000;
export const weekEndMs = (week) => (week + 1) * WEEK_SECONDS * 1000;

/** The `count` most recent weeks that have ended; the one in progress is a sliver of a week. */
export function completeWeeks(nowMs, count) {
  const current = weekOf(nowMs);
  return Array.from({ length: count }, (_, i) => current - count + i);
}

export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

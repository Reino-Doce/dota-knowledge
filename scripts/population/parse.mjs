/**
 * Pure HTML -> data functions for the Dotabuff scraper.
 *
 * Kept free of any I/O so they can be unit-tested against saved fixtures
 * (`node --test scripts/*.test.mjs`). Dotabuff changes its markup from time to
 * time; if the scraper ever starts returning empty tables, this is the only
 * file that should need touching.
 */

const TABLE_RE = /<table[^>]*>([\s\S]*?)<\/table>/gi;
const ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const HERO_HREF_RE = /href="(?:https?:\/\/[^"]*?)?\/heroes\/([a-z0-9-]+)"/i;
const DATA_VALUE_RE = /data-value="(-?\d+(?:\.\d+)?)"/gi;
const CELL_RE = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
const NUMBER_IN_TEXT_RE = /-?\d+(?:,\d{3})*(?:\.\d+)?/;

/** Slugs under /heroes/ that are site sections, not heroes. */
const NOT_A_HERO = new Set([
  "meta", "trends", "lanes", "played", "winning", "damage", "economy",
  "combat", "vision", "facets", "matchups", "counters", "guides", "items",
]);

/** The handful of named entities Dotabuff actually emits in hero names. */
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/**
 * Decode HTML entities: named (`&amp;`), decimal (`&#39;`) and hex (`&#x27;`).
 *
 * Dotabuff escapes apostrophes as `&#x27;`, so "Nature's Prophet" arrives
 * hex-encoded; missing that leaks the raw entity into the UI. `&amp;` is
 * decoded last so `&amp;#x27;` cannot round-trip into a second decode pass.
 */
const decodeEntities = (text) => text
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);

const stripTags = (html) => decodeEntities(html.replace(/<[^>]*>/g, " "))
  .replace(/\s+/g, " ").trim();

const matchAll = (re, str) => {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(str)) !== null) out.push(m);
  return out;
};

const toNumber = (raw) => {
  const n = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** Split a document into its `<table>` bodies. */
export function extractTables(html) {
  return matchAll(TABLE_RE, html).map((m) => m[1]);
}

/** Split a table body into its `<tr>` bodies. */
export function extractRows(tableHtml) {
  return matchAll(ROW_RE, tableHtml).map((m) => m[1]);
}

/** First number in each `<td>`, in column order. */
function cellNumbers(rowHtml) {
  const out = [];
  for (const m of matchAll(CELL_RE, rowHtml)) {
    const text = stripTags(m[1]);
    const hit = NUMBER_IN_TEXT_RE.exec(text);
    if (!hit) continue;
    const n = toNumber(hit[0]);
    if (n !== null) out.push(n);
  }
  return out;
}

/**
 * Pull the ordered numeric values out of a table row.
 *
 * Dotabuff puts a machine-readable `data-value` on every sortable cell, which
 * is far more reliable than the rendered text. We fall back to reading one
 * number per cell — in column order — when those attributes are absent.
 */
export function rowNumbers(rowHtml) {
  const fromAttrs = matchAll(DATA_VALUE_RE, rowHtml)
    .map((m) => toNumber(m[1]))
    .filter((n) => n !== null);
  if (fromAttrs.length >= 3) return fromAttrs;
  return cellNumbers(rowHtml);
}

/**
 * Locate a run of `validators.length` consecutive numbers where every value
 * passes its validator, preferring the right-most match.
 *
 * Column indices are not dependable: Dotabuff attaches sortable `data-value`
 * attributes to non-numeric cells too (hero names, tier letters), which shifts
 * everything. Validating a sliding window is immune to that.
 */
export function pickWindow(nums, validators) {
  const width = validators.length;
  for (let start = nums.length - width; start >= 0; start--) {
    const window = nums.slice(start, start + width);
    if (window.every((v, i) => Number.isFinite(v) && validators[i](v))) return window;
  }
  return null;
}

/** The hero a row points at, or null for header/spacer rows. */
export function rowHeroSlug(rowHtml) {
  const m = HERO_HREF_RE.exec(rowHtml);
  if (!m) return null;
  const slug = m[1];
  return NOT_A_HERO.has(slug) ? null : slug;
}

const isPercent = (lo, hi) => (v) => v >= lo && v <= hi;

/** [disadvantage, winRate, matchesPlayed] from a matchup row. */
export const pickMatchupTriple = (nums) =>
  pickWindow(nums, [
    (v) => Math.abs(v) <= 60,
    isPercent(15, 85),
    (v) => Number.isInteger(v) && v >= 1,
  ]);

/** [presence, winRate, kda, gpm, xpm] from a lane row. */
export const pickLaneStats = (nums) =>
  pickWindow(nums, [
    isPercent(0.01, 100),
    isPercent(15, 85),
    (v) => v > 0 && v < 25,
    (v) => v >= 100 && v <= 2500,
    (v) => v >= 100 && v <= 3000,
  ]);

/**
 * Parse `/heroes/{slug}/matchups`.
 *
 * The page holds three tables: "countered by" (top 5), "counters" (top 5) and
 * the complete matchup table. We take whichever has the most hero rows, so we
 * never depend on heading text or table ordering.
 *
 * Returns rows from the perspective of the page's hero:
 * `disadvantage > 0` means the page hero is WORSE than usual against `slug`.
 */
export function parseMatchups(html) {
  let best = [];
  for (const table of extractTables(html)) {
    const rows = [];
    const seen = new Set();
    for (const row of extractRows(table)) {
      const slug = rowHeroSlug(row);
      if (!slug || seen.has(slug)) continue;
      const triple = pickMatchupTriple(rowNumbers(row));
      if (!triple) continue;
      const [disadvantage, winRate, matches] = triple;
      seen.add(slug);
      rows.push({
        slug,
        disadvantage: round(disadvantage, 3),
        winRate: round(winRate, 3),
        matches,
      });
    }
    if (rows.length > best.length) best = rows;
  }
  return best;
}

/** Strict table parser used by collection; counts never pass through Number. */
export function parseMatchupsExact(html) {
  const tables = extractTables(html).map(table => extractRows(table).filter(row => rowHeroSlug(row)));
  const table = tables.sort((a, b) => b.length - a.length)[0] ?? [];
  const seen = new Set();
  return table.map(row => {
    const slug = rowHeroSlug(row);
    if (seen.has(slug)) throw new Error('Duplicate matchup identity.');
    seen.add(slug);
    const attrs = matchAll(DATA_VALUE_RE, row).map(m => m[1]);
    const tokens = attrs.length >= 3 ? attrs : matchAll(CELL_RE, row)
      .map(m => NUMBER_IN_TEXT_RE.exec(stripTags(m[1]))?.[0]?.replaceAll(',', '')).filter(Boolean);
    for (let i = tokens.length - 3; i >= 0; i--) {
      const [disadvantage, winRate] = tokens.slice(i, i + 2).map(Number);
      const matches = tokens[i + 2];
      if (Math.abs(disadvantage) <= 60 && winRate >= 15 && winRate <= 85 && /^[1-9]\d*$/.test(matches)) {
        return { slug, disadvantage: round(disadvantage, 3), winRate: round(winRate, 3), matches };
      }
    }
    throw new Error('Malformed matchup row.');
  });
}

/**
 * Parse `/heroes/lanes?lane={mid|safe|off|jungle|roaming}`.
 *
 * Columns are Hero | Presence | Win Rate | KDA | GPM | XPM. Presence is the
 * share of that hero's games spent in the lane; GPM is what separates the core
 * from the support once you already know the lane.
 */
export function parseLaneTable(html) {
  const out = new Map();
  for (const table of extractTables(html)) {
    for (const row of extractRows(table)) {
      const slug = rowHeroSlug(row);
      if (!slug || out.has(slug)) continue;
      const stats = pickLaneStats(rowNumbers(row));
      if (!stats) continue;
      const [presence, winRate, kda, gpm, xpm] = stats;
      out.set(slug, {
        presence: round(presence, 2),
        winRate: round(winRate, 2),
        kda: round(kda, 2),
        gpm: Math.round(gpm),
        xpm: Math.round(xpm),
      });
    }
    if (out.size) break;
  }
  return out;
}

/**
 * Parse the hero-stats table on `/heroes` for overall win/pick/ban rates.
 * Column order is read from `<thead>` so a reshuffle upstream won't silently
 * shift the numbers.
 */
export function parseHeroStats(html) {
  const out = new Map();
  for (const table of extractTables(html)) {
    const rows = extractRows(table);
    if (rows.length < 50) continue; // the stats table lists every hero

    const headerRow = rows.find((r) => /<th[\s>]/i.test(r));
    const headers = headerRow
      ? matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi, headerRow).map((m) => stripTags(m[1]).toLowerCase())
      : [];
    // Numeric columns, in the order rowNumbers() will report them.
    const numericHeaders = headers.filter((h) => /rate|change/.test(h));
    if (numericHeaders.length < 2) continue;
    const idxOf = (needle) => numericHeaders.findIndex((h) => h.startsWith(needle));
    const winIdx = idxOf("win");
    const pickIdx = idxOf("pick");
    const banIdx = idxOf("ban");

    for (const row of rows) {
      const slug = rowHeroSlug(row);
      if (!slug || out.has(slug)) continue;
      const nums = rowNumbers(row);
      if (!nums.length) continue;
      // Sortable non-numeric cells (hero name, tier letter) can contribute
      // leading data-values, so align the numbers to the right-hand edge.
      const offset = Math.max(0, nums.length - numericHeaders.length);
      const at = (i) => {
        const v = i >= 0 ? nums[offset + i] : undefined;
        return Number.isFinite(v) ? v : null;
      };
      const winRate = at(winIdx);
      // A win rate outside this band means the columns did not line up.
      if (winRate === null || winRate < 15 || winRate > 85) continue;
      const tierCell = /<td[^>]*>\s*([SABCDF])\s*<\/td>/.exec(row);
      out.set(slug, {
        winRate,
        pickRate: at(pickIdx),
        banRate: at(banIdx),
        tier: tierCell ? tierCell[1] : null,
      });
    }
    if (out.size) break;
  }
  return out;
}

/**
 * Parse the attribute groups from the "Quick Search" block at the bottom of
 * `/heroes`. Keyed off the stable `hero_str/agi/int/all` icon asset names.
 */
export function parseHeroAttributes(html) {
  const markers = [
    { attr: "str", re: /hero_str[-.]/ },
    { attr: "agi", re: /hero_agi[-.]/ },
    { attr: "int", re: /hero_int[-.]/ },
    { attr: "uni", re: /hero_all[-.]/ },
  ];
  const positions = markers
    .map((m) => ({ ...m, at: html.search(m.re) }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (positions.length < 4) return new Map();

  const out = new Map();
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].at;
    const end = i + 1 < positions.length ? positions[i + 1].at : html.length;
    const chunk = html.slice(start, end);
    for (const m of matchAll(/\/heroes\/([a-z0-9-]+)"/g, chunk)) {
      if (!NOT_A_HERO.has(m[1])) out.set(m[1], positions[i].attr);
    }
  }
  return out;
}

/** Every hero slug -> display name found in the document. */
export function parseHeroNames(html) {
  const out = new Map();
  for (const m of matchAll(/<a[^>]+\/heroes\/([a-z0-9-]+)"[^>]*>([^<]{2,40})<\/a>/g, html)) {
    const [, slug, label] = m;
    const name = stripTags(label);
    if (!NOT_A_HERO.has(slug) && name && !out.has(slug)) out.set(slug, name);
  }
  return out;
}

export function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

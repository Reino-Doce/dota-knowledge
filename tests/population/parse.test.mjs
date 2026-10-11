import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseMatchups,
  parseHeroStats,
  parseHeroAttributes,
  parseHeroNames,
} from "../../scripts/population/parse.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(join(HERE, "fixtures", name), "utf8");

test("parseMatchups picks the full table, not the top-5 teasers", async () => {
  const rows = parseMatchups(await fixture("matchups.html"));
  assert.equal(rows.length, 5, "should return the 5-row Matchups table");
  assert.deepEqual(
    rows.map((r) => r.slug),
    ["slark", "viper", "legion-commander", "enigma", "natures-prophet"],
  );
});

test("parseMatchups reads disadvantage, win rate and sample size", async () => {
  const rows = parseMatchups(await fixture("matchups.html"));
  const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));

  // Bristleback is countered by Slark: positive disadvantage.
  assert.equal(bySlug.slark.disadvantage, 6.837);
  assert.equal(bySlug.slark.winRate, 42.663);
  assert.equal(bySlug.slark.matches, 90848);

  // Bristleback counters Enigma: negative disadvantage.
  assert.equal(bySlug.enigma.disadvantage, -5.18);
  assert.ok(bySlug.enigma.winRate > 50);
});

test("parseMatchups handles hyphenated slugs", async () => {
  const rows = parseMatchups(await fixture("matchups.html"));
  const np = rows.find((r) => r.slug === "natures-prophet");
  assert.ok(np, "Nature's Prophet should survive slug parsing");
  assert.equal(np.matches, 41003);
});

test("rowNumbers falls back to visible text when data-value is missing", async () => {
  // The legacy table in the fixture has a single row and no data-value
  // attributes; parseMatchups only returns the largest table, so assert the
  // fallback through the exported primitives instead.
  const { extractTables, extractRows, rowNumbers, rowHeroSlug } = await import("../../scripts/population/parse.mjs");
  const html = await fixture("matchups.html");
  const legacy = extractTables(html).at(-1);
  const row = extractRows(legacy).find((r) => rowHeroSlug(r) === "pudge");
  assert.ok(row, "legacy row should be found");
  assert.deepEqual(rowNumbers(row), [1.23, 49.5, 52110]);
});

test("parseMatchups tolerates junk without throwing", () => {
  assert.deepEqual(parseMatchups(""), []);
  assert.deepEqual(parseMatchups("<html><body>nope</body></html>"), []);
  assert.deepEqual(parseMatchups("<table><tr><td>garbage</td></tr></table>"), []);
});

test("parseMatchups survives extra sortable columns", async () => {
  // Dotabuff sometimes adds data-value to non-numeric cells (hero name, facet
  // count, …). The triple we want must still be located correctly.
  const html = (await fixture("matchups.html")).replace(
    /<td class="cell-icon"><a href="\/heroes\/slark">/,
    '<td class="cell-icon" data-value="12"><a href="/heroes/slark">',
  );
  const rows = parseMatchups(html);
  const slark = rows.find((r) => r.slug === "slark");
  assert.equal(slark.disadvantage, 6.837, "leading junk value must be ignored");
  assert.equal(slark.matches, 90848);
});

test("pickMatchupTriple rejects rows that cannot line up", async () => {
  const { pickMatchupTriple } = await import("../../scripts/population/parse.mjs");
  assert.deepEqual(pickMatchupTriple([1, 2]), null);
  // A win rate of 3% is not a win rate.
  assert.deepEqual(pickMatchupTriple([90, 3, 5]), null);
  assert.deepEqual(pickMatchupTriple([7, 2.5, 48.1, 1200]), [2.5, 48.1, 1200]);
});

test("parseHeroStats maps columns from the header row", async () => {
  let html = await fixture("heroes.html");
  // The real page lists every hero; pad the table past the 50-row threshold.
  const filler = Array.from({ length: 60 }, (_, i) => `
    <tr>
      <td class="cell-icon"><a href="/heroes/filler-${i}"><img src="x.jpg"></a></td>
      <td class="cell-large"><a href="/heroes/filler-${i}">Filler ${i}</a></td>
      <td class="cell-centered">C</td>
      <td class="cell-centered" data-value="50.0000">50.00%</td>
      <td class="cell-centered" data-value="0.0000">0.00%</td>
      <td class="cell-centered" data-value="5.0000">5.00%</td>
      <td class="cell-centered" data-value="0.0000">0.00%</td>
      <td class="cell-centered" data-value="0.5000">0.50%</td>
    </tr>`).join("");
  html = html.replace("<!--FILLER-->", filler);

  const stats = parseHeroStats(html);
  const pl = stats.get("phantom-lancer");
  assert.ok(pl, "Phantom Lancer row should be parsed");
  assert.equal(pl.winRate, 53.0701);
  assert.equal(pl.pickRate, 13.13);
  assert.equal(pl.banRate, 4.95);
  assert.equal(pl.tier, "S");

  const np = stats.get("natures-prophet");
  assert.equal(np.winRate, 42.8);
  assert.equal(np.tier, "D");
});

test("parseHeroStats stays aligned when the tier column is sortable", async () => {
  let html = await fixture("heroes.html");
  // Give the tier cell a data-value, as Dotabuff does for sortable letters.
  html = html.replace(/<td class="cell-centered">([SABCD])<\/td>/g,
    (_, t) => `<td class="cell-centered" data-value="${"FDCBAS".indexOf(t)}">${t}</td>`);
  const filler = Array.from({ length: 60 }, (_, i) => `
    <tr>
      <td class="cell-icon"><a href="/heroes/filler-${i}"><img src="x.jpg"></a></td>
      <td class="cell-large"><a href="/heroes/filler-${i}">Filler ${i}</a></td>
      <td class="cell-centered" data-value="3">C</td>
      <td class="cell-centered" data-value="50.0000">50.00%</td>
      <td class="cell-centered" data-value="0.0000">0.00%</td>
      <td class="cell-centered" data-value="5.0000">5.00%</td>
      <td class="cell-centered" data-value="0.0000">0.00%</td>
      <td class="cell-centered" data-value="0.5000">0.50%</td>
    </tr>`).join("");
  html = html.replace("<!--FILLER-->", filler);

  const pl = parseHeroStats(html).get("phantom-lancer");
  assert.equal(pl.winRate, 53.0701, "win rate must not pick up the tier value");
  assert.equal(pl.pickRate, 13.13);
  assert.equal(pl.banRate, 4.95);
  assert.equal(pl.tier, "S");
});

test("parseHeroAttributes groups heroes by primary attribute", async () => {
  const attrs = parseHeroAttributes(await fixture("heroes.html"));
  assert.equal(attrs.get("axe"), "str");
  assert.equal(attrs.get("largo"), "str");
  assert.equal(attrs.get("slark"), "agi");
  assert.equal(attrs.get("lina"), "int");
  assert.equal(attrs.get("enigma"), "uni");
  assert.equal(attrs.get("natures-prophet"), "uni");
});

test("parseHeroNames decodes entities and skips section links", async () => {
  const names = parseHeroNames(await fixture("heroes.html"));
  assert.equal(names.get("natures-prophet"), "Nature's Prophet");
  assert.equal(names.get("phantom-lancer"), "Phantom Lancer");
  assert.equal(names.has("meta"), false);
  assert.equal(names.has("trends"), false);
});

test("parseHeroNames decodes hex, decimal and named entities alike", () => {
  // Live Dotabuff escapes the apostrophe as &#x27;, the saved fixture as &#39;.
  const link = (slug, label) => `<a href="/heroes/${slug}">${label}</a>`;
  const names = parseHeroNames([
    link("natures-prophet", "Nature&#x27;s Prophet"),
    link("natures-prophet-dec", "Nature&#39;s Prophet"),
    link("natures-prophet-named", "Nature&apos;s Prophet"),
    link("amp-hero", "Rock &amp; Roll"),
  ].join(""));

  assert.equal(names.get("natures-prophet"), "Nature's Prophet");
  assert.equal(names.get("natures-prophet-dec"), "Nature's Prophet");
  assert.equal(names.get("natures-prophet-named"), "Nature's Prophet");
  assert.equal(names.get("amp-hero"), "Rock & Roll");
});

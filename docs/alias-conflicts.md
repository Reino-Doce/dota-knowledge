# Hero alias conflicts

`heroes/aliases.json` maps each lowercase alias to one canonical hero key. An
alias claimed by multiple heroes is omitted unless a resolution is listed
below. `hunter` maps to `bounty_hunter`, following the explicit lookup mapping
for Bounty Hunter. The other current conflicts have no lookup mapping; use the
canonical hero key with `heroByKey` for those heroes.

These conflicts come from the current profile alias claims. The list should be
updated when those claims change.

| Alias | Claiming hero keys | Lookup mapping |
| --- | --- | --- |
| `assassin` | `nyx_assassin`, `phantom_assassin`, `riki`, `templar_assassin` | omitted |
| `bm` | `beastmaster`, `brewmaster`, `broodmother` | omitted |
| `breaker` | `dawnbreaker`, `spirit_breaker` | omitted |
| `cw` | `centaur`, `rattletrap` | omitted |
| `db` | `dawnbreaker`, `doom_bringer` | omitted |
| `demon` | `lion`, `shadow_demon` | omitted |
| `dragon` | `jakiro`, `puck` | omitted |
| `es` | `earth_spirit`, `earthshaker`, `ember_spirit` | omitted |
| `goblin` | `shredder`, `techies` | omitted |
| `hunter` | `bounty_hunter`, `tidehunter` | `bounty_hunter` |
| `keeper` | `keeper_of_the_light`, `terrorblade` | omitted |
| `king` | `monkey_king`, `skeleton_king` | omitted |
| `knight` | `chaos_knight`, `chen`, `dragon_knight`, `omniknight`, `sven` | omitted |
| `lord` | `abaddon`, `zuus` | omitted |
| `mage` | `antimage`, `skywrath_mage` | omitted |
| `master` | `beastmaster`, `brewmaster` | omitted |
| `moon` | `luna`, `mirana` | omitted |
| `nerubian` | `nyx_assassin`, `weaver` | omitted |
| `ns` | `naga_siren`, `night_stalker` | omitted |
| `prophet` | `death_prophet`, `furion` | omitted |
| `ranger` | `drow_ranger`, `windrunner` | omitted |
| `rider` | `batrider`, `luna` | omitted |
| `runner` | `centaur`, `windrunner` | omitted |
| `sf` | `nevermore`, `snapfire` | omitted |
| `sk` | `sand_king`, `skeleton_king` | omitted |
| `soul` | `leshrac`, `terrorblade` | omitted |
| `spirit` | `earth_spirit`, `ember_spirit`, `storm_spirit`, `vengefulspirit`, `void_spirit` | omitted |
| `ss` | `shadow_shaman`, `storm_spirit` | omitted |
| `ts` | `leshrac`, `shredder` | omitted |
| `vs` | `vengefulspirit`, `void_spirit` | omitted |
| `wolf` | `crystal_maiden`, `lycan` | omitted |

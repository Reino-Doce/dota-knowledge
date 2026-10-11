# Population collection and publication

`@reino-doce/dota-knowledge/node/population` is the independent Node API for
Dotabuff tables, STRATZ position/lane counts, OpenDota synergy/duration samples
and explicitly selected model fitting. Importing it performs no I/O. The default
browser/runtime entry does not import collectors, validators or Electron.

## Commands

Run from a checkout containing canonical `data/`, or pass `--dataset` explicitly.
An extracted package ships runtime data, not an editable canonical workspace;
apply requires a caller-owned schema-2 canonical directory.

```sh
npm run population:refresh -- --run sample-001 --adapter /path/to/provider-adapter.mjs
npm run population:refresh -- --run sample-001 --offline
npm run population:apply -- --run sample-001
npm run population:recover -- --dataset data --evidence evidence/population
```

Refresh saves response bytes, request fingerprints, clocks, progress and normalized
scopes under `evidence/population/`. It never publishes. Apply works offline,
recomputes the selected normalizations, checks completeness and identities,
validates the staged canonical/runtime output and uses the guarded publisher.
`--scopes` selects comma-separated scope keys from the run manifest; omitted means
all completed scopes. Failed scopes retain their old values and clocks.

Default steps are `roster,counters,positions,synergies,timings,lanes`; use `--steps`
to select a subset. `--fresh` requires a new run ID. Reusing an unfinished run ID
resumes verified responses under the identical roster, queries, cohorts, recipes,
prior-input hashes and model signature. A checkpoint older than the injected
resume limit (24 hours by default) needs a new run. `--offline` replays saved
responses with their original clocks; missing evidence stays incomplete.

## Injected providers and credentials

The CLI loads only the module named by `--adapter`. It exports
`async createPopulationAdapter({ signal })` and returns `clients`, optionally
`roster`, `recipes`, `limits`, `priorInputs`, and `calibrationAdapter`.
No token arguments, implicit environment reads, application settings, Keychain
or account-store discovery exist in the collectors. The adapter owns credential
retrieval and authenticated requests. Keep credentials inside its client closures.

Each client receives `(request, { signal })` and returns a standard `Response`
with original response bytes. Do not call `response.json()` in an adapter: integer
tokens must reach the lossless parser. A request contains a provider, operation,
format and the appropriate `query`/`variables`, `sql`, hero slug or lane. It never
contains headers, tokens or credential-bearing URLs. The adapter maps these safe
descriptors to provider requests. It must return provider payloads without embedded
secrets; error envelopes are rejected before persistence and adapter error text is
never logged. The API does not contact providers unless a caller supplies clients.

```js
import { collectPopulation, createFileStorage, recipeSettings, DEFAULT_LIMITS }
    from '@reino-doce/dota-knowledge/node/population';
import { setTimeout as delay } from 'node:timers/promises';

// roster and clients come from the caller; identities use canonical decimal IDs,
// keys, npc_dota_hero_* sourceKey and an explicit Dotabuff providerSlug crosswalk.
const run = await collectPopulation({
    runId: 'sample-001', roster, clients,
    storage: await createFileStorage('evidence/population'),
    clock: () => new Date(),
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
    signal: new AbortController().signal,
    logger: event => console.log(event),
    limits: { ...DEFAULT_LIMITS }, recipes: recipeSettings(),
    priorInputs: { positionPriors: null }, steps: ['lanes'],
});
console.log(run.state);
```

An executable offline example is [population-fixture.mjs](examples/population-fixture.mjs).
It creates a tiny canonical dataset, collects fixture responses, applies and repeats
the application. It needs no credentials, providers, application files or ignored evidence.

## Replacement scopes and identities

| Collection | Atomic replacement scope |
| --- | --- |
| OpenDota roster | Provider identity/profile observations; never native profiles |
| Dotabuff profiles | Provider profile table |
| Dotabuff counters | One canonical hero's complete matchup table |
| Dotabuff lane inference | Overall rates plus all five lane tables |
| STRATZ positions | All pages, requested positions and complete weeks for one rank/mode band |
| STRATZ lanes | All requested weeks, positions and both `against`/`with` directions for one bracket set |
| OpenDota synergies / timings | Every contiguous match-ID window needed to meet the selected sample target |
| Calibration | Complete selected sample, validated adapter and accepted fit |

Missing, challenged, malformed, empty or interrupted tables cannot authorize
replacement. A completed table can omit previously present rows; apply removes those
superseded rows and their compact projections together. Legacy aggregate position
summaries lose only the replaced position cells in matching bands. Narrow selections
replace overlapping rows and preserve unselected positions. Other providers, review decisions and native
mechanics remain intact. Unknown/ambiguous identities fail their affected scope.
Provider display names remain observations.

New record IDs hash the provider, kind, pair direction, position/bucket and cohort.
Surviving logical records retain existing IDs. Retired IDs remain bound to their
original identity in the reconciliation ledger. Rank, mode and requested week/window
metadata are retained; changing a cohort creates a distinct logical record.
STRATZ observation clocks describe the completed week boundary; retrieval clocks
remain separate. Unknown provider time windows remain unknown.

## Version-1 recipes

`RECIPES_V1` and `recipeSettings()` name the frozen source formulas and parameters.
Choose source precedence explicitly: `positionPriorsFromCounts(rows, { band })`
constructs measured priors; `derivePositions()` provides the lane-derived alternative.
Pass the selected canonical-ID priors in `priorInputs.positionPriors`. The library
does not silently read a Picker file or choose a fallback. Selected prior values
participate in checkpoint and recipe fingerprints.

Raw counts aggregate with `BigInt` and serialize as decimal strings. IDs and counts
are parsed from original JSON/HTML tokens. Numeric formulas retain their version-1
safe-input outputs. Counts outside their floating-point domain retain the exact raw
observations with an explicit unavailable estimate. Lane results retain measured
counts and stomps separately from derived rates; missing extras remain unknown.
Synergy cells retain stored pair order and mark position assignment as inferred.
Duration buckets retain the original 25/35/45-minute boundaries and shrinkage of 400.

## Optional Electron

Electron is an optional peer. Install it in the caller's environment and explicitly
launch `electron scripts/population/cli.mjs refresh --browser --session <directory>`
with the usual run/adapter arguments. The session directory must be outside evidence.
There is no automatic browser fallback. Windows are sandboxed, context-isolated and
have Node integration disabled. A challenge opens the owned window for human handling;
the collector does not solve it. Cancellation closes only that window. Choose a
request timeout long enough for the configured challenge window through adapter limits.
Tests use a generated request in a fixture VM and an injected window host; no installed
browser, live session or DOM dependency is needed.

## Calibration adapters

Calibration is absent from the default sequence. Select `--steps calibration` and
supply `calibrationAdapter`: `id`, `version`, SHA-256 `inputSignature`, feature `keys`,
`sample(match, priorInputs)`, `vectorize(sample, tau)`, `constraints.nonPositive`,
and all `acceptance` settings. `priorInputs.matchRanges` records every feature-source
match range that requires separation. Calibration samples must be strictly older than
the lowest boundary. Exact match-ID parity separates fitting/evaluation folds; duplicate
matches and overlap fail. Model results retain input/sample signatures, ranges,
holdout scores, reliability bins and acceptance settings. Apply also requires the same
adapter to reproduce the fit offline.

Picker retains `scripts/model-adapter.mjs`, its TypeScript loader and application
feature model. `createPickerModelAdapter({ files, roster, assignPositions })` supplies
the original feature/constraint policy with explicit inputs. Run its imports through
Picker's retained `register-ts-resolve.mjs`; the library does not depend on those files.
The library publishes calibration observations, not Picker application JSON.

## Preservation, pruning and recovery

Apply writes a replacement reconciliation ledger under `reviews/reconciliation/`.
Retired audit targets resolve to hash-verified preservation artifacts with their
original identities and digests. Missing references still fail unless that exact
identity is authorized; archived neighboring rows cannot excuse unrelated deletion.
Phase A captures and their original evidence lie outside the owned population tree.

Cleanup starts only after the promoted manifest is verified. Only content-addressed
ordinary artifacts recorded by this workflow are candidates. Active rows, active scope
manifests, incomplete/unpublished runs, recovery state, preservation records and
`protected.json` artifact pins retain their evidence. Unknown files and browser
sessions are untouched. Storage binds to one canonical dataset. Historical archives
and the ID ledger are retained; superseded ordinary responses/normalizations are pruned.

Cleanup journals each deletion. After interruption, run `population:recover`: it
verifies promotion or restores the previous dataset, then resumes eligible cleanup.
Failed publication or rollback leaves the prior snapshot and its evidence available.
A live operation lock cannot be stolen. Reapplying an unchanged run leaves canonical
bytes and generation metadata unchanged. A pruned superseded run is no longer replayable;
protected historical audit evidence remains available.

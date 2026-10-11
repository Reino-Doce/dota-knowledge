# Data workflow

For new population snapshots, use the independent [population collection and publication workflow](population.md). Refresh saves evidence; offline apply replaces only completed selected scopes through the guarded publisher. Compilation by itself performs no acquisition.

## Compile canonical records

`npm run compile` reads `data/manifest.json` and its canonical records, then validates and publishes the schema-v2 tree with compiler `dota-knowledge-compiler-3`. It works offline without a Picker checkout or ignored acquisition files. `--dataset <directory>` and `--output <directory>` select another canonical input and destination. Unchanged selected inputs retain source clocks, review clocks, generation metadata and exact artifact bytes.

The canonical manifest lists every generated file and its byte length/SHA-256. `heroes/index.json` links decimal IDs, existing keys, engine identifiers and provider slugs to profiles, abilities, mechanics and guides. Alias candidates preserve collisions. `observations/index.json` references full records by path and offset; compact runtime projections select fields without replacing the full payloads. Calibration stays under its original source identity in `observations/sources.json`.

`reviews/claims.json`, `reviews/bindings.json` and `reviews/profiles.json` retain full decisions, explicit field attribution and native/historical profile comparisons. The plain current profile uses build-bound native values. Historical ranks, cohorts, counts, clocks and stored pair order remain observations. Image schemas/types are defined, but image acquisition and lookup APIs remain separate work.

## Import selected source bundles

`npm run import:legacy -- --mechanics <directory> --evidence <directory> --output data --version <label> --replace` imports the selected mechanics and external-evidence bundles. It stores the exact selected bytes under the ignored `evidence/legacy-inputs/<input-signature>/` tree, checks their source manifests, and feeds the same normalized record graph and serializer as layout migration. It emits field reconciliation under `reviews/reconciliation/` and validates canonical records, the core and lazy artifacts.

The compiler preserves the previous generation time when the semantic input signature is unchanged. It never changes source retrieval times, claims a missing acquisition, or promotes an unreviewed interpretation. A changed input receives a new signature and must pass source, review, reference, and schema checks.

## Migrate a v1 layout and recover publication

`npm run migrate:canonical -- --audit <completed-phase-a-directory>` migrates `data/hero-knowledge/` into `data/`. It requires the verified preservation baseline at revision `1684ee640b3d80310ebc0aa5841235917981e0ae`. `--from-archive` instead restores that exact baseline into an isolated directory and can reproduce the migration after the old active tree is retired. Neither route acquires providers or changes the Phase A capture.

The Phase B overlay at `reviews/reconciliation/phase-b-fields.jsonl.gz` maps old fields to canonical records, review bindings or retained archive members. Every original mapped subtree is hashed; nested attribution can be reconstructed, and arrays are compared in order. `phase-b.json` records the archive hash, merge counts and empty semantic-ID rename list. The old acquisition reconciliation maps remain unchanged, including their historical paths.

Publication owns one sibling `.<output-name>-staging/` directory containing an exclusive lock, journal, staged tree and rollback tree. It verifies the complete stage before promotion. Concurrent target edits abort publication; unrelated files are carried forward. Recovery verifies the promoted manifest or restores the previous tree while preserving unrelated edits made during an interruption. Recovery itself is exclusive and can resume another interrupted recovery.

After an interrupted operation, use `npm run compile -- --output <directory> --recover` or `npm run migrate:canonical -- --output <directory> --recover`. A live owner's lock prevents recovery. Cleanup is limited to the owned staging operation. The baseline archive and all acquisition evidence stay outside it.

## Recover original source bytes

`npm run recover:native -- --dataset data --game <game-directory>` reads requested resources from the installed VPK and stores bytes only if they match the source registry SHA-256. `npm run recover:picker -- --dataset data --repository <checkout>` reads recorded Picker Git revisions without changing that checkout and verifies selected resource hashes. A missing repository, VPK entry, or matching hash is recorded as unavailable; compiled output is not treated as a substitute for original bytes.

The package's ignored `evidence/` directory is persistent development storage. Tests and cleanup tasks must not remove it. It is excluded from package distribution. Review license and attribution before redistributing any acquired source.

## Capture a consolidation baseline

On schema v2, `npm run audit:consolidation` validates the current tree and writes a fresh `evidence/consolidation/canonical-<timestamp>/` capture. It records file hashes, hero/alias indexes, entity/claim/observation identities and semantic digests, and repeats the Phase A performance workload. It requires neither Picker nor ignored original evidence. Existing captures are never overwritten; `--skip-measurement` records that performance was not measured.

The original Phase A workflow below remains reproducible using the baseline archive and its saved tooling:

```sh
npm run audit:consolidation -- --legacy-archive <completed-phase-a-directory> --picker <picker-checkout>
```

This restores the committed revision, verifies every blob, restores saved audit tooling and copies only hash-verified retained evidence into an isolated checkout before running the original capture. Picker's selected bytes also come from the saved Phase A inputs; the supplied local checkout supplies its pinned Git revision without network access. To capture a still-active v1 layout directly, run:

```sh
npm run audit:consolidation -- --picker <picker-checkout>
```

For a v1 capture, the default Picker path is the sibling `dotabuff-picker` checkout. This offline command creates a new `evidence/consolidation/phase-a-<timestamp>-<revision>/` directory. `--output <new-directory>` selects a destination outside the source checkouts or under library `evidence/consolidation/`; existing captures are never overwritten. `--base <revision>` selects the committed recovery baseline (default `HEAD`, v1 capture only). It never changes either checkout or runs a collector.

The capture verifies manifest hashes, runs the existing focused store/population/diff tests and full original-evidence schema check, and restores a Git archive into an owned temporary directory. Every restored file must match its committed blob, and the focused tests run from that isolated tree. Git line-ending conversion is disabled for archive creation. Current dataset bytes that differ from the selected commit are retained separately; uncommitted work is not reset or staged.

Start with `index.json`; it is written only after the complete capture succeeds. The audit is divided into:

| Artifact | Purpose |
| --- | --- |
| `files.json`, `heroes.json`, `identities.json` | Byte hashes/sizes, old/new paths, decimal IDs, engine keys and provider slugs; explicit rename list (initially empty) |
| `fields.jsonl.gz`, `coverage.json` | Exact old JSON pointers, destination files, subtree digests and exhaustive leaf coverage, including ordered arrays and empty containers |
| `observations.jsonl.gz`, `cohorts.json` | Observation identities/occurrences, clocks, counts, direction, cohorts and historical-rank keys |
| `reviews.jsonl.gz`, `profile-candidates.jsonl.gz`, `aliases.json` | Detailed review decisions/bindings, static candidates and alias collisions; candidates do not resolve conflicts |
| `picker.json`, `inputs/picker/` | Script/test/fixture classifications, dependencies, exact selected outputs/portraits, attribution and explicit gaps |
| `evidence.json` | Existing immutable acquisitions and field reconciliation maps, including all original source pointers |
| `baseline.tar.gz`, `recovery.json` | Committed recovery archive and file-by-file restoration evidence |
| `performance.json` | Dedicated-process load/query samples, peak RSS and retained heap after loading beyond the guide cache capacity |

A field mapping covers the entire subtree rooted at its pointer. An array's order and every nested value contribute to its digest. Original acquisition bytes stay in their existing evidence locations; the audit references and hashes them. The baseline archive supplies unchanged library bytes, and `inputs/library/` holds any selected uncommitted dataset bytes. Newly captured Picker bytes are immutable audit inputs, separate from the older Picker snapshots already referenced by library observations. Source generation and acquisition dates are not refreshed.

Destinations describe the future layout. The audit does not implement migration, select conflicting static values, rename stable IDs, or prove collector parity. Historical ranks/builds remain statistics; calibration metadata has a separate population record destination, while app model policy stays in Picker. Unknown scripts, fields, hero identities, artifact mismatches and concurrent selected-input edits fail the capture. Picker caches/session storage, rank medals and app screenshots are outside this selected input set.

Performance uses five sequential store loads, 200 warmed representative query batches, and lazy loading of 17 heroes with an eight-guide cache. The first load is process-cold; the OS filesystem cache is uncontrolled. Compare repeated measurements on the same host before applying the plan's regression thresholds. `--skip-measurement` is available for inventory-only reruns and is explicitly reported as unmeasured. Portrait checks establish PNG signature, dimensions and hashes; full decoding and hero/icon/ability/item coverage belong to the image phase.

## Validation and review

`npm run schema:check` validates every JSON schema and the canonical/runtime data. It resolves every field reconciliation pointer against the exact retained source bytes, checks field occurrence totals, verifies recovered hashes, and confirms historical claim targets resolve to canonical claim or observation IDs.

`npm run compare -- --base <git-revision>` uses separate v1/v2 adapters and compares the union of both identity sets, so deletions are visible. Gameplay, observation payloads/projections and review decisions determine equivalence; structure, naming and metadata are reported separately. Effect order, historical cohorts and exact decimal counts are significant. A layout-only migration has no gameplay, observation-value or review-decision changes.

Run `npm test`, `npm run typecheck`, `npm run schema:check`, and `npm run package:verify` before producing an archive. `schema:check:package` checks runtime artifacts without original evidence. `package:verify` extracts the actual npm archive, resolves the public exports and every lazy reference, and exercises the browser module graph in a context supplying browser globals without Node imports. No dependencies are installed in the extracted package. `pack:check` remains available for a dry-run inventory. Git preserves generated JSON and compressed bytes without text conversion.

`node scripts/consolidation/verify-phase-b.mjs --audit <completed-phase-a-directory>` verifies field preservation, semantic equivalence, baseline restoration, the first nested-source cutover and two identical canonical compilations. It alternates three isolated runs of the original archived reader and current reader using the Phase A workload, records retained heap and latency, and flags latency increases above 10% or any retained-memory increase for investigation. It also rechecks original acquisition hashes. Results go to a new `evidence/consolidation/phase-b-validation-<timestamp>/` directory.

Ordinary builds do not acquire remote sources. Acquisition tools should accept injected clients and credentials and must not read application settings.

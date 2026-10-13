# Data workflow

For new population snapshots, use the independent [population collection and publication workflow](population.md). Refresh saves evidence; offline apply replaces only completed selected scopes through the guarded publisher. Compilation by itself performs no acquisition.

## Compile canonical records

`npm run compile` reads `data/manifest.json` and its canonical records, then validates and publishes the schema-v2 tree with compiler `dota-knowledge-compiler-5`. It works offline without a Picker checkout or ignored acquisition files. `--dataset <directory>` and `--output <directory>` select another canonical input and destination. Unchanged selected inputs retain source clocks, review clocks, generation metadata and exact artifact bytes.

The canonical manifest lists every generated file and its byte length/SHA-256. `heroes/index.json` links decimal IDs, existing keys, engine identifiers and provider slugs to profiles, abilities, mechanics and guides. `heroes/aliases.json` maps lowercase aliases to canonical hero keys. Aliases claimed by multiple heroes are omitted unless explicitly resolved; see the [conflict list](alias-conflicts.md). `observations/index.json` references full records by path and offset; compact runtime projections select fields without replacing the full payloads. Calibration stays under its original source identity in `observations/sources.json`.

Per-hero ability files are compact generated views with `innate`, `skills`, `talents`, and `bonus_attributes`. Their game identifiers and tags join lossless full records in `mechanics/abilities.json`. The views expose source-declared behavior, affected target classes, dispel and debuff-immunity properties, damage type, and breakability when those declarations are recognized. Compilation validates the views against source declarations and structured activation quantities; unsupported casting modes and missing quantities remain explicit or omitted. Legacy files containing Ability/Activation arrays remain readable for migration. Runtime Ability and Activation APIs retain their full records.

The compiler accepts stale derived casting/name/cost views when rules change, using canonical metadata and verified source declarations to regenerate them. It still checks input hashes, identities, completeness and tag-array structure, and strictly validates the freshly generated dataset. Ordinary canonical reads remain strict about source-derived views. Editing a generated cost or casting type does not change its canonical source value.

Consumers use `heroByKey(key)` or `heroesByAlias(alias)` from the loaded store.
The runtime builds these lookups from validated profiles and the flat alias
map in the core. `heroesByAlias` returns the single mapped hero or an empty
array for an unknown or ambiguous alias. See [lookup contracts and the runnable
example](api.md#hero-keys-and-aliases).

`reviews/claims.json`, `reviews/bindings.json` and `reviews/profiles.json` retain full decisions, explicit field attribution and native/historical profile comparisons. The plain current profile uses build-bound native values. Historical ranks, cohorts, counts, clocks and stored pair order remain observations. The separate [image workflow](images.md) collects and publishes artwork; canonical compilation and population publication preserve those image artifacts.

## Generate native item data

`npm run items:generate -- --game <game-directory>` reads item definitions, locked item IDs, neutral item tiers and English localization from the installed VPK. It writes compact `items/<item-slug>/data.json` profiles plus an `items/index.json` with build identity and source hashes through the guarded canonical writer, preserving them during later compilation and image or population publication. `--dataset <directory>` selects another canonical dataset. The generator makes no network requests; see the [item data guide](items.md) for the output fields and source boundaries.

## Import selected source bundles

`npm run import:bundle -- --mechanics <directory> --evidence <directory> --output data --version <label> --replace` imports selected offline mechanics and external-evidence bundles. It checks manifest-listed bytes and stores exact inputs under ignored `evidence/bundle-inputs/<input-signature>/`. It uses the canonical serializer and guarded publisher, including schema and runtime validation. See the [executable offline fixture](examples/bundle-fixture.mjs).

The mechanics directory supplies `hero_mechanics_manifest.json`, `hero_mechanics.json`, `hero_mechanics_annotations.json` and `hero_mechanics_browser.json`. The evidence directory supplies `draft_evidence_manifest.json`, `draft_evidence.json` and every manifest-listed hero guide. Existing supported population records, claims and provider inputs retain their validation and source units.

Historical profiles use an explicit per-hero array:

```json
{
  "historicalProfiles": [
    { "sourceId": "source:archive-input", "sourceRecord": { "name": "Historical name", "ranks": {} } }
  ]
}
```

The corresponding evidence source has `id: "archive-input"`, a historical `kind`, its original response `sha256`, and `rawFile` pointing to a response listed in the evidence manifest. The importer verifies those bytes. Source identity becomes `source:historical:<sha256>`; profile identity becomes `observation:<hero-id>:historical-profile:<sha256>`, with `originalField: "historicalProfile"`. The wrapper accepts only `sourceId` and `sourceRecord`; profile fields are `id`, `engineKey`, `name`, `aliases`, `primaryAttribute`, `complexity`, `roles`, `attackRange`, `flags` and `ranks`. Unsupported historical fields, unrecognized fields ending in `Profile`, and identity collisions fail the import. Other provider extension fields remain exact `provider-record:<field>` observations. Values and ordered nested rank records remain exact; current native profiles remain authoritative.

`--generated-at <date>` injects a generation clock. `--previous <manifest>` selects the previous canonical manifest (by default the destination manifest). An unchanged input signature preserves its generation time. `--replace` authorizes replacement of manifest-owned output files; unrelated files survive. Source retrieval, observation and commit clocks are never refreshed by import.

## Historical preservation and publication recovery

Historical sources expose a typed `preservation` reference to verified archived metadata, retaining original source hashes, clocks, cohort uncertainty and historical item definitions. The reference contains `kind: "archived-json"`, an evidence-relative `path`, byte length, SHA-256 and JSON `pointer`. Runtime loaders do not open evidence archives.

Reconciliation-index version 2 refers to the immutable original index and field maps through archive descriptors. `reviews/reconciliation/identities.json` publishes old-identity digests, new IDs, before/after record digests and an archive descriptor. Exact old/new identities remain in migration evidence. Development verification resolves original pointers and claim targets through verified mappings. Missing archives, altered bytes, reused identities, missing mappings and unexplained historical deletions fail verification. Ordinary compilation validates the current ledger and remains independent of ignored evidence.

The original Phase B overlay at `reviews/reconciliation/phase-b-fields.jsonl.gz` remains unchanged. Its read-only preservation adapter applies only authorized identity/provenance transformations and verified before/after generation clocks when comparing old subtrees. The ledger's generation reference binds the original signature and migration clock; comparison checks the recomputed migration signature even when a stale original header would otherwise produce no difference. Later population publications retain their own generation clocks. Original Phase A-E evidence and the pre-retirement source/tooling archive remain available for historical reproduction. One-time migration writers and validators have been retired from maintained commands.

Publication uses a sibling `.<output-name>-staging/` directory with an exclusive lock, journal, staged tree and rollback tree. It verifies the stage before promotion and rejects concurrent target edits. Recovery can resume interrupted rollback and preserves unrelated work.

After interruption, run `npm run compile -- --output <directory> --recover`. A live owner's lock prevents recovery. Cleanup belongs to the guarded publisher's owned operation; persistent evidence is outside that operation.

## Recover original source bytes

`npm run recover:native -- --dataset data --game <game-directory>` reads requested resources from the installed VPK and stores bytes only if they match the source registry SHA-256. `npm run recover:picker -- --dataset data --repository <checkout>` reads recorded Picker Git revisions without changing that checkout and verifies selected resource hashes. A missing repository, VPK entry, or matching hash is recorded as unavailable; compiled output is not treated as a substitute for original bytes.

The package's ignored `evidence/` directory is persistent development storage. Tests and cleanup tasks must not remove it. It is excluded from package distribution. Review license and attribution before redistributing any acquired source.

## Capture a consolidation baseline

`npm run audit:consolidation` validates and captures current canonical data offline under a new `evidence/consolidation/canonical-<timestamp>/` directory. It records file hashes, hero/alias indexes, entity/claim/observation digests and current identity mappings. Existing captures are never overwritten. `--output <new-directory>` selects another evidence location; `--skip-measurement` explicitly records that performance was not measured.

The performance workload uses five sequential loads, 200 warmed query batches and 17 lazy heroes with an eight-guide cache. The first load is process-cold; filesystem cache state is uncontrolled. Compare paired dedicated-process samples on the same host. The saved historical tooling and archives own earlier capture formats.

## Validation and review

`npm run schema:check` validates canonical/runtime schemas, archive digests, original reconciliation pointers, occurrence totals, recovered hashes and historical targets. It requires persistent development evidence. `npm run schema:check:package` checks packaged runtime artifacts without that evidence.

`npm run compare -- --base <git-revision>` retains raw differences and reports verified identity changes separately. The read-only v1/v2 adapters compare the union of identities, preserving deletions, effect order, cohorts, counts and review states. Only exact ledger-backed transformations can reconcile renamed records; unrelated payload/provenance changes fail equivalence.

Run `npm test`, `npm run typecheck`, `npm run schema:check` and `npm run package:verify` before packaging. Package verification extracts the actual archive, installs declared production dependencies from the offline cache, checks Node/browser exports and every lazy reference, decodes images and runs bundle/population/image fixture examples with network blocked. `npm run pack:check` provides the package inventory.

`node scripts/consolidation/reference-scan.mjs --policy <archived-policy.json>` scans active filenames and file contents, including decompressed audit maps. The policy supplies terms, roots and any exact hash-bound, individually explained archival or legal exceptions. `npm run package:verify -- --reference-policy <archived-policy.json>` also scans the extracted package. Original evidence and required notices remain intact; terms are never hidden by encoding.

Ordinary compilation and tests perform no acquisition. Acquisition tools use explicit inputs and injected clients and credentials.

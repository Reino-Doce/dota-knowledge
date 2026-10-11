# Public API

Image catalog queries and lazy byte access are documented in [the image API guide](images.md).
Use `./images` in browsers and `./node/images` for filesystem loading and explicit acquisition.

## Main entry

`loadKnowledgeStore({ manifest, readArtifact, guideCacheSize?, guideCacheMaxBytes? })` validates the supplied runtime manifest and core before returning a `KnowledgeStore`. `readArtifact` receives a descriptor tagged as `core`, `guide`, or `observations`; it returns the exact encoded artifact bytes. The store verifies byte bounds, SHA-256, schema version, references, source bindings, and core identity before exposing a record.

### Stable-ID lookups

`heroes()` returns the ordered hero records. `hero(id)`, `ability(id)`, `activation(id)`, `effect(id)`, `modifier(id)`, `rule(id)`, `condition(id)`, `value(id)`, `unit(id)`, `upgrade(id)`, `source(id)`, and `claim(id)` return the corresponding stable record or `undefined`. `effectsForHero(id)` returns that hero's effects in declared evaluation order. Returned records preserve stable string IDs; internal indexes never escape as identities.

### Profile and review contracts

The loader accepts schema version 2 and compiler `dota-knowledge-compiler-3`. `hero(id)` exposes `id`, `key`, engine `sourceKey`, `name`, `aliases`, `primaryAttribute`, `attackRange`, `complexity`, `roles`, enable flags, ordered ability/effect IDs and coverage.

| Field | Representation |
| --- | --- |
| `primaryAttribute` | `0` strength, `1` agility, `2` intelligence, `3` universal, or `null` |
| `attackRange` | Native numeric range or `null` |
| `complexity` | Native integer `1`–`3` or `null` |
| `roles` | Declaration-ordered `{ role, level }[]`; lowercase native role names, levels `0`–`3` |
| `coverage.fields` | Status for each of those fields; unavailable values include a reason |

Historical profiles contribute aliases but never replace current native scalar facts or roles. Measured position distributions remain observations. Canonical alias indexes normalize trim, lowercase and collapsed whitespace, and map each alias to a sorted array of candidate keys. Existing runtime lookups still take decimal IDs; there is no new alias lookup API.

Static abilities, shared activations, effects and conditions have separate records. Their acquisition references and review metadata are in `reviews/bindings.json`, with explicit `{ subjectId, field, value }` entries. `field` is a JSON pointer to the removed field in that subject; nested conflict values retain their position. Lazy `HeroEvidence.reviewBindings` exposes the corresponding runtime attribution, and `profileHistory` retains native selection evidence and official comparisons. `claim(id)` and `source(id)` remain available; full claim details load with the guide. Separation never promotes a review or resolves a conflict.

`ImageDescriptor` defines available assets with a safe relative path, identity, positive dimensions/byte length, media type and SHA-256. Unavailable descriptors contain a reason and no asset metadata. The separate [image catalog](images.md) supplies hero, ability and item lookups and lazy bytes without adding image reads to the knowledge loader.

### Observations and evidence

`observations(filter?)` returns records present in the compact core. `loadObservations(filter?)` loads any indexed lazy observation shards needed by the filter, deduplicates concurrent reads, and returns matching rows. The filter supports exact `heroId`, `otherHeroId`, `allyHeroId`, `opponentHeroId`, `kind`, `sourceId`, and `cohortId` values. It does not rank, weight, or choose between observations.

`getHeroEvidence(id)` returns an already cached guide or `undefined`. `loadHeroEvidence(id)` verifies and loads the requested guide. Guide reads are coalesced by core hash and hero ID. The default cache holds at most eight heroes and 32 MiB of encoded content; individual artifact limits still apply. A failed read is not cached. `clearEvidenceCache()` removes cached details. `retire()` invalidates the store and rejects outstanding work so callers can replace a dataset safely.

`metadata` exposes build, patch-label, extractor, decoder, review, compiler, source, and coverage identities. `coreSha256` identifies the core against which the lazy evidence was compiled.

### Errors

Integrity and data-contract failures throw `KnowledgeDataError`, with a stable `code` property. An absent lookup returns `undefined`. A missing source artifact, hash mismatch, unsafe path, malformed record, invalid reference, incompatible guide, or oversized response is an error; it is not translated to empty or approved data.

## Node entry

`loadKnowledgeDirectory(manifestPath, options?)` loads a manifest and its relative artifacts from a directory. `loadKnowledgePackage(options?)` loads the current runtime data shipped by the package. The `@reino-doce/dota-knowledge/node/game-files` subpath exposes read-only `openVpk`, `parseKeyValues`, and `resolveGameDirectory` utilities for explicit development tools.

The `@reino-doce/dota-knowledge/node/provider-acquisition` subpath exposes `acquireProviderArtifact({ providerId, client, request, credentials?, timeoutMs?, maxBytes?, clock? })`. The caller supplies the provider client, request, and credentials. The library enforces a timeout signal and response-size bound, then returns exact bytes, SHA-256, content type, and the acquisition clock without retaining credentials or reading application settings.

## TypeScript

The typed `@reino-doce/dota-knowledge/node/population` export provides `collectPopulation`, `normalizeScope`, `applyPopulation`, `recoverPopulation`, `prunePopulation`, `createFileStorage`, `createRoster`, `recipeSettings`, exact-count helpers and version-one statistical recipes. It imports production validation dependencies only in the Node tooling graph. The [population guide](population.md) documents explicit inputs, errors, replacement scopes and calibration adapters.

The main export includes declarations for all record and filter types. Hero IDs, semantic IDs, and exact population counts are strings. The package does not ship application scoring types because scoring and statistical policy are consumer-owned.

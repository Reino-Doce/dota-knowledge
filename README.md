# Dota knowledge

`@reino-doce/dota-knowledge` is a reusable, source-qualified library of Dota 2 mechanics and match observations. It owns acquisition records, normalized knowledge, validation, deterministic compilation, and identity-based queries. It does not decide how a consumer scores a draft, selects a provider, weights a sample, or presents advice.

## Node.js

```js
import { loadKnowledgePackage } from '@reino-doce/dota-knowledge/node';

const knowledge = await loadKnowledgePackage();
const hero = knowledge.hero('7');
const effects = knowledge.effectsForHero('7');
const matchups = await knowledge.loadObservations({ kind: 'matchup', heroId: '7' });
const guide = await knowledge.loadHeroEvidence('7');
```

`knowledge.heroByKey('antimage')` resolves an exact canonical key.
`knowledge.heroesByAlias('Anti-Mage')` returns all recorded alias candidates,
sorted by canonical key; it trims, lowercases and collapses whitespace. Unknown
aliases return an empty array, and collisions remain visible to the consumer.
Use the returned hero's `id` for effects, observations, evidence and images.
See the [runnable lookup example](docs/examples/hero-lookups.mjs).

For a custom installation or package layout, use `loadKnowledgeDirectory(manifestPath)`. The Node entry reads only the manifest and the artifacts it lists. There is no filesystem, network, or provider access when the main package entry is imported.

## Browser

The browser entry accepts an explicit manifest and byte reader, so consumers control the transport and base URL:

```js
import { loadKnowledgeStore } from '@reino-doce/dota-knowledge';

const manifest = await fetch('/data/dota-knowledge/current/manifest.json').then(response => response.json());
const knowledge = await loadKnowledgeStore({
    manifest,
    readArtifact: async descriptor => {
        const response = await fetch(`/data/dota-knowledge/current/${descriptor.name}`);
        if (!response.ok) throw new Error(`Knowledge artifact unavailable: ${descriptor.name}`);
        return new Uint8Array(await response.arrayBuffer());
    },
});
```

See [the API reference](docs/api.md) for query filters, identity rules, cache behavior, and errors.

## Records and data layout

Heroes, abilities, activations, effects, modifiers, rules, conditions, values, units, upgrades, sources, claims, and observations have explicit records and schema definitions in `schema/`. Hero and other public numeric IDs remain decimal strings. Stable semantic IDs are used in explanations and references. Rank values retain their precision, population counts remain decimal strings, and effect order remains explicit.

Known, decoded, unknown, unsupported, not-applicable, and conflicted values have separate states. Review decisions remain source- and build-qualified. Data absence is never converted to a zero or an approval. Observation queries select identities, kinds, sources, and cohorts; provider selection, compatibility policy, freshness policy, and statistical weighting belong to the application.

`data/` is the canonical current dataset, using schema **2** and compiler **3**. `heroes/<key>/` holds plain profiles, abilities, ordered mechanics, guides and population records. `heroes/index.json` supplies ID/key/engine/provider crosswalks; `heroes/aliases.json` preserves all normalized alias candidates. Shared mechanics, sources and review records live under `mechanics/`, `observations/` and `reviews/`. Indexes point to records instead of repeating their payloads.

Profiles select current native attributes, attack range, complexity and ordered roles. Missing scalars are `null` with an explanation in `coverage.fields`. Historical profiles, official comparisons and acquisition bindings remain available in observations and review records. A separate image catalog supplies base hero portraits/icons, ability artwork and current playable item icons, with explicit reasons for unavailable artwork.

Runtime consumers load the indexed core and fetch hero-keyed guides and observation shards on request. The package ships `data/runtime/`; its existing `./runtime/manifest.json` export resolves to the new location. Runtime loaders accept v2 only. Original acquisitions and the verified v1 preservation archive remain in ignored `evidence/`.

The manifest separates game build, verified patch label, extractor, decoder, review, acquisition, observation, and compiler identities. Recompiling identical selected inputs preserves generation metadata and artifact hashes. The public patch label remains unknown until its mapping is verified.

## Data workflow

Population acquisition has a typed, independent `./node/population` entry. `population:refresh` saves evidence and completed scopes; `population:apply` publishes selected scopes offline, then prunes superseded ordinary evidence. Clients, credentials and calibration features are caller supplied. See [population collection and publication](docs/population.md) for recipes, adapters, optional browser sessions, recovery and an executable fixture example.

Images have browser-safe `./images` and Node `./node/images` entries. Catalog loading leaves pixels lazy; URLs and filesystem roots remain caller-controlled. `images:refresh` captures artwork and `images:apply` publishes it offline. See [image access, acquisition and coverage](docs/images.md).

Ordinary compilation reads canonical records offline without Picker or original acquisitions:

```sh
npm run compile
npm run schema:check
npm run compare -- --base <git-revision>
npm run package:verify
```

Offline bundle import and explicit source recovery are described in [the data workflow guide](docs/data-workflow.md). Native VPK files and Picker Git snapshots are retained only after their recorded SHA-256 matches. Missing originals remain explicit in `reviews/reconciliation/index.json`. Recovery and acquisition are separate operations from compilation.

Run `npm test`, `npm run typecheck`, `npm run schema:check`, and `npm run package:verify` before packaging. Comparison reports gameplay, observations, review decisions, structure, naming and metadata separately, including deleted identities. Package verification extracts the archive and checks its Node exports, browser entry and every lazy reference without development dependencies.

`npm run audit:consolidation` captures the current v2 records and performance offline. Historical captures remain in verified archives with their original tooling. See [the capture workflow](docs/data-workflow.md#capture-a-consolidation-baseline).

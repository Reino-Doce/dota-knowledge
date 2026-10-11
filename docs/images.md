# Images

The image catalog is independent of the mechanics core. It publishes base hero
portraits and native icons, ability icons, and current standard-match item icons.
Cosmetics, vertical selection portraits, obsolete items and event-only items are
outside this inventory. Existing ability identities remain intact, including
talents and hidden slots; missing artwork has an explicit reason.

The bundled build-6957 inventory enumerates 128 heroes, 2,335 ability records and
355 selected items. It supplies both variants for 127 heroes, 1,039 ability
bindings and every selected item, sharing 1,364 distinct PNG files. The target
dummy has no artwork. Unavailable ability entries comprise 1,178 talents,
109 hidden slots, two preserved native metadata fields and seven other entries
with no matching native texture or selected CDN image. Inspect descriptors for
individual reasons; absence is part of the catalog rather than a broken URL.

## Read images

```js
import { loadImagePackage, resolveImageUrl } from '@reino-doce/dota-knowledge/node/images';

const images = await loadImagePackage();
const portrait = images.image('hero', '1', 'profile');
if (portrait?.state === 'available') {
    const url = resolveImageUrl(portrait, 'https://example.test/dota/data/');
    const bytes = await images.loadBytes(portrait.id);
}
const blink = images.image('ability', 'ability:1:antimage_blink');
const items = images.entities('item'); // decimal IDs, keys, engine IDs, acquisition class
```

To start with a hero key or name, resolve it through the knowledge store's
`heroByKey(key)` or `heroesByAlias(alias)` and pass the selected hero's `id` to
`images.image('hero', hero.id)`. Alias queries can have multiple candidates.
The [lookup example](examples/hero-lookups.mjs) combines both catalogs without
constructing asset paths or loading pixels.

`loadImageDirectory(dataRoot)` loads a caller-owned directory. The browser entry
`@reino-doce/dota-knowledge/images` exports `loadImageCatalog({ manifest,
readArtifact })` and `resolveImageUrl`. Import the manifest through
`@reino-doce/dota-knowledge/images/manifest.json`, or fetch it explicitly.
`readArtifact` receives `{ name, bytes, sha256, kind }`; `kind` is `catalog` or
`image`, and names are relative to the **data directory**, not `data/images`.

```js
import { loadImageCatalog, resolveImageUrl } from '@reino-doce/dota-knowledge/images';

const base = new URL('/dota/data/', location.href);
const response = await fetch(new URL('images/manifest.json', base));
if (!response.ok) throw new Error('Image manifest unavailable');
const images = await loadImageCatalog({
    manifest: await response.json(),
    readArtifact: async artifact => {
        const response = await fetch(new URL(artifact.name, base));
        if (!response.ok) throw new Error('Image artifact unavailable');
        return new Uint8Array(await response.arrayBuffer());
    },
});
const icon = images.image('hero', '1');
const url = icon && resolveImageUrl(icon, base);
```

Imports perform no I/O. Loading the catalog reads metadata only. `images(kind?,
id?)` enumerates descriptors; `image(kind, id, variant = 'icon')` returns one or
`undefined` for an unknown identity. An unavailable descriptor has a reason and
no path, dimensions or hash. `loadBytes(imageId)` returns `undefined` for an
unknown/unavailable image and otherwise verifies size and SHA-256. Concurrent
reads of shared artwork are coalesced, returned buffers are independent, and
pixels are not retained in a library cache. Failed reads may be retried.

The catalog limit is 8 MiB; individual images are limited to 16 MiB and
4096 pixels per dimension. Publication fully decodes PNGs with CRC validation.
URL resolution checks paths but does not fetch or authenticate bytes rendered
directly by an HTML image element. Use `loadBytes` when byte verification is needed.

## Acquire and publish

Run acquisition only when explicitly requested. Source 2 Viewer is an external
tool supplied with `--resource-tool`; install a release from its
[official distribution](https://github.com/ValveResourceFormat/ValveResourceFormat/releases).
The importer records the executable's version and SHA-256. It reads selected VPK
resources and decodes in owned temporary directories; it does not launch a game
or browser. `pngjs` is a declared Node dependency; neither decoder is imported by
the browser image entry or the default knowledge entry.

```sh
npm run images:refresh -- --run images-6957 --game <game-directory> --resource-tool <Source2Viewer-CLI> --picker-portraits <portrait-directory>
npm run images:refresh -- --run images-6957 --offline
npm run images:apply -- --run images-6957
npm run images:recover
```

Refresh saves immutable raw resources, normalized PNGs, source mappings and
progress under `evidence/images/acquisition/`; it does not change canonical data.
`--evidence` and `--dataset` select caller-owned roots. Existing Picker portraits
are optional inputs, joined by the canonical provider crosswalk and preserved
without resizing. Missing portraits use genuine native portrait resources.
`--cdn` explicitly enables Valve's image CDN for remaining eligible gaps. It uses
no credentials, follows no redirects and never contacts population providers.
There is no automatic network fallback.

Re-run the same refresh command to resume. Roster, definitions, selected resource
hashes, item policy and decoder identity must match; incompatible inputs require
a new run ID. `--fresh` rejects an existing run ID. Offline replay verifies the
saved bytes without consulting an installation or endpoint. An acquisition or
decoder failure leaves an incomplete run that apply rejects; it cannot replace
a previously published image with an unavailable state.

Apply validates the complete image inventory offline and uses the guarded
canonical publisher. Existing gameplay/runtime JSON and acquisition clocks are
preserved. Reapplying identical inputs preserves image generation metadata too.
Hero and ability identities must cover the complete canonical roster. Concurrent
canonical edits invalidate the captured input snapshot and require an apply retry.
Recovery verifies the promoted dataset or restores the previous one. Acquisition
evidence is retained; population cleanup cannot prune this separate evidence tree.
Compilation and subsequent population application preserve registered images.

## Identity, selection and provenance

Image schema version 1 uses stable bindings for entity kind, entity ID and variant.
Shared artwork is stored once, referenced by asset ID, and exposed through the
existing `ImageDescriptor` union. Hero paths use native keys such as `antimage`.
Item IDs come from native ability-ID declarations and remain decimal strings.
Item identities support artwork lookup; they do not introduce item mechanics.

The versioned item policy selects shop items, active neutral pools/enhancements,
purchasable recipe scrolls for selected items, and standard-match pickups or
generated items. Automatic zero-cost recipe definitions, inactive neutrals and
other internal/event definitions remain in the exclusion inventory. Explicit
native `SubAbilityNames` links add generated consumables of selected items,
including Forager's Kit choices. The bundled
policy is for client build 6957. A different build requires an explicitly supplied
matching policy through the Node acquisition API.

Ability textures follow native declarations, explicit `_base` relationships, or
engine names. The game's shared innate icon is used for native innate records
without individual art, with the native UI stylesheet retained as evidence.
Talents or hidden slots without artwork remain unavailable; unrelated generic
portraits/icons are never substituted. Portrait sizes and transparency are
preserved. Drow Ranger's imported portrait is 128×72; most imported portraits are
256×144. Artwork remains Valve's property; see [NOTICE](../NOTICE.md).
Native dimensions are retained too: most hero icons are 32×32, while Muerta's
is 32×31. The catalog records actual dimensions rather than imposing a size.

`./node/images` exposes `inventoryImages`, `createNativeImageSource`,
`createSource2Decoder`, `createValveCdnReader`, `createImageStorage`, `collectImages`,
`applyImages`, and `recoverImages`. Collectors require explicit storage, clock,
cancellation and logger dependencies. Fresh collection also requires a verified
source inventory/reader and decoder adapter. Fixture decoders need no executable.
See [the executable fixture](examples/images-fixture.mjs):

```sh
node docs/examples/images-fixture.mjs
```

The package contains runtime JSON, image catalog/assets and required notices.
Canonical gameplay sources, original evidence and Source 2 Viewer binaries are
not distributed. `images:apply` targets a canonical checkout/dataset, not the
runtime-only package directory.

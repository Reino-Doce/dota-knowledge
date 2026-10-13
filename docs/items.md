# Item data

`items:generate` writes one current-build profile per item to `data/items/<item-slug>/data.json` and a compact source index to `data/items/index.json`.

```sh
npm run items:generate -- --game "<Dota game directory>"
```

The command reads item definitions, locked item IDs, neutral item tiers, and English localization from the selected VPK, then reads the build identity from `dota/steam.inf`. It makes no network requests. `--dataset <directory>` selects another canonical data directory. Build and source hashes are kept in the index, not repeated in each item profile.

## Item profile

An item profile keeps useful item fields as ordinary JSON values. Items with an ability use the same compact ability fields as hero ability views: `type`, `behavior`, `target`, `affects`, `manaCost`, `cooldown`, dispel and damage properties, and `tags`. Item-only values such as cast range, charges, shop tags, recipe components, and neutral tiers sit beside them.

```json
{
  "id": "1",
  "key": "blink",
  "sourceKey": "item_blink",
  "name": "Blink Dagger",
  "aliases": ["blink", "blink dagger", "item_blink"],
  "description": "...",
  "lore": "...",
  "notes": ["Self-casting sends the wielder toward the fountain."],
  "cost": 2250,
  "shopTags": ["teleport", "mobility", "escape"],
  "quality": "component",
  "neutralTiers": [],
  "ability": {
    "id": "item_blink",
    "type": "point",
    "behavior": ["point-target"],
    "manaCost": 0,
    "cooldown": 15,
    "castRange": 1200,
    "tags": [],
    "values": {
      "blink_range": 1200,
      "blink_damage_cooldown": 3,
      "blink_range_clamp": 960
    }
  }
}
```

Ranked mechanics values are numbers or arrays of numbers. Conditional declarations stay as ordinary nested values, and expressions that cannot be calculated without more context remain strings. Missing optional fields are omitted; missing localized text is `null`.

The index records build identity, source resource hashes, item profile paths, and item IDs that have no matching definition. It is the package entry point for listing items:

```js
import itemIndex from '@reino-doce/dota-knowledge/items/index.json' with { type: 'json' };
import blink from '@reino-doce/dota-knowledge/items/blink/data.json' with { type: 'json' };
```

Schemas: `schema/item-index.schema.json` and `schema/item-profile.schema.json`. The item dataset can have a different build identity from hero mechanics and image datasets.

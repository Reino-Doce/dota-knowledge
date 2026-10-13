# Ability tags

Every record in `data/heroes/<hero>/abilities.json` carries a sorted `tags` array. Innates use the same field. The ability entry is the only published assignment: mechanics records do not carry tag payloads, and hero files do not contain per-tag evidence or contribution documents.

The file groups entries under `innate`, `skills`, `talents`, and `bonus_attributes`. Entries use the game identifier as `id`; they omit internal record identities, owner/state fields and activation records. Singleton groups contain an object, multiple records use an array, and an absent group is `null`. Skills and talents are always arrays. Full tagless Ability metadata and structured Activation records remain in `data/mechanics/abilities.json`; the runtime record API retains its existing identities and fields.

Skill arrays follow the original record order and expose that value as `order`, retaining positions when other records are moved into their own groups.

`Name` is the source-bound default English ability title. Known owned numeric arguments are formatted in talent titles. Unavailable, conflicting or unresolved names are omitted. Names do not come from identifiers or another ability's title.

Casting `type` retains its compact compatibility value: `passive`, `toggle`, `target`, `point`, `vector`, `target-or-point`, `self-target`, `unknown`, or `placeholder`. The separate `behavior` array exposes recognized `AbilityBehavior` classes: `unit-target`, `passive`, `point-target`, `no-target`, `auto-cast`, `channeled`, `point-vector-target`, `toggle`, and `tree-vector-target`. It can contain multiple values when the source declares combined behavior flags. A source-proven acquired/invoked spell container uses `placeholder` before the passive rule: it must be passive/non-learnable with zero maximum level and an owning gameplay description stating that spells or abilities replace/fill its slot. Zero level alone does not establish a placeholder. Placeholders have no casting costs or selectable targets. `self-target` means no target is selected when casting; it does not limit affected recipients to the caster. Active innates retain casting fields. Known costs use scalars or rank arrays, collapsing equal ranks; unknown values are omitted. `target` lists source-declared selectable unit classes. `affects` summarizes declared target teams and unit types as one or more catalog labels, such as `allied-units` with `allied-buildings`; it does not prove the runtime effect's complete recipient set. `dispellable`, `dispelType`, `piercesDebuffImmunity`, `damageType`, and `breakable` are emitted only when their installed declarations have recognized values. `dispelType` is the minimum dispel strength stated by `SpellDispellableType` (`basic` or `strong`); `dispellable` is `yes`, `no`, or `strong-only`. `damageType` reflects the displayed `AbilityUnitDamageType` value; `DAMAGE_TYPE_NONE` is omitted, and this field alone does not establish actual damage. `breakable` is a boolean. Grouping and these source fields do not assign contribution tags.

`data/tags/index.json` is the separate vocabulary index. It lists tag keys and labels under generic categories such as `buff`, `save`, `control`, and `damage`. Categories organize tags; they are not assigned as extra effects. For example, `death_prevention` belongs to the `save` category, so Dazzle's Shallow Grave uses the precise tag rather than a vague `save` tag.

When a recipient-qualified tag fully refines a general tag, the published ability keeps the specific tag and omits the redundant general one. For example, `self_heal` and `ally_heal` replace `heal`; the same rule applies to health regeneration, dispels, lifesteal, healing amplification, and barriers.

The compiler applies general rules to source-backed native fields, behavior flags, and gameplay descriptions and notes. It recognizes affirmative operations, their recipients, conditions, and polarity; modeled effect types and recipients can corroborate those operations. Classification does not depend on ability names, effect IDs, a list of known abilities, or exact tooltip hashes. Hero roles, lore, imported guide labels, and unverified modifier-name candidates do not create ability tags.

Damage kinds use the dedicated `damageType` field and are not contribution tags. A declared damage type alone does not establish a damage operation, and a summoned creature's damage does not become the caster's damage. Statements about accepted targets or conditions also do not grant capabilities: “affects invulnerable units” does not grant invulnerability, and “while already untargetable” does not grant untargetability.

`damage_reflection` returns incoming damage outward; `spell_reflection` returns the targeted spell itself. `damage_negation` prevents qualifying damage events; partial reduction, flat blocking and absorbable barriers use `damage_reduction`, `damage_block` and `barrier` respectively. Physical-only and magical-only immunity have separate tags. Neither damage reflection nor event negation implies general damage immunity. Reflected damage that inherits the incoming damage type does not receive a fixed `damageType` value.

Numeric field labels can corroborate a contribution when the label belongs to the ability, its matching native value is nonzero, and the beneficiary is established. For example, an HP-regeneration label paired with a positive regeneration rate can establish a self-regeneration buff. An ability's UI-hidden flag does not establish hero invisibility, and a native cast distance alone does not establish a cast-range buff.

Generic stat talents also use their source-bound title, passive attribute metadata, and owned positive value. A whole title such as `+{s:value} Health` establishes maximum health; it does not establish healing. Spell-specific titles do not enter this rule. Linked talents use the parent declaration's numeric base and explicit modifier operation, and receive only the property they change: lowering a stun spell's cooldown grants the talent `cooldown_reduction`, without copying `stun` or its damage type. That modifier does not give the spell itself a cooldown-reduction contribution. The same distinction applies to mana and charge costs. Unknown operators, zero changes and inconsistent rank changes remain untagged.

An explicit, resolved `_base` template can provide missing gameplay text when the source chain and compatible handler are verified. Child declarations still determine the numeric payload. Ordinary links between abilities do not establish shared effects.

A source-bound NPC `AbilityN` assignment, creator mapping and matching callback dependency can establish a local controlled-unit ability. Its own damage and stun use its own parameters and gameplay text. Creature survival uses `controlled_unit_damage_immunity` and `controlled_unit_health_regen`; an ordering endpoint does not grant hero immunity or escape.

For example, `dazzle_shallow_grave` has `ally_healing_amplification`, `buff`, `death_prevention`, and `healing_amplification`. Tags include supported conditional capabilities; they do not promise that every upgrade is active. The serialized record stays small:

```json
{
  "id": "dazzle_shallow_grave",
  "tags": [
    "ally_healing_amplification",
    "buff",
    "death_prevention",
    "healing_amplification"
  ]
}
```

All abilities remain present in `abilities.json`. An empty array means the available declarations and recognized gameplay statements do not establish a tag. Some engine behavior is absent from exposed game-file declarations; unsupported or ambiguous statements remain untagged. The same inputs and classifier version produce the same sorted arrays.

`heroes/<hero>/profile.json` contains `capabilities`, a sorted map of category keys to positive integer scores. Each distinct tag on an owned ability contributes 1 to every category it belongs to in `data/tags/index.json`, including innates, skills, talents and attribute bonuses. Multiple tags from the same ability each contribute: `heal`, `self_heal`, and `ally_heal` on one skill add 3 to `sustain`, 2 to `defense`, and 1 to `save`. The same tag on another ability contributes again; duplicate copies within one ability's array count once. Empty tag arrays contribute nothing; categories with no contributions are omitted, and an entirely untagged hero has `{}`. These scores count available tagged contributions, including conditional upgrades; they do not measure potency or a simultaneously active build. Compilation regenerates the scores after deriving ability tags. Runtime hero records expose the same immutable map.

`attack_modifier` identifies a source-supported alteration to basic attacks. `damage_over_distance` identifies outgoing damage scaled by distance; a cast-range limit or distance used only as a threshold does not establish that contribution. Controlled-unit damage buffs use `controlled_unit_damage`; `creep_damage` describes damage against creeps. Buffing creature attacks does not establish the buffing ability's own damage type or immunity piercing.

`escape` is an ability-level capability tag, not a copied hero role or a promise that escape will succeed. It is derived from supported repositioning and explicit avoidance effects such as projectile disjoint, invisibility, or untargetability. A movement-speed stat by itself does not establish an escape capability. The specific tags remain on the ability as well.

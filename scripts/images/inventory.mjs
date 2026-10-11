import { parseKeyValues } from '../../src/node/game-files.mjs';
import { semanticHash, hash } from '../../src/canonical-model.mjs';
import { imageId } from '../../src/image-contracts.mjs';

export const IMAGE_RECIPE = 'native-images-1';
// Standard-match acquisition paths that are engine-owned rather than shop/neutral-table entries.
// This policy is tied to the native build; exclusions and raw definitions are retained in each run.
export const STANDARD_ITEM_POLICY = Object.freeze({
    version: 'standard-items-6957-1', clientVersion: '6957',
    pickups: ['cheese', 'famango', 'great_famango', 'greater_famango', 'royale_with_cheese',
        'ward_dispenser', 'tango_single', 'ultimate_scepter_roshan', 'aghanims_shard_roshan',
        'aegis', 'refresher_shard', 'roshans_banner', 'madstone_bundle', 'miniboss_minion_summoner',
        'furion_gold_bag', 'tidehunter_fish'].map(key => 'item_' + key),
});

export function rosterIdentity(roster) {
    return { heroes: roster.heroes.map(row => ({ id: row.id, key: row.key, engineId: row.sourceKey, enabled: row.enabled })),
        abilities: roster.abilities.map(row => ({ id: row.id, heroId: row.heroId, engineId: row.engineId })) };
}
export const rosterSignature = roster => semanticHash(rosterIdentity(roster));

export function validateImageRoster(catalog, roster) {
    const expected = rosterIdentity(roster);
    expected.heroes = expected.heroes.map(({ enabled: _enabled, ...row }) => row);
    for (const kind of ['heroes', 'abilities']) {
        const ordered = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
        if (semanticHash(ordered(catalog.entities[kind])) !== semanticHash(ordered(expected[kind]))) {
            throw new Error('Image catalog does not enumerate the complete canonical ' + kind + ' identities.');
        }
    }
}

export function selectItems({ definitions, ids, neutrals, policy, build }) {
    if (!policy || policy.clientVersion !== build.clientVersion || !Array.isArray(policy.pickups)) throw new Error('An item policy matching the native build is required.');
    const pool = new Set();
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
            if (key.startsWith('item_') && child === '1') pool.add(key);
            else visit(child);
        }
    };
    visit(neutrals);
    const selected = new Map(); const exclusions = [];
    const rows = Object.entries(definitions).filter(([key, value]) => /^item_[a-z0-9_]+$/.test(key) && value && typeof value === 'object');
    for (const [engineId, raw] of rows.filter(([, row]) => row.ItemRecipe !== '1')) {
        let acquisition;
        if (raw.IsObsolete !== '1' && !raw.EventID) {
            if (pool.has(engineId)) acquisition = 'active-neutral-pool';
            else if (policy.pickups.includes(engineId)) acquisition = 'standard-match-pickup-or-generated';
            else if (raw.ItemPurchasable !== '0' && raw.ItemIsNeutralActiveDrop !== '1' && raw.ItemIsNeutralPassiveDrop !== '1') acquisition = 'shop';
        }
        if (acquisition) selected.set(engineId, acquisition);
    }
    // Explicit native subitem relationships include generated consumables such as
    // Forager's Kit choices. Traverse only from selected standard-match items.
    for (const engineId of selected.keys()) {
        for (const child of String(definitions[engineId].SubAbilityNames ?? '').split(/[;\s]+/).filter(Boolean)) {
            const raw = definitions[child];
            if (!/^item_[a-z0-9_]+$/.test(child) || !raw || typeof raw !== 'object') throw new Error('Unknown generated native item: ' + child);
            if (raw.IsObsolete !== '1' && !raw.EventID && raw.ItemRecipe !== '1' && !selected.has(child)) selected.set(child, 'native-generated-subitem');
        }
    }
    for (const [engineId, raw] of rows.filter(([, row]) => row.ItemRecipe === '1')) {
        // Zero-cost recipes describe automatic combinations, not obtainable recipe-scroll items.
        if (raw.IsObsolete !== '1' && !raw.EventID && raw.ItemPurchasable !== '0'
            && /^[0-9]+$/.test(raw.ItemCost ?? '') && BigInt(raw.ItemCost) > 0n && selected.has(raw.ItemResult)) selected.set(engineId, 'purchasable-recipe');
    }
    const seen = new Set(); const items = [];
    for (const [engineId, raw] of rows) {
        if (!selected.has(engineId)) {
            exclusions.push({ engineId, reason: raw.IsObsolete === '1' ? 'Native definition is obsolete.'
                : raw.EventID ? 'Event-only definition.' : raw.ItemRecipe === '1' ? 'Recipe is not obtainable in the selected standard-match inventory.'
                    : 'Not in the shop, active neutral pool, or versioned standard-match pickup policy.' });
            continue;
        }
        const id = ids[engineId];
        if (typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id) || seen.has(id)) throw new Error('Unknown or duplicate native item ID: ' + engineId);
        seen.add(id); items.push({ id, key: engineId.slice(5), engineId, acquisition: selected.get(engineId) });
    }
    return { items, exclusions };
}

/** Build a complete replacement inventory without reading image bytes or making requests. */
export async function inventoryImages({ roster, build, files, readResource, itemPolicy = STANDARD_ITEM_POLICY }) {
    const available = new Set(files); const inputs = [];
    const read = async resource => {
        const bytes = await readResource(resource);
        inputs.push({ resource, sha256: hash(bytes), bytes: bytes.length });
        return parseKeyValues(Buffer.from(bytes).toString('utf8'));
    };
    const definitions = (await read('scripts/npc/items.txt')).DOTAAbilities;
    const ids = (await read('scripts/npc/npc_ability_ids.txt')).DOTAAbilityIDs?.ItemAbilities?.Locked;
    const neutrals = (await read('scripts/npc/neutral_items.txt')).neutral_items;
    const shared = (await read('scripts/npc/npc_abilities.txt')).DOTAAbilities;
    if (!definitions || !ids || !neutrals || !shared) throw new Error('Incomplete native image definitions.');
    const { items, exclusions } = selectItems({ definitions, ids, neutrals, policy: itemPolicy, build });
    const entities = rosterIdentity(roster);
    entities.heroes = entities.heroes.map(({ enabled: _enabled, ...row }) => row);
    entities.items = items;
    const requests = [];
    const find = (prefix, texture) => {
        if (!/^[a-z0-9_/-]+$/.test(texture ?? '') || texture.split('/').some(part => !part)) return null;
        return [`${prefix}/${texture}_png.vtex_c`, `${prefix}/${texture}.png`].find(name => available.has(name)) ?? null;
    };
    const request = (kind, id, variant, destination, resource, reason, extra = {}) => requests.push({
        id: imageId(kind, id, variant), entityKind: kind, entityId: id, variant, destination, resource, reason, ...extra,
    });
    const nativeHeroes = new Map();
    for (const hero of roster.heroes) {
        const resource = `scripts/npc/heroes/${hero.sourceKey}.txt`;
        nativeHeroes.set(hero.id, available.has(resource) ? (await read(resource)).DOTAHeroes?.[hero.sourceKey] ?? {} : {});
        for (const variant of ['profile', 'icon']) request('hero', hero.id, variant, `heroes/${hero.key}/images/${variant}.png`,
            find('panorama/images/heroes' + (variant === 'icon' ? '/icons' : ''), hero.sourceKey),
            'No matching native hero artwork exists in the selected build.', { heroKey: hero.key, providerSlug: hero.providerSlug ?? null });
    }
    const owners = new Map();
    for (const row of roster.abilities) {
        if (!owners.has(row.engineId)) owners.set(row.engineId, new Set());
        owners.get(row.engineId).add(row.heroId);
    }
    for (const ability of roster.abilities) {
        const hero = roster.heroes.find(row => row.id === ability.heroId);
        if (!hero) throw new Error('Ability has no canonical hero.');
        const local = nativeHeroes.get(hero.id).AbilityDefinitions ?? {};
        const original = local[ability.engineId] ?? shared[ability.engineId];
        const bases = [];
        const resolve = (key, active = new Set()) => {
            if (active.has(key)) throw new Error('Cyclic native ability inheritance: ' + key);
            const declaration = local[key] ?? shared[key];
            if (!declaration || typeof declaration !== 'object') return {};
            if (!declaration._base) return declaration;
            active.add(key); bases.push(declaration._base);
            const parent = resolve(declaration._base, active); active.delete(key);
            return { ...parent, ...declaration };
        };
        const raw = resolve(ability.engineId);
        const texture = raw.AbilityTextureName || ability.engineId;
        let resource = find('panorama/images/spellicons', texture);
        let mapping = raw.AbilityTextureName ? 'native-texture-declaration' : 'engine-texture-name';
        if (!resource) for (const base of bases) {
            resource = find('panorama/images/spellicons', base);
            if (resource) { mapping = 'native-base-texture'; break; }
        }
        if (!resource && (raw.Innate === '1' || String(raw.AbilityBehavior).includes('DOTA_ABILITY_BEHAVIOR_INNATE_UI'))
            && available.has('panorama/images/hud/facets/innate_icon_large_png.vtex_c')) {
            // The game's innate_icon layout/style explicitly uses this shared art.
            const ui = 'panorama/styles/innate_icon.vcss_c';
            if (available.has(ui)) {
                const bytes = await readResource(ui);
                if (Buffer.from(bytes).includes(Buffer.from('innate_icon_large_png.vtex'))) {
                    resource = 'panorama/images/hud/facets/innate_icon_large_png.vtex_c'; mapping = 'native-innate-ui';
                    if (!inputs.some(row => row.resource === ui)) inputs.push({ resource: ui, bytes: bytes.length, sha256: hash(bytes) });
                }
            }
        }
        const reason = original && typeof original !== 'object' ? 'Canonical entry preserves a native metadata field rather than an ability definition.'
            : ability.engineId.startsWith('special_bonus') ? 'Talent has no individual native texture in the selected build.'
            : String(raw.AbilityBehavior).includes('HIDDEN') || /(^generic_hidden$|empty\d*$)/.test(ability.engineId)
                ? 'Hidden ability slot has no individual native texture.' : 'No declared or engine-named native ability texture exists in the selected build.';
        const filename = ability.engineId.toLowerCase();
        const destination = mapping === 'native-innate-ui' ? 'abilities/innate/images/icon.png'
            : owners.get(ability.engineId).size > 1 ? `abilities/${filename}/images/icon.png`
                : `heroes/${hero.key}/images/abilities/${filename}.png`;
        request('ability', ability.id, 'icon', destination, resource, reason, { heroKey: hero.key, mapping });
    }
    for (const item of items) {
        const raw = definitions[item.engineId];
        const texture = raw.AbilityTextureName || (raw.ItemRecipe === '1' ? 'recipe' : item.key);
        request('item', item.id, 'icon', `items/${raw.ItemRecipe === '1' ? 'recipe' : item.key}/images/icon.png`,
            find('panorama/images/items', texture), 'No matching native item artwork exists in the selected build.',
            { mapping: raw.ItemRecipe === '1' ? 'native-recipe-scroll' : raw.AbilityTextureName ? 'native-texture-declaration' : 'engine-texture-name' });
    }
    return { recipe: IMAGE_RECIPE, build, rosterSignature: rosterSignature(roster), entities, exclusions, requests,
        inputs: inputs.sort((a, b) => a.resource.localeCompare(b.resource)), itemPolicy };
}

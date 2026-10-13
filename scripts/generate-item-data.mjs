import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openVpk, parseKeyValues, resolveGameDirectory } from '../src/node/game-files.mjs';
import { decodeMechanicsValue } from '../src/mechanics-values.mjs';
import { deriveNativeItemAbilityTags } from '../src/tags/ability-tags.mjs';
import { compactAbilityMetadata, compactCastingType, compactTargets } from '../src/node/ability-view.mjs';
import { normalizeAlias } from '../src/record-contracts.mjs';
import { sha256Hex } from '../src/sha256.mjs';
import { jsonBytes, readCanonical, writeCanonical } from '../src/node/canonical.mjs';
import { publishDataset } from '../src/node/publish-dataset.mjs';
import { validateDataset } from './consolidation/validation.mjs';

export const ITEM_DATA_GENERATOR_VERSION = 'item-data-generator-3';
export const ITEM_DATA_RESOURCES = Object.freeze([
    'resource/localization/abilities_english.txt',
    'scripts/npc/items.txt',
    'scripts/npc/npc_ability_ids.txt',
    'scripts/npc/neutral_items.txt',
]);
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
const MAX_ITEMS = 2048;
const ITEM_KEY = /^item_[a-z0-9_]+$/;
const DECIMAL_ID = /^[1-9][0-9]*$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseNativeResource(bytes, resource) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_RESOURCE_BYTES) {
        throw new Error(`Invalid or oversized item source: ${resource}`);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/^\s*#base\s+/m.test(text)) throw new Error(`Unsupported KeyValues include in ${resource}.`);
    return parseKeyValues(text);
}

function sourceIdentity(build, sources) {
    return sha256Hex(Buffer.from(JSON.stringify({ build, sources }), 'utf8'));
}

function validateNative(value, depth = 0) {
    if (typeof value === 'string') return;
    if (!object(value) || depth > 32) throw new Error('Item definition contains an unsupported KeyValues value.');
    for (const child of Object.values(value)) validateNative(child, depth + 1);
}

function tokenValues(tokens) {
    const result = new Map();
    for (const [token, value] of Object.entries(tokens)) {
        if (typeof value !== 'string') throw new Error('Item localization contains a non-text token.');
        const key = token.toLowerCase();
        if (!result.has(key)) result.set(key, []);
        result.get(key).push(value);
    }
    return result;
}

function localizedValue(index, key) {
    const values = index.get(key.toLowerCase());
    if (!values?.length) return null;
    const unique = [...new Set(values)];
    if (unique.length !== 1) throw new Error(`Conflicting localized item token: ${key}`);
    return unique[0];
}

function localizedNotes(index, engineId) {
    const prefix = `dota_tooltip_ability_${engineId.toLowerCase()}_note`;
    const notes = new Map();
    for (const [token, values] of index) {
        if (!token.startsWith(prefix)) continue;
        const match = /_note([0-9]+)$/.exec(token);
        if (!match) continue;
        const unique = [...new Set(values)];
        if (unique.length !== 1) throw new Error(`Conflicting localized item note: ${token}`);
        const order = Number(match[1]);
        if (notes.has(order) && notes.get(order) !== unique[0]) throw new Error(`Conflicting localized item note order: ${token}`);
        notes.set(order, unique[0]);
    }
    return [...notes].sort(([left], [right]) => left - right).map(([, value]) => value);
}

function neutralTierIndex(neutralItems) {
    const tiers = neutralItems?.neutral_items?.neutral_tiers;
    if (!object(tiers)) throw new Error('Native neutral item tiers are missing.');
    const result = new Map();
    for (const [tierText, tier] of Object.entries(tiers)) {
        if (!/^[1-9][0-9]*$/.test(tierText) || !object(tier)) throw new Error('Invalid native neutral item tier.');
        const tierNumber = Number(tierText);
        const visit = value => {
            if (!object(value)) return;
            for (const [key, child] of Object.entries(value)) {
                if (ITEM_KEY.test(key)) {
                    if (typeof child !== 'string' || !/^[0-9]+$/.test(child)) throw new Error(`Invalid neutral item entry: ${key}`);
                    if (!result.has(key)) result.set(key, new Set());
                    result.get(key).add(tierNumber);
                }
                else visit(child);
            }
        };
        visit(tier);
    }
    return result;
}

function readBuild(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024 * 1024) throw new Error('Invalid game build metadata.');
    const fields = new Map();
    for (const line of new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/)) {
        if (!line) continue;
        const separator = line.indexOf('=');
        if (separator < 1) continue;
        const key = line.slice(0, separator);
        if (fields.has(key)) throw new Error(`Duplicate game build field: ${key}`);
        fields.set(key, line.slice(separator + 1));
    }
    const build = { clientVersion: fields.get('ClientVersion'), serverVersion: fields.get('ServerVersion'), sourceRevision: fields.get('SourceRevision') };
    if (Object.values(build).some(value => !/^[0-9]+$/.test(value ?? ''))) throw new Error('Incomplete Dota build metadata.');
    return build;
}

function valueTokens(raw) {
    if (typeof raw !== 'string') return [];
    return raw.split('|').map(token => token.trim()).filter(Boolean);
}

function teamTargets(raw) {
    const teams = new Set();
    for (const flag of valueTokens(raw)) {
        if (flag === 'DOTA_UNIT_TARGET_TEAM_FRIENDLY') { teams.add('self'); teams.add('ally'); }
        else if (flag === 'DOTA_UNIT_TARGET_TEAM_ENEMY') teams.add('enemy');
        else if (flag === 'DOTA_UNIT_TARGET_TEAM_BOTH') { teams.add('self'); teams.add('ally'); teams.add('enemy'); }
        else if (flag === 'DOTA_UNIT_TARGET_TEAM_CUSTOM') teams.add('custom');
    }
    return [...teams];
}

function splitAliases(name, searchAlias, key, engineId) {
    return [...new Set([name, ...(searchAlias ?? '').split(';'), key, engineId]
        .filter(value => typeof value === 'string' && value.trim())
        .map(normalizeAlias))].sort();
}

function localizedFieldLabels(localized, engineId) {
    const prefix = `dota_tooltip_ability_${engineId.toLowerCase()}_`;
    const result = [];
    for (const [token, values] of localized) {
        if (!token.startsWith(prefix) || /_(?:description|lore|note[0-9]+)$/.test(token)) continue;
        const unique = [...new Set(values)];
        if (unique.length === 1) result.push({ field: token.slice(prefix.length), text: unique[0] });
    }
    return result;
}

function normalizedConstant(value) {
    return value.replace(/^(?:DOTA_ABILITY_BEHAVIOR_|DOTA_UNIT_TARGET_TEAM_|DOTA_UNIT_TARGET_FLAG_|DOTA_UNIT_TARGET_|DAMAGE_TYPE_|DOTA_DAMAGE_TYPE_|SPELL_DISPELLABLE_|SPELL_IMMUNITY_|DOTA_ITEM_DISASSEMBLE_|ITEM_)/, '')
        .toLowerCase().replaceAll('_', '-');
}

function plainValue(raw) {
    if (Array.isArray(raw)) return raw.map(plainValue);
    if (object(raw)) return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, plainValue(value)]));
    const value = decodeMechanicsValue(raw);
    if (value.state === 'known') return value.value;
    if (value.kind === 'boolean') return value.decoded;
    if (value.kind === 'enum') return normalizedConstant(value.decoded);
    if (value.kind === 'flags') return value.decoded.map(normalizedConstant);
    if (value.kind === 'reference' || value.kind === 'string') return value.decoded;
    // Expressions remain their original declaration until there is enough
    // context to calculate them; this keeps the JSON plain and lossless.
    return raw;
}

function numericValue(raw) {
    if (raw === undefined) return undefined;
    const value = decodeMechanicsValue(raw);
    if (value.state !== 'known' || !['number', 'rank-values'].includes(value.kind)) return undefined;
    return value.value;
}

function booleanValue(raw) {
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return undefined;
}

function addDeclaredBoolean(record, output, native, input = output[0].toUpperCase() + output.slice(1)) {
    const value = booleanValue(native[input]);
    if (value !== undefined) record[output] = value;
}

function recipeRequirements(native) {
    if (!object(native.ItemRequirements)) return undefined;
    return Object.entries(native.ItemRequirements).sort(([left], [right]) => Number(left) - Number(right))
        .map(([, value]) => typeof value === 'string' ? value.split(';').map(part => part.trim()).filter(Boolean) : []);
}

function itemAbility(item, localized) {
    const { engineId, native } = item;
    const abilityFields = ['AbilityBehavior', 'AbilityValues', 'AbilityManaCost', 'AbilityCooldown', 'AbilityCastRange',
        'AbilityCastPoint', 'AbilityChannelTime', 'AbilityDamage', 'AbilityDamageType', 'AbilityUnitDamageType',
        'AbilityDuration', 'AbilityHealthCost', 'AbilitySharedCooldown', 'AbilityUnitTargetTeam', 'AbilityUnitTargetType'];
    if (!abilityFields.some(field => Object.hasOwn(native, field))) return undefined;

    const fields = new Map(Object.entries(native).filter(([field, value]) => field !== 'AbilityValues' && typeof value === 'string'));
    for (const [field, value] of Object.entries(native.AbilityValues ?? {})) fields.set(field, value);
    const behavior = new Set(valueTokens(native.AbilityBehavior));
    const snippets = [item.description, ...item.notes].filter(Boolean).map(text => ({ suffix: 'description', text }));
    const fieldLabels = localizedFieldLabels(localized, engineId);
    const tags = deriveNativeItemAbilityTags({ fields, snippets, fieldLabels, abilityLabel: item.name ?? undefined,
        behavior, nativeTeams: teamTargets(native.AbilityUnitTargetTeam), actorNames: [item.name].filter(Boolean) });
    const ability = { id: engineId, ...compactAbilityMetadata(fields), tags };
    const type = compactCastingType(fields, snippets);
    if (type !== 'unknown') ability.type = type;
    const targets = compactTargets(fields);
    if (targets.length && type !== 'toggle') ability.target = targets;
    for (const [output, input] of [['manaCost', 'AbilityManaCost'], ['cooldown', 'AbilityCooldown'],
        ['castRange', 'AbilityCastRange'], ['castPoint', 'AbilityCastPoint'], ['channelTime', 'AbilityChannelTime'],
        ['damage', 'AbilityDamage'], ['duration', 'AbilityDuration'], ['healthCost', 'AbilityHealthCost']]) {
        const value = numericValue(native[input]);
        if (value !== undefined) ability[output] = value;
    }
    for (const [output, input] of [['sharedCooldown', 'AbilitySharedCooldown']]) {
        if (typeof native[input] !== 'string') continue;
        const value = plainValue(native[input]);
        if (value !== '') ability[output] = value;
    }
    if (object(native.AbilityValues)) ability.values = Object.fromEntries(Object.entries(native.AbilityValues).map(([key, value]) => [key, plainValue(value)]));
    return ability;
}

function makeItemRecord(item, localized) {
    const { native } = item;
    const record = {
        id: item.id,
        key: item.key,
        sourceKey: item.engineId,
        name: item.name,
        aliases: splitAliases(item.name, item.searchAlias, item.key, item.engineId),
        description: item.description,
        lore: item.lore,
        notes: item.notes,
        neutralTiers: item.neutralTiers,
    };
    const cost = numericValue(native.ItemCost);
    if (cost !== undefined) record.cost = cost;
    if (typeof native.ItemShopTags === 'string') record.shopTags = [...new Set(native.ItemShopTags.split(';')
        .map(value => value.trim().toLowerCase().replaceAll('_', '-')).filter(Boolean))];
    if (typeof native.ItemQuality === 'string' && native.ItemQuality) record.quality = native.ItemQuality;
    for (const [output, input] of [['purchasable', 'ItemPurchasable'], ['sellable', 'ItemSellable'], ['permanent', 'ItemPermanent'],
        ['stackable', 'ItemStackable'], ['droppable', 'ItemDroppable'], ['killable', 'ItemKillable'], ['requiresCharges', 'ItemRequiresCharges']]) {
        addDeclaredBoolean(record, output, native, input);
    }
    for (const [output, input] of [['maxStack', 'ItemStackableMax'], ['baseLevel', 'ItemBaseLevel'], ['maxUpgradeLevel', 'MaxUpgradeLevel'],
        ['displayCharges', 'ItemDisplayCharges'], ['chargeRestoreTime', 'AbilityChargeRestoreTime']]) {
        const value = numericValue(native[input]);
        if (value !== undefined) record[output] = value;
    }
    const initialCharges = numericValue(native.ItemInitialCharges ?? native.AbilityCharges ?? native.InitialAbilityCharges);
    if (initialCharges !== undefined) record.initialCharges = initialCharges;
    if (typeof native.ItemShareability === 'string' && native.ItemShareability) record.shareability = normalizedConstant(native.ItemShareability);
    if (typeof native.ItemDisassembleRule === 'string' && native.ItemDisassembleRule) record.disassembleRule = normalizedConstant(native.ItemDisassembleRule);
    if (native.ItemRecipe === '1') record.recipe = true;
    if (typeof native.ItemResult === 'string') record.recipeResult = native.ItemResult;
    const requirements = recipeRequirements(native);
    if (requirements) record.recipeRequirements = requirements;
    if (typeof native.UpgradeRecipe === 'string') record.upgradeRecipe = native.UpgradeRecipe;
    if (typeof native.UpgradesItems === 'string') record.upgradesItems = native.UpgradesItems.split(';').map(value => value.trim()).filter(Boolean);
    const ability = itemAbility(item, localized);
    if (ability) record.ability = ability;
    return record;
}

/** Create per-item profiles and a compact index from explicit native KeyValues resources. */
export async function createItemCatalog({ readResource, build }) {
    if (typeof readResource !== 'function' || !object(build)
        || ['clientVersion', 'serverVersion', 'sourceRevision'].some(key => !/^[0-9]+$/.test(build[key] ?? ''))) {
        throw new Error('Item generation requires a resource reader and complete build identity.');
    }
    const sourceBytes = new Map();
    for (const resource of ITEM_DATA_RESOURCES) {
        const bytes = Buffer.from(await readResource(resource));
        const parsed = parseNativeResource(bytes, resource);
        sourceBytes.set(resource, { bytes, parsed });
    }

    const definitions = sourceBytes.get('scripts/npc/items.txt').parsed.DOTAAbilities;
    const ids = sourceBytes.get('scripts/npc/npc_ability_ids.txt').parsed.DOTAAbilityIDs?.ItemAbilities?.Locked;
    const tokens = sourceBytes.get('resource/localization/abilities_english.txt').parsed.lang?.Tokens;
    const neutralTiers = neutralTierIndex(sourceBytes.get('scripts/npc/neutral_items.txt').parsed);
    if (!object(definitions) || !object(ids) || !object(tokens)) throw new Error('Required native item or localization table is missing.');
    for (const engineId of neutralTiers.keys()) {
        if (!object(definitions[engineId]) || !DECIMAL_ID.test(ids[engineId] ?? '')) {
            throw new Error(`Neutral item has no native item definition or ID: ${engineId}`);
        }
    }

    const localized = tokenValues(tokens);
    const seenIds = new Set();
    const seenKeys = new Set();
    const sourceManifest = ITEM_DATA_RESOURCES.map(resource => {
        const bytes = sourceBytes.get(resource).bytes;
        return { resource, bytes: bytes.byteLength, sha256: sha256Hex(bytes) };
    });
    const sourceHash = sourceIdentity(build, sourceManifest);
    const items = [];
    for (const [engineId, native] of Object.entries(definitions)) {
        if (!ITEM_KEY.test(engineId) || !object(native)) continue;
        const id = ids[engineId];
        if (!DECIMAL_ID.test(id ?? '') || seenIds.has(id) || seenKeys.has(engineId)) {
            throw new Error(`Missing or duplicate native item identity: ${engineId}`);
        }
        validateNative(native);
        seenIds.add(id); seenKeys.add(engineId);
        const token = suffix => localizedValue(localized, `dota_tooltip_ability_${engineId}${suffix}`);
        const item = { id, key: engineId.slice('item_'.length), engineId,
            name: localizedValue(localized, `dota_tooltip_ability_${engineId}`),
            searchAlias: localizedValue(localized, `dota_searchalias_ability_${engineId}`),
            description: token('_description'), lore: token('_lore'), notes: localizedNotes(localized, engineId),
            neutralTiers: [...(neutralTiers.get(engineId) ?? [])].sort((left, right) => left - right), native };
        items.push(makeItemRecord(item, localized));
    }
    if (!items.length || items.length > MAX_ITEMS) throw new Error('Native item definition count is outside supported bounds.');
    items.sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0);

    const allIds = new Set(seenIds);
    const unmatchedIds = Object.entries(ids).filter(([engineId]) => ITEM_KEY.test(engineId) && !seenKeys.has(engineId))
        .map(([engineId, id]) => {
            if (!DECIMAL_ID.test(id ?? '') || allIds.has(id)) throw new Error(`Invalid unmatched native item identity: ${engineId}`);
            allIds.add(id);
            return { id, engineId };
        }).sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : left.engineId.localeCompare(right.engineId));

    return { schemaVersion: 1, generatorVersion: ITEM_DATA_GENERATOR_VERSION, build: { ...build }, sourceHash,
        sources: sourceManifest, items, unmatchedIds };
}

/** Publish per-item profiles and their index through the guarded canonical writer. */
export async function publishItemCatalog({ dataset, catalog, interruptAt } = {}) {
    const target = path.resolve(dataset ?? fileURLToPath(new URL('../data', import.meta.url)));
    const graph = await readCanonical(target);
    const index = { schemaVersion: 1, generatorVersion: catalog.generatorVersion, build: catalog.build,
        sourceHash: catalog.sourceHash, sources: catalog.sources,
        items: catalog.items.map(item => ({ id: item.id, key: item.key, engineId: item.sourceKey, path: `items/${item.key}/data.json` })),
        unmatchedIds: catalog.unmatchedIds };
    for (const name of [...graph.extras.keys()]) {
        if (/^items\/[^/]+\/data\.json$/.test(name)) graph.extras.delete(name);
    }
    graph.extras.set('items/index.json', jsonBytes(index));
    for (const item of catalog.items) graph.extras.set(`items/${item.key}/data.json`, jsonBytes(item));
    const expectedFiles = [graph.inputManifest, ...graph.metadata.sourceFiles];
    const ownedFiles = ['manifest.json', ...graph.metadata.sourceFiles.map(row => row.name)];
    const result = await publishDataset({ target, replace: true, expectedFiles, ownedFiles,
        build: stage => writeCanonical(stage, graph), validate: validateDataset, interruptAt });
    for (const item of catalog.items) {
        const name = `items/${item.key}/data.json`;
        if (sha256Hex(await fs.readFile(path.join(target, ...name.split('/')))) !== sha256Hex(jsonBytes(item))) {
            throw new Error('Published item profile differs from generated data: ' + item.key);
        }
    }
    return { ...result, itemCount: catalog.items.length, unmatchedIdCount: catalog.unmatchedIds.length, sourceHash: catalog.sourceHash };
}

const help = `Generate per-item profiles and native ability mechanics from installed Dota game files.

npm run items:generate -- [options]
  --game DIR       Dota game directory (otherwise use existing installation discovery)
  --dataset DIR    Canonical data directory; defaults to this package's data/
  --help           Show this help

The command reads item definitions, native item IDs, neutral item tiers, and English localization from the VPK,
then writes items/<item-slug>/data.json records and items/index.json through the guarded canonical writer. It does not use the network.`;

export async function main(argv = process.argv.slice(2)) {
    const { values } = parseArgs({ args: argv, options: { game: { type: 'string' }, dataset: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) { console.log(help); return; }
    const game = resolveGameDirectory(values.game);
    const buildFile = path.join(game, 'dota/steam.inf');
    const buildBytes = await fs.readFile(buildFile);
    const build = readBuild(buildBytes);
    const archive = openVpk(path.join(game, 'dota/pak01_dir.vpk'));
    const catalog = await createItemCatalog({ build, readResource: resource => archive.read(resource) });
    if (!buildBytes.equals(await fs.readFile(buildFile))) throw new Error('Installed build changed during extraction; retry after the game update finishes.');
    const result = await publishItemCatalog({ dataset: values.dataset, catalog });
    process.stdout.write(JSON.stringify({ published: true, build, itemCount: result.itemCount,
        namedItems: catalog.items.filter(item => item.name !== null).length, unmatchedIdCount: result.unmatchedIdCount,
        sourceHash: catalog.sourceHash }, null, 2) + '\n');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

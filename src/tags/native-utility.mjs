/** Classify utility operations from verified native prose and owned numeric declarations. */
function ranks(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return Object.hasOwn(raw, 'value') ? ranks(raw.value) : [];
    if (Array.isArray(raw)) return raw.flatMap(ranks);
    if (typeof raw === 'number') return Number.isFinite(raw) ? [raw] : [];
    if (typeof raw !== 'string') return [];
    const values = raw.trim().split(/\s+/);
    return values.length && values.every(value => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(value))
        ? values.map(value => Number(value.replace(/%$/, ''))) : [];
}

function normalize(text, actorNames) {
    let out = String(text).replace(/<\s*br\s*\/?\s*>/gi, '. ').replace(/<[^>]*>/g, ' ')
        .replace(/\\[nr]|[\r\n]/g, '. ').replace(/’/g, "'").toLowerCase();
    for (const name of [...new Set(actorNames)].filter(name => typeof name === 'string' && name.length).sort((a, b) => b.length - a.length)) {
        const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp('\\b' + escaped + "('s|s)?\\b", 'g'), (_, suffix) => suffix === "'s" ? "caster's" : 'caster');
    }
    return out.replace(/\bdoesn't\b/g, 'does not').replace(/\bcan't\b/g, 'cannot').replace(/\s+/g, ' ').trim();
}

function actionClauses(text) {
    const clauses = [];
    for (let sentence of text.split(/[.!?;](?:\s+|$)/).map(value => value.trim()).filter(Boolean)) {
        const context = sentence;
        if (/^(?:when|whenever|every time|each time|if|while|after|before|once)\b/.test(sentence) && sentence.includes(',')) {
            sentence = sentence.slice(sentence.indexOf(',') + 1).trim();
        }
        sentence = sentence.split(/\b(?:whenever|every time|each time|when|while|after|unless)\b|(?<!as )\bif\b/)[0].trim();
        clauses.push(...sentence.split(/,\s*|\band\s+(?=(?:(?:the )?(?:caster|he|she|allies|enemies|owner)\b)|(?:gain|grant|receiv|earn|refund|copy|repeat|provid)\w*\b)/)
            .map(value => value.trim()).filter(Boolean).map(text => ({ text, context })));
    }
    return clauses;
}

const ownActor = /\b(?:caster|you|your|he|she|himself|herself|owner|allies|allied|friendly|teammates?|your team|our team)\b/;
const enemyActor = /\b(?:enemy|enemies|hostile|opponents?|foes?)\b/;
const actionVerb = /\b(?:gains?|grants?|gives?|receives?|gets?|earns?|synthesizes?|steals?|learns?|copies?|uses?|can|casts?|repeats?|disassembles?|stacks?|retains?|shares?|refunds?|is|are|has|have)\b/;
const negated = /\b(?:cannot|can not|does? not|do not|never|no longer|is not|are not|not allowed to)\s+(?:\w+\s+){0,3}(?:cop(?:y|i)|duplicate|learn|use|cast|repeat|enable|allow|disassemble|gain|receive|earn|get|synthesiz|steal|grant|give|award|refund|provide|yield|retain|share|stack|accumulat|upgrade|choose|select|generate|create|produce|obtain|summon|teleport|recall|transfer|deliver|reduce|lower|behav|interact|treat|count|consider|regard|benefit|see|view|know|faster)\w*\b/;
const explicitFriendlyGrant = /\b(?:grant|give|award|provide)\w*\s+(?:(?:the|an?|all|nearby|target)\s+)*(?:caster|you|owner|ally|allies|allied|friendly|teammates?)\b/;
const explicitFriendlyDestination = /\b(?:to|for)\s+(?:(?:the|an?|all|nearby|target)\s+)*(?:caster|you|owner|ally|allies|allied|friendly|teammates?)\b/;
const explicitPayout = text => explicitFriendlyGrant.test(text)
    || /\b(?:gold|bounty|experience|xp)\b/.test(text) && explicitFriendlyDestination.test(text);

function beneficiary(text, implicitOwn) {
    const operation = text.split(/\b(?:based on|equal to|derived from|in proportion to|according to)\b/)[0];
    if (explicitFriendlyGrant.test(operation) || explicitFriendlyDestination.test(operation)) return true;
    if (/\b(?:grant|give|award|provide)\w*\b.{0,40}\b(?:to )?(?:enemy|enemies|opponents?)\b/.test(text)) return false;
    const predicate = actionVerb.exec(text);
    const head = predicate ? text.slice(0, predicate.index) : text;
    if (enemyActor.test(head) && !ownActor.test(head)) return false;
    if (ownActor.test(head)) return true;
    if (/\b(?:enemy|enemies|opponents?)\s+(?:will )?(?:receive|gain|earn|get|use|see)\b/.test(text)) return false;
    return implicitOwn;
}

/** Return capability tags only; the caller verifies source, build and localization binding. */
export function inferUtilityTags({ fields = new Map(), snippets = [], actorNames = [], behavior = new Set(), nativeTeams = [] } = {}) {
    const tags = new Set();
    const entries = [...fields].map(([field, raw]) => [field.toLowerCase(), raw]);
    const byName = new Map(entries);
    const positive = pattern => entries.some(([field, raw]) => pattern.test(field) && ranks(raw).some(value => value > 0));
    const enabled = pattern => !entries.some(([field]) => pattern.test(field)) || positive(pattern);
    const payload = (text, pattern) => {
        const references = [...text.matchAll(/%([a-z][a-z0-9_]*)%/g)].map(match => match[1]).filter(field => pattern.test(field));
        return references.length ? references.some(field => ranks(byName.get(field)).some(value => value > 0)) : positive(pattern);
    };
    if (byName.has('maxlevel') && ranks(byName.get('maxlevel')).every(value => value === 0) && ranks(byName.get('maxlevel')).length) return tags;
    const implicitOwn = behavior.has('DOTA_ABILITY_BEHAVIOR_PASSIVE') || behavior.has('DOTA_ABILITY_BEHAVIOR_NO_TARGET')
        || nativeTeams.some(team => ['self', 'ally'].includes(team));
    const gold = /^(?!.*(?:cost|range|radius|interval|duration|time))(?=.*(?:gold|bounty_multiplier)).+$/;
    const experience = /^(?!.*(?:range|radius|interval|duration|time))(?=.*(?:\bxp\b|(?:^|_)xp(?:_|$)|experience)).+$/;

    for (const snippet of snippets) {
        if (snippet.suffix && !/^(?:description|note\d+|(?:scepter|shard)_description|facet_.+)$/i.test(snippet.suffix)) continue;
        const text = normalize(snippet.text, actorNames);
        if (/\b(?:temporarily disabled|currently disabled|removed from the game)\b/.test(text)) continue;
        const learnedSpell = /\b(?:stolen|copied|learned)\s+(?:spells?|abilit)|\b(?:enemy|enemies|hero)\b.{0,90}\b(?:last )?spells?\b/.test(text);
        const sentences = text.split(/[.!?;](?:\s+|$)/);
        for (const { text: clause, context } of actionClauses(text)) {
            if (negated.test(clause) || !beneficiary(clause, implicitOwn)) continue;
            const output = clause.split(/\b(?:based on|equal to|derived from|in proportion to|according to)\b/)[0];
            const payout = !/\b(?:grant|give|award|provide)\w*\b/.test(clause) || explicitPayout(context.split(/\b(?:based on|equal to|derived from|in proportion to|according to)\b/)[0]);

            if ((/\b(?:cop(?:y|i)\w*|steal\w*|learn\w*)\b.{0,70}\b(?:spells?|abilities|ability)\b/.test(clause)
                || learnedSpell && /\b(?:can )?use\b.{0,40}\bspell\b.{0,25}\bas (?:his|her|their|its|the caster's|your|an?)?\s*own\b/.test(clause))
                && enabled(/(?:ability|spell)_copy|can_copy/)) tags.add('ability_copy');

            if (/\b(?:spells?|abilities|ability|items?)\b/.test(clause)
                && /\b(?:multiple times|several times|twice|multicast|repeat\w*)\b/.test(clause)
                && /\b(?:cast|use|enable|repeat|multicast)\w*\b/.test(clause)
                && payload(clause, /multicast|repeat|(?:cast|use)_count|(?:cast|repeat).*times/)) tags.add('ability_repetition');

            if (/\b(?:ability|abilities|talent|talents|skill)\b.{0,35}\b(?:level requirements?|points?)\b|\b(?:ability|skill) points?\b/.test(clause)
                && /\b(?:reduc\w*|lower\w*|refund\w*|gain\w*|receiv\w*|bonus|additional|extra)\b/.test(clause)
                && !/\b(?:per|based on|from|for each)\b.{0,30}\b(?:ability|skill) points?\b/.test(clause)
                && payload(clause, /required_level|levels_between_upgrades|(?:ability|skill)_(?:points?|level)|point_count|bonus_points/)) tags.add('skill_progression');

            const meleeInteraction = /\branged attacks?\b.{0,70}\b(?:behav\w*|interact\w*|treat\w*|count\w*|benefit\w*)\b.{0,55}\bmelee attacks?\b/.test(clause)
                || /\b(?:considered|treated|regarded|counts? as|is|are)\b.{0,20}\bboth\s+(?:a )?ranged\b.{0,15}\band\s+(?:a )?melee attackers?\b/.test(clause);
            if (meleeInteraction && !/\b(?:not|never|cannot|no longer)\b.{0,25}\b(?:considered|treated|regarded|counts?|both|ranged)\b/.test(clause)
                && !/\b(?:makes?|renders?|grants?|treats?)\b.{0,25}\b(?:enemy|enemies)\b/.test(clause)) tags.add('melee_attack_interaction');

            if (/\bdisassembl\w*\b.{0,35}\bitems?\b/.test(clause) && enabled(/(?:item_)?disassembly|can_disassemble/)) tags.add('item_disassembly');
            if ((/\b(?:receiv\w*|creat\w*|gain\w*|provid\w*|give\w*|get\w*)\b.{0,50}\bcopy\b.{0,30}\b(?:neutral )?items?\b/.test(clause)
                || /\b(?:cop(?:y|i)\w*|duplicate\w*)\b.{0,35}\bitems?\b/.test(clause)) && enabled(/item_copy|can_copy_items/)) tags.add('item_copy');
            const extraChoice = /\b(?:extra|additional|bonus) choice\b.{0,35}\b(?:neutral )?items?\b/.test(clause);
            const itemOptions = /\b(?:chooses?|choosing|selects?|selecting)\b.{0,65}\b(?:items?|item options?)\b/.test(clause)
                || /\bchoose from\b.{0,90}\boptions?\b/.test(clause) && sentences.some(sentence => /^\s*the items\b/.test(sentence));
            if (!/\b(?:no|without)\s+(?:extra|additional|bonus) choice\b/.test(clause)
                && (extraChoice && payload(clause, /bonus_choice|item_choice/) || itemOptions && enabled(/item_choice/))) tags.add('item_choice');
            if (/\ball\b.{0,45}\bcan use\b.{0,40}\bitems?\b|\bshares? items\b|\b(?:items?)\b.{0,25}\bshared\b/.test(clause)
                && !/\b(?:share|shared) cooldown\b/.test(clause) && enabled(/item_sharing|share_items/)) tags.add('item_sharing');
            const enchantmentUpgrade = /\b(?:enchantments?|items?)\b/.test(clause) && /\b(?:stack\w*|retain\w*|accumulat\w*|upgrad\w*)\b/.test(clause);
            const grantUpgrade = /\b(?:melts? down|consum\w*|convert\w*)\b.{0,80}\bgrant\w*\b.{0,75}\bupgrades?\b/.test(clause);
            const strongerBonuses = /\bitems?\b.{0,30}\b(?:passive )?bonuses\b.{0,35}\b(?:more powerful|stronger|increas\w*)\b/.test(clause)
                && payload(clause, /bonus_stat_percent|item.*(?:amp|bonus)|(?:amp|bonus).*item/);
            if ((enchantmentUpgrade || grantUpgrade) && enabled(/item_upgrade|enchant/) || strongerBonuses) tags.add('item_upgrade');

            if (/\bcouriers?\b/.test(clause)) {
                const operation = /\b(?:summon\w*|teleport\w*|recall\w*|transfer\w*|deliver\w*)\b/.test(clause);
                const numericBenefit = /\b(?:grant\w*|gain\w*|bonus|increas\w*|faster)\b/.test(clause)
                    && /\b(?:speed|moves?|movement|levels?|health|hp)\b/.test(clause)
                    && payload(clause, /courier.*(?:speed|level|hp|health)|bonus_(?:speed|levels?|hp|health)(?:_tooltip)?/);
                if (operation || numericBenefit) tags.add('courier_utility');
            }

            if (/\b(?:receiv\w*|grant\w*|creat\w*|generat\w*|gain\w*|produc\w*|obtain\w*)\b/.test(clause)
                && /\b(?:single-use|one-use|consumables?)\b/.test(clause)
                && !/\b(?:not|non-)\s*(?:single-use|one-use|consumables?)\b/.test(clause)
                && enabled(/consumable.*(?:count|number)|souvenir.*(?:count|number)/)) tags.add('consumable_generation');

            if ((/\b(?:gold|bounty)\b/.test(output) && /\b(?:earn\w*|receiv\w*|gain\w*|get\w*|synthesiz\w*|steal\w*|grant\w*|give\w*|award\w*|yield\w*|refund\w*|retain\w*)\b/.test(clause)
                || /\brefund\w*\b/.test(clause) && /\bgold\b/.test(context))
                && !/\b(?:spend\w*|pay\w*|costs?|loses?|lost)\b/.test(clause.replace(/\bgold lost from death\b/g, 'gold'))
                && !/\b(?:no|without)\s+(?:(?:extra|additional|bonus)\s+)?(?:gold|bounty)\b/.test(clause)
                && payout && payload(clause, gold)) tags.add('economy_gain');
            if (/\b(?:experience|xp)\b/.test(output) && /\b(?:gain\w*|receiv\w*|get\w*|grant\w*|give\w*|award\w*|earn\w*)\b/.test(clause)
                && !/\b(?:no|without)\s+(?:(?:extra|additional|bonus)\s+)?(?:experience|xp)\b/.test(clause)
                && payout && payload(clause, experience)) tags.add('experience_gain');
            if (/\b(?:can see|allows? .{0,25} to see|reveal\w*|view|know)\b.{0,65}\b(?:objectives?|boss|roshan|tormentor)\b.{0,35}\b(?:respawn|spawn|timer|time)\b/.test(clause)) tags.add('objective_information');
        }
    }
    return tags;
}

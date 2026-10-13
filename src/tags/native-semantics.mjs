/**
 * Classify source-bound native declarations. Callers own source/build verification.
 * Rules describe action, recipient and numeric payload families, never identities.
 */
const numericOperand = /^(?:value|hero_levelup)$/i;

function numbers(value) {
    if (Array.isArray(value)) return value.flatMap(numbers);
    if (value && typeof value === 'object') return Object.entries(value)
        .filter(([key]) => numericOperand.test(key)).flatMap(([, child]) => numbers(child));
    if (typeof value === 'number') return Number.isFinite(value) ? [value] : [];
    if (typeof value !== 'string') return [];
    const tokens = value.trim().split(/\s+/);
    return tokens.filter(token => /^[+=-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(token))
        .map(token => Number(token.replace(/^[+=]/, '').replace(/%$/, ''))).filter(Number.isFinite);
}

function normalize(text, actorNames) {
    let out = String(text).replace(/<\s*br\s*\/?\s*>/gi, '. ').replace(/<[^>]*>/g, ' ').replace(/\\[nr]|[\r\n]/g, '. ')
        .replace(/[’]/g, "'").toLowerCase()
        .replace(/\bdoesn't\b/g, 'does not').replace(/\bdon't\b/g, 'do not')
        .replace(/\bisn't\b/g, 'is not').replace(/\baren't\b/g, 'are not');
    for (const name of [...actorNames].filter(Boolean).sort((a, b) => b.length - a.length)) {
        const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp('\\b' + escaped + '\\b', 'g'), 'caster');
        // Tooltips sometimes use only the first word of the owning actor's
        // localized name. Accept it only as an explicit grammatical subject.
        const first = name.toLowerCase().split(/\s+/)[0];
        if (name.includes(' ') && first.length >= 3) {
            const subjectName = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            out = out.replace(new RegExp('\\b' + subjectName + '(?=\\s+(?:(?:and (?:his|her|their) (?:ranged )?allies)\\s+)?(?:gain\\w*|receiv\\w*|creat\\w*|has|have|is|are|deal\\w*)\\b)', 'g'), 'caster');
        }
    }
    return out.replace(/\battack and movement speeds?\b/g, 'attack speed and movement speed')
        .replace(/\bmovement and attack speeds?\b/g, 'movement speed and attack speed')
        .replace(/\battack speed and damage\b/g, 'attack speed and attack damage')
        .replace(/\bslowing their attacks\b/g, 'slowing their attack speed')
        .replace(/\s+/g, ' ').trim();
}

const recipientMarkers = [
    ['controlled', /\b(?:summon(?:ed|s)?|creatures?|illusions?|reflections?|controlled units?|units (?:he|she|it|the caster) controls)\b/],
    ['ally', /\b(?:all(?:y|ies|ied)|friendly|teammates?)\b/],
    ['enemy', /\b(?:enem(?:y|ies)|hostile|victims?|foes?)\b/],
    ['self', /\b(?:caster|you|your|yourself|himself|herself|itself|he|she)\b/],
];

function recipients(text, inherited, nativeTeams, controlledActor) {
    if (/^(?:gain|increas|grant|giv|provid|receiv)\w*\s+(?:his|her|its|their|your)\b(?!\s+(?:all(?:y|ies|ied)|friendly|teammates?)\b)/.test(text)) return inherited.length ? inherited : nativeTeams;
    const subjectPredicate = /\b(?:gains?|gets?|receives?|regenerates?|earns?|synthesizes?|steals?|consumes?|becomes?|recedes?|has|have|is|are|deals?|attacks?|takes?|restores?|moves?|hides?)\b/.exec(text);
    // In "creatures gain X% of the caster's damage", the caster is a
    // formula input; the recipient is the grammatical subject before "gain".
    if (subjectPredicate?.index > 0) {
        const head = text.slice(0, subjectPredicate.index);
        const explicitHead = controlledActor?.test(head) || recipientMarkers.some(([, pattern]) => pattern.test(head));
        if (explicitHead) text = head;
    }
    const hits = [];
    if (controlledActor) for (const match of text.matchAll(new RegExp(controlledActor.source, 'g'))) hits.push({ team: 'controlled', index: match.index });
    for (const [team, pattern] of recipientMarkers) {
        for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) hits.push({ team, index: match.index });
    }
    if (hits.length) {
        hits.sort((a, b) => a.index - b.index);
        const latestHit = hits.at(-1);
        const precedingBeneficiary = hits.slice(0, -1).reverse().find(hit => hit.team !== 'self');
        const spatialReference = precedingBeneficiary && text.slice(precedingBeneficiary.index, latestHit.index);
        if (latestHit.team === 'self' && precedingBeneficiary
            && /\b(?:near|nearby|around|within|beside|alongside|close to|in range of|within range of|surrounding)\b/.test(spatialReference)
            && !/\b(?:and|or)\b/.test(spatialReference)) {
            hits.splice(hits.indexOf(latestHit), 1);
        }
        // Explicit coordinated beneficiaries retain both recipients; a later
        // subject in another predicate must not change an earlier operation.
        const latest = hits.at(-1);
        const prior = hits.at(-2);
        if (prior && /\b(?:and|or)\b/.test(text.slice(prior.index, latest.index))
            && !/\b(?:gain|deal|grant|take|attack|become|reduce|burn|restore|steal|inflict)\w*\b/.test(text.slice(prior.index, latest.index))) {
            return [...new Set([prior.team, latest.team])];
        }
        return [latest.team];
    }
    if (/\b(?:target|unit|them|their|it|its)\b/.test(text)) return inherited.length ? inherited : nativeTeams;
    return inherited.length ? inherited : nativeTeams;
}

/** Separate action clauses from prerequisites that merely mention another state. */
function clauses(text) {
    const out = [];
    for (let sentence of text.split(/[.!?;]+\s*/).filter(Boolean)) {
        if (/\b(?:is|are|will be)\s+(?:interrupt\w*|cancel\w*)\s+(?:if|when|unless)\b/.test(sentence)) continue;
        // A trigger is not an action granted by the ability: "Whenever the
        // caster disjoints an attack, it restores health" grants restoration.
        if (/^(?:whenever|when|if|once|after|before|as long as)\b/.test(sentence) && sentence.includes(',')) {
            sentence = sentence.slice(sentence.indexOf(',') + 1).trim();
        }
        if (/^(?:when|whenever|if)\b/.test(sentence) && !sentence.includes(',') && /\bdies?\b/.test(sentence)) {
            const revival = /\b(?:he|she|it|the caster|caster|you)\s+(?:will\s+)?(?:instantly\s+)?(?:respawn\w*|reviv\w*|reincarnat\w*)\b/.exec(sentence);
            if (revival) sentence = sentence.slice(revival.index);
        }
        if (/^(?:when|whenever|if|once|after)\b/.test(sentence) && !sentence.includes(',')) {
            const consequent = [...sentence.matchAll(/\b(?:it|he|she|they|the caster|caster|you)\s+(?:(?:will|also)\s+)?(?:instantly\s+)?(?:burst|explod|deal|restor|gain|receiv|becom|return|appl)\w*\b/g)]
                .find(match => /\b(?:is|are|was|were|drops?|dies?|takes?|gains?|casts?|creates?|hits?|attacks?|becomes?|goes?|reaches?)\b/.test(sentence.slice(0, match.index)));
            if (consequent) sentence = sentence.slice(consequent.index);
        }
        if (/^(?:additionally\s+)?every time\b/.test(sentence) && !sentence.includes(',')) {
            const consequent = /\b(?:he|she|it|the caster|caster|you)\s+also\s+(?:gain|receiv|restor|spawn)\w*\b/.exec(sentence);
            if (consequent) sentence = sentence.slice(consequent.index);
        }
        // Trailing triggers constrain the preceding grant. The enemy in
        // "gains speed each time the caster hits an enemy" is not its recipient.
        sentence = sentence.replace(/\b(?:each time|every time|whenever|when|if|unless|as long as)\b[^,]*/g, '').trim();
        // Keep conditional actions ("while he gains armor") but discard state
        // prerequisites ("while she is already invulnerable").
        sentence = sentence.replace(/\b(?:while|when|if|whenever|unless|until)\s+(?:(?:the )?caster|he|she|it|you|they|the target|the unit)\s+(?:is|are|was|were|remains?|has|have)\b[^,]*/g, '');
        const parts = sentence.split(/,\s*|\bwhile\s+(?=(?:he|she|it|the caster)\s+(?:gain|receive|restore|become|take|deal)\w*)|\b(?:and|but)\s+(?=(?:(?:the )?(?:caster|allies|enemies|enemy|friendly|target|he|she|it|they)\b)|(?:deal|grant|give|gain|provid|increas|reduc|silenc|stun|root|disarm|mute|heal|restor|burn|drain|knock|apply|becom|prevent|reflect|reveal|teleport|creat|summon|spawn)\w*\b)/);
        let assertedSubject;
        let positiveContinuationStats = new Set();
        let positiveContinuation = false;
        for (let part of parts.map(part => part.trim()).filter(Boolean)) {
            const copula = /^(.+?\b(?:is|are|becomes?))\s+/.exec(part);
            if (copula) assertedSubject = copula[1];
            else if (assertedSubject && /^(?:and\s+)?(?:invisible|invulnerable|untargetable|hidden|stationary|silenced|muted|disarmed)\b/.test(part)) {
                part = assertedSubject + ' ' + part.replace(/^and\s+/, '');
            }
            if (/\b(?:gain\w*|grant\w*|giv\w*|provid\w*|receiv\w*|increas\w*|has|have)\b/.test(part)) {
                positiveContinuationStats = new Set([...part.matchAll(/\b(attack speed|attack damage|movement speed|move speed|spell amplification|magic(?:al)? resistance|slow resistance|status resistance|armor|health|hp|mana|evasion|lifesteal)\b/g)]
                    .map(([, stat]) => stat));
                positiveContinuation = true;
            } else {
                const continuation = /^(?:and\s+)?(?:(?:%[^%]+%|\d+(?:\.\d+)?)(?:%)*\s+)?(?:(?:bonus|hasted|additional|increased)\s+)?(armor|health|hp|mana|evasion|lifesteal|attack speed|attack damage|movement speed|move speed|spell amplification|magic(?:al)? resistance|slow resistance|status resistance)\b/.exec(part);
                if (positiveContinuation && continuation && (!positiveContinuationStats.size || !positiveContinuationStats.has(continuation[1]))) {
                    part = 'gains ' + part.replace(/^and\s+/, '');
                    positiveContinuationStats.add(continuation[1]);
                } else {
                    positiveContinuationStats.clear();
                    positiveContinuation = false;
                }
            }
            out.push(part);
        }
    }
    return out;
}

const positiveVerb = /\b(?:gain\w*|gets?|grant\w*|giv\w*|provid\w*|increas\w*|improv\w*|receiv\w*|amplif\w*|restor\w*|regenerat\w*|has|have|bonus|additional|more|heal\w*)\b/;
const negativeVerb = /\b(?:reduc\w*|decreas\w*|lower\w*|slow\w*|drain\w*|steal\w*|less|loss|lost|penalt\w*|prevent\w*)\b/;
const negated = /\b(?:does? not|do not|cannot|can't|never|no longer)\s+(?:\w+\s+){0,2}(?:gain|grant|give|provide|increase|become|disjoint|heal|restore|summon|stun|silence|root|reflect|reveal|teleport)\w*\b/;

function effectTeams(effect) {
    const teams = effect.targets?.teams;
    return teams?.state === 'known' && Array.isArray(teams.value) ? teams.value : [];
}

/** Return plain vocabulary keys inferred from verified native fields and prose. */
export function inferNativeTags({ fields = new Map(), snippets = [], fieldLabels = [], abilityLabel, effects = [], behavior = new Set(), nativeTeams = [], actorNames = [] } = {}) {
    const tags = new Set();
    const entries = [...fields.entries()];
    const fieldsByName = new Map(entries.map(([field, raw]) => [field.toLowerCase(), raw]));
    const has = pattern => entries.some(([field, raw]) => pattern.test(field) && numbers(raw).some(number => number !== 0));
    const positive = pattern => entries.some(([field, raw]) => pattern.test(field) && numbers(raw).some(number => number > 0));
    const duration = () => positive(/duration|time|delay|interval|AbilityChannelTime/i);
    const payload = pattern => has(pattern);
    const payloadFor = (text, pattern) => {
        const referenced = [...text.matchAll(/%([a-z][a-z0-9_]*)%/g)].map(match => match[1]).filter(field => pattern.test(field));
        return referenced.length ? referenced.some(field => numbers(fieldsByName.get(field)).some(number => number !== 0)) : payload(pattern);
    };
    const statPayloadFor = (text, family) => {
        const excluded = family === 'armor' ? /reduc|loss|cost|penalt|debuff/i
            : family === 'attack_speed' ? /reduc|slow|loss|cost|penalt|debuff/i : null;
        const eligible = field => fieldFamilies[family].test(field) && !excluded?.test(field);
        const referenced = [...text.matchAll(/%([a-z][a-z0-9_]*)%/g)].map(match => match[1]).filter(eligible);
        return referenced.length
            ? referenced.some(field => numbers(fieldsByName.get(field)).some(number => number !== 0))
            : entries.some(([field, raw]) => eligible(field) && numbers(raw).some(number => number !== 0));
    };
    const referencedPayload = text => [...text.matchAll(/%([a-z][a-z0-9_]*)%/g)]
        .some(match => numbers(fieldsByName.get(match[1])).some(number => number !== 0));
    const qualitativeEnabled = pattern => {
        const relevant = entries.filter(([field]) => pattern.test(field));
        return !relevant.length || relevant.some(([, raw]) => numbers(raw).some(number => number !== 0));
    };
    const positiveLabeled = phrase => fieldLabels.some(label => typeof label.field === 'string' && typeof label.text === 'string'
        && numbers(fieldsByName.get(label.field.toLowerCase())).some(number => number > 0)
        && phrase.test(normalize(label.text, actorNames).replace(/[%:]/g, '').trim()));
    const quantifiedProperty = (text, phrase) => {
        const match = phrase.exec(text);
        if (!match) return false;
        const left = text.slice(0, match.index).match(/(%[a-z][a-z0-9_]*%|\d+(?:\.\d+)?)(?:%)*\s+(?:(?:bonus|additional|extra|stacking)\s+)?$/);
        const right = text.slice(match.index + match[0].length).match(/^\s+(?:by|of|is|at a rate of)\s+(%[a-z][a-z0-9_]*%|\d+(?:\.\d+)?)/);
        const token = left?.[1] ?? right?.[1];
        if (!token) return false;
        return token.startsWith('%') ? numbers(fieldsByName.get(token.slice(1, -1))).some(number => number > 0) : Number(token) > 0;
    };
    const add = (...keys) => keys.flat().filter(Boolean).forEach(key => tags.add(key));
    const buff = (...keys) => add('buff', ...keys);
    const friendly = teams => teams.some(team => team === 'self' || team === 'ally');
    const beneficiary = (teams, selfTag, allyTag, extra = []) => {
        if (!friendly(teams)) return;
        buff(extra, teams.includes('self') ? selfTag : null, teams.includes('ally') ? allyTag : null);
    };
    const knownRecipients = [...new Set(effects.flatMap(effectTeams))];
    const defaultTeams = nativeTeams.length ? nativeTeams : knownRecipients;
    const defaultSelf = behavior.has('DOTA_ABILITY_BEHAVIOR_NO_TARGET') || behavior.has('DOTA_ABILITY_BEHAVIOR_PASSIVE');
    let directDamage = false;
    let hostilePayload = false;
    let friendlyAvoidance = false;
    let globalDeliveryClaim = false;

    const texts = snippets.map(snippet => normalize(snippet.text, actorNames));
    const currentAbilityName = typeof abilityLabel === 'string' ? normalize(abilityLabel, []) : '';
    const controlledCausalRecipient = text => {
        const match = /\b(?:caus\w*|allow\w*|enabl\w*)\s+(.+?)\s+to\s+(?:deal|gain|receiv|attack)\w*\b/.exec(text);
        return match && /\b(?:neutral creeps?|controlled (?:creatures?|units?|creeps?)|(?:any )?units? under (?:his|her|its|your|(?:the )?caster'?s?) control)\b/.test(match[1]);
    };
    // Unit names are learned from the declaration's grammar, rather than a
    // game-unit or hero whitelist. Ownership declarations can appear later
    // than a stat sentence, so collect them before classifying operations.
    const controlledNames = new Set();
    const createdNames = new Set();
    const creationVerb = '(?:summons?|summoning|creates?|creating|calls? forth|brings? forth|forms|forming|forges?|forging|spawns?|spawning|raises?|raising)';
    const admitCreatedWords = phrase => {
        for (const word of phrase.split(/\s+/).filter(word => /^[a-z][a-z-]*$/.test(word))) {
            if (!['a', 'an', 'the', 'and', 'or', 'another', 'additional', 'extra', 'caster', 'his', 'her', 'its', 'their', 'your', 'own'].includes(word)) createdNames.add(word);
        }
    };
    for (const text of texts) {
        const creationObject = new RegExp('\\b' + creationVerb + '\\s+(?:(?:a (?:reduced number|number|group|pair) of|as many|as few|a|an|the|one|two|three|four|five|six|several|\\d+|%[^%]+%)\\s+)?([a-z][a-z -]*?)(?=\\s+(?:to|of|from|that|which|at|with|for|upon|based|according|around|beneath|near|beside|under|in|as)\\b|[.,;!]|$)', 'g');
        for (const match of text.matchAll(creationObject)) admitCreatedWords(match[1].trim());
        for (const match of text.matchAll(/\bconvert\w*\b[^.!]{0,60}\b(?:trees?|terrain|rocks?|objects?)\b\s+into\s+([a-z][a-z -]*?)\s+under (?:the )?command\b/g)) admitCreatedWords(match[1].trim());
        for (const match of text.matchAll(/\b(?:a|an|an additional|an extra)\s+([a-z][a-z -]*?)\s+(?:will\s+)?spawn\b/g)) admitCreatedWords(match[1].trim());
        for (const match of text.matchAll(/\b(?:a|an|the)\s+([a-z][a-z -]*?)\s+(?:is|are|will be)\s+(?:summoned|spawned|created)\b/g)) admitCreatedWords(match[1].trim());
        for (const match of text.matchAll(new RegExp('\\b' + creationVerb + '\\s+%([a-z][a-z0-9_]*)_(?:count|number|amount)%', 'g'))) admitCreatedWords(match[1]);
    }
    const nonCreatureCreation = [...createdNames].some(name => /^(?:walls?|barriers?|shields?|shells?|hills?|arenas?|coils?|terrain|trees?|particles?|projectiles?|missiles?|waves?|explosives?|traps?|vehicles?|staffs?|staves|weapons?|swords?|blades?|armor)$/.test(name));
    const livingLiteralCreation = [...createdNames].some(name => texts.some(text =>
        new RegExp('\\bonly (?:one|[1-9]\\d*) ' + name + 's? can exist\\b').test(text)
        && new RegExp('\\b' + name + 's? (?:dies?|takes? damage|attacks?)\\b').test(text)));
    const namedCountPayload = [...createdNames].some(name => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return positive(new RegExp('(?:^|_)(?:' + escaped + 's?_(?:count|number|amount)|(?:count|number|amount)_' + escaped + 's?)(?:_|$)', 'i'));
    });
    const summonPayload = !nonCreatureCreation && (namedCountPayload
        || positive(/(?:^|_)(?:summon|spawn|unit|creature|illusion|clone|pet)s?_(?:count|number|amount)(?:_|$)|(?:^|_)(?:count|number|amount)_(?:summons?|spawns?|units?|creatures?|illusions?|clones?|pets?)(?:_|$)|summon.*duration|spawn_interval|tooltip_clones|_spawns?$|_created$/i)
        || [...createdNames].some(name => [name, ...(name.endsWith('s') ? [name.slice(0, -1)] : [])]
            .some(noun => positive(new RegExp('(?:^|_)' + noun + '_duration|duration_' + noun + '(?:_|$)|^max_' + noun + 's?$', 'i'))))
        || createdNames.size > 0 && (positive(/(?:^|_)(?:hp|health|max_health|base_max_health)$/i)
            || positiveLabeled(/^(?:(?:unit|creature|summon) )?lifetime$/) || livingLiteralCreation));
    for (const text of texts) {
        if (summonPayload) for (const name of createdNames) controlledNames.add(name);
        for (const match of text.matchAll(/\b(?:the|these|those)\s+([a-z][a-z-]*)\s+(?:are|is)\s+(?:all\s+)?(?:under\s+(?:the\s+)?caster's control|controlled by\s+(?:the\s+)?caster)/g)) controlledNames.add(match[1]);
        for (const match of text.matchAll(/\borders?\s+(?:the\s+|an?\s+)?([a-z][a-z -]*?)(?=\s+(?:closest|nearest|to|at|within)\b)/g)) {
            if (!/\b(?:all(?:y|ies|ied)|enemy|enemies|friendly|hero|caster)\b/.test(match[1])) {
                for (const word of match[1].trim().split(/\s+/)) controlledNames.add(word);
            }
        }
    }
    const controlledActor = controlledNames.size ? new RegExp('\\b(?:' + [...controlledNames].map(name => name.endsWith('s') ? name + '|' + name.slice(0, -1) : name + 's?').join('|') + ')\\b') : null;

    const fieldFamilies = {
        armor: /^(?!.*(?:reduc|loss|cost|penalt|debuff)).*armor/i,
        attack_speed: /^(?!.*(?:reduc|slow|loss|cost|penalt|debuff)).*(?:attack_speed|attackspeed|aspd|atkspd|(?:^|_)as_bonus)(?:_|$)/i,
        movement_speed: /move.?speed|movement.?speed|(^|_)ms(_|$)|_per_speed$|^current_speed$|^(?:bonus_speed|speed_bonus)$/i,
        attack_damage: /(?:^|_)(?:attack_bonus|attack_damage(?:_bonus)?|base_attack(?:_damage)?|bonus_attack_damage|damage_bonus|bonus_damage|reward|crit(?:ical)?(?:_damage)?|damage_amp)(?:_|$)|^health_as_damage_pct$|^damage_per_(?:attack|hit)$/i,
        attack_range: /attack_range|range_bonus/i,
        health_regen: /(?:hp|health).*regen|bonus_regen|heal_per_second/i,
        mana_regen: /mana.*regen|(?:mp|mana)_per_kill/i,
        healing_amplification: /heal.*(?:amp|amplif)|(?:amp|amplif).*heal/i,
        heal: /heal|health_restore|hp_restore|health_per_second|regen/i,
        mana_restore: /mana_(?:restore|steal|drain|per_second|pct_per_hit)|mana_and_health_restore|mana_gain|mana_restore/i,
        damage: /damage|(^|_)dps($|_)|(^|_)dmg(?:_|$)|^explosion$/i,
    };
    const directDamagePayload = () => entries.some(([field, raw]) => fieldFamilies.damage.test(field)
        && !/reflect|recoil|negat|reduc|absorb|barrier|block|shield|incoming|damage_per_mana|threshold|delay|interval|duration|grace/i.test(field)
        && numbers(raw).some(number => number !== 0));
    const directHealingPayload = () => entries.some(([field, raw]) => /(?:^|_)(?:heal(?:ing)?|health_restore|hp_restore|health_per_second)(?:_|$)/i.test(field)
        && !/regen|amplif|heal.*amp|reduc|restore.*speed|duration|interval|threshold/i.test(field)
        && numbers(raw).some(number => number > 0));
    const healthStealPayload = () => positive(/(?:health|hp)_(?:steal|leech)|(?:steal|leech)_(?:health|hp)/i)
        || positiveLabeled(/^(?:health|hp) steal(?: \([a-z -]+\))?$/);
    const copyNames = [...new Set(actorNames.filter(name => typeof name === 'string' && name.length > 0)
        .map(name => name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's'))];
    const copyHealing = new RegExp('\\bheals?\\b.{0,30}\\ball other (?:copies|clones' + (copyNames.length ? '|' + copyNames.join('|') : '') + ')\\b');
    const sourceCopyHealing = texts.some(text => copyHealing.test(text));
    const derivedHealingPayload = text => {
        const healAction = /\bheal(?:s|ing)?\b(?!\s+amplif\w*)/.test(text) && !negated.test(text);
        if (!healAction) return false;
        const sameDamageAmount = /\bheal(?:s|ing)?\b.{0,30}\bfor (?:the )?(?:total|same) amount\b/.test(text) && directDamagePayload();
        const sharedDamageHeal = positiveLabeled(/^(?:damage\s*\/\s*heal|heal\s*\/\s*damage|damage and heal)(?: per second)?$/);
        const consumedHealth = /\bconsum\w*\b.{0,100}\bheal(?:s|ing)?\b/.test(text)
            && positive(/^(?:health|hp)_gain(?:_|$)/i) && positiveLabeled(/^bonus (?:health|hp)$/);
        return sameDamageAmount || sharedDamageHeal || consumedHealth;
    };
    const derivedDamagePayload = text => {
        const manaFormula = /\bdamage\b/.test(text) && /\bmana\b/.test(text) && /\b(?:missing|drained|burned)\b/.test(text)
            && positive(/(?:^|_)damage_per_mana(?:_|$)/i);
        const absorptionFormula = /\bdamage (?:equal to|equals|based on)\b.{0,55}\babsor\w*\b|\babsorbed damage (?:is|was|will be) dealt\b/.test(text)
            && positive(/^(?:damage_absorb|absorbed_damage|barrier_(?:amount|health|capacity)|shield_(?:amount|health|hp)|absorb_to_damage)(?:_|$)/i);
        return manaFormula || absorptionFormula;
    };
    const attackBonusPayload = text => {
        const referenced = [...text.matchAll(/%([a-z][a-z0-9_]*)%/g)].map(match => match[1])
            .filter(field => fieldFamilies.attack_damage.test(field));
        const eligible = field => fieldFamilies.attack_damage.test(field) && !/reduc|loss|cost|penalt|threshold|duration|delay|interval/i.test(field);
        return referenced.length ? referenced.some(field => eligible(field) && numbers(fieldsByName.get(field)).some(number => number > 0))
            : entries.some(([field, raw]) => eligible(field) && numbers(raw).some(number => number > 0));
    };
    const enemyHealthDamageFormula = fieldLabels.some(label => typeof label.field === 'string' && typeof label.text === 'string'
        && numbers(fieldsByName.get(label.field.toLowerCase())).some(number => number > 0)
        && /\b(?:enemy|target|victim)\b.{0,30}\b(?:max(?:imum)?|current|missing)\s+(?:health|hp)\b.{0,25}\b(?:as )?damage\b/.test(normalize(label.text, actorNames)));
    const sourceAttackModifier = texts.some(text => text.split(/[.!?;]+/).some(sentence =>
        (behavior.has('DOTA_ABILITY_BEHAVIOR_ATTACK') || /\bbasic attacks?\b/.test(sentence))
        && /\b(?:enchant\w*|imbu\w*|modif\w*|augment\w*|empower\w*|enhanc\w*)\b.{0,55}\b(?:(?:each|every|next|basic) )?attacks?\b/.test(sentence)
        && /\b(?:deal|caus|inflict)\w*\b.{0,70}\bdamage\b/.test(sentence)
        && !controlledCausalRecipient(sentence) && !negated.test(sentence)
        && !/\b(?:does? not|do not|cannot|can't|never)\b.{0,25}\b(?:enchant|imbu|modif|augment|empower|enhanc)\w*\b/.test(sentence)
        && directDamagePayload() && payloadFor(sentence, fieldFamilies.damage)));
    const distanceDamagePayload = () => entries.some(([field, raw]) => /(?:distance|travel(?:led|ed)?).*damage|damage.*(?:distance|travel(?:led|ed)?)/i.test(field)
        && !/cap|threshold|range|speed|duration|radius/i.test(field) && numbers(raw).some(number => number > 0))
        || positiveLabeled(/^distance damage$|^damage per (?:unit of )?distance(?: unit)?$/);
    const distanceDamageFormula = text => /\bdamage\b.{0,30}\b(?:based on|scal\w* with|proportional to|in proportion to)\b.{0,35}\b(?:distance|how far|how much .*travel)\b/.test(text)
        || /\b(?:farther|further)\b.{0,35}\b(?:greater|more)\b.{0,20}\bdamage\b/.test(text);

    // Numeric parameter labels can establish unambiguous owner restoration
    // stats even when the prose leaves those parameters unexplained. They do
    // not establish recipients for summons or an enemy-targeted operation.
    const ownStatRecipients = effects.filter(effect => ['modifier', 'passive', 'heal', 'save'].includes(effect.type)).flatMap(effectTeams);
    const hostileStatRecipient = effects.some(effect => effectTeams(effect).includes('enemy')
        && ['modifier', 'passive', 'control', 'slow', 'damage'].includes(effect.type));
    const labelTeams = !summonPayload && !hostileStatRecipient
        ? ownStatRecipients.some(team => team === 'self' || team === 'ally') ? [...new Set(ownStatRecipients)] : defaultSelf ? ['self'] : []
        : [];
    for (const label of fieldLabels) {
        if (!labelTeams.length || typeof label.field !== 'string' || typeof label.text !== 'string') continue;
        const field = label.field.toLowerCase();
        if (!numbers(fieldsByName.get(field)).some(number => number > 0)) continue;
        const words = normalize(label.text, actorNames).replace(/[%:]/g, '').trim();
        if (/\b(?:reduc|loss|slow|enemy|negative|cost|drain|burn)/.test(words)) continue;
        if (/^(?:max(?:imum)?\s+)?(?:hp|health)\s+regen(?:eration)?$/.test(words) && fieldFamilies.health_regen.test(field)) beneficiary(labelTeams, 'self_health_regen', 'ally_health_regen', ['health_regen']);
        if (/^(?:max(?:imum)?\s+)?mana\s+regen(?:eration)?$/.test(words) && fieldFamilies.mana_regen.test(field)) beneficiary(labelTeams, 'self_mana_regen', 'ally_mana_regen');
        if (/^(?:hp|health)\s*(?:\/|and)\s*mana\s+regen(?:eration)?$/.test(words) && /regen/i.test(field)) {
            beneficiary(labelTeams, 'self_health_regen', 'ally_health_regen', ['health_regen']);
            beneficiary(labelTeams, 'self_mana_regen', 'ally_mana_regen');
        }
    }

    // These narrow native parameter families declare a stat and its positive
    // direction. They apply only without gameplay prose, with an owning self
    // cast/passive or an explicit friendly native recipient, and never a
    // summon or hostile operation. Other arbitrary parameter names stay opaque.
    if (!texts.length && !summonPayload && !hostileStatRecipient && !nativeTeams.includes('enemy')) {
        const statTeams = nativeTeams.some(team => ['self', 'ally'].includes(team)) ? nativeTeams
            : ownStatRecipients.some(team => ['self', 'ally'].includes(team)) ? ownStatRecipients : defaultSelf ? ['self'] : [];
        const nativeStats = [
            [/^(?:bonus_)?attack_speed(?:_bonus|_per_stack)?$/i, 'self_attack_speed', 'ally_attack_speed'],
            [/^(?:bonus_)?(?:move|movement)_speed(?:_bonus|_pct|_per_stack)?$/i, 'self_movement_speed', 'ally_movement_speed'],
            [/^(?:bonus_)?armor(?:_bonus)?$/i, 'self_armor', 'ally_armor'],
            [/^(?:bonus_attack_damage|bonus_damage|damage_bonus|attack_damage_per_(?:level|stack))$/i, 'self_attack_damage', 'ally_attack_damage'],
        ];
        for (const [pattern, selfTag, allyTag] of nativeStats) if (positive(pattern)) beneficiary(statTeams, selfTag, allyTag);
        if (friendly(statTeams)) {
            if (positive(/^(?:bonus_)?spell_(?:amp|amplification)(?:_per_stack|_pct)?$/i)) buff('spell_amplification');
            if (positive(/^heal(?:ing)?_(?:amp|amplify|amplification)$/i)) beneficiary(statTeams, null, 'ally_healing_amplification', ['healing_amplification']);
            if (positive(/^(?:strength|agility|intelligence)_(?:bonus|gain|per_stack)$/i)) buff('attribute_bonus');
            if (positive(/^(?:item_)?cooldown_reduction(?:_pct)?$/i)) buff('cooldown_reduction');
            if (positive(/^lifesteal(?:_pct|_percent)?$/i)) buff('lifesteal', statTeams.includes('self') ? 'self_lifesteal' : null);
            if (positive(/^spell_lifesteal(?:_pct|_percent)?$/i)) buff('spell_lifesteal');
            if (positive(/^(?:hp|health)_regen(?:_per_stack)?$/i)) beneficiary(statTeams, 'self_health_regen', 'ally_health_regen', ['health_regen']);
            if (positive(/^mana_regen(?:_per_stack)?$/i)) beneficiary(statTeams, 'self_mana_regen', 'ally_mana_regen');
            if (positive(/^(?:base_)?slow_(?:resist|resistance)(?:_per_threshold|_per_upgrade)?$/i)) buff('slow_resistance');
            if (positive(/^status_resistance(?:_per_upgrade)?$/i)) buff('status_resistance');
            if (positive(/^(?:bonus_)(?:str|agi|int)$/i)) buff('attribute_bonus');
            if (positive(/^barrier_amount$/i)) buff('barrier', statTeams.includes('ally') ? 'ally_barrier' : null);
            if (positive(/^aoe_(?:per_threshold|bonus)$/i)) buff('area_increase');
        }
    }
    if (!texts.length && nativeTeams.includes('enemy') && duration() && positive(/^(?:movement_slow|move_slow|slow)(?:_pct)?$/i)) { add('slow'); hostilePayload = true; }
    if (!texts.length && nativeTeams.includes('enemy') && positive(/(?:^|_)stun_duration$/i)) { add('stun', 'disable'); hostilePayload = true; }
    if (!texts.length && defaultSelf && positive(/^bash_chance$/i) && positive(/^bash_duration$/i)) {
        add('attack_stun', 'disable', 'stun'); hostilePayload = true;
        if (positive(/^bash_damage$/i)) directDamage = true;
    }

    // Modeled action types are useful without reading authored effect names.
    // Only type, known recipient and native nonzero payload are consulted.
    if (healthStealPayload() && texts.some(text => /\bsteal\w* (?:health|hp) from (?:the )?enem(?:y|ies)\b/.test(text) && !negated.test(text))) {
        directDamage = true; hostilePayload = true;
        if (sourceCopyHealing) add('heal');
    }
    for (const effect of effects) {
        const teams = effectTeams(effect);
        const hostile = teams.includes('enemy');
        if (effect.type === 'damage' && hostile && directDamagePayload()) directDamage = true;
        if (effect.type === 'control' && hostile && duration()) hostilePayload = true;
        if (effect.type === 'slow' && hostile && payload(/slow|move.?speed|movement.?speed/i)) { add('slow'); hostilePayload = true; }
        if (effect.type === 'heal' && friendly(teams) && !sourceCopyHealing
            && (directHealingPayload() || texts.some(derivedHealingPayload))) {
            add('heal', teams.includes('self') ? 'self_heal' : null, teams.includes('ally') ? 'ally_heal' : null);
        }
        if (effect.type === 'displacement' && positive(/distance|radius|range|speed/i)) {
            if (hostile) { add('enemy_displacement'); hostilePayload = true; }
            if (friendly(teams)) { add('mobility', teams.includes('self') ? 'self_reposition' : null, teams.includes('ally') ? 'ally_reposition' : null); friendlyAvoidance = true; }
        }
        if (effect.type === 'mobility' && friendly(teams) && positive(/distance|range|speed/i)) { add('mobility'); friendlyAvoidance = true; }
        if (effect.type === 'dispel' && (hostile || friendly(teams))) add('dispel', teams.includes('ally') ? 'ally_dispel' : null);
        if (effect.type === 'illusion' && positive(/count|illusion|duration/i)) add('illusions');
        if (effect.type === 'detection' && positive(/radius|duration|range/i)) add('detection');
        if (effect.type === 'break' && hostile && duration()) { add('break'); hostilePayload = true; }
        if (effect.type === 'anti-heal' && hostile && payload(/heal|regen|restoration/i)) { add('anti_heal'); hostilePayload = true; }
    }

    for (const text of texts) {
        let inherited = defaultSelf ? ['self'] : defaultTeams;
        if (/^(?:after|when|if)\b[^,]*\b(?:allied|friendly) hero\b[^,]*,\s*(?:they|he|she|it)\b/.test(text)
            && friendly(defaultTeams)) inherited = defaultTeams.filter(team => ['self', 'ally'].includes(team));
        if (/^(?:when|whenever|if)\b[^,]*\b(?:an?|the) (?:illusion|summoned unit|controlled unit|creature)\b[^,]*\b(?:is|are) created\b/.test(text)) inherited = ['controlled'];
        const incomingDamageContext = /\b(?:when|whenever|after)\b.{0,45}\b(?:enemy|attacker|foe)\b.{0,35}\bdeal(?:s|ing)?\b.{0,30}\bdamage to (?:the )?caster\b/.test(text);
        for (const clause of clauses(text)) {
            const inheritedActor = inherited;
            if (/\b(?:interrupt\w*|cancel\w*)\b.{0,35}\b(?:if|when|unless)\b|\bdisabled by setting\b/.test(clause)) continue;
            const operationText = clause.split(/\b(?:based on|in proportion to|equal to|according to|derived from|from each|for every|per point of)\b/)[0];
            const harmfulStatOperation = negativeVerb.test(operationText.replace(/\b(?:slow resistance|damage reduction|cooldown reduction|mana cost reduction)\b/g, ''));
            const predicate = /\b(?:gain\w*|receiv\w*|becom\w*|deals?|attacks?|stun\w*|root\w*|silenc\w*|slow\w*|has|have|is|are)\b/.exec(clause);
            const subject = predicate ? clause.slice(0, predicate.index) : clause;
            const controlledCause = controlledCausalRecipient(clause);
            const controlledSubject = controlledCause || ((/^(?:they|these|its)\b/.test(clause) || /\btheir\b/.test(subject)) && inherited.includes('controlled') && !friendly(inherited))
                || ((controlledActor?.test(subject) || recipientMarkers[0][1].test(subject)) && !recipientMarkers[3][1].test(subject));
            const teams = controlledCause ? ['controlled'] : recipients(clause, inherited, defaultTeams, controlledActor);
            const isFriendly = friendly(teams);
            const controlledOnly = controlledSubject || teams.includes('controlled') && !isFriendly;
            const implicitHostile = behavior.has('DOTA_ABILITY_BEHAVIOR_PASSIVE')
                && !/\b(?:caster|he|she|himself|herself|ally|allies|friendly)\b/.test(operationText)
                && /\b(?:inflicts? (?:a )?poison|mana (?:burned|drained) per hit)\b/.test(operationText);
            const hostile = teams.includes('enemy') || /\b(?:enemy|enemies|hostile|victim)\b/.test(clause)
                || /\btarget\b/.test(clause) && defaultTeams.includes('enemy') || implicitHostile
                || nativeTeams.includes('enemy') && /\b(?:it|them|their)\b/.test(clause) && /\b(?:silenc|stun|root|disabl|disarm|mute|fear)\w*\b/.test(operationText);
            // Subject state can be retained for coordinated clauses and pronouns.
            if (!/^\b(?:damage|healing|spells|attacks|projectiles)\b/.test(clause)) inherited = teams;
            if (nonCreatureCreation && new RegExp('^' + creationVerb + '\\b').test(clause)) inherited = defaultSelf ? ['self'] : defaultTeams;
            if (negated.test(clause) || /\b(?:cannot|can't) be used\b|\b(?:is|are|was|were|becomes?)\s+(?:not|never)\s+(?:immune|invulnerable|untargetable|invisible|hidden)\b/.test(clause)) continue;

            // Directly asserted state changes, with prerequisite mentions already
            // removed. Target susceptibility ("can be disjointed") is separate.
            const untargetable = /\b(?:becom\w*|mak\w*|render\w*|grant\w*)\b.{0,65}\buntargetable\b/.test(clause)
                || /\b(?:caster|he|she|you|ally|allies|friendly (?:unit|hero)|target)\b.{0,35}\b(?:cannot|can't) be targeted\b/.test(clause)
                || /\b(?:caster|he|she|you|ally|allies|they|units?|target)\b.{0,35}\b(?:is|are)(?: also| now| temporarily)? untargetable\b/.test(clause);
            if (untargetable && isFriendly && !controlledOnly) { add('untargetable'); friendlyAvoidance = true; }
            const disjoint = !/\b(?:can|cannot|can't|not|unable)\s+(?:be\s+)?disjointed\b/.test(clause)
                && (/\bdisjoint(?:s|ing)?\s+(?:incoming\s+)?(?:attack|projectile)s?\b/.test(clause)
                    || /\b(?:incoming )?projectiles?\s+(?:are|is) disjointed\b/.test(clause));
            if (disjoint && !controlledOnly && !teams.includes('enemy') && (isFriendly || defaultSelf)) { add('disjoint'); friendlyAvoidance = true; }
            const invulnerable = /\b(?:becom\w*|mak\w*|render\w*|grant\w*)\b.{0,65}\b(?:invulnerab\w*|damage immunity)\b/.test(clause)
                || /\b(?:caster|he|she|you|unit|ally|target)\b.{0,40}\b(?:is|are) invulnerable\b/.test(clause)
                || /\b(?:is|becomes?) immune (?:to|from) (?:harm|damage)\b/.test(clause);
            if (invulnerable && isFriendly && !controlledOnly && !/\b(?:physical|magical|magic) damage\b/.test(clause)
                && !/\b(?:affects?|heals?|targets?)\b.{0,35}\binvulnerable\b/.test(clause)) { add('damage_immunity'); friendlyAvoidance = true; }
            if (isFriendly && /\b(?:cannot|can't) die\b/.test(clause) && !/\bdie\s+(?:from|by|with|to)\b/.test(clause)) add('death_prevention');
            if (isFriendly && /\b(?:prevent\w* death|health cannot (?:fall|drop) below|minimum (?:hp|health))\b/.test(clause) && duration()) add('death_prevention');
            if (isFriendly && /\bdelay\w*\b.{0,65}\b(?:healing or damage|damage (?:and|or) healing)\b/.test(clause) && duration()) add('death_prevention');
            if (isFriendly && !controlledOnly && /\b(?:grant\w*|gain\w*|becom\w*|provid\w*|is|into)\b.{0,40}\bdebuff immun(?:e|ity)\b/.test(clause)) buff('debuff_immunity');
            if (isFriendly && !controlledOnly && /\breflect(?:s|ing)?\s+(?:(?:targeted|incoming|enemy|all|any|entire|whole)\s+)*(?:spells?|abilit(?:y|ies))(?!\s+damage)\b/.test(clause)
                && qualitativeEnabled(/^does_reflect$|^reflect_spells?$/i)) add('spell_reflection');

            // Returning an incoming damage event is different from recasting a
            // whole targeted spell. Its type comes from that incoming event.
            const reflectedAction = /\b(?:reflect(?:s|ing)?|return(?:s|ing)?|recoil(?:s|ing)?)\b/.exec(clause);
            const reflectorHead = reflectedAction ? clause.slice(0, reflectedAction.index) : '';
            const reflectorTeams = reflectorHead.trim() ? recipients(reflectorHead, inheritedActor, defaultTeams, controlledActor) : inheritedActor;
            const reflectionSubject = friendly(reflectorTeams) && !controlledOnly;
            const reflectiveDamage = reflectedAction && (/\b(?:incoming|received)(?: spell|attack|physical|magical|pure)? damage\b|\bdamage (?:dealt|done) to\b/.test(clause)
                || /\b(?:reflect|return|recoil)(?:s|ing)?\b.{0,55}\b(?:damage|it)\b.{0,50}\b(?:source|attacker|enem(?:y|ies))\b/.test(clause)
                || incomingDamageContext && /\bdamage dealt\b/.test(clause));
            const reflectionMagnitude = /(?:damage.*reflect|reflect.*(?:damage|pct|percent)|(?:return|recoil).*damage)/i;
            const reflectionRestriction = /\b(?:does? not|do not|cannot|can't|unable to|not able to)\b.{0,45}\b(?:reflect|return|recoil|negate|prevent)\b|\bconsidered reflected damage\b/.test(clause);
            const reflectiveEvent = reflectionSubject && reflectiveDamage && !reflectionRestriction && payloadFor(clause, reflectionMagnitude);
            if (reflectiveEvent) add('damage_reflection');
            const negatesHit = /\bnegat(?:e|es|ing)\b.{0,40}\bdamage\b/.test(clause)
                || /\bprevent(?:s|ing)?\b.{0,60}\b(?:hit|damage event)\b.{0,35}\bfrom damaging\b/.test(clause);
            const negationFields = entries.filter(([field]) => /damage.*negat|negat.*damage|prevent.*damage/i.test(field));
            const negationPayload = negationFields.length ? negationFields.some(([, raw]) => numbers(raw).some(number => number > 0)) : duration();
            if (negatesHit && reflectionSubject && !reflectionRestriction && negationPayload
                && !/\b(?:part|percentage|portion|some)\b.{0,30}\bdamage\b/.test(clause)) add('damage_negation');

            // Stat changes require both a statement of the operation and a real
            // numeric field in the relevant family. A zero-only field is absent.
            const statRules = [
                [/\barmor\b/, 'armor', 'self_armor', 'ally_armor', 'armor_reduction'],
                [/\battack speed\b/, 'attack_speed', 'self_attack_speed', 'ally_attack_speed', 'enemy_attack_speed_reduction'],
                [/\b(?:movement speed|move speed|movespeed|increases? movement)\b/, 'movement_speed', 'self_movement_speed', 'ally_movement_speed', 'slow'],
                [/\b(?:attack damage|critical (?:hit|strike|damage))\b/, 'attack_damage', 'self_attack_damage', 'ally_attack_damage', 'outgoing_damage_reduction'],
                [/\battack range\b/, 'attack_range', 'self_attack_range', 'ally_attack_range', null],
            ];
            for (const [phrase, family, selfTag, allyTag, enemyTag] of statRules) {
                const coordinatedPayload = /\battack speed\b/.test(operationText) && /\b(?:attack damage|movement speed)\b/.test(operationText) && positive(/^max_total_increase$/i);
                if (!phrase.test(operationText) || !((family === 'attack_damage' ? attackBonusPayload(operationText) : statPayloadFor(operationText, family)) || coordinatedPayload || quantifiedProperty(operationText, phrase))) continue;
                if (harmfulStatOperation && hostile && enemyTag) { add(enemyTag); hostilePayload = true; }
                else if (positiveVerb.test(operationText) && !harmfulStatOperation && isFriendly && !controlledOnly
                    && (family !== 'attack_damage' || !/\b(?:deal|inflict|take)\w*\b/.test(operationText) || /\bcritical damage\b/.test(operationText))) beneficiary(teams, selfTag, allyTag);
            }
            if (!controlledOnly && /\bcritical (?:damage|hit|strike)\b/.test(operationText) && /\battack\w*\b/.test(text) && positive(/crit.*(?:mult|bonus|damage)/i)) add('attack_damage_scaling');
            if (isFriendly && !controlledOnly && /\battacks?\b/.test(operationText) && /\b(?:bonus|extra|more|increased) damage\b/.test(operationText)
                && !/\b(?:magic|magical|pure) damage\b/.test(operationText) && !harmfulStatOperation && attackBonusPayload(operationText)) beneficiary(teams, 'self_attack_damage', 'ally_attack_damage');
            const movementFloor = /\b(?:movement speed|move speed|movespeed)\b.{0,30}\b(?:cannot|can't) be lower than\s+(%[a-z][a-z0-9_]*%|\d+(?:\.\d+)?)/.exec(operationText);
            const floorToken = movementFloor?.[1];
            const positiveMovementFloor = floorToken && (floorToken.startsWith('%')
                ? numbers(fieldsByName.get(floorToken.slice(1, -1))).some(number => number > 0) : Number(floorToken) > 0);
            if (isFriendly && !controlledOnly && positiveMovementFloor
                && qualitativeEnabled(/^(?:min|minimum)_(?:movement|move)_?speed$/i)) beneficiary(teams, 'self_movement_speed', 'ally_movement_speed');
            if ((hostile || effects.some(effect => ['slow', 'modifier', 'control'].includes(effect.type) && effectTeams(effect).includes('enemy'))) && !controlledOnly && /\b(?:slow\w*|movement speed (?:penalty|cap)|movespeed penalty|decreased speed|movement speed (?:cannot exceed|is capped)|cap\w* .{0,25}(?:max(?:imum)? )?movement speed)\b/.test(operationText)
                && payload(/movement.?speed|move.?speed|move.?slow|movement_slow|speed_bonus|^slow$|max_movement_speed/i)) { add('slow'); hostilePayload = true; }
            if (/\b(?:healing|health restoration|health regen(?:eration)?)\b/.test(clause)
                && negativeVerb.test(clause) && hostile && payload(/heal|regen|restoration/i)) { add('anti_heal'); hostilePayload = true; }
            if (/\b(?:attack|outgoing|total) damage\b/.test(clause) && negativeVerb.test(clause) && hostile && payload(/damage.*reduc|damage_reduction|damage_pct|damage_loss|attack_damage/i)) add('outgoing_damage_reduction');
            if (/\b(?:health|hp)(?: and mana)? regen(?:eration)?\b/.test(operationText) && positiveVerb.test(operationText) && isFriendly && !controlledOnly
                && (payloadFor(operationText, fieldFamilies.health_regen)
                    || quantifiedProperty(operationText, /\b(?:health|hp)(?: and mana)? regen(?:eration)?\b/)
                    || positiveLabeled(/^(?:hp|health) regen(?:eration)?$/))) {
                beneficiary(teams, 'self_health_regen', 'ally_health_regen', ['health_regen']);
            }
            if (/\b(?:mana regen(?:eration)?|health and mana regen(?:eration)?)\b/.test(operationText) && positiveVerb.test(operationText) && isFriendly && !controlledOnly && payloadFor(operationText, fieldFamilies.mana_regen)) beneficiary(teams, 'self_mana_regen', 'ally_mana_regen');
            if (isFriendly && !controlledOnly && /\bbonus speed\b/.test(operationText) && positiveVerb.test(operationText) && positive(/(?:movement|move)_speed|speed_bonus/i)) beneficiary(teams, 'self_movement_speed', 'ally_movement_speed');
            if (/\bregenerat\w*\s+(?:health|hp)\b/.test(operationText) && isFriendly && !controlledOnly && payloadFor(operationText, fieldFamilies.health_regen)) beneficiary(teams, 'self_health_regen', 'ally_health_regen', ['health_regen']);
            if (/\bheal(?:ing)?\b/.test(operationText) && /\b(?:amplif\w*|increas\w*|bonus|more)\b/.test(operationText) && isFriendly && !controlledOnly && payloadFor(operationText, fieldFamilies.healing_amplification)) beneficiary(teams, null, 'ally_healing_amplification', ['healing_amplification']);
            if (isFriendly && !controlledOnly && /\bhealing\b/.test(operationText) && /\bmore effective\b/.test(operationText) && referencedPayload(operationText)) beneficiary(teams, null, 'ally_healing_amplification', ['healing_amplification']);
            const restores = /\b(?:heal(?:s|ing)?|restor\w*|replenish\w*|regenerat\w*)\b/.test(clause)
                && !/\bregen(?:eration)?\b|\bregenerat\w*\s+(?:health|hp)\b/.test(clause);
            if (restores && /\b(?:health|hp|heal\w*)\b/.test(clause) && isFriendly && !copyHealing.test(clause)
                && (directHealingPayload() || derivedHealingPayload(text)) && !/\bamplif/.test(clause)) add('heal', teams.includes('self') ? 'self_heal' : null, teams.includes('ally') ? 'ally_heal' : null);
            if (restores && /\bmana\b/.test(clause) && isFriendly && payload(fieldFamilies.mana_restore)) add(teams.includes('self') ? 'self_mana_restore' : null, teams.includes('ally') ? 'ally_mana_restore' : null);
            if (isFriendly && !controlledOnly && /\b(?:gain|give|receiv)\w*\b.{0,35}\bmana\b/.test(operationText) && !/\b(?:max(?:imum)? mana|mana regeneration)\b/.test(operationText) && payloadFor(operationText, fieldFamilies.mana_restore)) add(teams.includes('self') ? 'self_mana_restore' : null, teams.includes('ally') ? 'ally_mana_restore' : null);
            if (hostile && (/\b(?:burn\w*|drain\w*|steal\w*)\b.{0,65}\bmana\b|\bmana (?:burned|drained) per hit\b/.test(clause))
                && payload(/mana.*(?:burn|drain|steal|per_second|per_hit)|(?:burn|drain|steal).*mana|^burn_amount$/i) && !controlledOnly) { add('mana_burn'); hostilePayload = true; }
            if (/\bprevent\w*\b.{0,65}\b(?:regenerating|gaining|restoring) mana\b/.test(clause) && duration()) { add('mana_restoration_prevention'); hostilePayload = true; }

            const genericStats = [
                [/\b(?:spell amp(?:lification)?|spell damage)\b/, /spell.*(?:amp|damage)|(?:amp|damage).*spell/i, 'spell_amplification'],
                [/\b(?:strength|agility|intelligence|attributes?|stats?)\b/, /(?:^|_)(?:str|agi|int|strength|agility|intelligence|attribute|stats?)(?:_|$).*(?:gain|bonus|buff|per_stack)|(?:^|_)(?:gain|bonus|buff)(?:_|$).*(?:str|agi|int|attribute|stats?)(?:_|$)|(?:as_|to_)(?:strength|agility|intelligence)$|^stats_pct$|^strength$|^agility$|^intelligence$/i, 'attribute_bonus'],
                [/\b(?:magic(?:al)? (?:damage )?resistance)\b/, /magic.*resist/i, 'magic_resistance'],
                [/\bslow resistance\b/, /slow.*resist/i, 'slow_resistance'],
                [/\b(?:status|debuff) resistance\b/, /(?:status|debuff).*resist/i, 'status_resistance'],
                [/\b(?:evasion|evade\w*)\b/, /evasion|miss_chance/i, 'evasion'],
                [/\blifesteal\b/, /lifesteal|hp_leech_percent|health_leech/i, 'lifesteal'],
                [/\b(?:cast range|range of .+?abilit(?:y|ies)|range of .+)\b/, /cast_range|AbilityCastRange/i, 'cast_range'],
            ];
            for (const [phrase, family, tag] of genericStats) if (isFriendly && !controlledOnly && phrase.test(operationText)
                && (positiveVerb.test(operationText) || tag === 'evasion' && /\bcan evade attacks?\b/.test(operationText))
                && (payloadFor(operationText, family) || quantifiedProperty(operationText, phrase))) {
                const fromSpells = /\bspell[- ]lifesteal\b|\blifesteal (?:from|with|of) spells?\b/.test(operationText)
                    || !payload(/^(?:lifesteal(?:_|$)|hp_leech_percent|health_leech)/i) && payload(/^spell_lifesteal(?:_|$)/i);
                if (tag === 'lifesteal' && fromSpells) buff('spell_lifesteal');
                else {
                    buff(tag);
                    if (tag === 'lifesteal' && teams.includes('self')) add('self_lifesteal');
                }
            }
            const owningAbilityProperty = defaultSelf && !controlledOnly && !/\b(?:enemy|enemies|hostile|controlled|summoned)\b/.test(operationText);
            if (owningAbilityProperty && /\brange of\b/.test(operationText) && /\bincreas\w*\b/.test(operationText)
                && payloadFor(operationText, /^cast_range(?:_bonus|_increase)?$/i)) buff('cast_range');
            if ((isFriendly || owningAbilityProperty) && /\b(?:reduc|decreas|lower)\w*\b.{0,35}\bcooldowns?\b|\bcooldowns?\b.{0,35}\b(?:reduc|decreas|lower)\w*\b/.test(operationText) && payloadFor(operationText, /cooldown|AbilityCooldown|cdr/i)) buff('cooldown_reduction');
            if (isFriendly && !controlledOnly && /\bcooldown(?:s| progress)?\b.{0,40}\b(?:accelerat\w*|speed|faster)\b|\baccelerat\w*\b.{0,35}\bcooldown\w*\b/.test(operationText)
                && payloadFor(operationText, /cooldown.*(?:speed|accelerat)|cooldown_acceleration|cdr/i)) buff('cooldown_reduction');
            if (isFriendly && !controlledOnly && /\b(?:barrier|shield)\b/.test(clause) && /\b(?:grant\w*|provid\w*|creat\w*|absor\w*)\b/.test(clause) && positive(/barrier|shield|absorb|absorp|block/i)) {
                if (/\bbarrier\b/.test(clause) || positive(/barrier|shield_(?:health|amount|hp)/i)) buff('barrier', teams.includes('ally') ? 'ally_barrier' : null);
                else buff('damage_reduction');
            }
            if (isFriendly && /\b(?:incoming damage|damage taken)\b/.test(clause) && negativeVerb.test(clause) && payload(/damage.*reduc|reduc.*damage/i)) buff('damage_reduction');
            if (isFriendly && !controlledOnly && /\bdamage reduction\b/.test(operationText) && positiveVerb.test(operationText) && payloadFor(operationText, /damage.*reduc|reduc.*damage/i)) buff('damage_reduction');
            if (isFriendly && !controlledOnly && /\btak(?:e|es|ing) less damage\b/.test(operationText)
                && qualitativeEnabled(/damage.*reduc|reduc.*damage/i)) buff('damage_reduction');
            if (controlledOnly && /\btak(?:e|es|ing) less damage\b/.test(operationText) && payload(/damage.*reduc|reduc.*damage/i)) add('controlled_unit_damage_reduction');
            if (isFriendly && !controlledOnly && /\b(?:mana|overheal|excess healing|extra healing)\b.{0,70}\b(?:convert\w*|turn\w*)\b.{0,35}\bbarrier\b/.test(operationText)
                && positive(/barrier|mana_multiplier|absorb_per_damage/i)) buff('barrier', teams.includes('ally') ? 'ally_barrier' : null);
            if (isFriendly && !controlledOnly && /\b(?:grant|gain|receiv|creat|provid)\w*\b.{0,45}\b(?:physical |magical |magic )?barrier\b/.test(operationText)
                && positive(/barrier|absorb_per_damage/i)) buff('barrier', teams.includes('ally') ? 'ally_barrier' : null);
            if ((isFriendly || /\b(?:caster|all(?:y|ies|ied)|friendly)\b/.test(clause)) && /\bprojectiles?\b/.test(clause) && /\bslow\w*\b/.test(clause) && payload(/projectile.*slow|slow.*projectile/i)) add('projectile_slow');

            // Additional precise mechanics use their own action/object grammar.
            // Quantitative declarations corroborate the operation; qualitative
            // state and inventory rules do not require an invented magnitude.
            const redistributesAttributes = /\b(?:strength|agility|intelligence)\b.{0,60}\b(?:pour\w*|transfer\w*|convert\w*|shift\w*)\b.{0,45}\b(?:strength|agility|intelligence)\b/.test(operationText)
                || /\b(?:pull\w*|transfer\w*|shift\w*)\b.{0,35}\b(?:strength|agility|intelligence)\b.{0,45}\b(?:into|to)\b.{0,25}\b(?:strength|agility|intelligence)\b/.test(operationText);
            if (redistributesAttributes && isFriendly && !controlledOnly && positive(/points_per_tick|morph_rate|attribute.*(?:transfer|shift)/i)) { add('attribute_shift'); tags.delete('attribute_bonus'); }
            if (isFriendly && !controlledOnly && /\b(?:strength|agility|intelligence)\b.{0,30}\b(?:cannot|can't)\b.{0,15}\b(?:lower|below)\b/.test(operationText)) add('attribute_floor');
            if (isFriendly && !controlledOnly && /\bprimary attribute\b.{0,25}\b(?:is now|becomes?|changes? to)\b/.test(operationText)) add('primary_attribute_change');
            if (isFriendly && !controlledOnly && /\b(?:cannot|can't)\b.{0,20}\b(?:below|less than)\b.{0,30}\bmana\b/.test(operationText) && qualitativeEnabled(/minimum_mana|mana_floor/i)) add('mana_floor');
            if (isFriendly && !controlledOnly && /\b(?:physical|magical|magic) damage immun(?:e|ity)\b|\bimmun(?:e|ity) (?:to|from) (?:all )?(?:physical|magical|magic) damage\b/.test(operationText)) {
                const kind = /\bphysical\b/.test(operationText) ? 'physical' : 'magical';
                if (qualitativeEnabled(new RegExp(kind + '.*(?:immun|immune)|(?:immun|immune).*' + kind, 'i'))) buff(kind + '_damage_immunity');
            }
            if (isFriendly && !controlledOnly && /\b(?:block\w* damage|damage block)\b/.test(operationText) && payloadFor(operationText, /damage.*block|block.*damage/i)) buff('damage_block');
            if (isFriendly && !controlledOnly && /\b(?:cannot|can't) be affected by forced movement\b|\bimmune to forced movement\b/.test(operationText)) add('forced_movement_immunity');
            if (!controlledOnly && /\b(?:ignor\w*|pierc\w*)\b.{0,45}\b(?:base )?armor\b/.test(operationText) && qualitativeEnabled(/pierc.*armor|armor.*pierc/i)) add('armor_piercing');
            if (!controlledOnly && (isFriendly || defaultSelf && !/\b(?:enemy|enemies)\b/.test(operationText)) && /\b(?:true strike|attacks? .{0,20}(?:cannot|can't) miss)\b/.test(operationText)
                && qualitativeEnabled(/true_strike|cannot_miss/i)) add('true_strike');
            if (!controlledOnly && /\b(?:enclos\w*|lift\w*|suspend\w*|pick\w* up)\b/.test(operationText)
                && /\b(?:tornado|cyclone|air|battlefield)\b/.test(text) && duration()) { add('cyclone'); if (hostile || defaultTeams.includes('enemy')) { add('disable'); hostilePayload = true; } }
            if (!controlledOnly && /\b(?:turn\w*|becom\w*)\b.{0,35}\b(?:stone|petrif\w*)\b/.test(operationText)
                && /\b(?:enemy|target|them|unit)\b/.test(operationText) && positive(/stone.*(?:duration|time|base)|petrif|duration/i)) { add('petrify'); if (hostile || defaultTeams.includes('enemy')) { add('disable'); hostilePayload = true; } }
            if (!controlledOnly && /\bcleav\w*\b/.test(operationText) && positive(/cleave_(?:damage|distance|width|starting_width|ending_width)|great_cleave_damage/i)) {
                add('cleave', 'attack_damage_scaling');
                if (directDamagePayload()) directDamage = true;
            }
            if (!controlledOnly && /\battack\w*\b.{0,55}\bbounc\w*\b/.test(operationText) && positive(/bounces|bounce_count|bounce_range/i)) add('attack_bounce');
            if (!controlledOnly && /\b(?:creates?|created|wall|fissure|barrier|terrain)\b.{0,80}\b(?:blocks? movement|enemies cannot pass|cannot be passed|impassable)\b/.test(operationText)
                && qualitativeEnabled(/wall_width|wall_thickness|fissure_radius|duration|terrain/i)) add('terrain_block');
            if (isFriendly && !controlledOnly && /\b(?:area of effect bonus|area of effect|effect area|spell area)\b/.test(operationText) && positiveVerb.test(operationText)
                && payloadFor(operationText, /aoe_(?:bonus|per_)|current_aoe|area_(?:bonus|increase)|bonus_aoe/i)) buff('area_increase');
            if (!controlledOnly && /\b(?:buffs?|debuffs?)\b.{0,70}\b(?:extended duration|last longer|duration (?:amp|increas)|longer duration)\b/.test(operationText)
                && payloadFor(operationText, /buff_amplification|debuff_amp|duration_(?:amp|increase)|buff_duration_bonus|^amp_pct$/i)) add('duration_extension');
            if (!controlledOnly && /\bdamage and (?:buff|debuff) duration amp(?:lification)?\b/.test(operationText)
                && /\b(?:caster|he|she|you)\b/.test(operationText) && positiveVerb.test(operationText)
                && payloadFor(operationText, /^amp_pct$|damage.*amp|amp.*damage/i)) add('outgoing_damage_amplification');
            const capacityPhrase = /\b(?:max(?:imum)? (?:health|hp)|bonus (?:health|hp)|max(?:imum)? mana)\b(?!\s+regen\w*)/.exec(operationText);
            if (isFriendly && !controlledOnly && capacityPhrase && positiveVerb.test(operationText)) {
                const resource = /\bmana\b/.test(capacityPhrase[0]) ? 'mana' : 'health';
                const family = resource === 'mana' ? /(?:bonus|max).*mana|mana.*(?:bonus|increase|max)/i : /(?:bonus|max).*(?:health|hp)|(?:health|hp).*(?:bonus|increase|max)|^(?:health|hp)_gain(?:_|$)/i;
                const eligibleCapacity = new RegExp('^(?!.*(?:regen|restor|healing|per_second))(?=.*(?:' + family.source + ')).*$', 'i');
                if (payloadFor(operationText, eligibleCapacity)) beneficiary(teams, 'self_max_' + resource, 'ally_max_' + resource);
            }
            if (isFriendly && !controlledOnly && /\b(?:gain|receiv|giv|grant|provid)\w*\b/.test(operationText)
                && !/\b(?:regen\w*|restor\w*|heal\w*|per second)\b/.test(operationText)) {
                // A referenced proportional capacity field disambiguates a
                // plain "gains mana/health" grant from resource restoration.
                // The input attribute after "per point of" is not granted.
                for (const [resource, words] of [['mana', 'mana'], ['health', '(?:health|hp)']]) {
                    const capacity = new RegExp('(?:^|_)(?:max|maximum)_' + words + '_per_', 'i');
                    const ownsCapacity = [...operationText.matchAll(/%([a-z][a-z0-9_]*)%/g)]
                        .some(match => capacity.test(match[1]) && numbers(fieldsByName.get(match[1])).some(number => number > 0));
                    if (ownsCapacity && new RegExp('\\b' + words + '\\b').test(operationText)) beneficiary(teams, 'self_max_' + resource, 'ally_max_' + resource);
                }
            }
            if ((isFriendly || owningAbilityProperty) && /\bmana costs?\b/.test(operationText) && /\b(?:reduc|decreas|lower)\w*\b/.test(operationText)
                && payloadFor(operationText, /mana_cost_(?:reduction|reduc)|(?:reduce|reduction).*mana|manacost_reduction/i)) buff('mana_cost_reduction');
            if (isFriendly && !controlledOnly && /\b(?:abilit\w*|spell) damage\b|\bdamage (?:of|for|to)\b.{0,35}\babilit\w*\b/.test(operationText)
                && /\b(?:bonus|additional|increas\w*|extra)\b/.test(operationText) && payloadFor(operationText, /(?:bonus_)?ability_damage|bonus_spell_damage|spell_damage_bonus/i)) buff('ability_damage_bonus');
            if (!controlledOnly && /\b(?:increas\w*|amplif\w*|additional|more)\b.{0,45}\bdamage taken\b|\btak\w*\b.{0,25}\b(?:additional|more) damage\b/.test(operationText)
                && (hostile || /\benemy\b/.test(text)) && payloadFor(operationText, /damage.*(?:amp|increase)|(?:amp|increase).*damage|resist_debuff|^stack$/i)) { add('incoming_damage_amplification'); hostilePayload = true; }
            if (!controlledOnly && /\b(?:magic|magical)(?: damage)? resistance\b.{0,30}\breduction\b|\breduc\w*\b.{0,30}\bmagic(?:al)? resistance\b/.test(operationText)
                && (hostile || defaultTeams.includes('enemy')) && payloadFor(operationText, /magic.*(?:reduc|debuff)|resist_debuff|resist_reduc/i)) { add('magic_resistance_reduction'); hostilePayload = true; }
            const moreDamage = /\bdeals?\s+(?:(?:%[a-z][a-z0-9_]*%|\d+(?:\.\d+)?)(?:%)*\s+)?more damage\b|\bdamage amplif\w*\b/.test(operationText);
            const buildingScope = /\b(?:buildings?|structures?|towers?)\b/.test(operationText);
            const namedAbilityScope = currentAbilityName && operationText.includes(currentAbilityName) && /\b(?:caus\w*|allow\w*)\b.{0,90}\bto deal\b/.test(operationText);
            if (!controlledOnly && moreDamage && namedAbilityScope && payloadFor(operationText, /bonus_damage|damage_(?:bonus|increase|pct)|damage_amp/i)) buff('ability_damage_bonus');
            if (!controlledOnly && moreDamage && buildingScope && positive(/bonus_building_damage|building.*damage|damage.*building/i)) {
                add('building_damage');
                const knownAttackDelivery = effects.some(effect => effect.delivery?.kind === 'attack'
                    || effect.delivery?.kind?.state === 'known' && effect.delivery.kind.value === 'attack');
                if (/\battack\w*\b/.test(operationText) || positive(/building_attack_damage|attack_building_damage|building_attack_bonus/i) || knownAttackDelivery) add('building_attack_amplification');
            }
            const explicitOwnerDamage = /\b(?:caster|he|she|you)\s+(?:deal|cause)\w*\b|\b(?:all damage from (?:the )?caster|attacks and abilities)\b/.test(operationText);
            const scopedDelivery = /\b(?:spell|attack|auto attack)\w*\b/.test(operationText)
                && !/\battacks and abilities\b/.test(operationText);
            const damageWasRemoved = /\b(?:lost|removed|forfeit\w*)\b/.test(operationText);
            if (!controlledOnly && moreDamage && explicitOwnerDamage && !namedAbilityScope && !buildingScope
                && !scopedDelivery && !damageWasRemoved
                && qualitativeEnabled(/damage_amp|damage.*increase|front_damage_increase|^amp_pct$/i)) add('outgoing_damage_amplification');
            if (!controlledOnly && /\b(?:takes? control|convert\w*|dominat\w*)\b.{0,65}\bcreeps?\b/.test(operationText)
                && qualitativeEnabled(/max_units|conversion|dominate|level_req/i)) add('creep_conversion');
            const cloneCreation = /\b(?:creat\w*|summon\w*)\b.{0,65}\b(?:duplicate|duplication|clone|another caster)\b/.test(operationText)
                && /\b(?:itself|himself|herself|caster|own|items|spells)\b/.test(operationText);
            if (cloneCreation && !controlledOnly && qualitativeEnabled(/duration|tooltip_clones|clone_count/i)) add('clone_creation');
            if (!controlledOnly && /\b(?:enemy|enemies|foes?)\b.{0,70}\b(?:chance|probability)\b/.test(operationText)
                && /\b(?:proc|trigger|random|item|ability)\b/.test(operationText) && negativeVerb.test(operationText) && payloadFor(operationText, /chance_reduce|proc.*reduc|chance.*reduc/i)) add('proc_chance_reduction');
            if (!controlledOnly && /\b(?:swap\w*|exchang\w*)\b.{0,55}\b(?:health|hp|hit points?)\b/.test(operationText) && qualitativeEnabled(/hit_point_minimum|health_swap|exchange/i)) add('health_exchange');
            if (isFriendly && !controlledOnly && /\b(?:respawn\w*|reincarnat\w*|reviv\w*)\b/.test(operationText)
                && /\b(?:death|dies?|killed|dead)\b/.test(text) && positive(/respawn_delay|reincarnate|revive|resurrection/i)) add('reincarnation');
            if (isFriendly && !controlledOnly && /\b(?:restor\w*|regen\w*)\b/.test(operationText) && /\b(?:faster|accelerat\w*|rate|speed)\b/.test(operationText)
                && positive(/consume_speed|restoration_speed|regen_speed|restore_rate/i)) buff('restoration_rate_amplification');
            if (!controlledOnly && /\b(?:mana|health) costs?\b.{0,55}\bconvert\w*\b.{0,45}\b(?:mana|health) costs?\b/.test(operationText)) { add('resource_conversion'); if (/\bhealth costs?\b/.test(operationText)) add('health_cost'); }
            if (!controlledOnly && /\bheals?\b.{0,35}\b(?:also )?restor\w* mana\b/.test(operationText)
                && positiveLabeled(/^healing converted to mana$/)) add('resource_conversion');
            if (isFriendly && !controlledOnly && /\b(?:losing health|health cost|sacrific\w* .{0,25}health)\b/.test(operationText) && qualitativeEnabled(/health_cost|hp_cost|self_damage/i)) add('health_cost');
            if (isFriendly && !controlledOnly && /\b(?:convert\w*|turn\w*)\b.{0,55}\b(?:health|hp)\b.{0,40}\bmana\b/.test(operationText)
                && payloadFor(operationText, /mana_restore|mana.*(?:pct|gain)|restore.*mana/i)) add('resource_conversion', teams.includes('self') ? 'self_mana_restore' : null, teams.includes('ally') ? 'ally_mana_restore' : null);
            if (!controlledOnly && /\b(?:steal\w*|drain\w*)\b.{0,35}\bdamage\b/.test(operationText) && /\b(?:target|enemy|enemies)\b/.test(text) && positive(/^drain_rate$|damage_steal/i)) { add('outgoing_damage_reduction'); buff('self_attack_damage'); hostilePayload = true; }
            if (!controlledOnly && /\b(?:detect\w*)\b.{0,45}\b(?:heroes?|enemy units?)\b/.test(operationText) && positive(/radius|range|duration/i)) add('detection');
            if (!controlledOnly && /\b(?:can see|allows? .{0,20} to see)\b.{0,50}\b(?:footprints?|trail|range)\b/.test(operationText) && positive(/vision|search_radius|trail|range/i)) add('vision');

            // Hostile controls are actions against enemies, not friendly costs,
            // state susceptibility or trigger conditions.
            const controls = [
                ['stun', /\bstun(?:s|ned|ning)?\b/], ['silence', /\bsilenc(?:e|es|ed|ing)\b/],
                ['root', /\b(?:root(?:s|ed|ing)?|immobiliz(?:e|es|ed|ing))\b/], ['disarm', /\bdisarm(?:s|ed|ing)?\b/],
                ['mute', /\bmut(?:e|es|ed|ing)\b/], ['sleep', /\b(?:puts? .{0,50} to sleep|putting .{0,50} to sleep)\b/],
                ['taunt', /\btaunt(?:s|ed|ing)?\b/], ['fear', /\b(?:becom\w* fearful|feared|fearing|(?:forces?|caus\w*) .{0,50} to flee|enemies to flee)\b/],
                ['break', /\b(?:appl(?:y|ies|ying)|inflict(?:s|ing)?)\b.{0,25}\bbreak\b/],
                ['hex', /\bhex(?:es|ed|ing)?\b|\btransforms?\b.{0,45}\b(?:harmless|beast|animal)\b/],
            ];
            const appliedEnemyControl = /\bappl(?:y|ies|ying)\b/.test(operationText)
                && !/\b(?:to|on) (?:the )?(?:caster|himself|herself|allies|an ally)\b/.test(operationText)
                && effects.some(effect => effect.type === 'control' && effectTeams(effect).includes('enemy'));
            if ((hostile || appliedEnemyControl) && !controlledOnly && duration()) for (const [tag, pattern] of controls) {
                if (!pattern.test(clause) || /\b(?:cannot|can't|not)\b.{0,25}(?:stun|silenc|root|disarm|mute|sleep|fear|taunt|hex)/.test(clause)) continue;
                if (isFriendly && /\b(?:caster|he|she|you|allies?|friendly|they)\b.{0,25}\b(?:is|are|becomes?)\b/.test(clause)) continue;
                const dedicated = entries.filter(([field]) => new RegExp('(?:^|_)' + (tag === 'fear' ? '(?:fear|status)' : tag) + '(?:_|$)', 'i').test(field));
                if (dedicated.length && !dedicated.some(([, raw]) => numbers(raw).some(number => number > 0))) continue;
                add(tag, tag === 'break' ? null : 'disable'); hostilePayload = true;
                if (tag === 'stun' && /\battack\b/.test(clause) && positive(/bash|stun_chance/i)) add('attack_stun');
            }
            if (hostile && /\bdisabl(?:e|es|ed|ing)\b/.test(clause) && !/\b(?:this|the) ability is disabled\b/.test(clause) && duration()) { add('disable'); hostilePayload = true; }
            if (hostile && !controlledOnly && /\bprevent\w*\b.{0,70}\b(?:casting|cast)\b.{0,15}\bspells?\b/.test(operationText) && duration()) { add('silence', 'disable'); hostilePayload = true; }
            if (hostile && /\b(?:knock\w* (?:back|away)|shov\w*|push\w*|pull\w*|drag\w*|forc\w* .{0,25} mov)\b/.test(clause) && positive(/distance|knock|push|pull|speed/i)) { add('enemy_displacement'); hostilePayload = true; }
            if (hostile && /\bturn\w*\b/.test(clause) && /\b(?:reduc\w*|slow\w*|cannot)\b/.test(clause) && positive(/turn.*(?:rate|slow)|duration/i)) add('turn_rate_reduction');

            // Creation and controlled-unit operations do not become caster
            // attack bonuses, immunity or direct ability damage.
            const summons = new RegExp('\\b' + creationVerb + '\\s+(?!gain\\w*|receiv\\w*|deal\\w*|have\\b|are\\b)\\S+').test(clause)
                || /\b(?:a|an)\s+.{0,35}\b(?:will\s+)?spawn\b/.test(clause)
                || /\b(?:is|are|will be)\s+(?:summoned|spawned|created)\b/.test(clause)
                || /\bconvert\w*\b.{0,60}\b(?:trees?|terrain|rocks?|objects?)\b\s+into\b.{0,60}\bunder (?:the )?command\b/.test(clause);
            if (summons && summonPayload && !cloneCreation && !/\b(?:illusions?|courier)\b/.test(clause)) { add('summons'); inherited = ['controlled']; }
            if ((/\b(?:creat\w*|summon\w*)\b.{0,40}\billusions?\b/.test(clause) || /\billusions?\b.{0,40}\b(?:will\s+)?spawn\b/.test(clause)) && positive(/illusion|count|duration/i)) add('illusions');
            if (controlledOnly && /\bdamage\b/.test(clause) && positiveVerb.test(clause) && payload(/damage.*(?:amp|bonus)|(?:bonus|amp).*damage/i)) buff('controlled_unit_damage');
            if (controlledOnly && /\b(?:outgoing |attack )?damage\b.{0,35}\b(?:cannot|can't)\b.{0,15}\b(?:go|fall|drop) below\b/.test(operationText)
                && duration() && (positive(/^(?:outgoing|damage|attack_damage)_floor$|^(?:min|minimum)_(?:outgoing_)?damage$/i)
                    || positiveLabeled(/^(?:min(?:imum)?|floor) (?:outgoing |attack )?damage$/))) buff('controlled_unit_damage');
            const damageText = clause.split(/\bat (?:the )?cost of\b/)[0];
            const dealsDamage = /\b(?:deal(?:s|ing)?|inflict(?:s|ing)?|caus(?:es|ing)|tak(?:e|es|ing))\b.{0,70}\bdamage\b|\bdamag(?:e|es|ing)\b.{0,45}\b(?:enemy|enemies|target|units?)\b|\bdamage (?:is|was|will be) (?:dealt|inflicted)\b|\b(?:is|are|was|were) damaged\b/.test(damageText)
                || /\bhit\w*\b.{0,45}\bunits?\b.{0,35}\b(?:with (?:a )?damaging|dealing damage)\b/.test(damageText);
            const damageAmplification = /\bdeal(?:s|ing)?\s+(?:(?:%[a-z][a-z0-9_]*%|\d+(?:\.\d+)?)(?:%)*\s+)?(?:more|increased|amplified)\s+(?:(?:spell|attack)\s+)?damage\b/.test(damageText);
            const selfCost = /\b(?:self|own) damage\b|\bdamage (?:to|dealt to|taken by|on) (?:the )?caster\b/.test(damageText)
                || isFriendly && !hostile && /\b(?:caster|he|she|you)\s+tak(?:e|es|ing)\b/.test(damageText);
            const plantedExplosive = /\bplant(?:s|ed|ing)?\b.{0,50}\b(?:explosives?|mines?|traps?)\b/.test(operationText);
            if (!controlledOnly && plantedExplosive && positive(/radius|duration|activation_time/i)) add('trap');
            if (!controlledOnly && plantedExplosive && /\bdetonat\w*\b/.test(operationText) && directDamagePayload()
                && !selfCost && positive(/detonat.*delay|damage_delay|explosion_delay/i)) { add('delayed_damage'); directDamage = true; hostilePayload = true; }
            if (dealsDamage && !reflectiveDamage && !damageAmplification && !selfCost && !controlledOnly
                && (directDamagePayload() && payloadFor(damageText, fieldFamilies.damage) || derivedDamagePayload(text))
                && !/\b(?:less|reduc\w*|damage taken|incoming damage|instead of harm|will heal)\b/.test(damageText)) {
                directDamage = true; hostilePayload = true;
                if (/\b(?:over time|per second|every|periodic|each (?:tick|second))\b/.test(damageText) || positive(/(?:tick|damage_per_second|dps|damage_pers|damage_interval)/i)) add('damage_over_time');
                if (/\b(?:after|delay|when they fall)\b/.test(text) && positive(/delay|damage_delay/i)) add('delayed_damage');
                if (/\b(?:initial|impact|instant|immediate)\b/.test(damageText)
                    || /\bdamage\b.{0,45}\b(?:they hit|on impact|upon impact)\b/.test(damageText)) add('immediate_damage');
                if (/\b(?:max(?:imum)?|current|missing) health\b/.test(damageText) && payload(/health.*(?:damage|pct)|(?:damage|pct).*health/i)) add('target_health_scaling');
                if (enemyHealthDamageFormula) add('target_health_scaling');
                if (/\b(?:attack damage|base damage|critical)\b/.test(damageText) && positive(/attack_factor|damage_pct|crit|attack_damage/i)) add('attack_damage_scaling');
                if (distanceDamagePayload() && distanceDamageFormula(damageText)) add('damage_over_distance');
                if (/\b(?:buildings?|towers?)\b/.test(damageText)) add('building_damage');
                if (/\b(?:damages?|damaging)\s+(?:(?:all|nearby|enemy|neutral|hostile|target)\s+)*creeps?\b|\bdamage\b.{0,35}\bto (?:the )?(?:(?:enemy|neutral|hostile) )?creeps?\b|\bcreeps?\s+(?:take|takes|are|is)\b.{0,25}\bdamag(?:e|ed)\b/.test(damageText)) add('creep_damage');
            }
            if (!controlledOnly && /\b(?:attack\w*|attacked unit)\b/.test(text)
                && /\b(?:splitting|spill\w*|splash\w*)\b/.test(operationText)
                && positive(/^(?:attack_spill|splash|cleave)_(?:pct|damage|damage_pct)$/i)) {
                add('attack_damage_scaling'); directDamage = true; hostilePayload = true;
            }
            if (!controlledOnly && !selfCost && directDamagePayload() && /\b(?:explod\w*|detonat\w*|bursts?)\b/.test(operationText)
                && (hostile || /\b(?:target|enemy|enemies|damage)\b/.test(operationText) || /\b(?:enemy|enemies)\b/.test(text))) {
                directDamage = true; hostilePayload = true;
                if (/\bafter\b/.test(text) && positive(/damage.*(?:delay|duration)|detonate_delay/i)) add('delayed_damage');
                if (/\b(?:target|victim|dying units?|enemies|enemy)\b.{0,25}\bmax(?:imum)? health\b/.test(text) && positive(/damage.*pct|health.*damage/i)) add('target_health_scaling');
            }
            if (!controlledOnly && /\bburns?\b.{0,30}\b(?:enemy|enemies)\b/.test(operationText) && !/\bmana\b/.test(operationText) && directDamagePayload()) { directDamage = true; hostilePayload = true; add('damage_over_time'); }
            if (!controlledOnly && /\b(?:attacks? from each|attacks? twice|second attack|counter-attack)\b/.test(operationText) && qualitativeEnabled(/attack_count|second_attack_delay|sidegunner_fire_rate|trigger_attacks/i)) add('repeated_attacks');
            if (!controlledOnly && /\battack\w*\b/.test(operationText) && /\bevery\b/.test(operationText) && /\bwith (?:his|her|the caster's) attack\b/.test(operationText) && positive(/attack_interval|fire_rate/i)) add('repeated_attacks');
            if (/\bpermanent(?:ly)?\b/.test(clause) && /\b(?:gain\w*|steal\w*|bonus|increas\w*)\b/.test(clause) && payload(/per_kill|reward|damage_per|stat_loss|agi_gain|permanent/i) && !controlledOnly) add('earned_permanent_growth');
            if (/\b(?:bonus damage|critical (?:hit|strike))\b/.test(clause) && isFriendly && /\b(?:base damage|attack damage|critical)\b/.test(clause) && positive(/crit|damage_pct|strength_damage|attack_factor/i)) add('attack_damage_scaling');

            // Position changes must have a friendly subject. A projectile's own
            // travel speed is never movement for the caster.
            if (isFriendly && !controlledOnly && /\b(?:(?:teleports?|blinks?|leaps?|jumps?|dashes?|repositions?|flies?|rushes?)\s+(?:(?:the )?caster\s+)?(?:forward|backward|to|towards?|away|into|out|over|through|up|back)|travels? with|teleportation that allows)\b/.test(clause)
                && !/\b(?:projectile|snake|orb)\b.{0,20}\b(?:travels?|jumps?)\b/.test(clause)
                && (positive(/distance|range|speed|AbilityCastRange/i) || effects.some(effect => effect.type === 'mobility'))) {
                add('mobility', teams.includes('self') ? 'self_reposition' : null, teams.includes('ally') ? 'ally_reposition' : null); friendlyAvoidance = true;
                if (/\b(?:teleport|blink)\w*\b/.test(clause)) add('blink');
            }
            const mountedCreation = /\bsummons?\s+.+\bto ride\b/.exec(clause);
            const mountActor = mountedCreation ? clause.slice(0, mountedCreation.index) : '';
            const ownMountedCreation = defaultSelf && mountedCreation && !controlledActor?.test(mountActor) && !recipientMarkers[0][1].test(mountActor);
            if ((isFriendly && !controlledOnly || ownMountedCreation) && /\b(?:to ride around|can ride|rides? around|ride .{0,20} on)\b/.test(clause)
                && positive(/^(?:mount|ride|riding)_duration$/i) && positive(/^(?:max_)?speed$|^acceleration$/i)) { add('mobility'); friendlyAvoidance = true; }
            if (isFriendly && !controlledOnly && (/\b(?:becom\w*|mak\w*|grant\w*|turn\w*|render\w*)\b.{0,45}\binvisib(?:le|ility)\b/.test(clause)
                || /^(?:permanently|temporarily) invisible\b/.test(clause)
                || /\b(?:caster|he|she|you|allies?|they|units?|target)\b.{0,30}\b(?:is|are)\s+(?:also\s+)?invisible\b/.test(clause))) { add('invisibility'); friendlyAvoidance = true; }
            if (isFriendly && !controlledOnly && /\b(?:hides? (?:himself|herself|itself|the caster)|becom\w* .{0,25}(?:hidden|impossible to see)|(?:allies|caster|he|she|friendly units)\s+(?:\w+\s+){0,4}(?:are|is) hidden)\b/.test(clause)) { add('concealment'); friendlyAvoidance = true; }
            if (/\b(?:provid\w*|grant\w*|gain\w*)\b.{0,45}\b(?:vision|sight)\b/.test(clause) && !controlledOnly && positive(/vision|sight|radius|duration/i)) add('vision');
            if (/\b(?:reveal\w*|detect\w*)\b.{0,35}\binvisib/.test(clause) && !controlledOnly && positive(/reveal|vision|radius|duration/i)) add('detection');
            if (hostile && /\b(?:reduc\w*|den\w*|obscur\w*)\b.{0,35}\bvision\b/.test(clause) && positive(/vision|radius|duration/i)
                && qualitativeEnabled(/obscure_vision|vision_denial|vision_reduction|reduce_vision/i)) add('vision_denial');
            if (/\b(?:remov\w*|purg\w*|dispel\w*)\b.{0,60}\b(?:debuff|negative|status effects?|disables?|buffs?)\b|\b(?:appl\w*|provid\w*)\b.{0,35}\b(?:basic|strong) dispel\b/.test(clause)) add('dispel', teams.includes('ally') ? 'ally_dispel' : null);
            if (/\b(?:all friendly units on the map|global(?:ly)?|anywhere on (?:the )?map)\b/.test(clause)
                && !/\b(?:not|no|never|cannot|can't|no longer)\b.{0,25}\bglobal(?:ly)?\b/.test(clause)) globalDeliveryClaim = true;
            if (/\baura\b/.test(clause) && /\b(?:provid\w*|grant\w*|increas\w*|gain\w*|giv\w*)\b/.test(clause) && tags.size && positive(/^(?:aura_)?radius$|^aura_range$/i)) add('aura');
            if (/\b(?:share\w*|redistribut\w*)\b.{0,45}\bdamage\b/.test(clause) && positive(/damage|share/i)) add('damage_sharing');
        }
    }
    if (globalDeliveryClaim && tags.size) add('global_delivery');
    if (directDamage && sourceAttackModifier) add('attack_modifier');
    if (directDamage || hostilePayload) {
        if (fields.get('SpellImmunityType') === 'SPELL_IMMUNITY_ENEMIES_YES') add('bkb_pierce');
    }
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_CHANNELLED')) add('channeled');
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_AOE')) add('aoe');
    if (behavior.has('DOTA_ABILITY_BEHAVIOR_AURA')) add('aura');
    if (friendlyAvoidance || ['self_reposition', 'ally_reposition'].some(tag => tags.has(tag))) add('escape');
    return tags;
}

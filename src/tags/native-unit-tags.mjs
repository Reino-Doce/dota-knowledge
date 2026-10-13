/** Source-bound NPC slot callbacks; joins establish local scope, never hero effects. */
const own = (value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined;
const expressionEscape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function numericBase(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return numericBase(own(raw, 'value'));
    if (typeof raw === 'number') return Number.isFinite(raw) ? [raw] : [];
    if (Array.isArray(raw)) return raw.length && raw.every(value => typeof value === 'number' && Number.isFinite(value)) ? raw : [];
    if (typeof raw !== 'string') return [];
    const tokens = raw.trim().split(/\s+/);
    return tokens.length && tokens.every(token => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(token))
        ? tokens.map(token => Number(token.replace(/%$/, ''))) : [];
}

function boundReference(record, node, relative, isBound) {
    return node?.state === 'decoded' && ['string', 'reference'].includes(node.kind)
        && typeof node.raw === 'string' && node.raw.length > 0 && node.raw === node.decoded
        && isBound(record, node, relative);
}

function assignedUnit(native, units, fields, isBound) {
    if (native?.state !== 'known' || !native.raw || typeof native.abilityId !== 'string' || typeof isBound !== 'function') return false;
    const dependency = native.nativeDeclarations?.fields?.DependentOnAbility;
    if (!boundReference(native, dependency, 'DependentOnAbility', isBound) || fields.get('DependentOnAbility') !== dependency.raw) return false;
    return units.some(unit => {
        if (unit?.state !== 'known' || !unit.raw) return false;
        const declarations = unit.nativeDeclarations?.fields ?? {};
        const creator = declarations.UnitToAbilityMap;
        if (!boundReference(unit, creator, 'UnitToAbilityMap', isBound) || creator.raw !== dependency.raw) return false;
        return Object.entries(declarations).some(([field, node]) => /^Ability\d+$/.test(field)
            && boundReference(unit, node, field, isBound) && node.raw === native.abilityId);
    });
}

const action = '(?:becomes?|turns?|smashes?|strikes?|stuns?|damages?|deals?|inflicts?|gains?|receives?|regains?|restores?|regenerates?|is|casts?|summons?|creates?|spawns?|attacks?)';
const subjectPattern = new RegExp('\\b(?:the|this|that|a|an)\\s+([a-z][a-z-]*(?:\\s+[a-z][a-z-]*){0,2}?)\\s+(?:will\\s+)?' + action + '\\b');
const foreignActor = /\b(?:enemy|enemies|hostile|foe|foes|opponent|attacker|ally|allies|allied|friendly|target|victim|owner|hero)\b/;
const foreignSubject = new RegExp('^(?:and\\s+)?(?:enemy|enemies|hostile|foe|foes|opponent|attacker|ally|allies|allied|friendly|target|victim)\\b(?:\\s+[a-z-]+){0,2}?\\s+(?:will\\s+)?' + action + '\\b');
const creation = /\b(?:summon\w*|creat\w*|spawn\w*|call\w* forth|bring\w* forth)\b/;
const negative = /\b(?:does? not|do not|cannot|can't|never|no longer|unable to|not able to)\b|\bnot (?:invulnerable|immune)\b/;

function textOf(snippet) {
    return String(snippet.text ?? '').replace(/<\s*br\s*\/?\s*>/gi, '. ').replace(/<[^>]*>/g, ' ')
        .replace(/\\[nr]|[\r\n]/g, '. ').replace(/\s+/g, ' ').toLowerCase().trim();
}

function clauses(text) {
    const out = [];
    for (let sentence of text.split(/[.!?;]+\s*/).filter(Boolean)) {
        // State prerequisites do not grant that state. An explicit consequent
        // remains eligible; local provenance is still required for its action.
        if (/^(?:if|when|whenever|while|unless|after|before)\b/.test(sentence)) {
            if (!sentence.includes(',')) continue;
            sentence = sentence.slice(sentence.indexOf(',') + 1).trim();
        }
        sentence = sentence.split(/\b(?:when|whenever|if|unless|until)\b/)[0].trim();
        out.push(...sentence.split(/,\s*|\band\s+(?=(?:the|this|that|it|he|she|they|caster|enemies|allies)\b)/).filter(Boolean));
    }
    return out;
}

/** Classify only an NPC-assigned local callback, using its own bound payload. */
export function inferUnitTags({ native, units = [], fields = new Map(), snippets = [], effects = [], behavior = new Set(), nativeTeams = [], isBound } = {}) {
    const tags = new Set();
    if (!assignedUnit(native, units, fields, isBound)) return tags;
    const entries = [...fields.entries()];
    const positive = pattern => entries.some(([field, raw]) => pattern.test(field)
        && numericBase(raw).some(value => value > 0));
    const enemyProof = nativeTeams.includes('enemy') || effects.some(effect => effect.targets?.teams?.state === 'known'
        && effect.targets.teams.value?.includes('enemy'));
    const localCast = behavior.has('DOTA_ABILITY_BEHAVIOR_NO_TARGET');
    const texts = snippets.filter(snippet => typeof snippet.text === 'string'
        && /^(?:description|note\d+|(?:scepter|shard)_description|facet_.+)$/i.test(snippet.suffix ?? '')).map(textOf);
    // Names of newly produced actors come from grammatical creation statements,
    // not an NPC-name list. Their later actions are separate from this callback.
    const created = new Set();
    for (const text of texts) for (const match of text.matchAll(/\b(?:summon\w*|creat\w*|spawn\w*|call\w* forth|bring\w* forth)\s+(?:a|an|the|one|another|additional)?\s*([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2}?)(?=\s+(?:that|which|to|with|from|for)\b|[.,;]|$)/g)) {
        for (const word of match[1].split(' ')) created.add(word);
    }
    const localName = texts.flatMap(clauses).map(clause => subjectPattern.exec(clause)?.[1])
        .find(name => name && !foreignActor.test(name) && !name.split(' ').some(word => created.has(word)));
    const localSubject = localName ? new RegExp('\\b(?:the|this|that|a|an)?\\s*' + expressionEscape(localName) + '\\s+(?:will\\s+)?' + action + '\\b') : null;
    let directDamage = false;
    let hostilePayload = false;
    for (const text of texts) {
        let local = false;
        for (const clause of clauses(text)) {
            const named = subjectPattern.exec(clause)?.[1];
            if (named) local = named === localName && !foreignActor.test(named);
            else if (foreignSubject.test(clause)) local = false;
            else if (/\bcaster\s+(?:will\s+)?(?:become\w*|turn\w*|gain\w*|regain\w*|restor\w*|regenerat\w*|is|stun\w*|damag\w*|deal\w*)\b/.test(clause)) local = true;
            else if (localSubject?.test(clause)) local = true;
            if (creation.test(clause)) { local = false; continue; }
            if (!local || negative.test(clause) || /\b(?:orders?|commands?|instructs?)\b/.test(clause)) continue;
            const foreignRecipient = /\b(?:allies|allied|friendly)\b/.test(clause);
            const selfCost = /\b(?:self.damage|own damage|damage to (?:itself|the caster)|damages? (?:itself|the caster)|health cost|cost of .{0,20}health)\b/.test(clause);
            const incomingReturn = /\b(?:reflect|return|recoil)\w*\b.{0,50}\b(?:damage|it)\b|\b(?:received|incoming)\s+(?:(?:spell|attack|physical|magical|pure)\s+)?damage\b/.test(clause);
            if (enemyProof && !foreignRecipient && !selfCost && !incomingReturn) {
                let ownOffense = false;
                if (/\bstun(?:s|ning)\b/.test(clause) && positive(/^stun_duration$/i)) {
                    tags.add('stun'); tags.add('disable'); hostilePayload = true; ownOffense = true;
                }
                if (/\bdamag(?:es|ing)\b|\b(?:deal(?:s|ing)?|inflict(?:s|ing)?)\b.{0,40}\bdamage\b/.test(clause)
                    && positive(/^(?:stun_damage|damage|damage_per_second|dps)$/i)) { directDamage = true; ownOffense = true; }
                if (ownOffense && /\b(?:all|multiple|nearby)\s+(?:(?:enemy|hostile)\s+)?(?:targets?|units?|enemies)\b/.test(clause)
                    && /\b(?:area|radius)\b/.test(clause) && positive(/^(?:(?:stun|damage)_radius|area_of_effect|aoe)$/i)) tags.add('aoe');
            }
            if (localCast && !foreignRecipient && !selfCost) {
                const immunityFields = entries.filter(([field]) => /^(?:invulnerab(?:le|ility)|damage_immunity)(?:_enabled)?$/i.test(field));
                const immunityEnabled = !immunityFields.length || immunityFields.some(([, raw]) => numericBase(raw).some(value => value > 0));
                if (/\b(?:becomes?|is|will be)\s+invulnerable\b|\b(?:gains?|receives?)\s+(?:invulnerability|damage immunity)\b/.test(clause)
                    && !/\b(?:physical|magic|magical)\b/.test(clause) && immunityEnabled) tags.add('controlled_unit_damage_immunity');
                if (/\b(?:regain\w*|regenerat\w*|restor\w*)\s+(?:(?:its|own|his|her)\s+)?health\b|\b(?:gain\w*|receiv\w*)\b.{0,25}\bhealth regen(?:eration)?\b/.test(clause)
                    && !/\b(?:all(?:y|ies)|enemy|enemies|target|caster's)\b/.test(clause)
                    && positive(/^(?:hp|health)_regen$/i)) tags.add('controlled_unit_health_regen');
            }
        }
    }
    if (directDamage) {
        if (positive(/^(?:stun_delay|damage_delay|delay)$/i) && texts.some(text =>
            /\b(?:after|delay(?:ed)?|later)\b/.test(text) && /\b(?:damage|damag\w*|explos\w*|detonat\w*|burst\w*)\b/.test(text))) tags.add('delayed_damage');
    }
    if ((directDamage || hostilePayload) && fields.get('SpellImmunityType') === 'SPELL_IMMUNITY_ENEMIES_YES') tags.add('bkb_pierce');
    return tags;
}

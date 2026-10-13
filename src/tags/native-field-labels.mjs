/** Exact source-bound parameter labels can supply stat semantics missing from field names. */
function positiveBase(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return Object.hasOwn(raw, 'value') && positiveBase(raw.value);
    if (Array.isArray(raw)) return raw.length > 0 && raw.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0);
    if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0;
    if (typeof raw !== 'string') return false;
    const parts = raw.trim().split(/\s+/);
    return parts.length > 0 && parts.every(value => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(value)
        && Number(value.replace(/%$/, '')) > 0);
}

function normalized(text, actorNames) {
    let value = text.replace(/<\s*br\s*\/?\s*>/gi, '. ').replace(/<[^>]*>/g, ' ').replace(/\\[nr]|[\r\n]/g, '. ').toLowerCase();
    for (const name of [...actorNames].filter(name => typeof name === 'string' && name.trim()).sort((a, b) => b.length - a.length)) {
        const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        value = value.replace(new RegExp('\\b' + escaped + '\\b', 'g'), 'caster');
    }
    return value.replace(/[’]/g, "'").replace(/\battack and movement speeds?\b/g, 'attack speed and movement speed')
        .replace(/\bmove speed\b/g, 'movement speed').replace(/\s+/g, ' ').trim();
}

const beneficial = /\b(?:gain\w*|grant\w*|provid\w*|receiv\w*|giv\w*|have|has|bonus|additional|increas\w*|improv\w*|enhanc\w*|transform\w*|caus\w*|allow\w*|empower\w*)\b/;
const negative = /\b(?:does? not|do not|cannot|can't|never|no longer|reduc\w*|decreas\w*|los(?:e|es|ing|t)|loss|penalt\w*|cost|drain\w*|consum\w*)\b/;
const controlled = /\b(?:illusion\w*|summon\w*|creatures?|controlled units?|units under .{0,15}control)\b/;
const enemySubject = /^(?:the\s+)?(?:enemy|enemies|hostile|foe|foes|opponent|attacker|victim)\b/;

function statements(text) {
    return text.split(/[.!?;]+\s*/).flatMap(sentence => {
        if (/^(?:if|when|whenever|while|after|before|unless)\b/.test(sentence)) {
            if (!sentence.includes(',')) return [];
            sentence = sentence.slice(sentence.indexOf(',') + 1).trim();
        }
        const parts = [];
        let from = 0;
        for (const match of sentence.matchAll(/\band\s+(?:the\s+)?(?=(?:caster|he|she|they|allies|friendly)\b)/g)) {
            const prior = sentence.slice(from, match.index);
            if (beneficial.test(prior) && /\b(?:damage|range|speed|lifesteal|armor)\b/.test(prior)) {
                parts.push(sentence.slice(from, match.index));
                from = match.index + match[0].length;
            }
        }
        parts.push(sentence.slice(from));
        return parts.map(part => part.split(/\b(?:based on|in proportion to|equal to|according to|derived from)\b/)[0].trim());
    }).filter(Boolean);
}

function recipients(body) {
    if (enemySubject.test(body) || controlled.test(body)) return [];
    if (/\b(?:grant|give|provid|allow|caus|offer)\w*\s+(?:(?:the|a|an)\s+)?(?:enemy|enemies|hostile|foes?|opponent)\b/.test(body)) return [];
    const grant = /\b(?:grant|give|provid|allow|caus|offer)\w*\s+(?:(?:the|a|an)\s+)?(caster|you|allies|ally|friendly)\b/.exec(body);
    if (grant) {
        if ((grant[1] === 'caster' || grant[1] === 'you') && /^(?:caster|you)\s+and\s+(?:allies|allied|friendly)\b/.test(body.slice(grant.index + grant[0].lastIndexOf(grant[1])))) return ['self', 'ally'];
        return grant[1] === 'caster' || grant[1] === 'you' ? ['self'] : ['ally'];
    }
    const to = /\b(?:to|for)\s+(?:the\s+)?(caster|you|allies|ally|friendly)\b/.exec(body);
    if (to) return to[1] === 'caster' || to[1] === 'you' ? ['self'] : ['ally'];
    if (/\b(?:caster|you)\s+and\s+(?:allies|allied|friendly)\b/.test(body)) return ['self', 'ally'];
    if (/\b(?:allies|allied|friendly)\b/.test(body)) return ['ally'];
    if (/\b(?:caster|you|your|himself|herself)\b/.test(body)) return ['self'];
    return [];
}

/** Infer precise friendly stat enhancements from their verified own labels and prose. */
export function inferFieldLabelTags({ fields = new Map(), fieldLabels = [], snippets = [], effects = [], behavior = new Set(), nativeTeams = [], actorNames = [] } = {}) {
    const tags = new Set();
    const knownTeams = new Set([...nativeTeams, ...effects.flatMap(effect => effect.targets?.teams?.state === 'known' ? effect.targets.teams.value ?? [] : [])]);
    const ownCast = behavior.has('DOTA_ABILITY_BEHAVIOR_PASSIVE') || behavior.has('DOTA_ABILITY_BEHAVIOR_NO_TARGET');
    if (ownCast) knownTeams.add('self');
    const bodies = snippets.filter(snippet => typeof snippet.text === 'string'
        && /^(?:description|note\d+|(?:scepter|shard)_description|facet_.+)$/i.test(snippet.suffix ?? ''))
        .map(snippet => normalized(snippet.text, actorNames)).flatMap(statements);
    const producedNames = new Set();
    for (const body of bodies) for (const match of body.matchAll(/\b(?:summon\w*|creat\w*|spawn\w*|call\w* forth)\s+(?:a|an|the|one)?\s*([a-z][a-z-]*)/g)) producedNames.add(match[1]);
    const eligible = bodies.filter(body => beneficial.test(body) && !negative.test(body)
        && ![...producedNames].some(name => new RegExp('\\b' + name + '\\b').test(body)))
        .map(body => ({ body, teams: recipients(body).filter(team => knownTeams.has(team)), attack: /\battack\w*\b|\bweapon\b/.test(body) }))
        .filter(row => row.teams.length);
    const modeledDamage = effects.some(effect => effect.type === 'damage' && effect.targets?.teams?.state === 'known' && effect.targets.teams.value?.includes('enemy'));
    const add = (proof, self, ally, extra = []) => {
        tags.add('buff');
        for (const tag of extra) tags.add(tag);
        if (self && proof.teams.includes('self')) tags.add(self);
        if (ally && proof.teams.includes('ally')) tags.add(ally);
    };
    for (const label of fieldLabels) {
        if (typeof label.field !== 'string' || typeof label.text !== 'string' || !positiveBase(fields.get(label.field))) continue;
        const words = normalized(label.text, []).replace(/[%:]/g, '').trim();
        if (/reduc|loss|cost|penalt|drain|burn|negative/.test(label.field.toLowerCase() + ' ' + words)) continue;
        for (const proof of eligible) {
            const body = proof.body;
            if (/^(?:spell[- ]?)?lifesteal$/.test(words) && /\b(?:lifesteal|life steal)\b/.test(body)) {
                const spell = /^spell/.test(words) || /\bspell[- ]lifesteal\b|\blifesteal from spells\b/.test(body);
                add(proof, spell ? null : 'self_lifesteal', null, [spell ? 'spell_lifesteal' : 'lifesteal']);
            }
            if (/^(?:bonus )?(?:base |attack )?damage$/.test(words) && /^bonus /.test(words) && proof.attack
                && (/\bdamage\b/.test(body) || /\btransform\w*\b/.test(body))
                && !/\b(?:spell|ability|magic|magical|pure) (?:bonus )?damage\b/.test(body)
                && (!modeledDamage || /^(?:bonus (?:base|attack) damage)$/.test(words))) add(proof, 'self_attack_damage', 'ally_attack_damage');
            if (/^(?:bonus )?attack range$/.test(words) && proof.attack
                && /\brange\b|\branged attack\b/.test(body)
                && (/^bonus /.test(words) || /\b(?:bonus|additional|increas\w*|extra)\s+(?:attack\s+)?range\b/.test(body))) add(proof, 'self_attack_range', 'ally_attack_range');
            if (/^bonus attack speed$/.test(words) && /\battack speed\b/.test(body)) add(proof, 'self_attack_speed', 'ally_attack_speed');
            if (/^bonus movement speed$/.test(words) && /\bmovement speed\b/.test(body)) add(proof, 'self_movement_speed', 'ally_movement_speed');
            if (/^bonus building damage$/.test(words) && proof.attack) add(proof, null, null, ['building_attack_amplification']);
            if (/^splash damage$/.test(words) && proof.attack && /\bsplash\w*\b/.test(body)) add(proof, null, null, ['aoe']);
        }
    }
    return tags;
}

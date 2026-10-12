import assert from 'node:assert/strict';
import { loadKnowledgePackage } from '@reino-doce/dota-knowledge/node';
import { loadImagePackage } from '@reino-doce/dota-knowledge/node/images';

const knowledge = await loadKnowledgePackage();
try {
    const hero = knowledge.heroByKey('antimage');
    assert.equal(hero, knowledge.hero('1'));
    assert.equal(knowledge.heroByKey('anti-mage'), undefined);
    const matches = knowledge.heroesByAlias('  ANTI-MAGE  ');
    assert.equal(matches.length, 1);
    assert.equal(matches[0], hero);
    assert.equal(knowledge.heroesByAlias('Magina')[0], hero);
    assert.deepEqual(knowledge.heroesByAlias('unknown hero'), []);
    for (const record of knowledge.heroes()) {
        assert.equal(knowledge.heroByKey(record.key), knowledge.hero(record.id));
    }
    const effects = knowledge.effectsForHero(hero.id);
    const guide = await knowledge.loadHeroEvidence(hero.id);
    assert.equal(guide.heroId, hero.id);
    const images = await loadImagePackage(); // Metadata only; no pixel reads.
    const portrait = images.image('hero', hero.id, 'profile');
    assert.equal(portrait.state, 'available');
    console.log(JSON.stringify({ heroId: hero.id, key: hero.key, aliasMatches: matches.map(row => row.key),
        roundTrips: knowledge.heroes().length, effects: effects.length, portrait: portrait.state }));
}
finally {
    knowledge.retire();
}

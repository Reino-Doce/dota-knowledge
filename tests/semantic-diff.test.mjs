import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChange } from '../scripts/compare-current.mjs';

test('semantic diffs keep mechanics, interpretations, observations, and provenance distinct', () => {
    assert.equal(classifyChange('heroes/1.json', '/abilities/ability:1:blink/order'), 'mechanics');
    assert.equal(classifyChange('heroes/1.json', '/effects/effect:blink/mana/0'), 'interpretations');
    assert.equal(classifyChange('observations/heroes/1.json', '/observations/0/matchCount'), 'observations');
    assert.equal(classifyChange('sources.json', '/0/retrievedAt'), 'provenance');
    assert.equal(classifyChange('mechanics/reference.json', '/sourceIdentities/native'), 'provenance');
});

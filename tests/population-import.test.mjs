import assert from 'node:assert/strict';
import test from 'node:test';
import { createPopulationObservations } from '../src/bundle-import.mjs';

test('population counts remain exact decimal strings and cohorts stay separate', () => {
    const population = {
        cohorts: [
            { id: 'stratz:uncalibrated:season-1', dataThrough: '2026-10-01T00:00:00.000Z' },
            { id: 'stratz:uncalibrated:season-2', dataThrough: '2026-10-08T00:00:00.000Z' },
        ],
        heroes: { '1': { state: 'available', overall: ['18446744073709551615', '18446744073709551620', 0],
            encodedDurations: [[4, '9007199254740993', '9007199254740999']],
            matchups: [[94, '9223372036854775808', '9223372036854775810', 1.125, 1]] } },
        verification: { durations: { state: 'unknown' }, matchupDirection: 'higher-is-better' },
    };
    const rows = createPopulationObservations('1', population);
    assert.equal(rows[0].winCount, '18446744073709551615');
    assert.equal(rows[0].matchCount, '18446744073709551620');
    assert.equal(rows[0].cohortId, 'stratz:uncalibrated:season-1');
    assert.equal(rows[1].winCount, '9007199254740993');
    assert.equal(rows[1].matchCount, '9007199254740999');
    assert.equal(rows[2].otherHeroId, '94');
    assert.equal(rows[2].winCount, '9223372036854775808');
    assert.equal(rows[2].cohortId, 'stratz:uncalibrated:season-2');
    assert.equal(rows[2].advantagePercentagePoints, 1.125);
    assert.equal(rows[2].direction, 'higher-is-better');
});

test('population importer rejects counts already rounded by a lossy numeric source', () => {
    const population = { heroes: { '1': { state: 'available', overall: [Number.MAX_SAFE_INTEGER + 1, 9, 0] } } };
    assert.throws(() => createPopulationObservations('1', population), /exact non-negative integer count/);
});

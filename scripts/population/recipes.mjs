import { semanticHash } from '../../src/canonical-model.mjs';
import { BUCKETS } from './timings-math.mjs';

const freeze = value => { Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); }); return Object.freeze(value); };
/** These settings describe the frozen formulas; choosing them is caller policy. */
export const RECIPES_V1 = freeze({
    dotabuff: { id: 'dotabuff-tables', version: 1, minMatchupRows: 40, minRosterRows: 100 },
    positions: { id: 'stratz-position-counts', version: 1, weeks: 4, pageSize: 5000,
        positions: [1, 2, 3, 4, 5], modes: ['ALL_PICK_RANKED'],
        bands: [{ key: 'all', brackets: null }, { key: 'divine', brackets: ['DIVINE', 'IMMORTAL'] }, { key: 'immortal', brackets: ['IMMORTAL'] }] },
    roles: { id: 'lane-position-inference', version: 1, minPresence: 2, minWeight: 0.12, prior: 0.15,
        minSamples: 4, minSeparation: 1.4, minClassShare: 0.15, roamingSplit: 0.7,
        fallbackCoreShare: { mid: 0.9, safe: 0.55, off: 0.65, jungle: 0.6, roaming: 0.7 } },
    synergies: { id: 'synergy-empirical-bayes', version: 1, matches: '300000', window: '60000', minGames: 50,
        minRank: 0, lobbyType: 7, gameMode: 22, ambiguousBelow: 0.5, assignmentFloor: 0.0001,
        minCellGames: 150, minCellGap: 0.05, ratePriorWins: 0.5, ratePriorGames: 1, logitClamp: 1e-9 },
    timings: { id: 'duration-skew', version: 1, matches: '300000', window: '60000', minGames: 200,
        minRank: 0, lobbyType: 7, gameMode: 22, minDuration: 600, shrinkGames: 400, buckets: BUCKETS },
    lanes: { id: 'stratz-lane-counts', version: 1, weeks: 4, minLanes: 50,
        positions: [1, 2, 3, 4, 5], brackets: [], directions: ['against', 'with'], settleDays: 7, unsettledTtlHours: 12 },
    calibration: { id: 'logistic-two-fold', version: 1, matches: '300000', window: '400000', minRank: 0,
        taus: [0.5, 1, 1.5, 2, 2.5, 3], holdout: 'exact-match-id-parity', minMatches: 100000,
        minGain: 0.005, maxBinError: 0.03, minBinGames: 1000, rangeBinGames: 200 },
});
export function recipeSettings(overrides = {}) {
    for (const key of Object.keys(overrides)) if (!Object.hasOwn(RECIPES_V1, key)) throw new Error('Unknown recipe.');
    const result = Object.fromEntries(Object.entries(RECIPES_V1).map(([key, value]) => [key, { ...structuredClone(value), ...overrides[key] }]));
    for (const [key, value] of Object.entries(result)) {
        if (value.id !== RECIPES_V1[key].id || value.version !== 1) throw new Error('Unsupported recipe version.');
    }
    return result;
}
export const recipeRecord = (settings, inputs) => ({ ...settings, inputFingerprint: semanticHash(inputs) });

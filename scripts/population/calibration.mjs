import { semanticHash } from '../../src/canonical-model.mjs';
import { decimal, compareIds } from './exact.mjs';
import { teamIds, wonFlag } from './normalize.mjs';
import { fitCalibration, calibrationProblems } from './calibrate-math.mjs';

export function modelIdentity(adapter) {
    if (!adapter || typeof adapter.id !== 'string' || !adapter.id || typeof adapter.version !== 'string' || !adapter.version
        || !Array.isArray(adapter.keys) || !adapter.keys.length || new Set(adapter.keys).size !== adapter.keys.length
        || typeof adapter.sample !== 'function' || typeof adapter.vectorize !== 'function'
        || !adapter.constraints || !adapter.acceptance || !/^[a-f0-9]{64}$/.test(adapter.inputSignature ?? '')) throw new Error('Calibration requires an explicit model adapter and input signature.');
    return { id: adapter.id, version: adapter.version, keys: adapter.keys, constraints: adapter.constraints, acceptance: adapter.acceptance, inputSignature: adapter.inputSignature };
}
export function calibrationBoundary(priorInputs) {
    const ranges = priorInputs.matchRanges;
    if (!Array.isArray(ranges) || !ranges.length || ranges.some(range => !Array.isArray(range) || range.length !== 2 || compareIds(range[0], range[1]) > 0)) throw new Error('Calibration requires feature-source match ranges.');
    return ranges.map(range => decimal(range[0])).sort(compareIds)[0];
}
export function fitModel(rows, { roster, priorInputs, adapter, recipe }) {
    const model = modelIdentity(adapter); const below = calibrationBoundary(priorInputs);
    const ids = new Set(); const samples = [];
    for (const row of rows) {
        const id = decimal(row.id);
        if (BigInt(id) >= BigInt(below) || ids.has(id)) throw new Error('Calibration samples overlap feature sources or each other.');
        ids.add(id);
        const match = { id, radiant: teamIds(row.r, roster), dire: teamIds(row.d, roster), y: Number(wonFlag(row.w)) };
        if (new Set([...match.radiant, ...match.dire]).size !== 10) throw new Error('Calibration has duplicate heroes.');
        const sample = adapter.sample(match, priorInputs);
        if (sample === null) continue;
        samples.push({ ...sample, id, y: match.y });
    }
    if (![0n, 1n].every(parity => samples.some(sample => BigInt(sample.id) % 2n === parity))) throw new Error('Calibration requires both independent folds.');
    const result = fitCalibration(samples, { keys: model.keys, taus: recipe.taus,
        nonPositive: model.constraints.nonPositive ?? [], vectorize(sample, tau) {
            const vector = adapter.vectorize(sample, tau);
            if (model.keys.some(key => !Number.isFinite(vector[key]))) throw new Error('Invalid calibration vector.');
            return vector;
        } });
    const problems = calibrationProblems(result, model.acceptance);
    if (problems.length) throw new Error('Calibration failed acceptance checks.');
    const sorted = samples.map(sample => sample.id).sort(compareIds);
    return { ...result, matches: String(result.matches), model, recipe, matchIdRange: [sorted[0], sorted.at(-1)], below,
        inputSignature: semanticHash(priorInputs), sampleSignature: semanticHash(samples),
        skipped: String(rows.length - samples.length), holdoutSeparation: 'exact-match-id-parity',
        reliability: result.reliability.map(([a, b, count, predicted, actual]) => [a, b, String(count), predicted, actual]) };
}

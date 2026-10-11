import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { normalizeLegacyRecords, hash, semanticHash, escapePointer } from '../../src/canonical-model.mjs';
import { readJson, regularBytes, observationFile, jsonBytes } from '../../src/node/canonical.mjs';

/** Version 1 reading is restricted to migration/comparison tooling. */
export async function readLegacyLayout(root, { read = name => readJson(root, name), crosswalk, aliases, retainMaps = true } = {}) {
    const metadata = await read('manifest.json');
    if (metadata.schemaVersion !== 1) throw new Error('Legacy migration requires a version 1 manifest.');
    const heroes = [];
    const guides = new Map();
    const observations = await read('observations/index.json');
    const runtimeObservations = observations.slice();
    const claims = [];
    for (const descriptor of metadata.sourceFiles.filter(row => /^heroes\/[0-9]+\.json$/.test(row.name))) {
        const row = await read(descriptor.name);
        heroes.push(row); claims.push(...row.claims);
        guides.set(row.hero.id, await read(`runtime/guides/${row.hero.id}.json`));
        observations.push(...(await read(`observations/heroes/${row.hero.id}.json`)).observations);
    }
    heroes.sort((a, b) => Number(a.hero.id) - Number(b.hero.id));
    const graph = normalizeLegacyRecords({ metadata: { ...metadata, runtimeObservations }, heroes, guides, observations, claims,
        sources: await read('sources.json'), reference: await read('mechanics/reference.json') }, { crosswalk, aliases });
    if (retainMaps) {
        for (const descriptor of metadata.sourceFiles.filter(row => row.name.startsWith('reconciliation/'))) {
            const name = 'reviews/' + descriptor.name;
            const bytes = await regularBytes(root, descriptor.name);
            if (descriptor.name === 'reconciliation/index.json') {
                const index = JSON.parse(bytes);
                for (const row of index.sourceBundles) row.fieldFile = 'reviews/' + row.fieldFile;
                graph.extras.set(name, jsonBytes(index));
            }
            else graph.extras.set(name, bytes);
        }
    }
    return graph;
}

export async function verifyPhaseA(root, audit) {
    const index = await readJson(audit, 'index.json');
    if (index.phase !== 'A' || index.state !== 'complete' || index.libraryRevision !== '1684ee640b3d80310ebc0aa5841235917981e0ae') {
        throw new Error('The selected Phase A baseline is not the confirmed preservation revision.');
    }
    const recovery = await readJson(audit, 'recovery.json');
    const archive = await regularBytes(audit, 'baseline.tar.gz');
    const archiveHash = recovery.archive?.sha256 ?? recovery.sha256;
    if (!archiveHash || archiveHash !== hash(archive) || recovery.state !== 'verified') throw new Error('Phase A archive is not verified.');
    const files = await readJson(audit, 'files.json');
    const rows = Array.isArray(files) ? files : files.files;
    for (const row of rows) {
        const name = row.path.replace(/^data\/hero-knowledge\//, '');
        const bytes = await regularBytes(root, name);
        if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error('Selected baseline file changed: ' + name);
    }
    return { index, files: rows, archiveSha256: hash(archive) };
}

/** Overlay maps complete old subtrees; the Phase A archive and acquisition maps remain immutable. */
export async function reconciliationOverlay(root, graph, baseline) {
    const byHero = new Map(graph.entities.heroes.map(row => [row.id, row]));
    const byObservation = new Map();
    const offsets = new Map();
    for (const row of graph.observations) {
        const file = observationFile(row, byHero);
        const offset = offsets.get(file) ?? 0; offsets.set(file, offset + 1);
        byObservation.set(row.id, { file, pointer: '/observations/' + offset });
    }
    const claims = new Map(graph.claims.map((row, index) => [row.id, { file: 'reviews/claims.json', pointer: '/claims/' + index }]));
    const bindings = new Map(graph.bindings.map((row, index) => [row.subjectId + '#' + row.field,
        { file: 'reviews/bindings.json', pointer: '/bindings/' + index + '/value' }]));
    const bindingsBySubject = new Map();
    for (const [identity, target] of bindings) {
        const subject = identity.slice(0, identity.indexOf('#'));
        if (!bindingsBySubject.has(subject)) bindingsBySubject.set(subject, []);
        bindingsBySubject.get(subject).push([identity, target]);
    }
    const rows = [];
    const add = (file, pointer, value, destination, disposition = 'canonical') => rows.push({ file, pointer,
        semanticSha256: semanticHash(value), destination, disposition });
    for (const old of baseline.files) {
        const name = old.path.replace(/^data\/hero-knowledge\//, '');
        if (!name.endsWith('.json')) {
            add(name, '', old.sha256, { archive: 'baseline.tar.gz', path: old.path }, 'retained-evidence'); continue;
        }
        const document = await readJson(root, name);
        let match;
        if ((match = /^heroes\/(\d+)\.json$/.exec(name))) {
            const hero = byHero.get(match[1]);
            for (const [section, value] of Object.entries(document)) {
                if (section === 'hero') for (const [field, child] of Object.entries(value)) {
                    add(name, '/hero/' + escapePointer(field), child, bindings.get(hero.id + '#/' + field)
                        ?? { file: `heroes/${hero.key}/profile.json`, pointer: '/' + escapePointer(field) });
                }
                else if (['abilities', 'activations', 'effects', 'conditions'].includes(section)) {
                    if (!value.length) add(name, '/' + section, value, { file: `heroes/${hero.key}/${['abilities', 'activations'].includes(section) ? 'abilities' : 'mechanics'}.json`, pointer: '/' + section });
                    for (const [index, record] of value.entries()) for (const [field, child] of Object.entries(record)) {
                        const destination = bindings.get(record.id + '#/' + field) ?? {
                            file: `heroes/${hero.key}/${['abilities', 'activations'].includes(section) ? 'abilities' : 'mechanics'}.json`,
                            pointer: `/${section}/${index}/${escapePointer(field)}` };
                        add(name, `/${section}/${index}/${escapePointer(field)}`, child, destination,
                            bindings.has(record.id + '#/' + field) ? 'review' : 'canonical');
                        const reviewFields = (bindingsBySubject.get(record.id) ?? []).filter(([identity]) => identity.startsWith(record.id + '#/' + field + '/'))
                            .map(([identity, target]) => ({ pointer: identity.slice((record.id + '#/' + field).length), target }));
                        if (reviewFields.length) rows.at(-1).reviewFields = reviewFields;
                    }
                }
                else if (section === 'claims') {
                    if (!value.length) add(name, '/claims', value, { file: 'reviews/claims.json', identities: [] }, 'review');
                    for (const [index, row] of value.entries()) add(name, '/claims/' + index, row, claims.get(row.id), 'review');
                }
                else add(name, '/' + section, value, bindings.get(hero.id + '#/' + section), 'review');
            }
        }
        else if (name === 'observations/index.json' || /^observations\/heroes\//.test(name)) {
            for (const [index, row] of (Array.isArray(document) ? document : document.observations).entries()) {
                add(name, (Array.isArray(document) ? '' : '/observations') + '/' + index, row, byObservation.get(row.id), 'merged-agreeing-fields');
            }
        }
        else if (name === 'claims/index.json') {
            for (const [index, row] of document.entries()) for (const [field, value] of Object.entries(row)) {
                add(name, '/' + index + '/' + field, value, field === 'detailsRef'
                    ? { file: 'runtime/manifest.json', pointer: '/guides/' + row.heroId + '/name' }
                    : { ...claims.get(row.id), pointer: claims.get(row.id).pointer + '/' + field },
                field === 'detailsRef' ? 'structural' : 'merged-review-details');
            }
        }
        else if ((match = /^runtime\/guides\/(\d+)\.json$/.exec(name))) {
            const hero = byHero.get(match[1]);
            const history = graph.history.findIndex(row => row.heroId === hero.id);
            for (const [field, value] of Object.entries(document)) {
                const destination = ['officialHero', 'officialDataset'].includes(field)
                    ? { file: 'reviews/profiles.json', pointer: `/profiles/${history}/${field}` }
                    : field === 'claims' ? { file: 'reviews/claims.json', identities: value.map(row => row.id) }
                        : ['schemaVersion', 'version', 'createdAt', 'coreSha256'].includes(field)
                            ? { file: 'runtime/manifest.json', pointer: field === 'coreSha256' ? '/core/sha256' : '/' + field }
                            : { file: `heroes/${hero.key}/guides/details.json`, pointer: '/' + field };
                add(name, '/' + field, value, destination, ['schemaVersion', 'coreSha256'].includes(field) ? 'structural' : 'canonical');
            }
        }
        else add(name, '', document, { archive: 'baseline.tar.gz', path: old.path }, 'retained-evidence');
    }
    if (rows.some(row => !row.destination)) throw new Error('Unmapped migration field.');
    graph.extras.set('reviews/reconciliation/phase-b-fields.jsonl.gz', gzipSync(rows.map(row => JSON.stringify(row)).join('\n') + '\n'));
    graph.extras.set('reviews/reconciliation/phase-b.json', jsonBytes({ schemaVersion: 2, baselineRevision: baseline.index.libraryRevision,
        archiveSha256: baseline.archiveSha256, fieldMappings: rows.length,
        policy: 'Original acquisition and Phase A bytes are retained unchanged. Array order contributes to each subtree digest.',
        observations: graph.reconciliation, explicitSemanticIdRenames: [] }));
    return rows.length;
}

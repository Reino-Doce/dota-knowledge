import type { HeroRecord, HeroEvidence, ImageDescriptor, ImageIdentity, KnowledgeManifest,
    KnowledgeStore, NativeRole, ReviewBinding } from '@reino-doce/dota-knowledge';
import { loadKnowledgePackage } from '@reino-doce/dota-knowledge/node';

async function profilesAndReviews(store: KnowledgeStore) {
    const hero: HeroRecord | undefined = store.hero('1');
    const keyed: HeroRecord | undefined = store.heroByKey('antimage');
    const candidates: readonly HeroRecord[] = store.heroesByAlias('Anti-Mage');
    // @ts-expect-error Candidates are read-only; the consumer must handle ambiguity.
    candidates.push(...candidates);
    // @ts-expect-error Keys are strings, not numeric IDs.
    store.heroByKey(1);
    // @ts-expect-error Alias queries require text.
    store.heroesByAlias(1);
    void [keyed, candidates];
    if (hero) {
        const attribute: 0 | 1 | 2 | 3 | null = hero.primaryAttribute;
        const range: number | null = hero.attackRange;
        const complexity: 1 | 2 | 3 | null = hero.complexity;
        const role: NativeRole | undefined = hero.roles[0]?.role;
        const guide: HeroEvidence | undefined = await store.loadHeroEvidence(hero.id);
        const binding: ReviewBinding | undefined = guide?.reviewBindings[0];
        const state = hero.coverage.fields.complexity;
        if (state.state !== 'known') { const reason: string = state.reason; void reason; }
        void [attribute, range, complexity, role, binding];
    }
}

function images(identity: ImageIdentity) {
    const unavailable: ImageDescriptor = { ...identity, state: 'unavailable', reason: 'Not acquired.' };
    const available: ImageDescriptor = { ...identity, state: 'available', path: 'heroes/antimage/images/profile.png',
        width: 256, height: 144, bytes: 200, mediaType: 'image/png', sha256: 'a'.repeat(64) };
    // @ts-expect-error Unavailable images must not claim an asset path.
    const invalid: ImageDescriptor = { ...identity, state: 'unavailable', reason: 'Not acquired.', path: 'image.png' };
    void [unavailable, available, invalid];
}

// @ts-expect-error Version-one runtime manifests are not accepted by the current loader.
const version: KnowledgeManifest['schemaVersion'] = 1;
// @ts-expect-error Historical fractional complexity is not a current native profile fact.
const complexity: HeroRecord['complexity'] = 1.5;
const load: () => Promise<KnowledgeStore> = loadKnowledgePackage;
void [profilesAndReviews, images, version, complexity, load];

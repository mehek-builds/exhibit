import { createTranslationExtension } from '../../src/translate/translate.js';
import { MemoryDeepL } from '../../src/twins/fakes.js';
import type { FounderProfile } from '../../src/types.js';
import { DARA, E, mail, seed } from '../corpus.js';
import type { GradeCheck, Scenario, ScenarioContext } from '../scenarios.js';

// S24 (stretch, PRD 6.14, E67): draft machine translation. `E.spanish` (`gmail:m-es`) carries a fake
// passport number so the redaction-before-DeepL boundary (constraint 17) is provable; a second,
// not-opted-in French item proves the opt-in gate holds and no call is made for it.

const M_ES_WITH_ID = mail({
  id: 'm-es',
  from: 'El Mundo Tech <redaccion@elmundotech.example>',
  date: '2026-07-22T12:00:00Z',
  subject: 'Entrevista: Dara Voss y el futuro de las pruebas de software',
  body:
    'Hola Dara, la entrevista con Dara Voss sobre Loomwork y el futuro de las pruebas de software está publicada en nuestra edición de julio. Para verificar tu identidad antes de la publicación impresa, confirmamos: Passport No. X98765432. Gracias por tu tiempo y por compartir tu experiencia con los lectores de la revista. https://elmundotech.example/entrevista-dara-voss',
});

const M_FR = mail({
  id: 'm-fr',
  from: 'Le Journal Tech <redaction@lejournaltech.example>',
  date: '2026-08-05T12:00:00Z',
  subject: "Article about Dara Voss et l'avenir des tests logiciels",
  body: "Bonjour Dara, cet article about Dara Voss sur Loomwork et l'avenir des tests logiciels est publié dans notre édition d'août, avec le soutien de toute la rédaction et de nos lecteurs fidèles. Merci beaucoup pour votre temps et pour avoir partagé votre expérience avec nous. https://lejournaltech.example/article-dara-voss",
});

const PROFILE: FounderProfile = { ...DARA, translationOptIn: ['gmail:m-es'] };

function chk(name: string, pass: boolean, detail: string): GradeCheck {
  return { name, pass, detail };
}

function exhibitBySource(ctx: ScenarioContext, id: string) {
  return ctx.env.ledger.exhibits().find((e) => e.sources.some((s) => s.app === 'gmail' && s.id === id));
}

export const S24: Scenario = {
  id: 'S24',
  title: 'Draft translation: redacted text only, opt-in gate holds',
  core: true,
  profile: PROFILE,
  seed: () => seed({ gmail: [M_ES_WITH_ID, M_FR, ...E.buildnight.gmail], calendar: E.buildnight.calendar }),
  play: async (ctx) => {
    const fake = new MemoryDeepL({ record: (a, o, ac, d) => ctx.env.twins.recordOp(a, o, ac, d) });
    ctx.env.deps.extensions = [createTranslationExtension({ client: fake })];
    (ctx.env as unknown as { fake: MemoryDeepL }).fake = fake;
    await ctx.env.run();
  },
  grade: (ctx) => {
    const checks: GradeCheck[] = [];
    const fake = (ctx.env as unknown as { fake: MemoryDeepL }).fake;

    checks.push(chk('exactly one DeepL call', fake.received.length === 1, `${fake.received.length}`));
    const sent = fake.received[0]?.text ?? '';
    checks.push(chk('DeepL never received the raw passport number', !sent.includes('X98765432'), sent));
    checks.push(chk('DeepL received the redacted placeholder instead', sent.includes('[REDACTED:passport]'), sent));

    const esExhibit = exhibitBySource(ctx, 'm-es');
    checks.push(chk('m-es exhibit found', !!esExhibit, ''));
    checks.push(chk('m-es status needs_attorney', esExhibit?.status === 'needs_attorney', `${esExhibit?.status}`));

    const files = ctx.env.twins.state().drive.files;
    const draft = esExhibit ? files.find((f) => f.appProperties?.role === 'translation' && f.appProperties?.exhibit_id === esExhibit.exhibit_id) : undefined;
    checks.push(chk('labeled draft translation filed beside the m-es exhibit', !!draft, draft ? draft.name : 'not found'));
    const draftContent = draft ? Buffer.from(ctx.env.twins.driveContent(draft.id) ?? new Uint8Array()).toString('utf8') : '';
    checks.push(chk('draft is labeled as a draft machine translation requiring certification', draftContent.includes('draft machine translation') || draftContent.includes('certified translation'), draftContent.slice(0, 120)));

    const frExhibit = exhibitBySource(ctx, 'm-fr');
    checks.push(chk('m-fr exhibit found', !!frExhibit, ''));
    const frDraft = frExhibit ? files.find((f) => f.appProperties?.role === 'translation' && f.appProperties?.exhibit_id === frExhibit.exhibit_id) : undefined;
    checks.push(chk('no DeepL-derived draft for the not-opted-in French item', !frDraft, frDraft ? frDraft.name : 'absent, as expected'));

    const events = ctx.env.ledger.events({ kind: 'translation' });
    const frEvent = events.find((e) => e.detail.source === 'gmail:m-fr');
    checks.push(chk('translation event for m-fr records opted_in: false, called: false', frEvent?.detail.opted_in === false && frEvent?.detail.called === false, JSON.stringify(frEvent?.detail)));
    const esEvent = events.find((e) => e.detail.source === 'gmail:m-es');
    checks.push(chk('translation event for m-es records called: true', esEvent?.detail.called === true, JSON.stringify(esEvent?.detail)));

    return checks;
  },
};

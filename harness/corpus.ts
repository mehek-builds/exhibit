import type { CalendarEvent, GithubRepo, GithubReview, GmailMessage, LinkedinPost } from '../src/apps/types.js';
import type { TwinSeed } from '../src/twins/memory.js';
import { buildEml } from '../src/twins/memory.js';
import type { FounderProfile, O1Criterion, Status } from '../src/types.js';
import { prng } from '../src/util.js';

// "Dara Voss", a fictional solo founder, and one year of her life (PRD 12.1). Every person,
// company, outlet and domain here is fictional and lives on .example domains. Nothing in this file
// describes a real person, a judge, or anyone's immigration status.

export const NOW = new Date('2026-09-13T12:00:00Z');

export const DARA: FounderProfile = {
  name: 'Dara Voss',
  aliases: ['Dara', 'D. Voss'],
  emails: ['dara@loomwork.example'],
  domain: 'loomwork.example',
  company: 'Loomwork',
  githubLogins: ['dvoss', 'loomwork'],
  ownAccounts: ['dvoss', 'dvoss-alt', 'dvoss-bot', 'dv-test1', 'dv-test2', 'dv-test3', 'dv-test4', 'dv-test5'],
  linkedinId: 'dara-voss',
  field: 'software engineering (developer tooling and AI infrastructure)',
  targetFilingDate: '2027-03-31',
  phone: '+15550100142',
  quietHours: { start: '22:00', end: '08:00', timeZone: 'America/Los_Angeles' },
  routes: ['O-1A', 'EB-1A'],
  scanSince: '2023-01-01',
  coauthors: ['Ren Park'],
  translationOptIn: [],
  jobTitle: 'Founder and Chief Executive Officer',
  socCode: '11-1011',
  controlledEmails: ['dara@loomwork.example', 'dara.signer@loomwork.example'],
  recommenderCandidates: [
    { name: 'Priya Raman', email: 'priya@buildnight.example', relationship: 'independent', role: 'Program Director, Build Night' },
    { name: 'Marco Ellis', email: 'marco@hackmesa.example', relationship: 'independent', role: 'Lead Organizer, HackMesa' },
    { name: 'Sam Ortiz', email: 'sam@forgeaccel.example', relationship: 'dependent', role: 'Partner, Forge Accelerator' },
    { name: 'Alex Chen', email: 'alex@quietfield.example', relationship: 'independent', role: 'Staff Engineer, Quietfield' },
  ],
};

const OWNER = DARA.emails[0]!;

export function mail(p: { id: string; from: string; to?: string[]; date: string; subject: string; body: string; headers?: Record<string, string>; labels?: string[]; threadId?: string }): GmailMessage {
  const date = new Date(p.date).toUTCString();
  const to = p.to ?? [OWNER];
  return {
    id: p.id,
    threadId: p.threadId ?? p.id,
    from: p.from,
    to,
    date,
    subject: p.subject,
    body: p.body,
    headers: p.headers ?? {},
    labels: p.labels ?? ['INBOX'],
    raw: buildEml(p.from, to, date, p.subject, p.body, p.headers ?? {}),
  };
}

function sent(p: { id: string; to: string; date: string; subject: string; body: string; threadId: string }): GmailMessage {
  return mail({ ...p, from: `Dara Voss <${OWNER}>`, to: [p.to], labels: ['SENT'] });
}

function event(p: { id: string; summary: string; start: string; end: string; organizer?: string; attendees: [string, CalendarEvent['attendees'][number]['responseStatus']][]; location?: string; description?: string; status?: CalendarEvent['status'] }): CalendarEvent {
  return {
    id: p.id,
    summary: p.summary,
    description: p.description ?? '',
    location: p.location,
    start: p.start,
    end: p.end,
    status: p.status ?? 'confirmed',
    organizer: p.organizer ? { email: p.organizer } : undefined,
    attendees: p.attendees.map(([email, responseStatus]) => ({ email, responseStatus, self: email === OWNER })),
    updated: p.start,
  };
}

// ---------------- evidence, grouped so scenarios can compose seeds ----------------

export const E = {
  accelerator: [
    mail({
      id: 'm-accel',
      from: 'Sam Ortiz <sam@forgeaccel.example>',
      date: '2026-02-20T17:00:00Z',
      subject: 'Congratulations: Loomwork is accepted to Forge Accelerator Batch F26',
      body: 'Hi Dara,\n\nCongratulations! Loomwork has been accepted to Forge Accelerator Batch F26. You were selected from 4,100 applications by our investment committee.\n\nThe batch announcement is live: https://forgeaccel.example/batches/f26\n\nWelcome aboard,\nSam Ortiz\nPartner, Forge Accelerator',
    }),
    sent({ id: 'm-accel-reply', threadId: 'm-accel', to: 'sam@forgeaccel.example', date: '2026-02-20T19:00:00Z', subject: 'Re: Congratulations: Loomwork is accepted to Forge Accelerator Batch F26', body: 'Thank you Sam, we are thrilled and ready to get to work.' }),
  ],
  safe: [
    mail({
      id: 'm-safe',
      from: 'SafeHub <notifications@safehub.example>',
      date: '2026-03-05T15:00:00Z',
      subject: 'Congratulations! Your SAFE financing has closed',
      body: 'Hi Dara,\n\nCongratulations on closing your round. The SAFE (simple agreement for future equity) for Loomwork, Inc. has closed with $750,000 from 6 investors at a $9M post-money valuation cap.\n\nView the closing documents in your dashboard.\n\nSafeHub',
    }),
  ],
  equity: [
    mail({
      id: 'm-equity',
      from: 'CapTable <notices@captable.example>',
      date: '2025-10-02T16:00:00Z',
      subject: 'Executed: Founder Stock Purchase Agreement',
      body: 'Dara Voss purchased 8,000,000 shares of common stock of Loomwork, Inc. under the Founder Stock Purchase Agreement dated October 1, 2025. The shares vest over four years.\n\nCapTable',
    }),
  ],
  press: [
    mail({
      id: 'm-press',
      from: 'Jordan Lee <jlee@devtoolsweekly.example>',
      date: '2026-03-18T14:00:00Z',
      subject: 'Your profile is live on Devtools Weekly',
      body: 'Hi Dara,\n\nThanks again for the interview. The story is live: "Loomwork\'s Dara Voss wants to end flaky CI"\nhttps://devtoolsweekly.example/2026/03/loomwork-dara-voss-flaky-ci\n\nBest,\nJordan Lee, Senior Reporter, Devtools Weekly',
    }),
  ],
  pressAlert: [
    mail({
      id: 'm-alert',
      from: 'Google Alerts <googlealerts-noreply@google.com>',
      date: '2026-03-19T08:00:00Z',
      subject: 'Google Alert - "Dara Voss"',
      headers: { 'List-Unsubscribe': '<https://www.google.com/alerts/unsubscribe?x=1>' },
      body: 'Google Alert - "Dara Voss"\n\nNEWS\n\nLoomwork\'s Dara Voss wants to end flaky CI\nDevtools Weekly\nhttps://devtoolsweekly.example/2026/03/loomwork-dara-voss-flaky-ci\n\nUnsubscribe from this Google Alert: https://www.google.com/alerts/unsubscribe?x=1',
    }),
  ],
  forwarded: [
    mail({
      id: 'm-fwd',
      from: 'Ren Park <ren@loomwork.example>',
      date: '2026-06-02T10:00:00Z',
      subject: 'Fwd: The Build Report interview with Dara Voss is out',
      body: 'Dara, saw this!\n\n---------- Forwarded message ---------\nFrom: The Build Report <editors@buildreport.example>\nDate: Tue, 19 May 2026 09:14:00 -0700\nSubject: The Build Report interview with Dara Voss is out\nTo: <dara@loomwork.example>\n\nHi Dara,\n\nOur interview with Dara Voss of Loomwork is published: https://buildreport.example/interviews/dara-voss\n\nThe Build Report editors',
    }),
  ],
  podcast: [
    mail({
      id: 'm-pod',
      from: 'Mina Cho <mina@shipitpod.example>',
      date: '2026-07-08T18:00:00Z',
      subject: 'Episode 212 is live: Dara Voss on deterministic test infra',
      body: 'Hi Dara, thanks for coming on Ship It. Episode 212 is live: https://shipitpod.example/episodes/212\n\nMina',
    }),
  ],
  incorporation: [
    mail({
      id: 'm-inc',
      from: 'Delaware Filings <filings@corpregistry.example>',
      date: '2025-09-22T15:00:00Z',
      subject: 'Certificate of Incorporation filed: Loomwork, Inc.',
      body: 'The Certificate of Incorporation for Loomwork, Inc. was filed on September 22, 2025. Incorporator: Dara Voss. Board consent and bylaws adopted.\n\nDelaware Filings',
    }),
  ],
  award: [
    mail({
      id: 'm-award',
      from: 'Launchfest Awards <awards@launchfest.example>',
      date: '2026-04-11T20:00:00Z',
      subject: 'Winner: Best Developer Tool at Launchfest 2026',
      body: "Dear Dara,\n\nCongratulations. Loomwork's Flakehound is the winner of Best Developer Tool at Launchfest 2026. Entries were judged by a panel of 9 engineers on technical depth and adoption; 310 entrants competed this year.\n\nWinners: https://launchfest.example/2026/winners\n\nLaunchfest Awards Committee",
    }),
  ],
  fellowship: [
    mail({
      id: 'm-ridge',
      from: 'Ridgeline Fellows <admissions@ridgelinefellows.example>',
      date: '2026-05-12T16:00:00Z',
      subject: 'Welcome to the Ridgeline Fellowship',
      body: "Dear Dara,\n\nOur selection committee has admitted you as a 2026 Ridgeline Fellow. Fellows are nominated by prior fellows and reviewed by a committee of engineers and investors; this year's acceptance rate was 2%.\n\nhttps://ridgelinefellows.example/2026-fellows",
    }),
  ],
  hackmesa: {
    gmail: [
      mail({
        id: 'm-hm-invite',
        from: 'Marco Ellis <marco@hackmesa.example>',
        date: '2025-10-20T17:00:00Z',
        subject: 'Invitation to judge HackMesa 2026',
        body: 'Hi Dara,\n\nWe would like to invite you to serve as a judge at HackMesa 2026, a student hackathon at Mesa State University, on January 24, 2026. Judges score final projects on technical depth and impact.\n\nMarco Ellis\nLead Organizer, HackMesa',
      }),
      sent({ id: 'm-hm-reply', threadId: 'm-hm-invite', to: 'marco@hackmesa.example', date: '2025-10-21T09:00:00Z', subject: 'Re: Invitation to judge HackMesa 2026', body: "Hi Marco, I'd be glad to judge. Count me in!" }),
      mail({
        id: 'm-hm-thanks',
        from: 'Marco Ellis <marco@hackmesa.example>',
        date: '2026-01-26T18:00:00Z',
        subject: 'Thank you for judging HackMesa 2026',
        body: 'Hi Dara,\n\nThank you for judging HackMesa 2026. You judged 62 submissions from 400 student hackers, and the teams loved your feedback.\n\nMarco',
      }),
    ],
    calendar: [
      event({
        id: 'ev-hm',
        summary: 'Judge: HackMesa 2026',
        start: '2026-01-24T17:00:00Z',
        end: '2026-01-25T01:00:00Z',
        organizer: 'marco@hackmesa.example',
        attendees: [
          [OWNER, 'accepted'],
          ['marco@hackmesa.example', 'accepted'],
        ],
        location: 'Mesa State University',
        description: 'Student hackathon judging. https://hackmesa.example/2026',
      }),
    ],
  },
  buildnight: {
    gmail: [
      mail({
        id: 'm-bn-invite',
        from: 'Priya Raman <priya@buildnight.example>',
        date: '2026-02-02T17:00:00Z',
        subject: 'Would you judge Spring Build Night?',
        body: 'Hi Dara,\n\nWe invite you to be one of our judges for Spring Build Night on March 14, 2026.\n\nPriya Raman\nProgram Director, Build Night',
      }),
      sent({ id: 'm-bn-reply', threadId: 'm-bn-invite', to: 'priya@buildnight.example', date: '2026-02-03T09:00:00Z', subject: 'Re: Would you judge Spring Build Night?', body: 'Happy to judge! See you on the 14th.' }),
      mail({
        id: 'm-bn-cert',
        from: 'Priya Raman <priya@buildnight.example>',
        date: '2026-03-16T17:00:00Z',
        subject: 'Your judging certificate: Spring Build Night',
        body: 'Hi Dara,\n\nThanks for judging! Attached is your certificate of judging. You evaluated 40 submissions.\n\nPriya',
      }),
    ],
    calendar: [
      event({
        id: 'ev-bn',
        summary: 'Judge: Spring Build Night',
        start: '2026-03-14T01:00:00Z',
        end: '2026-03-14T05:00:00Z',
        organizer: 'priya@buildnight.example',
        attendees: [
          [OWNER, 'accepted'],
          ['priya@buildnight.example', 'accepted'],
        ],
        location: 'Build Night Hall',
        description: 'Judging panel. https://buildnight.example/spring',
      }),
    ],
  },
  devjamDeclined: [
    mail({ id: 'm-dj-invite', from: 'DevJam Judges <judging@devjam.example>', date: '2026-04-02T17:00:00Z', subject: 'Invitation to judge DevJam 2026', body: 'Hi Dara,\n\nWe invite you to serve as a judge for DevJam 2026 on May 9.\n\nDevJam' }),
    sent({ id: 'm-dj-reply', threadId: 'm-dj-invite', to: 'judging@devjam.example', date: '2026-04-03T09:00:00Z', subject: 'Re: Invitation to judge DevJam 2026', body: "Thanks for thinking of me. Unfortunately I can't make it this year." }),
  ],
  codecraftUnanswered: [
    mail({ id: 'm-cc-invite', from: 'CodeCraft <judges@codecraft.example>', date: '2026-08-30T17:00:00Z', subject: 'Invitation to judge CodeCraft Hack', body: "Hi Dara,\n\nWe'd love to invite you to be a judge at CodeCraft Hack on October 18, 2026.\n\nCodeCraft" }),
  ],
  rising: [
    mail({ id: 'm-rising', from: 'Rising Builders <hello@risingbuilders.example>', date: '2026-06-20T15:00:00Z', subject: "You've been named a 2026 Rising Builder", body: 'Hi Dara, you have been named a 2026 Rising Builder. Share the badge on your profile! https://risingbuilders.example/2026' }),
  ],
  spanish: [
    mail({
      id: 'm-es',
      from: 'El Mundo Tech <redaccion@elmundotech.example>',
      date: '2026-07-22T12:00:00Z',
      subject: 'Entrevista: Dara Voss y el futuro de las pruebas de software',
      body: 'Hola Dara, la entrevista con Dara Voss sobre Loomwork y el futuro de las pruebas de software está publicada en nuestra edición de julio. Gracias por tu tiempo y por compartir tu experiencia con los lectores de la revista. https://elmundotech.example/entrevista-dara-voss',
    }),
  ],
  medium: [
    mail({ id: 'm-medium', from: 'Medium <noreply@medium.example>', date: '2026-04-28T13:00:00Z', subject: 'Your story was published: Why flaky tests are a product problem', body: 'Dara Voss, your story "Why flaky tests are a product problem" was published. https://medium.example/@daravoss/why-flaky-tests' }),
  ],
  pressRelease: [
    mail({
      id: 'm-pr',
      from: 'PRWire <distribution@prwire.example>',
      date: '2026-08-20T13:00:00Z',
      subject: 'Distributed: Loomwork launches Flakehound 2.0',
      body: 'FOR IMMEDIATE RELEASE\n\nLoomwork launches Flakehound 2.0, a deterministic test runner. "Flaky tests are a tax on every team," said Dara Voss, founder of Loomwork.\n\nDistributed via PRWire.',
    }),
  ],
};

export const REPOS: Record<string, { repos: GithubRepo[]; reviews: GithubReview[] }> = {
  dvoss: {
    repos: [
      { fullName: 'dvoss/dotfiles-kit', owner: 'dvoss', name: 'dotfiles-kit', description: 'Opinionated dotfiles', stars: 12, forks: 1, dependents: 0, stargazers: ['dvoss', 'dvoss-alt', 'dvoss-bot', 'dv-test1', 'dv-test2', 'dv-test3', 'dv-test4', 'dv-test5', 'kai-m', 'lena-o', 'tomas-r', 'aiko-n'], createdAt: '2025-12-01T00:00:00Z', pushedAt: '2026-08-01T00:00:00Z', archived: false, releases: 0, htmlUrl: 'https://github.com/dvoss/dotfiles-kit' },
      { fullName: 'dvoss/notes', owner: 'dvoss', name: 'notes', description: 'Scratch notes', stars: 0, forks: 0, dependents: 0, stargazers: [], createdAt: '2026-01-10T00:00:00Z', pushedAt: '2026-02-01T00:00:00Z', archived: false, releases: 0, htmlUrl: 'https://github.com/dvoss/notes' },
    ],
    reviews: [
      { id: 'r-orbit', repoFullName: 'orbit-ci/orbit', repoOwner: 'orbit-ci', repoStars: 4800, prNumber: 1432, prTitle: 'Deterministic retry scheduler', state: 'CHANGES_REQUESTED', submittedAt: '2026-05-02T16:00:00Z', htmlUrl: 'https://github.com/orbit-ci/orbit/pull/1432#pullrequestreview-1', body: 'Reviewed the retry scheduler; requested a fix for the jitter seed before merge.' },
    ],
  },
  loomwork: {
    repos: [
      { fullName: 'loomwork/flakehound', owner: 'loomwork', name: 'flakehound', description: 'Find and quarantine flaky tests', stars: 2340, forks: 188, dependents: 140, stargazers: ['dvoss', 'dvoss-alt', 'kai-m', 'lena-o'], createdAt: '2025-11-03T00:00:00Z', pushedAt: '2026-09-10T00:00:00Z', archived: false, releases: 14, htmlUrl: 'https://github.com/loomwork/flakehound' },
    ],
    reviews: [],
  },
};

export const POSTS: LinkedinPost[] = [
  { id: 'li-dtw', authorName: 'Devtools Weekly', authorType: 'publication', authorDomain: 'devtoolsweekly.example', text: "New on Devtools Weekly, featuring Loomwork's Dara Voss: https://devtoolsweekly.example/2026/03/loomwork-dara-voss-flaky-ci", url: 'https://devtoolsweekly.example/2026/03/loomwork-dara-voss-flaky-ci', createdAt: '2026-03-18T17:00:00Z' },
  { id: 'li-sn', authorName: 'Signal & Noise Magazine', authorType: 'publication', authorDomain: 'signalnoise.example', text: 'Featuring Dara Voss of Loomwork in our list of 20 founders fixing developer productivity: https://signalnoise.example/2026/20-founders', url: 'https://signalnoise.example/2026/20-founders', createdAt: '2026-08-05T15:00:00Z' },
  { id: 'li-oti', authorName: 'Open Tools Index', authorType: 'publication', authorDomain: 'opentoolsindex.example', text: 'This quarter we are featuring Flakehound by Dara Voss: https://opentoolsindex.example/q3', url: 'https://opentoolsindex.example/q3', createdAt: null },
  { id: 'li-forge', authorName: 'Forge Accelerator', authorType: 'program', authorDomain: 'forgeaccel.example', text: 'Meet Batch F26: 41 companies, including Loomwork. https://forgeaccel.example/batches/f26', url: 'https://forgeaccel.example/batches/f26', createdAt: '2026-02-24T15:00:00Z' },
  { id: 'li-launchfest', authorName: 'Launchfest', authorType: 'program', authorDomain: 'launchfest.example', text: 'The Launchfest 2026 results are out. https://launchfest.example/2026/winners', url: 'https://launchfest.example/2026/winners', createdAt: '2026-04-12T15:00:00Z' },
  ...['Kai M.', 'Lena O.', 'Tomas R.', 'Aiko N.', 'Ren Park'].map((name, i) => ({ id: `li-friend-${i + 1}`, authorName: name, authorType: 'person' as const, text: `So proud of my friend Dara Voss and the Loomwork team this year. Onward!`, url: null, createdAt: `2026-0${(i % 8) + 1}-15T12:00:00Z` })),
];

// ---------------- noise ----------------

const SUBJECTS = ['Quick sync Thursday?', "Notes from today's call", 'Intro: Ren and Kai', 'Hiring loop schedule', 'Lunch next week?', 'Re: design review comments', 'Customer call recap', 'Offsite logistics', 'Can you look at my PR?', 'Travel plans for October'];
const BODIES = ['Does 3pm work for you? Let me know.', 'Sharing the notes below. Nothing urgent.', 'Looping in Kai, who is building CI tooling at Parcel.', 'Here is the doc with the plan for next week.', 'Whenever works for you is fine.'];
const PEOPLE = ['kai@parcel.example', 'lena@northwind.example', 'tomas@brightline.example', 'aiko@kumo.example', 'ren@loomwork.example', 'ops@loomwork.example'];

export function noiseMail(count = 300, seed = 7): GmailMessage[] {
  const rnd = prng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const start = Date.parse('2025-09-15T00:00:00Z');
  const span = Date.parse('2026-09-12T00:00:00Z') - start;
  const out: GmailMessage[] = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(start + Math.floor(rnd() * span)).toISOString();
    const r = rnd();
    if (r < 0.4) {
      out.push(mail({ id: `n-news-${i}`, from: 'Dev Digest <digest@news.devdigest.example>', date, subject: `This week in developer tools #${i}`, headers: { 'List-Unsubscribe': '<https://news.devdigest.example/unsubscribe>' }, body: 'Top stories this week in CI, build systems and editors.\n\nUnsubscribe: https://news.devdigest.example/unsubscribe' }));
    } else if (r < 0.67) {
      out.push(mail({ id: `n-rcpt-${i}`, from: 'CloudHost Billing <billing@cloudhost.example>', date, subject: `Your receipt from CloudHost #${1000 + i}`, body: 'Thanks for your payment. Amount: $49.00.' }));
    } else {
      out.push(mail({ id: `n-coord-${i}`, from: pick(PEOPLE), date, subject: pick(SUBJECTS), body: pick(BODIES) }));
    }
  }
  return out;
}

export function noiseCalendar(): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (let i = 0; i < 20; i++) {
    const day = new Date(Date.parse('2025-10-06T16:00:00Z') + i * 16 * 86_400_000);
    events.push(event({ id: `ev-sync-${i}`, summary: i % 2 ? 'Weekly team sync' : '1:1 with Ren', start: day.toISOString(), end: new Date(day.getTime() + 1800_000).toISOString(), organizer: OWNER, attendees: [[OWNER, 'accepted'], ['ren@loomwork.example', 'accepted']] }));
  }
  events.push(event({ id: 'ev-focus', summary: 'Focus time', start: '2026-05-05T16:00:00Z', end: '2026-05-05T19:00:00Z', attendees: [] }));
  events.push(event({ id: 'ev-dinner', summary: 'Investor dinner', start: '2026-06-11T02:00:00Z', end: '2026-06-11T04:00:00Z', organizer: OWNER, attendees: [[OWNER, 'accepted'], ['kai@parcel.example', 'accepted']], status: 'cancelled' }));
  return events;
}

// ---------------- seeds ----------------

export interface SeedParts {
  gmail?: GmailMessage[];
  calendar?: CalendarEvent[];
  github?: TwinSeed['github'];
  linkedin?: LinkedinPost[] | null;
  noise?: boolean;
  followers?: number;
}

export function seed(parts: SeedParts): TwinSeed {
  return {
    owner: OWNER,
    gmail: [...(parts.gmail ?? []), ...(parts.noise ? noiseMail() : noiseMail(20, 11))],
    calendar: [...(parts.calendar ?? []), ...(parts.noise ? noiseCalendar() : [])],
    github: parts.github ?? {},
    linkedin: parts.linkedin === null ? null : { posts: parts.linkedin ?? [], followers: parts.followers ?? 18_400 },
  };
}

export function fullYearSeed(): TwinSeed {
  return seed({
    gmail: [
      ...E.accelerator,
      ...E.safe,
      ...E.equity,
      ...E.press,
      ...E.pressAlert,
      ...E.forwarded,
      ...E.podcast,
      ...E.incorporation,
      ...E.award,
      ...E.fellowship,
      ...E.hackmesa.gmail,
      ...E.buildnight.gmail,
      ...E.devjamDeclined,
      ...E.codecraftUnanswered,
      ...E.rising,
      ...E.spanish,
      ...E.medium,
      ...E.pressRelease,
    ],
    calendar: [...E.hackmesa.calendar, ...E.buildnight.calendar],
    github: REPOS,
    linkedin: POSTS,
    noise: true,
  });
}

// ---------------- ground truth (PRD 12.1, 12.2) ----------------

export interface Expected {
  label: string;
  /** Any source of the exhibit, as `app:id`. */
  source: string;
  kind: 'qualifying' | 'needs_attorney' | 'trap' | 'must_count';
  criteria?: O1Criterion[];
  status: Status;
  eb1a_status: Status;
  event_date?: string | null;
  comparable_for?: O1Criterion[];
  rule_id?: string;
  mergedSources?: string[];
  /** For traps: criteria the item must never be qualifying under. */
  never?: O1Criterion[];
}

export const GROUND_TRUTH: Expected[] = [
  { label: 'Accelerator acceptance', source: 'gmail:m-accel', kind: 'must_count', criteria: [1, 2], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2026-02-20', rule_id: 'D-accelerator-acceptance' },
  { label: 'SAFE closing', source: 'gmail:m-safe', kind: 'must_count', criteria: [8], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2026-03-05', never: [1] },
  { label: 'Founder equity', source: 'gmail:m-equity', kind: 'must_count', criteria: [8], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2025-10-02', comparable_for: [8] },
  { label: 'Devtools Weekly profile', source: 'gmail:m-press', kind: 'qualifying', criteria: [3], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2026-03-18', mergedSources: ['gmail:m-press', 'gmail:m-alert', 'linkedin:li-dtw'] },
  { label: 'Build Report interview (forwarded)', source: 'gmail:m-fwd', kind: 'qualifying', criteria: [3], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2026-05-19' },
  { label: 'Ship It podcast', source: 'gmail:m-pod', kind: 'qualifying', criteria: [3], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2026-07-08' },
  { label: 'HackMesa judging (student hackathon)', source: 'gmail:m-hm-invite', kind: 'must_count', criteria: [4], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2026-01-24', rule_id: 'D-student-hackathon-judging' },
  { label: 'Spring Build Night judging', source: 'gmail:m-bn-invite', kind: 'qualifying', criteria: [4], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2026-03-14' },
  { label: 'Code review on orbit-ci/orbit', source: 'github:review:r-orbit', kind: 'must_count', criteria: [4], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2026-05-02', comparable_for: [4] },
  { label: 'Flakehound adoption', source: 'github:loomwork/flakehound@2026-09-13', kind: 'qualifying', criteria: [5, 3], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2025-11-03', comparable_for: [3] },
  { label: 'Incorporation', source: 'gmail:m-inc', kind: 'qualifying', criteria: [7], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2025-09-22' },
  { label: 'Launchfest award', source: 'gmail:m-award', kind: 'qualifying', criteria: [1], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2026-04-11' },
  { label: 'Ridgeline Fellowship', source: 'gmail:m-ridge', kind: 'qualifying', criteria: [2], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2026-05-12' },
  { label: 'Signal & Noise list', source: 'linkedin:li-sn', kind: 'qualifying', criteria: [3], status: 'qualifying', eb1a_status: 'qualifying', event_date: '2026-08-05' },
  { label: 'Rising Builder (no selection criteria)', source: 'gmail:m-rising', kind: 'needs_attorney', criteria: [1], status: 'needs_attorney', eb1a_status: 'needs_attorney' },
  { label: 'Open Tools Index (undated)', source: 'linkedin:li-oti', kind: 'needs_attorney', criteria: [3], status: 'needs_attorney', eb1a_status: 'needs_attorney', event_date: null },
  { label: 'El Mundo Tech interview (Spanish)', source: 'gmail:m-es', kind: 'needs_attorney', criteria: [3], status: 'needs_attorney', eb1a_status: 'needs_attorney' },
  { label: 'Self-authored Medium story', source: 'gmail:m-medium', kind: 'trap', status: 'rejected', eb1a_status: 'rejected', never: [3] },
  { label: 'Press release', source: 'gmail:m-pr', kind: 'trap', status: 'rejected', eb1a_status: 'rejected', never: [3] },
  { label: 'Declined DevJam invite', source: 'gmail:m-dj-invite', kind: 'trap', status: 'rejected', eb1a_status: 'rejected', never: [4] },
  { label: 'Unanswered CodeCraft invite', source: 'gmail:m-cc-invite', kind: 'trap', status: 'building', eb1a_status: 'building', never: [4] },
  { label: "Stars from the founder's own accounts", source: 'github:dvoss/dotfiles-kit@2026-09-13', kind: 'trap', status: 'building', eb1a_status: 'building', never: [3, 5] },
];

import type { WebFixtures } from '../src/research/fixture.js';

// Recorded pages and research proposals for the synthetic founder's outlets (PRD 12.3, S17).
// Every outlet and verifier here is fictional (.example). The bad cases are seeded on purpose:
// a conflicting pair (Build Report), a news story repeating a media-kit number (newsroundup),
// a statistics aggregator (statsaggregator) and a hallucinated figure (Signal & Noise).

const page = (title: string, ...paragraphs: string[]) => ({ status: 200, body: `<html><head><title>${title}</title></head><body>${paragraphs.map((p) => `<p>${p}</p>`).join('')}</body></html>` });

export const WEB_FIXTURES: WebFixtures = {
  pages: {
    'https://devtoolsweekly.example/media-kit': page('Advertise with Devtools Weekly', 'Devtools Weekly reaches 1,200,000 monthly unique visitors.', 'Our readers are engineers and engineering leaders.'),
    'https://amr.example/publishers/devtools-weekly': page('Audited Media Registry (synthetic): Devtools Weekly', 'Devtools Weekly: 1,150,000 audited monthly unique visitors (August 2026).'),
    'https://forgeaccel.example/about': page('About Forge Accelerator', 'Forge Accelerator accepted 1% of applicants to Batch F26 (41 of 4,100).'),
    'https://forgeaccel.example/annual-letter-2026': page('Forge annual letter', 'We accepted 1% of the companies that applied this year.'),
    'https://shipitpod.example/sponsor': page('Sponsor Ship It', 'Ship It averages 88,000 downloads per episode.'),
    'https://podaudit.example/shows/ship-it': page('PodAudit (synthetic): Ship It', 'Ship It: 85,000 verified downloads per episode (July 2026).'),
    'https://newsroundup.example/ship-it-podcast-growth': page('News roundup', 'Ship It gets 90,000 downloads per episode, according to its media kit.'),
    'https://buildreport.example/advertise': page('Advertise in The Build Report', 'The Build Report reaches 500,000 monthly unique visitors.'),
    'https://amr.example/publishers/the-build-report': page('Audited Media Registry (synthetic): The Build Report', 'The Build Report: 210,000 audited monthly unique visitors (May 2026).'),
    'https://signalnoise.example/about': page('About Signal & Noise', 'Signal &amp; Noise is an independent magazine about developer productivity.'),
    'https://statsaggregator.example/signal-noise': page('Stats aggregator', 'Signal &amp; Noise has an estimated 2,400,000 monthly visitors.'),
    'https://hackmesa.example/2026/results': page('HackMesa 2026 results', 'This year 62 projects were submitted to HackMesa.'),
    'https://hackindex.example/events/hackmesa-2026': page('HackIndex (synthetic): HackMesa 2026', 'Submissions: 62 (HackMesa, January 2026).'),
    'https://buildnight.example/spring/results': page('Spring Build Night results', 'Teams competing at Spring Build Night: 40.'),
    'https://hackindex.example/events/spring-build-night': page('HackIndex (synthetic): Spring Build Night', 'Submissions: 40 (Spring Build Night, March 2026).'),
    'https://ridgelinefellows.example/2026-fellows': page('Ridgeline Fellows 2026', 'We admitted 2% of nominated founders to the 2026 class.'),
    'https://ridgelinefellows.example/selection': page('How Ridgeline selects fellows', 'Only 2% of nominees are admitted each year.'),
    'https://launchfest.example/2026/winners': page('Launchfest 2026 winners', 'A field of 310 entrants competed at Launchfest.'),
  },
  research: {
    'devtoolsweekly.example': [
      { measure: 'monthly unique visitors', value: 1_200_000, unit: 'monthly unique visitors', sentence: 'Devtools Weekly reaches 1,200,000 monthly unique visitors.', url: 'https://devtoolsweekly.example/media-kit', publisher: 'Devtools Weekly', kind: 'primary', as_of: '2026-08-01' },
      { measure: 'monthly unique visitors', value: 1_150_000, unit: 'monthly unique visitors', sentence: 'Devtools Weekly: 1,150,000 audited monthly unique visitors (August 2026).', url: 'https://amr.example/publishers/devtools-weekly', publisher: 'Audited Media Registry (synthetic)', kind: 'verifier', as_of: '2026-08-31' },
    ],
    'forgeaccel.example': [
      { measure: 'acceptance rate', value: 1, unit: 'percent of applicants accepted', sentence: 'Forge Accelerator accepted 1% of applicants to Batch F26 (41 of 4,100).', url: 'https://forgeaccel.example/about', publisher: 'Forge Accelerator', kind: 'primary', as_of: '2026-02-15' },
      { measure: 'acceptance rate', value: 1, unit: 'percent of applicants accepted', sentence: 'We accepted 1% of the companies that applied this year.', url: 'https://forgeaccel.example/annual-letter-2026', publisher: 'Forge Accelerator annual letter', kind: 'issuer_second', as_of: '2026-03-01' },
    ],
    'shipitpod.example': [
      { measure: 'downloads per episode', value: 90_000, unit: 'downloads per episode', sentence: 'Ship It gets 90,000 downloads per episode, according to its media kit.', url: 'https://newsroundup.example/ship-it-podcast-growth', publisher: 'News Roundup', kind: 'primary', as_of: '2026-07-10' },
      { measure: 'downloads per episode', value: 88_000, unit: 'downloads per episode', sentence: 'Ship It averages 88,000 downloads per episode.', url: 'https://shipitpod.example/sponsor', publisher: 'Ship It', kind: 'primary', as_of: '2026-07-01' },
      { measure: 'downloads per episode', value: 85_000, unit: 'downloads per episode', sentence: 'Ship It: 85,000 verified downloads per episode (July 2026).', url: 'https://podaudit.example/shows/ship-it', publisher: 'PodAudit (synthetic)', kind: 'verifier', as_of: '2026-07-31' },
    ],
    'buildreport.example': [
      { measure: 'monthly unique visitors', value: 500_000, unit: 'monthly unique visitors', sentence: 'The Build Report reaches 500,000 monthly unique visitors.', url: 'https://buildreport.example/advertise', publisher: 'The Build Report', kind: 'primary', as_of: '2026-05-01' },
      { measure: 'monthly unique visitors', value: 210_000, unit: 'monthly unique visitors', sentence: 'The Build Report: 210,000 audited monthly unique visitors (May 2026).', url: 'https://amr.example/publishers/the-build-report', publisher: 'Audited Media Registry (synthetic)', kind: 'verifier', as_of: '2026-05-31' },
    ],
    'signalnoise.example': [
      { measure: 'monthly readers', value: 2_400_000, unit: 'monthly readers', sentence: 'Signal & Noise has an estimated 2,400,000 monthly visitors.', url: 'https://statsaggregator.example/signal-noise', publisher: 'Stats Aggregator', kind: 'verifier', as_of: '2026-08-01' },
      { measure: 'monthly readers', value: 3_000_000, unit: 'monthly readers', sentence: 'Signal & Noise reaches 3,000,000 readers every month.', url: 'https://signalnoise.example/about', publisher: 'Signal & Noise', kind: 'primary', as_of: '2026-08-01' },
    ],
    'hackmesa.example': [
      { measure: 'submissions', value: 62, unit: 'submissions', sentence: 'This year 62 projects were submitted to HackMesa.', url: 'https://hackmesa.example/2026/results', publisher: 'HackMesa', kind: 'primary', as_of: '2026-01-26' },
      { measure: 'submissions', value: 62, unit: 'submissions', sentence: 'Submissions: 62 (HackMesa, January 2026).', url: 'https://hackindex.example/events/hackmesa-2026', publisher: 'HackIndex (synthetic)', kind: 'verifier', as_of: '2026-01-31' },
    ],
    'buildnight.example': [
      { measure: 'submissions', value: 40, unit: 'submissions', sentence: 'Teams competing at Spring Build Night: 40.', url: 'https://buildnight.example/spring/results', publisher: 'Build Night', kind: 'primary', as_of: '2026-03-15' },
      { measure: 'submissions', value: 40, unit: 'submissions', sentence: 'Submissions: 40 (Spring Build Night, March 2026).', url: 'https://hackindex.example/events/spring-build-night', publisher: 'HackIndex (synthetic)', kind: 'verifier', as_of: '2026-03-31' },
    ],
    'ridgelinefellows.example': [
      { measure: 'acceptance rate', value: 2, unit: 'percent of nominees admitted', sentence: 'We admitted 2% of nominated founders to the 2026 class.', url: 'https://ridgelinefellows.example/2026-fellows', publisher: 'Ridgeline Fellows', kind: 'primary', as_of: '2026-05-12' },
      { measure: 'acceptance rate', value: 2, unit: 'percent of nominees admitted', sentence: 'Only 2% of nominees are admitted each year.', url: 'https://ridgelinefellows.example/selection', publisher: 'Ridgeline Fellows selection page', kind: 'issuer_second', as_of: '2026-05-01' },
    ],
    'launchfest.example': [
      { measure: 'entrants', value: 310, unit: 'entrants', sentence: 'A field of 310 entrants competed at Launchfest.', url: 'https://launchfest.example/2026/winners', publisher: 'Launchfest', kind: 'primary', as_of: '2026-04-11' },
    ],
  },
};

import { readFileSync } from 'node:fs';
import type { FetchResult, ResearchCandidate, ResearchRequest, ResearchResult, Researcher, WebFetcher } from './types.js';

// The open web is not a twin (PRD 12.3). Graded attempts replay recorded pages and research
// proposals from a fixture file; the harness's bad cases (conflicting pair, repeated media-kit
// number, aggregator, hallucinated figure) are injected there. This repo's fixtures describe
// fictional outlets on .example domains, so no figure in them is presented as a real statistic.

export interface WebFixtures {
  pages: Record<string, { status: number; contentType?: string; body: string }>;
  research: Record<string, ResearchCandidate[]>;
}

export function loadWebFixtures(path: string): WebFixtures {
  return JSON.parse(readFileSync(path, 'utf8')) as WebFixtures;
}

export class FixtureFetcher implements WebFetcher {
  readonly kind = 'fixture' as const;
  readonly requested: string[] = [];
  constructor(private readonly fixtures: WebFixtures) {}

  async fetch(url: string): Promise<FetchResult> {
    this.requested.push(url);
    const page = this.fixtures.pages[url];
    if (!page) return { url, status: 404, contentType: 'text/html', body: '' };
    return { url, status: page.status, contentType: page.contentType ?? 'text/html', body: page.body };
  }
}

export class FixtureResearcher implements Researcher {
  readonly kind = 'fixture' as const;
  readonly requests: ResearchRequest[] = [];
  constructor(private readonly fixtures: WebFixtures) {}

  async propose(req: ResearchRequest): Promise<ResearchResult> {
    this.requests.push(req);
    return { candidates: structuredClone(this.fixtures.research[req.issuerDomain] ?? []), searches: 0, errors: [] };
  }
}

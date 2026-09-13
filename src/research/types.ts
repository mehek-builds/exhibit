import type { ExhibitRecord, FigureKind, FounderProfile, O1Criterion } from '../types.js';

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export interface WebFetcher {
  readonly kind: 'live' | 'fixture';
  fetch(url: string): Promise<FetchResult>;
}

/** A figure the research model proposes. Nothing here is trusted until code fetches and checks it (6.11 step 2). */
export interface ResearchCandidate {
  measure: string;
  value: number;
  unit: string;
  sentence: string;
  url: string;
  publisher: string;
  kind: FigureKind;
  as_of: string;
}

export interface ResearchRequest {
  exhibit: ExhibitRecord;
  criterion: O1Criterion;
  issuerDomain: string;
  allowedDomains: string[];
  systemPrompt: string;
  /** For verifier APIs that need the founder's occupation code or handles (#8 benchmark, platform stats). */
  profile?: FounderProfile;
}

export interface ResearchResult {
  candidates: ResearchCandidate[];
  searches: number;
  /** Server-tool errors arrive inside HTTP 200 responses (7.5b); they are collected here, never thrown. */
  errors: string[];
}

export interface Researcher {
  readonly kind: 'anthropic' | 'fixture';
  propose(req: ResearchRequest): Promise<ResearchResult>;
}

// Shared types for Exhibit. Section numbers refer to docs/PRD.md.

/** `discovery` covers every public discovery source in 6.14; `meta.source` names which one. */
export type SourceApp = 'gmail' | 'calendar' | 'github' | 'linkedin' | 'discovery';

/** O-1A criteria, 8 CFR 214.2(o)(3)(iii)(B). */
export type O1Criterion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** EB-1A criteria, 8 CFR 204.5(h)(3). */
export type Eb1Criterion = 'i' | 'ii' | 'iii' | 'iv' | 'v' | 'vi' | 'vii' | 'viii' | 'ix' | 'x';

export type Status = 'qualifying' | 'building' | 'needs_attorney' | 'rejected';

export type EvidenceKind =
  | 'invitation'
  | 'service_proof'
  | 'press_about'
  | 'authored'
  | 'award'
  | 'acceptance'
  | 'adoption'
  | 'review'
  | 'role'
  | 'remuneration'
  | 'talk'
  | 'exhibition'
  | 'other';

export interface Person {
  name?: string;
  email?: string;
  domain?: string;
  handle?: string;
}

/** One item read from a source app, before redaction. `raw` is the original artifact. */
export interface SourceItem {
  app: SourceApp;
  /** Stable per-source dedupe key (6.1). */
  id: string;
  threadId?: string;
  /** Original date from the source's own metadata; null when the source carries none (E25). */
  date: string | null;
  /** When the item reached the founder (a forward date, a capture time). Never used as the exhibit date. */
  receivedAt?: string | null;
  title: string;
  text: string;
  author?: Person;
  recipients?: string[];
  url?: string | null;
  links?: string[];
  meta: Record<string, unknown>;
  raw: string;
  rawType: 'eml' | 'json';
}

export interface Redaction {
  type: 'passport' | 'a_number' | 'sevis' | 'i94' | 'dob' | 'address' | 'mrz';
  count: number;
}

/** What models, traces and logs are allowed to see (6.2). */
export type RedactedItem = Omit<SourceItem, 'raw'> & { redactions: Redaction[] };

export interface Classification {
  is_candidate: boolean;
  kind: EvidenceKind;
  quote: string;
  /** `structured` = decided from source metadata (calendar, GitHub) without a model call. */
  decided_by: 'prefilter' | 'structured' | 'model';
  reason?: string;
}

export interface Mapping {
  criteria: O1Criterion[];
  eb1a_criteria: Eb1Criterion[];
  /** O-1A status. */
  status: Status;
  eb1a_status: Status;
  /** Criteria this item supports as comparable evidence (5.1). */
  comparable_for: O1Criterion[];
  rule_id: string;
  reason: string;
  quote: string;
  decided_by: 'rule' | 'model';
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SourceRef {
  app: SourceApp;
  id: string;
  url?: string | null;
}

export interface ExhibitMetrics {
  [key: string]: number | string | undefined;
  observed_at?: string;
}

/** A verified candidate, ready to file or to record as building / not counted. */
export interface VerifiedItem {
  key: string;
  mapping: Mapping;
  title: string;
  issuer: string | null;
  event_date: string | null;
  url: string | null;
  sources: SourceRef[];
  /** The primary item whose raw artifact is filed. */
  primary: SourceItem;
  /** Every item that was merged into this one (6.5 cross-source merge). */
  members: SourceItem[];
  checks: Check[];
  metrics: ExhibitMetrics;
  highlights: string[];
  people: Person[];
}

export interface ExhibitRecord {
  exhibit_id: string;
  key: string;
  criteria: O1Criterion[];
  eb1a_criteria: Eb1Criterion[];
  status: Status;
  eb1a_status: Status;
  comparable: boolean;
  comparable_for: O1Criterion[];
  rule_id: string;
  metrics: ExhibitMetrics;
  title: string;
  issuer: string | null;
  event_date: string | null;
  captured_at: string;
  sources: SourceRef[];
  artifact_path: string;
  sha256: string;
  reason: string;
  version: number;
  supersedes?: string | null;
  people: Person[];
}

export interface Recommender {
  name: string;
  email: string;
  relationship: 'dependent' | 'independent';
  role: string;
}

export interface FounderProfile {
  name: string;
  aliases: string[];
  emails: string[];
  /** The founder's own company domain; items from it are self-sourced. */
  domain: string;
  company: string;
  githubLogins: string[];
  /** Accounts the founder controls (alts); their stars never count (E13). */
  ownAccounts: string[];
  linkedinId: string;
  field: string;
  targetFilingDate: string;
  recommenderCandidates: Recommender[];
  /** The verified number for the message thread (6.13), E.164. */
  phone?: string;
  /** Quiet hours for proactive texts (4.1); default 22:00 to 08:00. */
  quietHours?: { start: string; end: string; timeZone: string };
  routes?: ('O-1A' | 'EB-1A')[];
  /** How far back the backfill scans (4.1); default 2023-01-01. */
  scanSince?: string;
  /** Second identifiers for discovered items (constraint 16). */
  coauthors?: string[];
  /** Source refs (`app:id`) the founder opted in for machine translation (6.14, E67). */
  translationOptIn?: string[];
  jobTitle?: string;
  /** Standard Occupational Classification code for the BLS benchmark (#8). */
  socCode?: string;
  /** Addresses the founder controls; the only Dropbox Sign signers allowed on the day (constraint 18). */
  controlledEmails?: string[];
}

export interface Clock {
  now(): Date;
}

export type FigureKind = 'primary' | 'verifier' | 'issuer_second';
export type FigureLabel = 'independently_confirmed' | 'issuer_confirmed';
export type FigureStatus = 'pending' | 'approved' | 'denied' | 'conflicting' | 'insufficient_sources';

// The external apps Exhibit operates (PRD 7.5). Each interface is implemented twice:
// by the in-memory twins in src/twins/memory.ts and by the live clients in src/apps/live/,
// which also point at Arga twins through base-URL overrides. Agent code only sees these.

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  date: string;
  subject: string;
  body: string;
  headers: Record<string, string>;
  labels: string[];
  raw: string;
}

export interface OutgoingEmail {
  to: string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
}

export interface GmailApi {
  /** Inbox and sent mail, oldest first. Spam and trash are never returned. */
  listMessages(): Promise<GmailMessage[]>;
  send(email: OutgoingEmail): Promise<{ id: string; threadId: string }>;
}

export interface CalendarAttendee {
  email: string;
  displayName?: string;
  responseStatus: 'accepted' | 'declined' | 'needsAction' | 'tentative';
  self?: boolean;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string;
  location?: string;
  start: string;
  end: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  organizer?: { email: string; displayName?: string };
  attendees: CalendarAttendee[];
  htmlLink?: string;
  updated: string;
}

export interface CalendarApi {
  listEvents(): Promise<CalendarEvent[]>;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  size: number;
  sha256: string | null;
  createdTime: string;
  modifiedTime: string;
  appProperties: Record<string, string>;
}

export interface DrivePermission {
  id: string;
  role: 'owner' | 'writer' | 'commenter' | 'reader';
  type: 'user' | 'group' | 'domain' | 'anyone';
  emailAddress?: string;
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveApi {
  /** `null` parent means the root of My Drive. */
  findChild(parentId: string | null, name: string): Promise<DriveFile | null>;
  createFolder(parentId: string | null, name: string): Promise<DriveFile>;
  createFile(params: {
    parentId: string;
    name: string;
    mimeType: string;
    content: Uint8Array | string;
    appProperties?: Record<string, string>;
  }): Promise<DriveFile>;
  /** Only for derived binder documents (index, not-counted list, ledger export, context notes). */
  updateFileContent(fileId: string, content: Uint8Array | string): Promise<DriveFile>;
  moveFile(fileId: string, fromParentId: string, toParentId: string): Promise<DriveFile>;
  readFile(fileId: string): Promise<Uint8Array>;
  listChildren(parentId: string): Promise<DriveFile[]>;
  listPermissions(fileId: string): Promise<DrivePermission[]>;
}

export interface DocsApi {
  create(title: string): Promise<{ documentId: string }>;
  replaceText(documentId: string, text: string): Promise<void>;
  getText(documentId: string): Promise<string>;
}

export interface SheetsApi {
  create(title: string, headers: string[]): Promise<{ spreadsheetId: string }>;
  appendRows(spreadsheetId: string, rows: string[][]): Promise<void>;
  /** All rows including the header row. */
  readRows(spreadsheetId: string): Promise<string[][]>;
}

export interface GithubRepo {
  fullName: string;
  owner: string;
  name: string;
  description: string;
  stars: number;
  forks: number;
  dependents: number;
  stargazers: string[];
  createdAt: string;
  pushedAt: string;
  archived: boolean;
  releases: number;
  htmlUrl: string;
}

export interface GithubReview {
  id: string;
  repoFullName: string;
  repoOwner: string;
  repoStars: number;
  prNumber: number;
  prTitle: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  submittedAt: string;
  htmlUrl: string;
  body: string;
}

export interface GithubApi {
  listReposFor(login: string): Promise<GithubRepo[]>;
  listReviewsBy(login: string): Promise<GithubReview[]>;
}

export interface LinkedinPost {
  id: string;
  authorName: string;
  authorType: 'publication' | 'program' | 'person' | 'self';
  authorDomain?: string;
  text: string;
  url?: string | null;
  createdAt: string | null;
}

export interface LinkedinApi {
  listMentions(profileId: string): Promise<LinkedinPost[]>;
  getProfile(profileId: string): Promise<{ followers: number }>;
}

export interface TextMessage {
  sid: string;
  from: string;
  to: string;
  body: string;
  direction: 'inbound' | 'outbound';
  channel: 'sms' | 'whatsapp';
  dateSent: string;
}

/** Twilio Programmable Messaging (6.13): SMS in the Arga twin, WhatsApp Sandbox live. */
export interface TwilioApi {
  /** Exhibit's sender address (E.164, or `whatsapp:+1...`). */
  readonly sender: string;
  /** Inbound messages to the sender, oldest first. */
  listInbound(): Promise<TextMessage[]>;
  send(message: { to: string; body: string }): Promise<{ sid: string }>;
}

export interface Apps {
  gmail: GmailApi;
  calendar: CalendarApi;
  drive: DriveApi;
  docs: DocsApi;
  sheets: SheetsApi;
  github: GithubApi;
  linkedin: LinkedinApi | null;
  /** The founder's message thread (6.13); absent when the text channel is not configured. */
  twilio?: TwilioApi | null;
}

/** HTTP 410 from an Arga twin: the TTL lapsed (PRD 7.1). */
export class TwinExpiredError extends Error {
  readonly status = 410;
  constructor(app: string) {
    super(`${app} twin expired (410)`);
    this.name = 'TwinExpiredError';
  }
}

/** A twin endpoint that is only stubbed (`X-Twin-Stub`). Any hit on a dependent path fails the attempt. */
export class TwinStubError extends Error {
  constructor(readonly path: string) {
    super(`twin stub hit: ${path}`);
    this.name = 'TwinStubError';
  }
}

export class AppUnavailableError extends Error {
  constructor(readonly app: string) {
    super(`${app} unavailable`);
    this.name = 'AppUnavailableError';
  }
}

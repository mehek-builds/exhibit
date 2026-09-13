import type { CalendarEvent, GmailMessage } from '../src/apps/types.js';
import type { TwinSeed } from '../src/twins/memory.js';
import type { FounderProfile } from '../src/types.js';

// Converts a scenario's in-memory TwinSeed (src/twins/memory.ts) into what Arga needs to hold
// Dara Voss's synthetic year (PRD 7.1, 7.5, 12.3). Seeding runs in two steps, both verified against
// live Arga twins on 2026-09-13:
//
// 1. `seed_config` (passed to `client.scenarios.create`) creates the twins' skeleton only: an empty
//    mailbox and one calendar, which the Calendar twin then serves as `primary`. With no seeded
//    calendar at all, `calendars/primary/events` returns 404.
// 2. After the twin environment is ready, harness/arga-backend.ts inserts every seed message and
//    event through the twin's own Gmail and Calendar APIs (`gmailInsertBody`, `calendarInsertBody`).
//
// Why not seed the messages in `seed_config`: the Gmail twin's seed schema is
// `{subject, body, from, to[], labels, message_id, thread_id}` (read back from a scenario Arga
// generated itself). It has no date field and no raw field: every seeded message gets the twin's
// clock date, and a `raw` entry crashes seeding with a 500. Exhibit's verifier reads the original
// `Date:` header (PRD 6: the original date, not the forward), so the untouched RFC 822 original has
// to go in through `messages.insert`, which keeps the raw bytes, the Date header and the thread.
//
// Not seeded here:
// - GitHub: Arga's GitHub seed models repos, files, branches and issues, but not third-party
//   stargazers or the founder's reviews on other people's PRs, which are the #5 and #4 signals.
//   GitHub is read from the seeded fixture instead (PRD 7.1 fallback).
// - LinkedIn: Arga lists a LinkedIn twin, but Exhibit's LinkedIn client targets a guessed API
//   shape that has not been checked against it. Read from the seeded fixture.
// - Drive, Docs, Sheets: seeded empty, so every file, doc and sheet in a graded attempt is one the
//   agent created.

export type ArgaSeedConfig = Record<string, unknown>;

/** The Google twins Exhibit provisions on Arga (identifiers verified against GET /twins). */
export const ARGA_GOOGLE_TWINS = ['gmail', 'google_calendar', 'google_drive', 'google_docs', 'google_sheets'] as const;

export function toArgaSeedConfig(seed: TwinSeed, profile?: FounderProfile): Record<string, ArgaSeedConfig> {
  void seed;
  void profile;
  return {
    gmail: { messages: [] },
    google_calendar: { calendars: [{ name: 'Primary', timezone: 'UTC', events: [] }] },
    google_drive: { files: [] },
  };
}

/** Seed messages in the order they must be inserted: oldest first, so a reply's thread already
 * exists when it arrives. */
export function seedMessagesInOrder(seed: TwinSeed): GmailMessage[] {
  return [...seed.gmail].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

/** Request body for `POST gmail/v1/users/me/messages` (messages.insert). `twinThreadId` is the
 * twin's id for the seed thread, once its first message is in. */
export function gmailInsertBody(m: GmailMessage, twinThreadId?: string): { raw: string; labelIds: string[]; threadId?: string } {
  const labelIds = m.labels.length > 0 ? m.labels : ['INBOX'];
  return { raw: Buffer.from(m.raw, 'utf8').toString('base64url'), labelIds, ...(twinThreadId ? { threadId: twinThreadId } : {}) };
}

/** Request body for `POST calendar/v3/calendars/primary/events` (events.insert). */
export function calendarInsertBody(e: CalendarEvent): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: e.summary,
    description: e.description,
    start: { dateTime: e.start },
    end: { dateTime: e.end },
    status: e.status,
    attendees: e.attendees,
  };
  if (e.location) body.location = e.location;
  if (e.organizer) body.organizer = e.organizer;
  return body;
}

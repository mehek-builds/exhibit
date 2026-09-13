// Extracts the "action date" a founder should react to for an unanswered judge invite (PRD 4.1,
// 6.13): the invite's own reply deadline if the invite states one ("reply by...", "RSVP by...",
// "deadline..."), otherwise the judging/event date it mentions ("judge X on <date>", "the event is
// on <date>", "takes place <date>"). This is deliberately separate from `event_date` (verifier.ts),
// which stays whatever it already means for filed/qualifying exhibits -- this value exists only to
// drive the time-sensitive nudge for an invite nobody has answered yet.

export type ActionDateKind = 'deadline' | 'event';

export interface ActionDate {
  /** ISO-8601 timestamp (day granularity, UTC midnight). */
  date: string;
  kind: ActionDateKind;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function monthNum(name: string): number | null {
  const m = MONTHS[name.toLowerCase()];
  return m === undefined ? null : m;
}

interface ParsedDate {
  month: number;
  day: number;
  year: number | null;
}

function parseDatePhrase(phrase: string): ParsedDate | null {
  let m = phrase.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) };

  m = phrase.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return { year: Number(m[3]), month: Number(m[1]) - 1, day: Number(m[2]) };

  // "September 18", "Sept 18, 2026"
  m = phrase.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/);
  if (m) {
    const mo = monthNum(m[1] ?? '');
    if (mo !== null) return { month: mo, day: Number(m[2]), year: m[3] ? Number(m[3]) : null };
  }

  // "18 September 2026"
  m = phrase.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s*(\d{4})?/);
  if (m) {
    const mo = monthNum(m[2] ?? '');
    if (mo !== null) return { month: mo, day: Number(m[1]), year: m[3] ? Number(m[3]) : null };
  }

  return null;
}

/** Turn a parsed month/day(/year) into an ISO date. A missing year rolls forward to the next
 * occurrence of that month/day at or after `reference` (the invite email's own date). */
function toISO(parsed: ParsedDate, reference: Date): string | null {
  let year = parsed.year;
  if (year === null) {
    year = reference.getUTCFullYear();
    const candidate = Date.UTC(year, parsed.month, parsed.day);
    const refDay = Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate());
    if (candidate < refDay) year += 1;
  }
  const t = Date.UTC(year, parsed.month, parsed.day);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

const DATE_CHARS = "[A-Za-z0-9][A-Za-z0-9,.\\/ -]{2,24}";
const DEADLINE_RE = new RegExp(
  `(?:reply|respond|rsvp|let us know|get back to us)[^.\\n]{0,40}?\\bby\\b\\s+(${DATE_CHARS})` +
    `|\\bdeadline\\b[^.\\n]{0,10}?(?:is|:)?\\s*(${DATE_CHARS})`,
  'i',
);
const EVENT_RE = new RegExp(`(?:judg\\w*|event)[^.\\n]{0,40}?\\b(?:on|takes place|is on)\\b\\s+(${DATE_CHARS})`, 'i');

/**
 * Parse an unanswered invite's own text for a reply deadline or, failing that, the event/judging
 * date it mentions. `referenceDateStr` is the invite email's own date, used to roll forward a
 * date phrase with no explicit year. Returns null when no date phrase is found.
 */
export function parseInviteActionDate(text: string, referenceDateStr: string | null): ActionDate | null {
  const parsedRef = referenceDateStr ? new Date(referenceDateStr) : new Date();
  const reference = Number.isNaN(parsedRef.getTime()) ? new Date() : parsedRef;

  const dm = text.match(DEADLINE_RE);
  const dPhrase = dm?.[1] ?? dm?.[2];
  if (dPhrase) {
    const parsed = parseDatePhrase(dPhrase);
    const iso = parsed ? toISO(parsed, reference) : null;
    if (iso) return { date: iso, kind: 'deadline' };
  }

  const em = text.match(EVENT_RE);
  if (em?.[1]) {
    const parsed = parseDatePhrase(em[1]);
    const iso = parsed ? toISO(parsed, reference) : null;
    if (iso) return { date: iso, kind: 'event' };
  }

  return null;
}

// Extracts the "action date" a founder should react to for an unanswered judge invite (PRD 4.1,
// 6.13): the invite's own reply deadline if the invite states one ("reply by...", "RSVP by...",
// a reply/response/RSVP/confirmation deadline), otherwise the judging/event date it mentions
// ("judge X on <date>", "the event is on <date>", "takes place <date>", "held on <date>"). This is
// deliberately separate from `event_date` (verifier.ts), which stays whatever it already means for
// filed/qualifying exhibits -- this value exists only to drive the time-sensitive nudge for an
// invite nobody has answered yet.
//
// This parser is deliberately CONSERVATIVE: a false nudge (texting the founder about a date that
// isn't real) is worse than a missed one, because a missed nudge just falls back to the previous
// behaviour (event_date, or no nudge at all). Every rule below exists to make the parser return
// nothing rather than guess when a date is anything but unambiguous.
//
// What IS recognised:
//   - Reply-intent phrases only: "reply by", "respond by", "RSVP by", "let us know by",
//     "confirm by" / "confirm your participation|availability by", "please reply/respond/confirm
//     by", and "reply/response/RSVP/confirmation deadline(: | is )<date>". A bare "deadline", or
//     one attached to submissions/projects/applications/registration/entries, is never treated as
//     a reply deadline.
//   - Event/judging phrases: "judge ... on <date>", "the event is on <date>", "takes place (on)
//     <date>", "held on <date>" -- only when the date is within the same sentence as the phrase.
//   - Date formats: "September 18[, 2026]" / "Sept. 18th" (month-first, optional weekday prefix,
//     optional ordinal suffix); "18 September 2026" / "18th of September" (day-first, its own
//     anchored pattern so a year's digits can never be misread as the day); "2026-09-18" (ISO);
//     "D/M/Y" or "M/D/Y" slash/dash dates, read D/M/Y only when the first number is > 12 and the
//     second is <= 12, M/D/Y only when the first is <= 12 and the second is > 12 -- when both are
//     <= 12 the date is ambiguous and nothing is returned for that match.
//   - A missing year rolls forward to the next on-or-after occurrence of that month/day, but only
//     when that is within about 10 months of the invite's send date; further out is treated as an
//     unresolvable past reference.
//   - Quoted (`>`) and forwarded/replied-to content is stripped before any matching: everything
//     from an "On <date>, <name> wrote:" line onward, everything after a
//     "---------- Forwarded message ----------" / "-----Original Message-----" marker, and every
//     line starting with `>`.
//
// What is NOT recognised (returns null for that candidate, per the above conservatism):
//   - Any calendar-invalid date ("September 31", "2/30", "February 29" in a non-leap year) --
//     validated by round-tripping year/month/day through a UTC Date.
//   - A generic "deadline" not tied to a reply (submission/project/application/registration/entry
//     deadlines, or a bare "deadline:").
//   - An ambiguous D/M vs M/D numeric date (both parts <= 12).
//   - A date phrase found only in quoted/forwarded content.

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

// Anchored (^) so a phrase can match at most one of these -- no ordering ambiguity between the
// day-first and month-first shapes, and no risk of one eating part of the other's year.
const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const NUMERIC_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/;
const DAY_FIRST_RE = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?\s*(\d{4})?(?!\d)/;
const WEEKDAYS = /^(?:mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i;
const MONTH_FIRST_RE = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d),?\s*(\d{4})?/;

function parseDatePhrase(phraseRaw: string): ParsedDate | null {
  const phrase = phraseRaw.trim();

  let m = phrase.match(ISO_RE);
  if (m) return { year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) };

  m = phrase.match(NUMERIC_RE);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = Number(m[3]);
    if (a > 12 && b <= 12) return { year, month: b - 1, day: a };
    if (a <= 12 && b > 12) return { year, month: a - 1, day: b };
    return null; // both <= 12: ambiguous D/M vs M/D, refuse to guess
  }

  // Day-first: "18 September 2026", "18th of September", "1 September 2026". Anchored on a
  // leading digit, so it never competes with the month-first pattern below (fixes the day-first
  // misread where a year's leading digits were read as the day).
  m = phrase.match(DAY_FIRST_RE);
  if (m) {
    const mo = monthNum(m[2] ?? '');
    if (mo !== null) return { month: mo, day: Number(m[1]), year: m[3] ? Number(m[3]) : null };
  }

  // Month-first: "September 18", "Sept. 18th, 2026", with an optional weekday prefix.
  const noWeekday = phrase.replace(WEEKDAYS, '');
  m = noWeekday.match(MONTH_FIRST_RE);
  if (m) {
    const mo = monthNum(m[1] ?? '');
    if (mo !== null) return { month: mo, day: Number(m[2]), year: m[3] ? Number(m[3]) : null };
  }

  return null;
}

const TEN_MONTHS_MS = 305 * 86_400_000;

/** year/month/day round-tripped through a UTC Date; catches "September 31", "2/30", a non-leap
 * "February 29", etc. Returns null instead of the overflowed date. */
function toISOValid(year: number, month: number, day: number): string | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const t = Date.UTC(year, month, day);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return d.toISOString();
}

/** Turn a parsed month/day(/year) into a validated ISO date. A missing year rolls forward to the
 * next on-or-after occurrence of that month/day, relative to `reference` (the invite email's own
 * date) -- but only within ~10 months; further out is almost certainly a stale/past reference and
 * is refused rather than guessed. */
function toISO(parsed: ParsedDate, reference: Date): string | null {
  if (parsed.year !== null) return toISOValid(parsed.year, parsed.month, parsed.day);

  const refYear = reference.getUTCFullYear();
  const refDay = Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate());

  let iso = toISOValid(refYear, parsed.month, parsed.day);
  let t = iso ? Date.parse(iso) : null;
  if (t === null || t < refDay) {
    iso = toISOValid(refYear + 1, parsed.month, parsed.day);
    t = iso ? Date.parse(iso) : null;
  }
  if (t === null) return null;
  if (t - refDay > TEN_MONTHS_MS) return null;
  return iso;
}

const DATE_CHARS = "[A-Za-z0-9][A-Za-z0-9,.\\/ -]{2,24}";

// Reply-intent phrases ONLY (PRD 4.1/6.13): a bare "deadline", or one tied to submissions,
// projects, applications, registration or entries, is never a reply deadline (fixes B2).
const DEADLINE_RE = new RegExp(
  `(?:reply|respond|rsvp|let us know|confirm(?:\\s+(?:your\\s+)?(?:participation|availability))?)` +
    `[^.\\n]{0,40}?\\bby\\b\\s+(${DATE_CHARS})` +
    `|(?:reply|response|rsvp|confirmation)\\s+deadline(?:\\s+is\\b|:)?\\s*(${DATE_CHARS})`,
  'i',
);
const EVENT_RE = new RegExp(
  `(?:judg\\w*|event)[^.\\n]{0,40}?\\b(?:on|takes place(?:\\s+on)?|is on|held on)\\b\\s+(${DATE_CHARS})`,
  'i',
);

const QUOTE_LINE_RE = /^\s*>/;
const WROTE_LINE_RE = /^\s*on\s.+\swrote:\s*$/i;
const FORWARD_MARKER_RE = /-{2,}\s*(forwarded message|original message)\s*-{2,}/i;

/** Strips quoted replies and forwarded/original-message blocks before any date matching, so a
 * date in someone else's earlier email never wins over (or masquerades as) the current one's own
 * dates (fixes B4). Everything from a `>`-quoted line, an "On <date>, <name> wrote:" line, or a
 * forwarded/original-message marker onward is dropped. */
function stripQuoted(text: string): string {
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if (QUOTE_LINE_RE.test(line)) continue;
    if (WROTE_LINE_RE.test(line.trim())) break;
    if (FORWARD_MARKER_RE.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Parse an unanswered invite's own text for a reply deadline or, failing that, the event/judging
 * date it mentions. `referenceDateStr` is the invite email's own date, used to roll forward a
 * date phrase with no explicit year. Returns null when no unambiguous, valid date phrase is
 * found -- see the module header for exactly what is and isn't recognised.
 */
export function parseInviteActionDate(text: string, referenceDateStr: string | null): ActionDate | null {
  const parsedRef = referenceDateStr ? new Date(referenceDateStr) : new Date();
  const reference = Number.isNaN(parsedRef.getTime()) ? new Date() : parsedRef;
  const clean = stripQuoted(text);

  const dm = clean.match(DEADLINE_RE);
  const dPhrase = dm?.[1] ?? dm?.[2];
  if (dPhrase) {
    const parsed = parseDatePhrase(dPhrase);
    const iso = parsed ? toISO(parsed, reference) : null;
    if (iso) return { date: iso, kind: 'deadline' };
  }

  const em = clean.match(EVENT_RE);
  if (em?.[1]) {
    const parsed = parseDatePhrase(em[1]);
    const iso = parsed ? toISO(parsed, reference) : null;
    if (iso) return { date: iso, kind: 'event' };
  }

  return null;
}

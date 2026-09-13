import { describe, expect, it } from 'vitest';
import { parseInviteActionDate } from '../src/pipeline/inviteDate.js';

// Table-driven coverage for src/pipeline/inviteDate.ts (PRD 4.1/6.13). Every probe input from
// scratchpad/review-nudge/nudge-review.md is included, plus the examples from the fix task. The
// parser is deliberately conservative: any ambiguous or invalid date returns null rather than a
// guess, because a false nudge is worse than a missed one.

interface Case {
  name: string;
  text: string;
  reference: string | null;
  expected: { date: string; kind: 'deadline' | 'event' } | null;
}

const NULL_CASES: Case[] = [
  { name: 'ambiguous D/M vs M/D numeric date', text: 'Please reply by 3/4/2026 to judge.', reference: '2026-01-01T00:00:00Z', expected: null },
  { name: 'invalid calendar date: September 31', text: 'Please reply by September 31 to judge.', reference: '2026-09-01T00:00:00Z', expected: null },
  { name: 'a quoted reply-by date, alone, is stripped and yields nothing', text: '> reply by August 5', reference: '2026-09-10T00:00:00Z', expected: null },
  {
    name: 'an unquoted "On ... wrote:" line drops everything after it, including a real later event',
    text: 'Following up.\nOn Aug 1, 2026, PastHacks wrote:\nPlease reply by August 5.\n\nJudge HackX on September 18, 2026.',
    reference: '2026-09-10T00:00:00Z',
    expected: null,
  },
  { name: 'reply by an unparseable weekday name', text: 'reply by Friday', reference: '2026-09-01T00:00:00Z', expected: null },
  { name: 'a bare "deadline:" with no reply intent', text: 'The deadline: September 16.', reference: '2026-09-01T00:00:00Z', expected: null },
  { name: 'a project deadline, not a reply deadline', text: 'The deadline for submissions is September 16.', reference: '2026-09-01T00:00:00Z', expected: null },
  { name: 'a registration deadline, not a reply deadline', text: 'Registration deadline: September 16.', reference: '2026-09-01T00:00:00Z', expected: null },
  { name: 'an application deadline, not a reply deadline', text: 'The application deadline is September 16.', reference: '2026-09-01T00:00:00Z', expected: null },
  { name: 'a February 29 in a non-leap year', text: 'Please reply by February 29 to judge.', reference: '2026-01-10T00:00:00Z', expected: null },
  { name: 'a rolled-forward year more than ~10 months out is refused as stale', text: 'Please reply by December 20 to judge.', reference: '2026-01-05T00:00:00Z', expected: null },
];

const PARSE_CASES: Case[] = [
  {
    name: '"Project submission deadline: <date>" is not a reply deadline (fixes B2); falls back to the real event date',
    text: 'Judge HackX on October 20, 2026. Project submission deadline: September 16.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-10-20T00:00:00.000Z', kind: 'event' },
  },
  {
    name: 'day-first date with year (fixes B1)',
    text: "We'd love you to judge HackX on 1 September 2026.",
    reference: '2026-08-01T00:00:00Z',
    expected: { date: '2026-09-01T00:00:00.000Z', kind: 'event' },
  },
  {
    name: 'D/M/Y slash date (first number > 12)',
    text: 'Please RSVP by 18/9/2026 to judge.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-09-18T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: 'M/D/Y slash date (second number > 12)',
    text: 'Please RSVP by 9/18/2026 to judge.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-09-18T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: 'RSVP-by deadline wins over a later event date',
    text: 'Please RSVP by Sept 18 to judge. The event is on October 3, 2026.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-09-18T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: 'garbage deadline falls back to a valid nearby event date',
    text: 'Please reply by September 31. The event is on October 3, 2026.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-10-03T00:00:00.000Z', kind: 'event' },
  },
  {
    name: 'a quoted old deadline does not hide the real event date (fixes B4)',
    text:
      "Just following up!\n\n> On Aug 1, 2026 PastHacks wrote:\n> Please reply by August 5 to judge PastHacks.\n\n" +
      "We'd love you to judge NewHacks on September 18, 2026.",
    reference: '2026-09-10T00:00:00Z',
    expected: { date: '2026-09-18T00:00:00.000Z', kind: 'event' },
  },
  {
    name: 'content after a forwarded-message marker is dropped',
    text: '---------- Forwarded message ----------\nPlease reply by August 5.\n\nJudge HackX on September 18, 2026.',
    reference: '2026-09-10T00:00:00Z',
    expected: null,
  },
  {
    name: 'ISO date',
    text: 'Please reply by 2026-09-18 to judge.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-09-18T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: 'day-first "of" phrasing with no year, rolled forward',
    text: 'Please reply by 18th of September to judge.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-09-18T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: 'month-first with weekday prefix and ordinal suffix',
    text: 'Please reply by Friday, Sept. 18th, 2026 to judge.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-09-18T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: 'RSVP deadline phrasing ("RSVP deadline:")',
    text: 'Judge HackX on October 20, 2026. RSVP deadline: September 16.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-09-16T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: 'confirm your availability by <date>',
    text: 'Please confirm your availability by September 18 to judge.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-09-18T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: 'missing-year rollover across a year boundary',
    text: 'Please reply by January 5 to judge.',
    reference: '2026-12-20T00:00:00Z',
    expected: { date: '2027-01-05T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: 'missing year, same-day as reference resolves to this year',
    text: 'Please reply by December 20 to judge.',
    reference: '2026-12-20T23:59:00Z',
    expected: { date: '2026-12-20T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: '"get back to us by" is a reply deadline (restored, review R1)',
    text: 'Would you judge HackX? Please get back to us by September 16.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-09-16T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: '"let us know if you can judge by" is a reply deadline (review R1)',
    text: 'Would you judge HackX? Let us know if you can judge by September 16.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-09-16T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: '"please confirm your participation by" is a reply deadline',
    text: 'Would you judge HackX? Please confirm your participation by September 16.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-09-16T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: 'bare "please confirm by" (adjacent to by, no other object) is a reply deadline',
    text: 'Would you judge HackX? Please confirm by September 16.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-09-16T00:00:00.000Z', kind: 'deadline' },
  },
  {
    name: '"confirm your travel arrangements by" is logistics, not a reply deadline (review R1); falls back to the event date',
    text: "We'd love for you to judge HackX on October 20, 2026. Please confirm your travel arrangements by September 16.",
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-10-20T00:00:00.000Z', kind: 'event' },
  },
  {
    name: '"let us know your dietary needs by" is not a reply deadline; falls back to the event date',
    text: 'Judge HackX on October 20, 2026. Let us know your dietary needs by September 16.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-10-20T00:00:00.000Z', kind: 'event' },
  },
  {
    name: '"confirm your hotel booking by" is not a reply deadline; falls back to the event date',
    text: 'Judge HackX on October 20, 2026. Please confirm your hotel booking by September 16.',
    reference: '2026-09-01T00:00:00Z',
    expected: { date: '2026-10-20T00:00:00.000Z', kind: 'event' },
  },
];

describe('parseInviteActionDate: must return nothing (conservative on ambiguity/invalidity)', () => {
  for (const c of NULL_CASES) {
    it(c.name, () => {
      expect(parseInviteActionDate(c.text, c.reference)).toBeNull();
    });
  }
});

describe('parseInviteActionDate: must parse to the expected unambiguous date', () => {
  for (const c of PARSE_CASES) {
    it(c.name, () => {
      expect(parseInviteActionDate(c.text, c.reference)).toEqual(c.expected);
    });
  }
});

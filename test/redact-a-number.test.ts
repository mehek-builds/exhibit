import { describe, expect, it } from 'vitest';
import { redactText } from '../src/pipeline/redact.js';

// USCIS A-numbers are 7-9 digits, almost always written with an "A" prefix (A12345678,
// A-012-345-678, A 012 345 678, or a bare 7-9 digit form after an "alien registration number"
// label). A review flagged that the pattern in src/pipeline/redact.ts only matched exactly 9
// digits; these tests cover the fixed 7-9 digit range and guard against redacting ordinary numbers.

describe('redactText: A-number 7-9 digit range', () => {
  it('redacts an 8-digit A-prefixed number with no separators', () => {
    const { text, redactions } = redactText('USCIS receipt references A12345678 for the filing.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toContain('12345678');
    expect(redactions).toEqual([{ type: 'a_number', count: 1 }]);
  });

  it('redacts a 7-digit A-prefixed number', () => {
    const { text } = redactText('Old-format number A1234567 appears here.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toContain('1234567');
  });

  it('redacts a 9-digit A-prefixed number', () => {
    const { text } = redactText('Number A123456789 appears here.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toContain('123456789');
  });

  it('redacts the canonical dashed 3-3-3 grouping', () => {
    const { text } = redactText('A-012-345-678 is the number.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toMatch(/012.345.678/);
  });

  it('redacts a space-grouped form', () => {
    const { text } = redactText('A 012 345 678 is the number.');
    expect(text).toContain('[REDACTED:a_number]');
  });

  it('redacts a bare 7-9 digit number introduced by "alien registration number"', () => {
    const { text } = redactText('Alien Registration Number: 012345678 on file.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toContain('012345678');
  });

  it('redacts a bare 7-digit number introduced by "alien number"', () => {
    const { text } = redactText('Alien number 0123456 on file.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toContain('0123456');
  });

  it('does not redact ordinary figures, dates, or phone-like counts', () => {
    const prose = 'We shipped 12345678 requests last month. Call 415-555-0142. Revenue grew 10 20 30 percent.';
    const { text, redactions } = redactText(prose);
    expect(text).toBe(prose);
    expect(redactions).toEqual([]);
  });

  it('does not redact "approve 1 2" or other small counting phrases', () => {
    const prose = 'Please approve 1 2 and file the rest.';
    const { text, redactions } = redactText(prose);
    expect(text).toBe(prose);
    expect(redactions).toEqual([]);
  });

  it('does not treat a 10+ digit A-prefixed number as an A-number (out of range)', () => {
    const { text, redactions } = redactText('Reference code A1234567890 is unrelated.');
    expect(text).toBe('Reference code A1234567890 is unrelated.');
    expect(redactions).toEqual([]);
  });

  it('does not treat a bare 6-digit A-prefixed number as an A-number (too short)', () => {
    const { text, redactions } = redactText('Ticket A123456 is unrelated.');
    expect(text).toBe('Ticket A123456 is unrelated.');
    expect(redactions).toEqual([]);
  });

  it('is idempotent: a second redaction pass over already-redacted text does not double count', () => {
    const first = redactText('Number A12345678 appears here.');
    const second = redactText(first.text);
    expect(second.text).toBe(first.text);
    expect(second.redactions).toEqual([]);
  });

  it('redacts an A# label with a space before contiguous digits', () => {
    const { text, redactions } = redactText('A# 123456789 is on file.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toContain('123456789');
    expect(redactions).toEqual([{ type: 'a_number', count: 1 }]);
  });

  it('redacts a dash-grouped bare-A form with a space before the digits', () => {
    const { text, redactions } = redactText('A 123-456-789 is the number.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toContain('123-456-789');
    expect(redactions).toEqual([{ type: 'a_number', count: 1 }]);
  });

  it('redacts a labeled "A-Number" with contiguous digits', () => {
    const { text, redactions } = redactText('A-Number: 123456789 on file.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toContain('123456789');
    expect(redactions).toEqual([{ type: 'a_number', count: 1 }]);
  });

  it('redacts a labeled "USCIS #" with dash-grouped digits', () => {
    const { text, redactions } = redactText('USCIS #: 123-456-789 on file.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toContain('123-456-789');
    expect(redactions).toEqual([{ type: 'a_number', count: 1 }]);
  });

  it('does not redact "Series A" funding round mentions with digit-like text after', () => {
    const prose = 'Series A 12 345 678 was the internal deal code, not an A-number.';
    const { text, redactions } = redactText(prose);
    expect(text).toBe(prose);
    expect(redactions).toEqual([]);
  });

  it('does not redact "Plan A" with a phone-like number after it', () => {
    const prose = 'Plan A 555-1234 is the backup contact line.';
    const { text, redactions } = redactText(prose);
    expect(text).toBe(prose);
    expect(redactions).toEqual([]);
  });

  it('does not redact "Grade A" with a date-like number after it', () => {
    const prose = 'Grade A 2026 09 13 was the inspection result.';
    const { text, redactions } = redactText(prose);
    expect(text).toBe(prose);
    expect(redactions).toEqual([]);
  });

  // N4 fix: ambiguity is resolved by FORM, not by the preceding word. A directly attached to
  // digits, or attached via "-"/"#", is unambiguous and is always redacted -- even right after a
  // label word like Exhibit/Type/Class/Series that would otherwise suppress the loose "A "+digits
  // form.

  it('redacts "Exhibit A-012-345-678" despite the "Exhibit" label (unambiguous dashed form)', () => {
    const { text, redactions } = redactText('See Exhibit A-012-345-678 for details.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toMatch(/012.345.678/);
    expect(redactions).toEqual([{ type: 'a_number', count: 1 }]);
  });

  it('redacts "Type A123456789" despite the "Type" label (unambiguous contiguous form)', () => {
    const { text, redactions } = redactText('Type A123456789 was recorded.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toContain('123456789');
    expect(redactions).toEqual([{ type: 'a_number', count: 1 }]);
  });

  it('redacts "Class A#123456789" despite the "Class" label (unambiguous "#" form)', () => {
    const { text, redactions } = redactText('Class A#123456789 was assigned.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toContain('123456789');
    expect(redactions).toEqual([{ type: 'a_number', count: 1 }]);
  });

  it('redacts "Series A-123456789" despite the "Series" label (unambiguous dashed form)', () => {
    const { text, redactions } = redactText('Series A-123456789 closed last week.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(text).not.toContain('123456789');
    expect(redactions).toEqual([{ type: 'a_number', count: 1 }]);
  });

  it('does not redact "Round A 10 000 000" (ambiguous loose form after a label word)', () => {
    const prose = 'Round A 10 000 000 was the funding headline.';
    const { text, redactions } = redactText(prose);
    expect(text).toBe(prose);
    expect(redactions).toEqual([]);
  });

  it('redacts a standalone "A 012 345 678" at the start of a clause', () => {
    const { text, redactions } = redactText('Filed under A 012 345 678 with the agency.');
    expect(text).toContain('[REDACTED:a_number]');
    expect(redactions).toEqual([{ type: 'a_number', count: 1 }]);
  });

  it('redacts the canonical 3-3-3 grouping even after a label word ("Type A 012 345 678")', () => {
    for (const s of ['Type A 012 345 678 was recorded.', 'See Exhibit A 012 345 678.', 'Class A 123-456-789 on file.']) {
      const { text, redactions } = redactText(s);
      expect(text, s).toContain('[REDACTED:a_number]');
      expect(redactions, s).toEqual([{ type: 'a_number', count: 1 }]);
    }
  });

  it('still leaves differently shaped look-alikes after a label word alone', () => {
    for (const s of ['Series A 12 345 678 closed.', 'Round A 10 000 000 raised.', 'Plan A 555-1234.', 'Grade A 2026 09 13.']) {
      expect(redactText(s).text, s).toBe(s);
    }
  });
});

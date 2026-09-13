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
});

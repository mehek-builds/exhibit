import { describe, expect, it } from 'vitest';
import { redactItem, redactText, scrubForBoundary } from '../src/pipeline/redact.js';
import { item } from './helpers.js';

// PRD 6.2: identity numbers are removed before any model call, trace or log. The raw artifact is
// stored only in the private Drive binder.

/** Build a TD3 passport MRZ second line whose document-number check digit is correct, using the
 * ICAO 9303 7-3-1 weighted checksum (weights 7,3,1 repeating; '<' = 0, letters A-Z = 10-35). */
function mrzCheckDigit(field: string): number {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const c = field[i]!;
    const v = c === '<' ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55;
    sum += v * weights[i % 3]!;
  }
  return sum % 10;
}

function buildMrzLine(docNumber: string): string {
  // TD3 line 2: docNumber(9) check(1) nationality(3) DOB(6) check(1) sex(1) expiry(6) check(1)
  // personalNumber(14) finalCheck(1). We only need the doc-number check digit to validate, so pad
  // the rest with '<' filler that the redactor's length/charset check still accepts.
  const doc9 = docNumber.padEnd(9, '<').slice(0, 9);
  const docCheck = mrzCheckDigit(doc9);
  const rest = 'USA<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<'.slice(0, 34); // pad to reach 44 total
  const line = `${doc9}${docCheck}${rest}`;
  return line.slice(0, 44).padEnd(44, '<');
}

describe('redactText: passport numbers', () => {
  it('redacts a labeled passport number', () => {
    const { text, redactions } = redactText('Please confirm: Passport No: AB1234567 before travel.');
    expect(text).not.toContain('AB1234567');
    expect(text).toContain('[REDACTED:passport]');
    expect(redactions.some((r) => r.type === 'passport')).toBe(true);
  });

  it('redacts a passport number with no explicit "passport" word but a number-only pattern after the word', () => {
    const { text } = redactText('passport # 123456789');
    expect(text).not.toContain('123456789');
    expect(text).toContain('[REDACTED:passport]');
  });
});

describe('redactText: A-number, SEVIS, I-94, DOB, address', () => {
  it('redacts an A-number in canonical dashed form', () => {
    const { text, redactions } = redactText('Your file is A-123-456-789, keep it handy.');
    expect(text).not.toContain('123-456-789');
    expect(redactions.some((r) => r.type === 'a_number')).toBe(true);
  });

  it('redacts an A-number introduced by "alien registration number"', () => {
    const { text } = redactText('Alien Registration Number: 012345678');
    expect(text).not.toContain('012345678');
    expect(text).toContain('[REDACTED:a_number]');
  });

  it('redacts a SEVIS id (N followed by 10 digits)', () => {
    const { text, redactions } = redactText('SEVIS ID N0012345678 is on file.');
    expect(text).not.toContain('N0012345678');
    expect(redactions.some((r) => r.type === 'sevis')).toBe(true);
  });

  it('redacts an I-94 admission number (11 digits)', () => {
    const { text, redactions } = redactText('I-94 Number: 12345678901');
    expect(text).not.toContain('12345678901');
    expect(redactions.some((r) => r.type === 'i94')).toBe(true);
  });

  it('redacts DOB in ISO, slash, and month-name formats', () => {
    const iso = redactText('DOB: 1994-06-12').text;
    const slash = redactText('Date of birth: 06/12/1994').text;
    const month = redactText('Born on: June 12, 1994').text;
    expect(iso).not.toContain('1994-06-12');
    expect(slash).not.toContain('06/12/1994');
    expect(month).not.toContain('June 12, 1994');
    expect(iso).toContain('[REDACTED:dob]');
    expect(slash).toContain('[REDACTED:dob]');
    expect(month).toContain('[REDACTED:dob]');
  });

  it('does NOT redact prose that merely mentions "dates of birth" with no value attached', () => {
    const { text, redactions } = redactText('Identity numbers removed: passport numbers, SEVIS ids, dates of birth and home addresses.');
    expect(text).toContain('dates of birth and home addresses');
    expect(redactions.find((r) => r.type === 'dob')).toBeUndefined();
    expect(redactions.find((r) => r.type === 'address')).toBeUndefined();
  });

  it('redacts a labeled home address', () => {
    const { text, redactions } = redactText('Home address: 42 Willow Lane, Springfield, IL 62704');
    expect(text).not.toContain('42 Willow Lane, Springfield, IL 62704');
    expect(redactions.some((r) => r.type === 'address')).toBe(true);
  });

  it('redacts an unlabeled street address pattern', () => {
    const { text, redactions } = redactText('Please mail the check to 1600 Pennsylvania Avenue.');
    expect(text).not.toContain('1600 Pennsylvania Avenue');
    expect(redactions.some((r) => r.type === 'address')).toBe(true);
  });
});

describe('redactText: passport MRZ line (ICAO 7-3-1 checksum)', () => {
  it('redacts a TD3 MRZ line whose document-number check digit validates', () => {
    const line = buildMrzLine('L898902C3');
    expect(line).toHaveLength(44);
    // sanity: our own check digit reconstruction matches what the redactor computes
    const doc9 = line.slice(0, 9);
    const check = Number(line[9]);
    expect(mrzCheckDigit(doc9)).toBe(check);

    const { text, redactions } = redactText(`Scanning attached image.\n${line}\nThanks.`);
    expect(text).not.toContain(line);
    expect(text).toContain('[REDACTED:mrz]');
    expect(redactions.some((r) => r.type === 'mrz')).toBe(true);
  });

  it('does not redact a 44-char line with a wrong check digit as an MRZ line via the checksum path', () => {
    const line = buildMrzLine('L898902C3');
    // Corrupt the check digit so it no longer validates, but keep the char class valid.
    const badDigit = String((Number(line[9]) + 1) % 10);
    const bad = line.slice(0, 9) + badDigit + line.slice(10);
    expect(bad).toHaveLength(44);
    const { text } = redactText(bad);
    // Falls through to the passport-line-1 pattern only if it starts with P; ours starts with 'L',
    // so it should be left alone entirely (not mistaken for an MRZ line).
    expect(text).toContain(bad);
  });
});

describe('redactText: no over-redaction of ordinary numbers', () => {
  it('leaves a dollar figure untouched', () => {
    const { text } = redactText('The SAFE closed at $750,000 from investors.');
    expect(text).toContain('$750,000');
  });

  it('leaves a plain count untouched', () => {
    const { text } = redactText('You judged 62 submissions this year.');
    expect(text).toContain('62 submissions');
  });
});

describe('redactItem', () => {
  it('drops the raw/original text entirely from its output', () => {
    const src = item({ app: 'gmail', id: 'm1', title: 'Passport No: AB1234567', text: 'Please send your DOB: 1990-01-01.', raw: 'RAW EML WITH AB1234567 AND 1990-01-01' });
    const out = redactItem(src);
    expect('raw' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('AB1234567');
    expect(JSON.stringify(out)).not.toContain('1990-01-01');
  });

  it('merges redaction counts across title and text', () => {
    const src = item({ app: 'gmail', id: 'm2', title: 'DOB: 1990-01-01', text: 'DOB: 1991-02-02 again' });
    const out = redactItem(src);
    const dob = out.redactions.find((r) => r.type === 'dob');
    expect(dob?.count).toBe(2);
  });
});

describe('scrubForBoundary', () => {
  it('reports leaks found in a value that reached the boundary unredacted', () => {
    const { value, leaked } = scrubForBoundary({ note: 'Passport No: AB1234567', nested: { dob: 'Born on: June 3, 1992' } });
    expect(leaked.length).toBeGreaterThan(0);
    expect(JSON.stringify(value)).not.toContain('AB1234567');
    expect(JSON.stringify(value)).not.toContain('June 3, 1992');
  });

  it('reports no leaks for already-clean values', () => {
    const { leaked } = scrubForBoundary({ note: 'Nothing sensitive here.', count: 62 });
    expect(leaked).toHaveLength(0);
  });
});

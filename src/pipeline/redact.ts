import type { Redaction, RedactedItem, SourceItem } from '../types.js';

// Section 6.2: identity numbers are removed before any model call, trace or log.
// The raw artifact is stored only in the private Drive binder.

interface Pattern {
  type: Redaction['type'];
  re: RegExp;
  /** Index of the capture group to replace; 0 replaces the whole match. */
  group: number;
}

const PATTERNS: Pattern[] = [
  { type: 'passport', re: /(passport(?:\s*(?:no\.?|number|num|#))?\s*[:#-]?\s*)([A-Z]{0,2}\d{6,9})\b/gi, group: 2 },
  { type: 'a_number', re: /\b(A[-# ]?\d{3}[- ]?\d{3}[- ]?\d{3})\b/g, group: 1 },
  { type: 'a_number', re: /(alien (?:registration )?(?:no\.?|number)\s*[:#-]?\s*)(A?\d{8,9})\b/gi, group: 2 },
  { type: 'sevis', re: /\b(N\d{10})\b/g, group: 1 },
  { type: 'i94', re: /(I-?94(?:\s*(?:admission)?\s*(?:no\.?|number|#))?\s*[:#-]?\s*)(\d{9}[A-Z]\d|\d{11})\b/gi, group: 2 },
  {
    type: 'dob',
    re: /((?:DOB|D\.O\.B\.|date of birth|born on)\s*[:#-]?\s*)(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4}|\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4})/gi,
    group: 2,
  },
  // A label with a separator is required, so prose such as "dates of birth and home addresses." is left alone.
  { type: 'address', re: /(\b(?:home|residential|mailing|street) address\s*[:#-]\s*)([^\n]{6,120})/gi, group: 2 },
  {
    type: 'address',
    re: /\b(\d{1,5} (?:[A-Z][a-z]+ ){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\.?(?:,? (?:Apt|Unit|Suite|#) ?[\w-]+)?)\b/g,
    group: 1,
  },
];

// ICAO 9303 check digit: weights 7,3,1 over digits, letters A=10..Z=35, '<'=0.
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

/** A TD3 passport MRZ second line whose document-number check digit validates. */
function isPassportMrzLine(line: string): boolean {
  if (!/^[A-Z0-9<]{44}$/.test(line)) return false;
  const docNumber = line.slice(0, 9);
  const check = line[9]!;
  return /\d/.test(check) && mrzCheckDigit(docNumber) === Number(check);
}

export interface RedactResult {
  text: string;
  redactions: Redaction[];
}

export function redactText(input: string): RedactResult {
  const counts = new Map<Redaction['type'], number>();
  const bump = (t: Redaction['type']) => counts.set(t, (counts.get(t) ?? 0) + 1);

  let text = input
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (/^P[A-Z<][A-Z<]{3}[A-Z<]{39}$/.test(trimmed) || isPassportMrzLine(trimmed)) {
        bump('mrz');
        return '[REDACTED:mrz]';
      }
      return line;
    })
    .join('\n');

  for (const p of PATTERNS) {
    text = text.replace(p.re, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as (string | undefined)[];
      const target = p.group === 0 ? match : groups[p.group - 1];
      // Idempotent: a second pass (the trace boundary scrub) must not count a placeholder as a new leak.
      if (target?.includes('[REDACTED:')) return match;
      bump(p.type);
      if (p.group === 0) return `[REDACTED:${p.type}]`;
      if (!target) return match;
      const prefix = p.group > 1 ? groups.slice(0, p.group - 1).join('') : '';
      return `${prefix}[REDACTED:${p.type}]${match.slice(prefix.length + target.length)}`;
    });
  }
  return { text, redactions: [...counts].map(([type, count]) => ({ type, count })) };
}

export function redactItem(item: SourceItem): RedactedItem {
  const { raw: _raw, ...rest } = item;
  const title = redactText(item.title);
  const text = redactText(item.text);
  const merged = new Map<Redaction['type'], number>();
  for (const r of [...title.redactions, ...text.redactions]) merged.set(r.type, (merged.get(r.type) ?? 0) + r.count);
  return {
    ...rest,
    title: title.text,
    text: text.text,
    redactions: [...merged].map(([type, count]) => ({ type, count })),
  };
}

/** Defense in depth for trace and log boundaries: reports whether anything still needed redaction. */
export function scrubForBoundary(value: unknown): { value: unknown; leaked: Redaction[] } {
  const leaked = new Map<Redaction['type'], number>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactText(v);
      for (const x of r.redactions) leaked.set(x.type, (leaked.get(x.type) ?? 0) + x.count);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value);
  return { value: out, leaked: [...leaked].map(([type, count]) => ({ type, count })) };
}

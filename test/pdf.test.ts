import { describe, expect, it } from 'vitest';
import { renderPdf } from '../src/binder/pdf.js';

// PRD 6.6: officer-ready renders. No dependencies, byte-for-byte deterministic so the render is
// hashable (constraint 3: a verified original date and source is not enough on its own, but the
// render itself must never vary run to run).

function textOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

describe('renderPdf: structural basics', () => {
  it('starts with the literal "%PDF-1.4" header and ends with "%%EOF"', () => {
    const bytes = renderPdf({ heading: 'Test heading', body: 'Body text.', highlights: [] });
    const text = textOf(bytes);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('every xref offset points at a byte offset that begins with "N 0 obj" for the right object number', () => {
    const bytes = renderPdf({ heading: 'EX-4-003: Judge, Spring Build Night', subheading: 'Prepared by Exhibit.', body: 'Some body text describing the exhibit.\nA second line.', highlights: ['Spring Build Night'] });
    const text = textOf(bytes);
    const xrefStart = text.match(/xref\n0 (\d+)\n/);
    expect(xrefStart).not.toBeNull();
    const count = Number(xrefStart![1]); // objects.length + 1 (the +1 is the free-object entry)
    const objectCount = count - 1;
    const xrefIdx = text.indexOf('xref\n');
    const xrefBlock = text.slice(xrefIdx);
    // xrefBlock split by \n: [0]="xref", [1]="0 N", [2]=free-object line, [3..] offset lines.
    const lines = xrefBlock.split('\n').slice(3, 3 + objectCount);
    expect(lines).toHaveLength(objectCount);
    lines.forEach((line, i) => {
      const objNum = i + 1;
      const offset = Number(line.slice(0, 10));
      const expectedPrefix = `${objNum} 0 obj`;
      expect(text.slice(offset, offset + expectedPrefix.length)).toBe(expectedPrefix);
    });
  });
});

describe('renderPdf: highlights draw a fill rectangle', () => {
  it('a highlighted line emits the PDF fill-rect operator sequence ("re f") with a preceding "rg" color op', () => {
    const bytes = renderPdf({ heading: 'Heading', body: 'This line mentions Dara Voss by name.\nThis other line does not.', highlights: ['Dara Voss'] });
    const text = textOf(bytes);
    expect(text).toMatch(/1 0\.93 0\.35 rg [\d.-]+ [\d.-]+ [\d.]+ [\d.]+ re f/);
  });

  it('a body with no matching highlight terms draws no fill rectangle', () => {
    const bytes = renderPdf({ heading: 'Heading', body: 'Nothing here matches anything.', highlights: ['Zzyzx Nonexistent Term'] });
    const text = textOf(bytes);
    expect(text).not.toMatch(/1 0\.93 0\.35 rg/);
  });
});

describe('renderPdf: non-ASCII sanitization', () => {
  it('sanitizes curly quotes, em dashes, ellipses and arrows rather than corrupting the PDF', () => {
    const bytes = renderPdf({ heading: 'Heading', body: 'Curly “quotes” and an em—dash, an ellipsis… and an arrow →.', highlights: [] });
    const text = textOf(bytes);
    expect(text).toContain('"quotes"');
    expect(text).toContain('em-dash');
    expect(text).toContain('...');
    expect(text).toContain('->');
    // Still a structurally valid, parseable PDF after sanitization.
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('replaces characters outside the printable Latin-1 range with "?" instead of raw bytes that would corrupt the stream', () => {
    const bytes = renderPdf({ heading: 'Heading', body: '中文字符 and emoji 🎉 should not break the file.', highlights: [] });
    const text = textOf(bytes);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('?');
  });
});

describe('renderPdf: determinism', () => {
  it('the same input produces byte-identical output across two calls', () => {
    const input = { heading: 'EX-3-004: Devtools Weekly profile', subheading: 'Prepared by Exhibit for attorney review. Not legal advice.', body: 'Source: gmail\nIssuer: devtoolsweekly.example\nOriginal date: 2026-03-18', highlights: ['devtoolsweekly.example', '2026-03-18'] };
    const a = renderPdf(input);
    const b = renderPdf(input);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('a multi-page render (long body) is also deterministic', () => {
    const longBody = Array.from({ length: 200 }, (_, i) => `Line number ${i} of a long body that spans multiple pages.`).join('\n');
    const a = renderPdf({ heading: 'Long doc', body: longBody, highlights: [] });
    const b = renderPdf({ heading: 'Long doc', body: longBody, highlights: [] });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(textOf(a).match(/\/Type \/Page\b/g)!.length).toBeGreaterThan(1);
  });
});

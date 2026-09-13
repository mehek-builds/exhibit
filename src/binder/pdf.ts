// A minimal PDF 1.4 writer for officer-ready renders (6.6): Helvetica text,
// with lines that contain a highlight term drawn over a yellow band.
// No dependencies, so the render is byte-for-byte deterministic and hashable.

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const FONT_SIZE = 10;
const LEADING = 14;
const MAX_CHARS = 96;

function toLatin(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/→/g, '->')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '?');
}

function escapePdf(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrap(text: string): string[] {
  const out: string[] = [];
  for (const para of toLatin(text).split('\n')) {
    if (para.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (word.length > MAX_CHARS) {
        if (line) out.push(line);
        for (let i = 0; i < word.length; i += MAX_CHARS) out.push(word.slice(i, i + MAX_CHARS));
        line = '';
        continue;
      }
      if ((line ? line.length + 1 : 0) + word.length > MAX_CHARS) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(line);
  }
  return out;
}

export interface RenderInput {
  heading: string;
  subheading?: string;
  body: string;
  highlights: string[];
}

export function renderPdf(input: RenderInput): Uint8Array {
  const terms = input.highlights.map((h) => toLatin(h).toLowerCase()).filter((h) => h.trim().length >= 3);
  const lines: { text: string; bold: boolean; mark: boolean }[] = [
    { text: toLatin(input.heading), bold: true, mark: false },
    ...(input.subheading ? [{ text: toLatin(input.subheading), bold: false, mark: false }] : []),
    { text: '', bold: false, mark: false },
    ...wrap(input.body).map((text) => {
      const lower = text.toLowerCase();
      return { text, bold: false, mark: terms.some((t) => lower.includes(t) || (t.length > 20 && t.includes(lower) && lower.length > 12)) };
    }),
  ];

  const perPage = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);
  const pages: (typeof lines)[] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (pages.length === 0) pages.push([]);

  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const boldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds: number[] = [];

  pages.forEach((pageLines, p) => {
    const ops: string[] = [];
    pageLines.forEach((line, i) => {
      const y = PAGE_H - MARGIN - (i + 1) * LEADING;
      if (line.mark && line.text) {
        const width = Math.min(PAGE_W - 2 * MARGIN, line.text.length * FONT_SIZE * 0.52 + 6);
        ops.push(`1 0.93 0.35 rg ${MARGIN - 3} ${y - 3.5} ${width.toFixed(1)} ${LEADING} re f`);
      }
      ops.push(`0 0 0 rg BT /${line.bold ? 'F2' : 'F1'} ${line.bold ? 12 : FONT_SIZE} Tf ${MARGIN} ${y} Td (${escapePdf(line.text)}) Tj ET`);
    });
    ops.push(`0.4 0.4 0.4 rg BT /F1 8 Tf ${MARGIN} ${MARGIN / 2} Td (Exhibit render, page ${p + 1} of ${pages.length}. Highlighted lines carry the name, issuer, date or key sentence.) Tj ET`);
    const stream = ops.join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  });

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

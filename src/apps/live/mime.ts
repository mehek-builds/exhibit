// Minimal RFC 822 / MIME parsing and building for the live Gmail adapter (PRD 6.1, 7.5).
// Just enough to read multipart invitations, press mail and forwards, and to build outgoing
// messages for `users.messages.send`. Not a general-purpose MIME library.

export interface ParsedEmail {
  headers: Record<string, string>;
  body: string;
}

function unfoldHeaders(raw: string): string[] {
  const lines = raw.split(/\r\n|\n/);
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

function parseHeaderBlock(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of unfoldHeaders(block)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    // First occurrence wins for the common single-value headers Exhibit reads (From, Subject, Date, ...).
    if (!(name in headers)) headers[name] = value;
  }
  return headers;
}

/** Splits `raw` into its header block and body at the first blank line. */
function splitHeaderBody(raw: string): { headerBlock: string; body: string } {
  const m = raw.match(/\r?\n\r?\n/);
  if (!m || m.index === undefined) return { headerBlock: raw, body: '' };
  return { headerBlock: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

function parseContentType(value: string | undefined): { type: string; params: Record<string, string> } {
  if (!value) return { type: 'text/plain', params: {} };
  const parts = value.split(';').map((p) => p.trim());
  const type = (parts[0] ?? 'text/plain').toLowerCase();
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { type, params };
}

function decodeQuotedPrintable(text: string): string {
  const withoutSoftBreaks = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    const c = withoutSoftBreaks[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(withoutSoftBreaks.slice(i + 1, i + 3))) {
      bytes.push(parseInt(withoutSoftBreaks.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(withoutSoftBreaks.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeCharset(buf: Buffer, charset: string): string {
  const cs = charset.toLowerCase();
  if (cs === 'latin1' || cs === 'iso-8859-1' || cs === 'us-ascii') return buf.toString('latin1');
  return buf.toString('utf8');
}

function decodeBody(body: string, encoding: string | undefined, charset: string): string {
  const enc = (encoding ?? '7bit').toLowerCase();
  if (enc === 'base64') {
    const cleaned = body.replace(/\s+/g, '');
    return decodeCharset(Buffer.from(cleaned, 'base64'), charset);
  }
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** One MIME part: its own headers plus decoded text, or nested parts for a multipart body. */
interface Part {
  contentType: string;
  headers: Record<string, string>;
  text?: string;
  parts?: Part[];
}

function splitByBoundary(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const segments = body.split(marker);
  // Drop the preamble (before the first boundary) and the epilogue (after the closing `--boundary--`).
  return segments.slice(1, -1).map((s) => s.replace(/^\r?\n/, '').replace(/\r?\n$/, ''));
}

function parsePart(raw: string): Part {
  const { headerBlock, body } = splitHeaderBody(raw);
  const headers = parseHeaderBlock(headerBlock);
  const { type, params } = parseContentType(headers['Content-Type']);
  if (type.startsWith('multipart/') && params.boundary) {
    const parts = splitByBoundary(body, params.boundary).map(parsePart);
    return { contentType: type, headers, parts };
  }
  const charset = params.charset ?? 'utf-8';
  const decoded = decodeBody(body, headers['Content-Transfer-Encoding'], charset);
  return { contentType: type, headers, text: type === 'text/html' ? stripHtml(decoded) : decoded };
}

/** Picks text/plain, falling back to stripped text/html; multipart/mixed and /alternative both walk their parts. */
function pickText(part: Part): string | null {
  if (part.text !== undefined) return part.contentType === 'text/plain' || part.contentType === 'text/html' ? part.text : null;
  if (!part.parts) return null;
  const plain = part.parts.find((p) => p.contentType === 'text/plain');
  if (plain?.text !== undefined) return plain.text;
  for (const p of part.parts) {
    const nested = pickText(p);
    if (nested !== null) return nested;
  }
  const html = part.parts.find((p) => p.contentType === 'text/html');
  return html?.text ?? null;
}

export function parseRawEmail(raw: string): ParsedEmail {
  const { headerBlock, body } = splitHeaderBody(raw);
  const headers = parseHeaderBlock(headerBlock);
  const { type, params } = parseContentType(headers['Content-Type']);
  let text: string | null;
  if (type.startsWith('multipart/') && params.boundary) {
    const parts = splitByBoundary(body, params.boundary).map(parsePart);
    text = pickText({ contentType: type, headers, parts }) ?? '';
  } else {
    const charset = params.charset ?? 'utf-8';
    const decoded = decodeBody(body, headers['Content-Transfer-Encoding'], charset);
    text = type === 'text/html' ? stripHtml(decoded) : decoded;
  }
  return { headers, body: text ?? '' };
}

export interface BuildEmailInput {
  from: string;
  to: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
}

export function buildRawEmail(input: BuildEmailInput): string {
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
  ];
  if (input.inReplyTo) {
    lines.push(`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`);
  }
  return [...lines, '', input.body].join('\r\n');
}

/** Gmail's `raw` field is base64url with no padding (RFC 4648 sec. 5). */
export function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBase64url(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(text.length + ((4 - (text.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

import { createHash } from 'node:crypto';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function slug(text: string, max = 48): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

export function domainOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.lastIndexOf('@');
  if (at >= 0) return value.slice(at + 1).replace(/[>\s]+$/, '').toLowerCase();
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** True when `host` is `allowed` or a subdomain of it. */
export function hostMatches(host: string, allowed: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const a = allowed.toLowerCase().replace(/^www\./, '');
  return h === a || h.endsWith(`.${a}`);
}

export function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    for (const p of [...u.searchParams.keys()]) if (p.startsWith('utm_')) u.searchParams.delete(p);
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${path}${u.search}`;
  } catch {
    return null;
  }
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(re|fwd?|fw):\s*/g, '')
    .replace(/["'“”‘’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isoDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

/** Deterministic PRNG (mulberry32) so the synthetic corpus is identical on every run. */
export function prng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function pad(n: number, width = 3): string {
  return String(n).padStart(width, '0');
}

export function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** Parse a number written with separators or a K/M suffix ("1,200,000", "9.2M", "88k"). */
export function parseFigure(text: string): number | null {
  // A suffix letter must end the token ("88k", "9.2M"); otherwise "1,200,000 monthly" reads as millions.
  const m = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)(?:\s*(million|thousand)\b|([km])\b|\s*(%))?/i);
  if (!m) return null;
  let n = Number(m[1]);
  const unit = (m[2] ?? m[3] ?? m[4] ?? '').toLowerCase();
  if (unit === 'k' || unit === 'thousand') n *= 1_000;
  if (unit === 'm' || unit === 'million') n *= 1_000_000;
  return n;
}

/** `Promise.all(items.map(fn))` with at most `limit` calls in flight; results keep input order.
 * After the first rejection no new calls start, and the returned promise rejects with it. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!, i);
      } catch (err) {
        failed = true; // stop starting new calls once one has failed
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

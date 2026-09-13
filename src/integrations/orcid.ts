import type { DiscoveredItem, DiscoveryAdapter, DiscoveryQuery, DiscoveryResult, HttpTransport, IntegrationInfo } from './types.js';

// ORCID discovery adapter (PRD 6.14: "Her own account data, read with her credentials"). Reads
// the founder's own ORCID iD's public works and peer-review activities via the ORCID Public API,
// authenticated with a client-credentials token (application-level, not the founder's login —
// the record itself is selected by her ORCID iD in opts). Works normalize to kind 'work'; a
// completed peer-review activity normalizes to kind 'review_assignment' with status 'accepted'
// (6.14: "a completed review is accepted").

const TOKEN_URL = 'https://orcid.org/oauth/token';
const DEFAULT_API_BASE = 'https://pub.orcid.org/v3.0';
const SCOPE = '/read-public';
const RESULT_CAP = 100;

// UNCONFIRMED: exact JSON shape of /works and /peer-reviews summary responses. Verify against
// https://info.orcid.org/documentation/api-tutorials/ — assumed here: works.group[].work-summary[0]
// with title.title.value, external-ids, journal-title.value, publication-date, put-code; and
// peer-reviews.group[].peer-review-group[].peer-review-summary[] with review-group-id (venue),
// review-completion-date, put-code.
interface OrcidWorkSummary {
  'put-code': number;
  title?: { title?: { value?: string } };
  'journal-title'?: { value?: string } | null;
  'external-ids'?: { 'external-id'?: { 'external-id-type': string; 'external-id-value': string }[] };
  'publication-date'?: { year?: { value?: string }; month?: { value?: string }; day?: { value?: string } } | null;
}
interface OrcidWorksResponse {
  group?: { 'work-summary': OrcidWorkSummary[] }[];
}

interface OrcidPeerReviewSummary {
  'put-code': number;
  'review-group-id'?: string;
  'convening-organization'?: { name?: string };
  'completion-date'?: { year?: { value?: string }; month?: { value?: string }; day?: { value?: string } } | null;
}
interface OrcidPeerReviewsResponse {
  group?: { 'peer-review-group': { 'peer-review-summary': OrcidPeerReviewSummary[] }[] }[];
}

function isoFromParts(d?: { year?: { value?: string }; month?: { value?: string }; day?: { value?: string } } | null): string | null {
  if (!d?.year?.value) return null;
  const y = d.year.value;
  const m = (d.month?.value ?? '01').padStart(2, '0');
  const day = (d.day?.value ?? '01').padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface OrcidAdapterOptions {
  transport: HttpTransport;
  /** ORCID iD, e.g. 0000-0002-1825-0097 (6.14: "founder's ORCID iD from opts"). */
  orcidId: string;
  clientId: string;
  clientSecret: string;
  apiBase?: string;
  tokenUrl?: string;
}

export function createOrcidAdapter(opts: OrcidAdapterOptions): DiscoveryAdapter {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const tokenUrl = opts.tokenUrl ?? TOKEN_URL;
  const { transport } = opts;

  const info: IntegrationInfo = {
    id: 'orcid',
    name: 'ORCID (Public API)',
    job: ['discover'],
    tier: 2,
    criteria: '#4, #6',
    freeTier: 'Free public API client',
    credentials: ['Client id and secret'],
    receives: "Her own account data, read with her credentials",
  };

  async function getToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: 'client_credentials',
      scope: SCOPE,
    }).toString();
    const res = await transport.request({
      method: 'POST',
      url: tokenUrl,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    if (res.status >= 400) {
      // Never echo client secret into the error message.
      throw new Error(`ORCID token request failed (status ${res.status})`);
    }
    let parsed: { access_token?: string };
    try {
      parsed = JSON.parse(res.body) as { access_token?: string };
    } catch {
      throw new Error('ORCID token response was not valid JSON');
    }
    if (!parsed.access_token) throw new Error('ORCID token response missing access_token');
    return parsed.access_token;
  }

  return {
    info,
    async discover(q: DiscoveryQuery): Promise<DiscoveryResult> {
      const items: DiscoveredItem[] = [];
      const errors: string[] = [];
      let limited = false;

      let token: string;
      try {
        token = await getToken();
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
        return { items, errors };
      }
      const authHeaders = { authorization: `Bearer ${token}`, accept: 'application/json' };

      const worksRes = await transport.request({ method: 'GET', url: `${apiBase}/${opts.orcidId}/works`, headers: authHeaders });
      if (worksRes.status === 429) {
        limited = true;
      } else if (worksRes.status >= 400) {
        errors.push(`ORCID works fetch failed (status ${worksRes.status})`);
      } else {
        try {
          const parsed = JSON.parse(worksRes.body) as OrcidWorksResponse;
          for (const g of parsed.group ?? []) {
            const w = g['work-summary']?.[0];
            if (!w) continue;
            if (items.length >= RESULT_CAP) break;
            const publishedAt = isoFromParts(w['publication-date']);
            if (q.since && publishedAt && publishedAt < q.since) continue;
            const doi = w['external-ids']?.['external-id']?.find((e) => e['external-id-type'] === 'doi')?.['external-id-value'];
            const title = w.title?.title?.value ?? '';
            const venue = w['journal-title']?.value ?? undefined;
            items.push({
              source: 'orcid',
              externalId: String(w['put-code']),
              kind: 'work',
              url: `https://orcid.org/${opts.orcidId}`,
              title,
              text: [title, venue ?? ''].filter(Boolean).join(' — '),
              publishedAt,
              meta: { doi, venue },
              raw: JSON.stringify(w),
            });
          }
        } catch {
          errors.push('ORCID works response was not valid JSON');
        }
      }

      const reviewsRes = await transport.request({ method: 'GET', url: `${apiBase}/${opts.orcidId}/peer-reviews`, headers: authHeaders });
      if (reviewsRes.status === 429) {
        limited = true;
      } else if (reviewsRes.status >= 400) {
        errors.push(`ORCID peer-reviews fetch failed (status ${reviewsRes.status})`);
      } else {
        try {
          const parsed = JSON.parse(reviewsRes.body) as OrcidPeerReviewsResponse;
          for (const g of parsed.group ?? []) {
            for (const prg of g['peer-review-group'] ?? []) {
              const pr = prg['peer-review-summary']?.[0];
              if (!pr) continue;
              if (items.length >= RESULT_CAP) break;
              const completedAt = isoFromParts(pr['completion-date']);
              if (q.since && completedAt && completedAt < q.since) continue;
              const venue = pr['review-group-id'] ?? pr['convening-organization']?.name ?? 'unknown venue';
              items.push({
                source: 'orcid',
                externalId: String(pr['put-code']),
                kind: 'review_assignment',
                url: `https://orcid.org/${opts.orcidId}`,
                title: `Reviewer — ${venue}`,
                text: `Reviewer assignment for ${venue}, status: accepted`,
                publishedAt: completedAt,
                // A completed review activity on the record is accepted (6.14).
                meta: { role: 'reviewer', venue, status: 'accepted' },
                raw: JSON.stringify(pr),
              });
            }
          }
        } catch {
          errors.push('ORCID peer-reviews response was not valid JSON');
        }
      }

      return { items: items.slice(0, RESULT_CAP), errors, limited };
    },
  };
}

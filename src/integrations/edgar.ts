import type { DiscoveredItem, DiscoveryAdapter, DiscoveryQuery, DiscoveryResult, HttpTransport, IntegrationInfo } from './types.js';

// SEC EDGAR discovery adapter (PRD 6.14, 9 E61, 8 constraint 17). Free, no key, but a descriptive
// User-Agent containing a contact email is required by SEC's fair-access policy — the adapter
// refuses to construct without one. Full-text search for Form D filings naming the company, then
// the Form D XML itself is fetched and parsed for issuer/amount/related-persons/date-of-first-sale
// (E61: a look-alike company name, e.g. "Loomworks Capital LLC" vs "Loomwork, Inc.", must stay
// distinguishable — the second-identifier rule downstream decides, this adapter never filters by
// similarity, and issuerName is kept verbatim). Respects SEC's 10 req/s guidance via an optional
// delay between requests.
//
// There is no `/detail/<id>` endpoint and filing detail is not JSON — that was an earlier,
// unconfirmed guess this file made and it was wrong (docs review, 2026-09-13). The corrected path:
//   1. Full-text search: `GET https://efts.sec.gov/LATEST/search-index?q="<company>"&forms=D`
//   2. Each hit's `_source` carries `ciks` and `adsh` (accession number, dashed); the Form D XML is
//      at `https://www.sec.gov/Archives/edgar/data/<cik>/<adsh-without-dashes>/primary_doc.xml`.
//   3. The public filing-index page is `https://www.sec.gov/Archives/edgar/data/<cik>/<adsh>-index.html`
//      (adsh keeps its dashes there).
//
// UNCONFIRMED against https://www.sec.gov/edgar/search/ and https://www.sec.gov/cgi-bin/browse-edgar
// — verify before relying on these in production:
//   - The exact full-text-search hit shape (`_source.ciks` as an array, `_source.adsh` format,
//     whether `display_names` is still present alongside them).
//   - Whether every issuer's `primary_doc.xml` uses the plain (non-namespaced) element names this
//     adapter greps for (`issuerName`, `totalAmountSold`, `dateOfFirstSale/value`,
//     `relatedPersonsList/relatedPersonInfo/relatedPersonName/(firstName|lastName)`) across all
//     EDGAR Form D XML schema versions in use.

const SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';
const RESULT_CAP = 50;
const DEFAULT_DELAY_MS = 110; // ~9 req/s, under the 10 req/s guidance.
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

interface EdgarSearchHit {
  _id: string;
  _source: {
    ciks: string[];
    adsh: string;
    display_names: string[];
    file_date: string;
    root_forms: string[];
  };
}
interface EdgarSearchResponse {
  hits?: { hits: EdgarSearchHit[] };
}

interface FormDFacts {
  issuerName: string;
  totalAmountSold?: number;
  dateOfFirstSale?: string;
  relatedPersons: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dependency-free extraction of a single flat element's text content, e.g. `<issuerName>X</issuerName>`. */
function extractTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1]!.trim() : null;
}

/** Extraction for a nested `<tag><value>X</value></tag>` element, as EDGAR uses for typed fields. */
function extractNestedValue(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>\\s*<value>([^<]*)</value>\\s*</${tag}>`));
  return m ? m[1]!.trim() : null;
}

function extractRelatedPersons(xml: string): string[] {
  const persons: string[] = [];
  const blocks = xml.match(/<relatedPersonInfo>[\s\S]*?<\/relatedPersonInfo>/g) ?? [];
  for (const block of blocks) {
    const nameBlock = block.match(/<relatedPersonName>[\s\S]*?<\/relatedPersonName>/)?.[0] ?? block;
    const first = extractTag(nameBlock, 'firstName') ?? '';
    const last = extractTag(nameBlock, 'lastName') ?? '';
    const name = [first, last].filter(Boolean).join(' ');
    if (name) persons.push(name);
  }
  return persons;
}

function parseFormD(xml: string, fallbackIssuerName: string): FormDFacts {
  const issuerName = extractTag(xml, 'issuerName') ?? extractTag(xml, 'entityName') ?? fallbackIssuerName;
  const amountRaw = extractNestedValue(xml, 'totalAmountSold') ?? extractTag(xml, 'totalAmountSold');
  const amount = amountRaw && /^\d+(\.\d+)?$/.test(amountRaw) ? Number(amountRaw) : undefined;
  const dateOfFirstSale = extractNestedValue(xml, 'dateOfFirstSale') ?? extractTag(xml, 'dateOfFirstSale') ?? undefined;
  return {
    issuerName,
    totalAmountSold: amount,
    dateOfFirstSale,
    relatedPersons: extractRelatedPersons(xml),
  };
}

export interface EdgarAdapterOptions {
  transport: HttpTransport;
  /** Required by SEC (must contain an email address, e.g. "Exhibit evidence agent contact@example.com"). Constructor throws without one. */
  userAgent: string;
  searchUrl?: string;
  requestDelayMs?: number;
}

export function createEdgarAdapter(opts: EdgarAdapterOptions): DiscoveryAdapter {
  if (!opts.userAgent || !EMAIL_PATTERN.test(opts.userAgent)) {
    throw new Error('EDGAR adapter requires a descriptive User-Agent header containing a contact email address (SEC fair-access policy)');
  }
  const searchUrl = opts.searchUrl ?? SEARCH_URL;
  const delayMs = opts.requestDelayMs ?? DEFAULT_DELAY_MS;
  const { transport } = opts;
  const headers = { 'user-agent': opts.userAgent, accept: 'application/json' };
  const xmlHeaders = { 'user-agent': opts.userAgent };

  const info: IntegrationInfo = {
    id: 'edgar',
    name: 'SEC EDGAR',
    job: ['discover'],
    tier: 2,
    criteria: '#7, #8',
    freeTier: 'Free; a descriptive User-Agent header with a contact email is required',
    credentials: [],
    receives: "The founder's public name, company and handles, as search queries",
  };

  return {
    info,
    async discover(q: DiscoveryQuery): Promise<DiscoveryResult> {
      const items: DiscoveredItem[] = [];
      const errors: string[] = [];
      let limited = false;

      const url = `${searchUrl}?q=${encodeURIComponent(`"${q.company}"`)}&forms=D`;
      const res = await transport.request({ method: 'GET', url, headers });
      if (res.status === 429) return { items, errors, limited: true };
      if (res.status >= 400) {
        errors.push(`EDGAR full-text search failed (status ${res.status})`);
        return { items, errors };
      }

      let parsed: EdgarSearchResponse;
      try {
        parsed = JSON.parse(res.body) as EdgarSearchResponse;
      } catch {
        errors.push('EDGAR full-text search response was not valid JSON');
        return { items, errors };
      }

      const hits = parsed.hits?.hits ?? [];
      for (const hit of hits) {
        if (items.length >= RESULT_CAP) break;
        if (q.since && hit._source.file_date && hit._source.file_date < q.since) continue;

        const cik = hit._source.ciks?.[0];
        const adsh = hit._source.adsh;
        if (!cik || !adsh) {
          errors.push(`EDGAR hit ${hit._id} is missing cik or accession number`);
          continue;
        }

        if (delayMs > 0) await sleep(delayMs);
        const adshNoDashes = adsh.replace(/-/g, '');
        const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${adshNoDashes}/primary_doc.xml`;
        const xmlRes = await transport.request({ method: 'GET', url: xmlUrl, headers: xmlHeaders });
        if (xmlRes.status === 429) {
          limited = true;
          continue;
        }
        if (xmlRes.status >= 400) {
          errors.push(`EDGAR Form D XML fetch failed for ${hit._id} (status ${xmlRes.status})`);
          continue;
        }

        const fallbackName = hit._source.display_names?.[0] ?? '';
        const facts = parseFormD(xmlRes.body, fallbackName);
        const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh}-index.html`;
        const filedAt = facts.dateOfFirstSale ?? hit._source.file_date ?? null;

        // issuerName kept verbatim as filed — never normalized or fuzzy-matched here (E61).
        items.push({
          source: 'edgar',
          externalId: hit._id,
          kind: 'filing',
          url: indexUrl,
          title: `Form D — ${facts.issuerName}`,
          text: [`Form D filed by ${facts.issuerName}`, ...facts.relatedPersons.map((p) => `Related person: ${p}`)].join('\n'),
          publishedAt: filedAt,
          meta: {
            formType: 'D',
            issuerName: facts.issuerName,
            amountSold: facts.totalAmountSold,
            filedAt,
            relatedPersons: facts.relatedPersons,
          },
          raw: xmlRes.body,
        });
      }

      return { items, errors, limited };
    },
  };
}

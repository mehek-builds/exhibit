import { safeErrorBody } from './types.js';
import type { HttpTransport, IntegrationInfo } from './types.js';

// USCIS Case Status API sandbox client (PRD 6.14, constraint 19). Not wired into the agent: the
// hackathon build only has developer sandbox access, so this is a fixture-tested client kept ready
// for the day production access is granted. OAuth2 client credentials against the developer sandbox,
// then a receipt-number lookup. UNCONFIRMED: sandbox base URL, token endpoint path and the exact
// response schema below are best-effort from the public USCIS Case Status API developer docs; confirm
// against the live sandbox before any production wiring.

const TOKEN_URL = 'https://api-int.uscis.gov/oauth/accesstoken';
const BASE_URL = 'https://api-int.uscis.gov/case-status';

export interface UscisOptions {
  clientId: string;
  clientSecret: string;
  transport: HttpTransport;
  tokenUrl?: string;
  baseUrl?: string;
}

export interface CaseStatus {
  receiptNumber: string;
  formType: string | null;
  status: string;
  statusText: string;
  lastUpdated: string | null;
}

export interface UscisClient {
  readonly info: IntegrationInfo;
  getCaseStatus(receiptNumber: string): Promise<CaseStatus>;
}

interface TokenJson {
  access_token: string;
  expires_in: number;
}

interface CaseStatusJson {
  case_status: {
    receipt_number: string;
    formType?: string;
    current_case_status_text_en: string;
    current_status_code?: string;
    modified_date?: string;
  };
}

export function createUscis(opts: UscisOptions): UscisClient {
  const tokenUrl = opts.tokenUrl ?? TOKEN_URL;
  const base = opts.baseUrl ?? BASE_URL;
  const { transport, clientId, clientSecret } = opts;
  let cachedToken: { token: string; expiresAt: number } | null = null;

  const info: IntegrationInfo = {
    id: 'uscis-case-status',
    name: 'USCIS Case Status API (developer sandbox)',
    job: ['act'],
    tier: 'sandbox',
    criteria: 'n/a (post-filing tracking, not evidence)',
    freeTier: 'Free developer sandbox; production access pending USCIS approval',
    credentials: ['USCIS_CLIENT_ID', 'USCIS_CLIENT_SECRET'],
    receives: 'A petition receipt number, to look up its public status',
  };

  async function getToken(now = Date.now()): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > now) return cachedToken.token;
    const form = new URLSearchParams();
    form.set('grant_type', 'client_credentials');
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
    const res = await transport.request({
      method: 'POST',
      url: tokenUrl,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (res.status >= 300) throw new Error(`USCIS token request failed: ${res.status} ${safeErrorBody(res.body)}`);
    const parsed = JSON.parse(res.body) as TokenJson;
    cachedToken = { token: parsed.access_token, expiresAt: now + parsed.expires_in * 1000 - 5000 };
    return cachedToken.token;
  }

  return {
    info,
    async getCaseStatus(receiptNumber: string): Promise<CaseStatus> {
      const token = await getToken();
      const res = await transport.request({
        method: 'GET',
        url: `${base}/${encodeURIComponent(receiptNumber)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status >= 300) throw new Error(`USCIS case status lookup failed: ${res.status} ${safeErrorBody(res.body)}`);
      const parsed = JSON.parse(res.body) as CaseStatusJson;
      const c = parsed.case_status;
      return {
        receiptNumber: c.receipt_number,
        formType: c.formType ?? null,
        status: c.current_status_code ?? 'unknown',
        statusText: c.current_case_status_text_en,
        lastUpdated: c.modified_date ?? null,
      };
    },
  };
}

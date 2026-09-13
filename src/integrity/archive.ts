import type { HttpTransport } from '../integrations/types.js';

// Internet Archive Save Page Now v2, with the availability API as a fallback (PRD 6.6, 6.14, E65).
// Only public source URLs are ever sent here (constraint 17) -- the caller (extension.ts) is
// responsible for never passing a Drive link or any private page.
//
// CONFIRMED against a modern, actively-maintained SPN2 client
// (https://raw.githubusercontent.com/MHammett/spn-client/main/src/spn_client/client.py, whose
// README describes "S3-key-authenticated POST /save" per archive.org's SPN2 API): the
// `Authorization: LOW <access_key>:<secret_key>` header, `POST https://web.archive.org/save`,
// the `GET https://web.archive.org/save/status/<job_id>` polling endpoint, and the `job_id`,
// `status` ("success"/"pending"/"error"), `timestamp` and `original_url` response fields below
// all match. (An older, unrelated `savepagenow` PyPI client that this module's original comment
// might be confused with instead uses SPN1's synchronous `GET /save/<url>`, which is a different,
// non-matching API — not what this file implements.)

const SAVE_URL = 'https://web.archive.org/save';
const AVAILABLE_URL = 'https://archive.org/wayback/available';
const DEFAULT_MAX_POLLS = 5;
const POLL_DELAY_MS = 0; // fixtures resolve instantly; a live run would sleep between polls

export interface ArchiveOptions {
  transport: HttpTransport;
  accessKey: string;
  secretKey: string;
  maxPolls?: number;
}

export interface ArchiveResult {
  ok: boolean;
  archiveUrl: string | null;
  /** Set when ok is false: rate-limited or the save job failed. E65: the caller retries on a later run. */
  reason?: string;
}

interface SavePageNowJobResponse {
  job_id?: string;
  message?: string;
}

interface SavePageNowStatusResponse {
  status?: 'pending' | 'success' | 'error';
  timestamp?: string;
  original_url?: string;
  message?: string;
}

async function sleep(ms: number): Promise<void> {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

async function savePageNow(url: string, opts: ArchiveOptions): Promise<ArchiveResult> {
  const submit = await opts.transport.request({
    method: 'POST',
    url: SAVE_URL,
    headers: { authorization: `LOW ${opts.accessKey}:${opts.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: `url=${encodeURIComponent(url)}`,
  });
  if (submit.status === 429) return { ok: false, archiveUrl: null, reason: 'rate limited (429)' };
  if (submit.status >= 400) return { ok: false, archiveUrl: null, reason: `save request failed: ${submit.status}` };
  let job: SavePageNowJobResponse;
  try {
    job = JSON.parse(submit.body) as SavePageNowJobResponse;
  } catch {
    return { ok: false, archiveUrl: null, reason: 'save request returned invalid JSON' };
  }
  if (!job.job_id) return { ok: false, archiveUrl: null, reason: job.message ?? 'save request returned no job_id' };

  const maxPolls = opts.maxPolls ?? DEFAULT_MAX_POLLS;
  for (let i = 0; i < maxPolls; i++) {
    const statusRes = await opts.transport.request({
      method: 'GET',
      url: `${SAVE_URL}/status/${job.job_id}`,
      headers: { authorization: `LOW ${opts.accessKey}:${opts.secretKey}` },
    });
    if (statusRes.status === 429) return { ok: false, archiveUrl: null, reason: 'rate limited (429) while polling status' };
    if (statusRes.status >= 400) return { ok: false, archiveUrl: null, reason: `status poll failed: ${statusRes.status}` };
    let status: SavePageNowStatusResponse;
    try {
      status = JSON.parse(statusRes.body) as SavePageNowStatusResponse;
    } catch {
      return { ok: false, archiveUrl: null, reason: 'status poll returned invalid JSON' };
    }
    if (status.status === 'success' && status.timestamp) {
      return { ok: true, archiveUrl: `https://web.archive.org/web/${status.timestamp}/${status.original_url ?? url}` };
    }
    if (status.status === 'error') return { ok: false, archiveUrl: null, reason: status.message ?? 'save job errored' };
    await sleep(POLL_DELAY_MS);
  }
  return { ok: false, archiveUrl: null, reason: 'save job still pending after max polls' };
}

interface AvailabilityResponse {
  archived_snapshots?: { closest?: { available?: boolean; url?: string; timestamp?: string } };
}

async function checkAvailability(url: string, transport: HttpTransport): Promise<ArchiveResult> {
  const res = await transport.request({ method: 'GET', url: `${AVAILABLE_URL}?url=${encodeURIComponent(url)}` });
  if (res.status >= 400) return { ok: false, archiveUrl: null, reason: `availability check failed: ${res.status}` };
  let parsed: AvailabilityResponse;
  try {
    parsed = JSON.parse(res.body) as AvailabilityResponse;
  } catch {
    return { ok: false, archiveUrl: null, reason: 'availability check returned invalid JSON' };
  }
  const closest = parsed.archived_snapshots?.closest;
  if (closest?.available && closest.url) return { ok: true, archiveUrl: closest.url };
  return { ok: false, archiveUrl: null, reason: 'no snapshot available' };
}

/** Save Page Now first; on failure or 429, the availability API is tried as a fallback (an existing snapshot may already cover the page). Either way, a failure here is retried on a later run (E65); the local snapshot in Drive stands regardless. */
export async function archivePage(url: string, opts: ArchiveOptions): Promise<ArchiveResult> {
  const primary = await savePageNow(url, opts);
  if (primary.ok) return primary;
  const fallback = await checkAvailability(url, opts.transport);
  if (fallback.ok) return fallback;
  return { ok: false, archiveUrl: null, reason: `save: ${primary.reason}; availability: ${fallback.reason}` };
}

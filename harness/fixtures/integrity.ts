import type { FixtureMap, HttpRequest, HttpResponse } from '../../src/integrations/types.js';
import { encodeTimestampProof } from '../../src/integrity/ots.js';
import type { OtsPath } from '../../src/integrity/ots.js';

// Synthetic calendar servers and a synthetic Bitcoin block-header source (PRD 12.3 S22), labeled as
// such. Every server matches by URL pattern rather than an exact fixed key: the digest a scenario
// stamps is different for every file, so a plain FixtureMap keyed on exact URLs can't cover it -- we
// use a Proxy object (structurally still a `FixtureMap`, since FixtureTransport only does `[key]`
// lookups) whose getter pattern-matches the calendar and archive endpoints. Also fakes the Internet
// Archive's Save Page Now v2 and availability API.
//
// The calendar responders speak the real binary wire protocol (opentimestamps/calendar.py
// `RemoteCalendar`): `POST /digest` takes the raw 32-byte digest as the body and returns a bare
// serialized `Timestamp`; `GET /timestamp/<hex>` returns 404 while pending (`CommitmentNotFoundError`
// in the reference client) or a bare serialized `Timestamp` ending in a Bitcoin attestation once
// `markUpgraded()` has been called. The "chain" below is entirely synthetic -- fake heights, fake
// merkle roots -- there is no real Bitcoin data involved.

function json(body: unknown, status = 200): HttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function timestampBody(paths: OtsPath[]): HttpResponse {
  const bytes = encodeTimestampProof(paths);
  return { status: 200, headers: { 'content-type': 'application/vnd.opentimestamps.v1' }, body: Buffer.from(bytes).toString('latin1'), bytes };
}

function reverseHex(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  return bytes.reverse().toString('hex');
}

export interface IntegrityFixtures {
  fixtures: FixtureMap;
  /** Flips every pending calendar's `/timestamp/...` poll to "complete" (simulates the Bitcoin tx confirming). */
  markUpgraded(): void;
  /** The fake chain: height -> merkle root hex, filled in as timestamps upgrade. Pass straight to `verifyProof`/`verifyBinder`. */
  blockHeaders(height: number): Promise<string | null>;
  /** Make Save Page Now fail (429) for this exact URL until `clearRateLimit` (E65). */
  rateLimit(url: string): void;
  clearRateLimit(url: string): void;
}

export function createIntegrityFixtures(): IntegrityFixtures {
  const chain = new Map<number, string>();
  const commitmentHeight = new Map<string, number>();
  let nextHeight = 900_001;
  let upgraded = false;
  const jobs = new Map<string, string>();
  let jobSeq = 0;
  const rateLimited = new Set<string>();

  /** height -> merkle root, stored in the conventional reversed/display byte order (see opentimestamps.ts verifyProof). */
  function heightFor(commitmentHex: string): number {
    let h = commitmentHeight.get(commitmentHex);
    if (h === undefined) {
      h = nextHeight++;
      commitmentHeight.set(commitmentHex, h);
      chain.set(h, reverseHex(commitmentHex));
    }
    return h;
  }

  function digestResponder(calendarBase: string) {
    return (req: HttpRequest): HttpResponse => {
      const digest = req.body instanceof Uint8Array ? req.body : undefined;
      if (!digest || digest.length !== 32) return json({ error: 'expected the raw 32-byte sha256 digest as the request body' }, 400);
      return timestampBody([{ ops: [], attestation: { kind: 'pending', uri: calendarBase } }]);
    };
  }

  function timestampResponder() {
    return (req: HttpRequest): HttpResponse => {
      const m = req.url.match(/\/timestamp\/([0-9a-f]+)$/);
      const commitmentHex = m?.[1] ?? '';
      // CommitmentNotFoundError equivalent: the calendar hasn't attested this commitment yet.
      if (!upgraded) return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'pending' };
      return timestampBody([{ ops: [], attestation: { kind: 'bitcoin', height: heightFor(commitmentHex) } }]);
    };
  }

  function saveResponder() {
    return (req: HttpRequest): HttpResponse => {
      const params = new URLSearchParams(typeof req.body === 'string' ? req.body : '');
      const url = params.get('url') ?? '';
      if (rateLimited.has(url)) return json({ error: 'rate limited' }, 429);
      const jobId = `job_${(jobSeq += 1)}`;
      jobs.set(jobId, url);
      return json({ job_id: jobId });
    };
  }

  function statusResponder() {
    return (req: HttpRequest): HttpResponse => {
      const m = req.url.match(/\/save\/status\/([\w-]+)$/);
      const jobId = m?.[1] ?? '';
      const url = jobs.get(jobId);
      if (!url) return json({ status: 'error', message: 'unknown job' }, 404);
      if (rateLimited.has(url)) return json({ error: 'rate limited' }, 429);
      return json({ status: 'success', timestamp: '20260913120000', original_url: url });
    };
  }

  function availabilityResponder() {
    return (req: HttpRequest): HttpResponse => {
      const u = new URL(req.url);
      const url = u.searchParams.get('url') ?? '';
      if (rateLimited.has(url)) return json({ archived_snapshots: {} });
      return json({ archived_snapshots: { closest: { available: true, url: `https://web.archive.org/web/20260101000000/${url.replace(/^https?:\/\//, '')}` } } });
    };
  }

  const fixtures = new Proxy(
    {},
    {
      get(_target, prop): HttpResponse | ((req: HttpRequest) => HttpResponse) | undefined {
        if (typeof prop !== 'string') return undefined;
        let m = prop.match(/^POST (https:\/\/[a-z]\.pool\.[\w.-]+)\/digest$/);
        if (m) return digestResponder(m[1]!);
        if (/^GET https:\/\/[a-z]\.pool\.[\w.-]+\/timestamp\/[0-9a-f]+$/.test(prop)) return timestampResponder();
        if (prop === 'POST https://web.archive.org/save') return saveResponder();
        if (/^GET https:\/\/web\.archive\.org\/save\/status\/[\w-]+$/.test(prop)) return statusResponder();
        if (prop.startsWith('GET https://archive.org/wayback/available')) return availabilityResponder();
        return undefined;
      },
    },
  ) as FixtureMap;

  return {
    fixtures,
    markUpgraded: () => {
      upgraded = true;
    },
    blockHeaders: async (height: number) => chain.get(height) ?? null,
    rateLimit: (url: string) => rateLimited.add(url),
    clearRateLimit: (url: string) => rateLimited.delete(url),
  };
}

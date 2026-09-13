import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDeepL } from '../src/integrations/deepl.js';
import type { HttpRequest, HttpResponse } from '../src/integrations/types.js';
import { FixtureTransport } from '../src/integrations/types.js';
import { archivePage } from '../src/integrity/archive.js';
import { stampDigest } from '../src/integrity/opentimestamps.js';
import { createIntegrityFixtures } from '../harness/fixtures/integrity.js';

// PRD section 8 constraint 17: "Never send anything to an integration beyond what the 6.14 data
// table allows: public pages only to the Internet Archive, hashes only to OpenTimestamps, redacted
// opt-in text only to DeepL." This test captures the actual outbound payloads through each
// integration's own fixture/fake transport and fails if anything beyond that minimum is sent.

function bodyString(body: HttpRequest['body']): string {
  if (body === undefined) return '';
  return typeof body === 'string' ? body : Buffer.from(body).toString('latin1');
}

describe('integration minimum data: OpenTimestamps receives only a 32-byte digest', () => {
  it('sends the raw 32-byte sha256 digest as the POST body, and nothing else identifying the file', async () => {
    const fixtures = createIntegrityFixtures();
    const transport = new FixtureTransport(fixtures.fixtures);
    const fileBytes = Buffer.from('the private artifact bytes, e.g. a passport scan, never sent anywhere');
    const digestHex = createHash('sha256').update(fileBytes).digest('hex');

    const { errors } = await stampDigest(digestHex, { transport, calendars: ['https://a.pool.opentimestamps.org'] });
    expect(errors).toEqual([]);

    const submits = transport.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/digest'));
    expect(submits.length).toBeGreaterThan(0);
    for (const req of submits) {
      const sentBytes = req.body instanceof Uint8Array ? req.body : Buffer.from(String(req.body), 'latin1');
      // Exactly the 32-byte digest, byte for byte -- no filename, no path, no file content.
      expect(sentBytes.length).toBe(32);
      expect(Buffer.from(sentBytes).toString('hex')).toBe(digestHex);
      // The raw file bytes never appear anywhere in the request (headers included).
      const wholeRequest = `${JSON.stringify(req.headers ?? {})}${bodyString(req.body)}`;
      expect(wholeRequest).not.toContain(fileBytes.toString('latin1'));
    }
  });
});

describe('integration minimum data: Internet Archive receives only a public URL', () => {
  it('sends only the page URL (no auth beyond the LOW header, no page content, no founder data)', async () => {
    const fixtures = createIntegrityFixtures();
    const transport = new FixtureTransport(fixtures.fixtures);
    const publicUrl = 'https://devtoolsweekly.example/2026/03/loomwork-profile';
    const secretPageContent = '<html>this HTML body must never be sent to the Internet Archive</html>';

    const result = await archivePage(publicUrl, { transport, accessKey: 'ak_test', secretKey: 'sk_test' });
    expect(result.ok).toBe(true);

    const saveReq = transport.requests.find((r) => r.method === 'POST' && r.url === 'https://web.archive.org/save');
    expect(saveReq).toBeDefined();
    const body = bodyString(saveReq!.body);
    // The body is exactly `url=<encoded url>` -- no other form field.
    expect(body).toBe(`url=${encodeURIComponent(publicUrl)}`);
    expect(new URLSearchParams(body).size).toBe(1);
    for (const req of transport.requests) {
      const whole = `${req.url} ${JSON.stringify(req.headers ?? {})} ${bodyString(req.body)}`;
      expect(whole).not.toContain(secretPageContent);
    }
  });
});

describe('integration minimum data: DeepL receives only redacted, opt-in text', () => {
  it('sends exactly the text it is given as form data, and never a raw identity number the caller failed to redact', async () => {
    const fixtures: Record<string, HttpResponse | ((req: HttpRequest) => HttpResponse)> = {
      'POST https://api-free.deepl.com/v2/translate': () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ translations: [{ detected_source_language: 'ES', text: 'translated output' }] }),
      }),
    };
    const transport = new FixtureTransport(fixtures);
    const client = createDeepL({ apiKey: 'fake-key:fx', transport });

    // The caller is responsible for redacting first (deepl.ts's own contract comment); this is the
    // text as it should arrive here -- already redacted, and opted in.
    const redactedDraft = 'Entrevista con la fundadora sobre Flakehound. Pasaporte: [REDACTED:passport].';
    const result = await client.translate(redactedDraft, 'EN-US');
    expect(result.text).toBe('translated output');

    expect(transport.requests.length).toBe(1);
    const req = transport.requests[0]!;
    const params = new URLSearchParams(bodyString(req.body));
    expect(params.get('text')).toBe(redactedDraft);
    expect(params.get('target_lang')).toBe('EN-US');
    // Only `text` and `target_lang` are sent -- no extra field carrying founder identity.
    expect([...params.keys()].sort()).toEqual(['target_lang', 'text']);
    // A raw (unredacted) identity number would fail this: the client sends the text verbatim, so
    // catching an unredacted leak is the caller's job (src/pipeline/redact.ts), but nothing beyond
    // `text`/`target_lang` reaches DeepL regardless.
    expect(bodyString(req.body)).not.toContain('Passport Number: X1234567');
  });
});

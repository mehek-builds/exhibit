import { describe, expect, it } from 'vitest';
import { createDeepL } from '../src/integrations/deepl.js';
import { FixtureTransport } from '../src/integrations/types.js';
import { MemoryDeepL } from '../src/twins/fakes.js';
import { createHarnessEnv } from '../harness/env.js';
import { S24 } from '../harness/scenarios/s24.js';

describe('createDeepL', () => {
  it('posts form-encoded text to the free-tier endpoint with the auth-key header', async () => {
    const transport = new FixtureTransport({
      'POST https://api-free.deepl.com/v2/translate': { status: 200, headers: {}, body: JSON.stringify({ translations: [{ detected_source_language: 'ES', text: 'Hello' }] }) },
    });
    const client = createDeepL({ apiKey: 'k:fx', transport });
    const result = await client.translate('Hola', 'EN-US');
    expect(result.text).toBe('Hello');
    expect(result.detectedSourceLang).toBe('ES');
    const req = transport.requests[0]!;
    expect(req.headers?.authorization).toBe('DeepL-Auth-Key k:fx');
    expect(String(req.body)).toContain('text=Hola');
    expect(String(req.body)).toContain('target_lang=EN-US');
  });

  it('throws on a non-2xx response', async () => {
    const transport = new FixtureTransport({ 'POST https://api-free.deepl.com/v2/translate': { status: 456, headers: {}, body: '{}' } });
    const client = createDeepL({ apiKey: 'k', transport });
    await expect(client.translate('x')).rejects.toThrow();
  });
});

describe('MemoryDeepL', () => {
  it('records the exact text it receives', async () => {
    const received: unknown[] = [];
    const fake = new MemoryDeepL({ record: (...args) => received.push(args) });
    await fake.translate('hola mundo');
    expect(fake.received).toEqual([{ text: 'hola mundo', targetLang: 'EN-US' }]);
    expect(received.length).toBe(1);
  });
});

describe('S24 scenario: draft translation', () => {
  it('translates only the opted-in item, with identity numbers redacted first', async () => {
    const env = createHarnessEnv({ seed: S24.seed(), profile: S24.profile, gate: S24.gate, twinOptions: S24.twinOptions, features: S24.features, scenarioId: S24.id, attempt: 1 });
    try {
      await S24.play({ env });
      const checks = await S24.grade({ env });
      const failed = checks.filter((c) => !c.pass);
      expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    } finally {
      await env.close();
    }
  }, 30_000);
});

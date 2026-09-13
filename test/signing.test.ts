import { describe, expect, it } from 'vitest';
import { createDropboxSign } from '../src/integrations/dropboxsign.js';
import { FixtureTransport } from '../src/integrations/types.js';
import { MemoryDropboxSign } from '../src/twins/fakes.js';
import { createHarnessEnv } from '../harness/env.js';
import { runScenarioAttempt } from '../harness/runner.js';
import { S23 } from '../harness/scenarios/s23.js';

describe('createDropboxSign', () => {
  it('sends a multipart request with test_mode=1 and reads status/pdf back', async () => {
    const fixtures = {
      'POST https://api.hellosign.com/v3/signature_request/send': {
        status: 200,
        headers: {},
        body: JSON.stringify({ signature_request: { signature_request_id: 'req_1', test_mode: 1, signatures: [{ status_code: 'awaiting_signature', signer_email_address: 'r@example.com' }] } }),
      },
      'GET https://api.hellosign.com/v3/signature_request/req_1': {
        status: 200,
        headers: {},
        body: JSON.stringify({ signature_request: { signature_request_id: 'req_1', signatures: [{ status_code: 'signed', signer_email_address: 'r@example.com', signed_at: 1_700_000_000 }] } }),
      },
      'GET https://api.hellosign.com/v3/signature_request/files/req_1': { status: 200, headers: {}, body: '', bytes: new Uint8Array([1, 2, 3]) },
    };
    const transport = new FixtureTransport(fixtures);
    const client = createDropboxSign({ apiKey: 'k', transport, testMode: true });

    const sent = await client.send({ title: 't', subject: 's', message: 'm', signerEmail: 'r@example.com', signerName: 'R', fileName: 'x.pdf', fileContent: new Uint8Array([9]) });
    expect(sent.requestId).toBe('req_1');
    expect(transport.requests[0]?.method).toBe('POST');
    expect(String(transport.requests[0]?.body)).toContain('name="test_mode"');
    expect(String(transport.requests[0]?.body)).toContain('\r\n1\r\n');
    expect(transport.requests[0]?.headers?.authorization).toMatch(/^Basic /);

    const status = await client.getStatus('req_1');
    expect(status.status).toBe('signed');
    expect(status.signedAt).toBeTruthy();

    const pdf = await client.downloadPdf('req_1');
    expect(Array.from(pdf)).toEqual([1, 2, 3]);
  });

  it('surfaces a declined status', async () => {
    const transport = new FixtureTransport({
      'GET https://api.hellosign.com/v3/signature_request/req_2': {
        status: 200,
        headers: {},
        body: JSON.stringify({ signature_request: { signature_request_id: 'req_2', is_declined: true, signatures: [{ status_code: 'declined', signer_email_address: 'r@example.com' }] } }),
      },
    });
    const client = createDropboxSign({ apiKey: 'k', transport, testMode: true });
    const status = await client.getStatus('req_2');
    expect(status.status).toBe('declined');
  });
});

describe('MemoryDropboxSign', () => {
  it('records ops with an actor and lets the admin sign or decline', async () => {
    const ops: { app: string; op: string; actor: string }[] = [];
    const fake = new MemoryDropboxSign({ testMode: true, now: () => new Date('2026-09-13T00:00:00Z'), record: (app, op, actor) => ops.push({ app, op, actor }) });
    const { requestId } = await fake.send({ title: 't', subject: 's', message: 'm', signerEmail: 'r@example.com', signerName: 'R', fileName: 'x.pdf', fileContent: new Uint8Array([1]) });
    expect((await fake.getStatus(requestId)).status).toBe('awaiting_signature');
    fake.recipientSigns(requestId);
    expect((await fake.getStatus(requestId)).status).toBe('signed');
    expect(await fake.downloadPdf(requestId)).toEqual(new Uint8Array([1]));
    expect(ops.some((o) => o.op === 'signature_request.send' && o.actor === 'agent')).toBe(true);
    expect(ops.some((o) => o.op === 'signature_request.signed' && o.actor === 'admin')).toBe(true);
  });

  it('refuses to hand back a PDF before it is signed', async () => {
    const fake = new MemoryDropboxSign({ testMode: true, now: () => new Date(), record: () => {} });
    const { requestId } = await fake.send({ title: 't', subject: 's', message: 'm', signerEmail: 'r@example.com', signerName: 'R', fileName: 'x.pdf', fileContent: new Uint8Array([1]) });
    await expect(fake.downloadPdf(requestId)).rejects.toThrow();
  });
});

describe('S23 scenario: signature (Dropbox Sign, test mode)', () => {
  it('signs one letter, declines another, and never creates a request without both approvals', async () => {
    const env = createHarnessEnv({ seed: S23.seed(), profile: S23.profile, gate: S23.gate, twinOptions: S23.twinOptions, features: S23.features, scenarioId: S23.id, attempt: 1 });
    try {
      await S23.play({ env });
      const checks = await S23.grade({ env });
      const failed = checks.filter((c) => !c.pass);
      expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    } finally {
      await env.close();
    }
  }, 30_000);

  it('mutation: disabling X-sign-both-approvals turns the confirmation-gate check (b) red', async () => {
    const result = await runScenarioAttempt(S23, 1, { ruleOptions: { disabled: ['X-sign-both-approvals'] } });
    const marcoCheck = result.checks.find((c) => c.name.startsWith('(b) confirmation gate: Marco (approved but never confirmed) has no signature request'));
    expect(marcoCheck, JSON.stringify(result.checks, null, 2)).toBeTruthy();
    expect(marcoCheck!.pass, marcoCheck!.detail).toBe(false);
    expect(result.passed).toBe(false);
  }, 30_000);
});

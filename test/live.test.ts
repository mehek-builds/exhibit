import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createGoogleApps } from '../src/apps/live/google.js';
import { createGithubApi } from '../src/apps/live/github.js';
import { base64url, buildRawEmail, decodeBase64url, parseRawEmail } from '../src/apps/live/mime.js';
import { buildLiveDeps } from '../src/config.js';

// Live adapters proven against local fakes, never real services (PRD 11, task instructions: no
// network calls to real services on this machine). A local http.createServer plus a `rootUrl` /
// `baseUrl` override proves the same client code that talks to an Arga twin also talks here.

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function listen(handler: Handler): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

describe('mime', () => {
  it('parses folded headers', () => {
    const raw = ['From: dara@loomwork.example', 'Subject: A very long subject line\r\n that wraps\r\n onto more lines', '', 'Body text.'].join('\r\n');
    const { headers, body } = parseRawEmail(raw);
    expect(headers['Subject']).toBe('A very long subject line that wraps onto more lines');
    expect(body).toBe('Body text.');
  });

  it('decodes base64 content-transfer-encoding', () => {
    const text = 'Congratulations on judging Build Night!';
    const raw = ['From: awards@buildnight.example', 'To: dara@loomwork.example', 'Subject: Certificate', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(text, 'utf8').toString('base64')].join('\r\n');
    const { body } = parseRawEmail(raw);
    expect(body).toBe(text);
  });

  it('decodes quoted-printable content-transfer-encoding', () => {
    const raw = ['From: press@outlet.example', 'To: dara@loomwork.example', 'Subject: Profile', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Dara=E2=80=99s new tool reaches =249.2M in funding.'].join('\r\n');
    const { body } = parseRawEmail(raw);
    expect(body).toBe('Dara’s new tool reaches $9.2M in funding.');
  });

  it('picks text/plain from multipart/alternative, falling back to stripped text/html', () => {
    const boundary = 'alt-boundary';
    const raw = [
      'From: press@outlet.example',
      'To: dara@loomwork.example',
      'Subject: Alternative parts',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML <b>only</b> version.</p>',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plain text version.',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const { body } = parseRawEmail(raw);
    expect(body).toBe('Plain text version.');
  });

  it('walks multipart/mixed to find the text part and keeps a forwarded body intact', () => {
    const inner = 'html-only-boundary';
    const outer = 'mixed-boundary';
    const forwardedBody = ['---------- Forwarded message ---------', 'From: organizer@buildnight.example', 'Date: Mon, 10 Mar 2026 09:00:00 +0000', 'Subject: You are invited to judge', '', 'We would love you to judge Spring Build Night.', '', 'Thanks!'].join('\n');
    const raw = [
      'From: dara@loomwork.example',
      'To: dara@loomwork.example',
      'Subject: Fwd: You are invited to judge',
      `Content-Type: multipart/mixed; boundary="${outer}"`,
      '',
      `--${outer}`,
      `Content-Type: multipart/alternative; boundary="${inner}"`,
      '',
      `--${inner}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      forwardedBody,
      `--${inner}--`,
      `--${outer}`,
      'Content-Type: application/pdf; name="agenda.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('not a real pdf').toString('base64'),
      `--${outer}--`,
      '',
    ].join('\r\n');
    const { body } = parseRawEmail(raw);
    expect(body).toBe(forwardedBody);
    expect(body).toContain('We would love you to judge Spring Build Night.');
  });

  it('round-trips a built raw email through base64url', () => {
    const raw = buildRawEmail({ from: 'dara@loomwork.example', to: ['priya@buildnight.example'], subject: 'Re: letter', body: 'Thank you.', inReplyTo: '<abc@mail.example>' });
    const encoded = base64url(raw);
    expect(encoded).not.toMatch(/[+/=]/);
    const decoded = decodeBase64url(encoded);
    expect(decoded).toBe(raw);
    const { headers, body } = parseRawEmail(decoded);
    expect(headers['In-Reply-To']).toBe('<abc@mail.example>');
    expect(body).toBe('Thank you.');
  });
});

describe('google apps live adapter against a local fake (rootUrl override)', () => {
  it('lists messages, decodes the raw form, and sends', async () => {
    const rawStored = buildRawEmail({ from: 'organizer@buildnight.example', to: ['dara@loomwork.example'], subject: 'You are invited to judge' + '', body: 'Please join our judging panel for Spring Build Night.' });
    let sentBody: unknown = null;

    const fake = await listen(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/gmail/v1/users/me/messages') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ messages: [{ id: 'msg_1', threadId: 'thr_1' }] }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/gmail/v1/users/me/messages/msg_1') {
        expect(url.searchParams.get('format')).toBe('raw');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_1', threadId: 'thr_1', labelIds: ['INBOX'], raw: base64url(rawStored) }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/gmail/v1/users/me/messages/send') {
        sentBody = JSON.parse(await readBody(req));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_sent_1', threadId: 'thr_1' }));
        return;
      }
      res.writeHead(404, { 'x-twin-stub': 'true' });
      res.end('not found');
    });

    try {
      const apps = createGoogleApps({ auth: 'test-access-token', rootUrl: fake.url, owner: 'dara@loomwork.example' });
      const messages = await apps.gmail.listMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.subject).toBe('You are invited to judge');
      expect(messages[0]?.from).toBe('organizer@buildnight.example');
      expect(messages[0]?.labels).toEqual(['INBOX']);
      expect(messages[0]?.body).toBe('Please join our judging panel for Spring Build Night.');

      const sent = await apps.gmail.send({ to: ['organizer@buildnight.example'], subject: 'Re: judging', body: 'Happy to judge.' });
      expect(sent).toEqual({ id: 'msg_sent_1', threadId: 'thr_1' });
      const raw = decodeBase64url((sentBody as { raw: string }).raw);
      expect(raw).toContain('From: dara@loomwork.example');
      expect(raw).toContain('Happy to judge.');
    } finally {
      await fake.close();
    }
  });
});

describe('drive findChild query escaping', () => {
  it('escapes single quotes in the file name', async () => {
    let capturedQuery: string | null = null;
    const fake = await listen((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/drive/v3/files') {
        capturedQuery = url.searchParams.get('q');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ files: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const apps = createGoogleApps({ auth: 'test-access-token', rootUrl: fake.url, owner: 'dara@loomwork.example' });
      const found = await apps.drive.findChild('folder_1', "Dara's Exhibit binder");
      expect(found).toBeNull();
      expect(capturedQuery).toContain("name = 'Dara\\'s Exhibit binder'");
      expect(capturedQuery).toContain("'folder_1' in parents");
      expect(capturedQuery).toContain('trashed = false');
    } finally {
      await fake.close();
    }
  });

  it('uses root for a null parent', async () => {
    let capturedQuery: string | null = null;
    const fake = await listen((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      capturedQuery = url.searchParams.get('q');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ files: [] }));
    });
    try {
      const apps = createGoogleApps({ auth: 'test-access-token', rootUrl: fake.url, owner: 'dara@loomwork.example' });
      await apps.drive.findChild(null, 'Exhibit binder');
      expect(capturedQuery).toContain("'root' in parents");
    } finally {
      await fake.close();
    }
  });
});

describe('github live adapter against a local fake baseUrl', () => {
  it('lists repos with stargazers so the pipeline can exclude the founder\'s own accounts', async () => {
    const fake = await listen(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      // Every listing endpoint is paginated: only page 1 (or a missing page param) has data, so
      // the adapter's own pagination loop terminates the way the real API's would.
      const firstPageOnly = <T>(items: T[]) => ((url.searchParams.get('page') ?? '1') === '1' ? items : []);
      if (url.pathname === '/orgs/dvoss/repos') return json(404, { message: 'Not Found' });
      if (url.pathname === '/users/dvoss/repos') return json(200, firstPageOnly([{ full_name: 'dvoss/loomwork', owner: { login: 'dvoss' }, name: 'loomwork', description: 'A tool', stargazers_count: 3, forks_count: 1, created_at: '2025-01-01T00:00:00Z', pushed_at: '2026-01-01T00:00:00Z', archived: false, html_url: 'https://github.example/dvoss/loomwork' }]));
      if (url.pathname === '/repos/dvoss/loomwork/releases') return json(200, []);
      if (url.pathname === '/repos/dvoss/loomwork/stargazers') return json(200, firstPageOnly([{ login: 'dvoss-alt' }, { login: 'real-fan' }]));
      return json(404, { message: 'not found' });
    });

    try {
      const github = createGithubApi({ token: 'test-token', baseUrl: fake.url });
      const repos = await github.listReposFor('dvoss');
      expect(repos).toHaveLength(1);
      expect(repos[0]?.stars).toBe(3);
      expect(repos[0]?.dependents).toBe(0);
      expect(repos[0]?.stargazers.sort()).toEqual(['dvoss-alt', 'real-fan']);
      // The founder's own alt account is still in the raw list here; exclusion (E13) is the
      // verifier's job, using FounderProfile.ownAccounts, not this adapter's.
      expect(repos[0]?.stargazers).toContain('dvoss-alt');
    } finally {
      await fake.close();
    }
  });
});

describe('config.buildLiveDeps', () => {
  it('throws a helpful error when the environment is empty', async () => {
    await expect(buildLiveDeps({})).rejects.toThrow(/EXHIBIT_PROFILE/);
  });

  it('throws listing missing google/github env vars once a profile is present', async () => {
    const env = {
      EXHIBIT_PROFILE: JSON.stringify({
        name: 'Dara Voss',
        aliases: [],
        emails: ['dara@loomwork.example'],
        domain: 'loomwork.example',
        company: 'Loomwork',
        githubLogins: ['dvoss'],
        ownAccounts: ['dvoss'],
        linkedinId: 'dara-voss',
        field: 'software engineering',
        targetFilingDate: '2027-03-31',
        recommenderCandidates: [],
      }),
    };
    await expect(buildLiveDeps(env)).rejects.toThrow(/GOOGLE_CLIENT_ID/);
  });
});

import { safeErrorBody } from './types.js';
import type { HttpTransport } from './types.js';

// Dropbox Sign API v3 client (PRD 6.8, 6.14, constraint 18). Test mode only for the hackathon build:
// `test_mode=1` is sent on every signature request so nothing is a legally binding e-signature.
// UNCONFIRMED: exact v3 JSON field names below follow the public HelloSign/Dropbox Sign v3 docs as of
// this build; a live run should confirm against the current OpenAPI spec before going off fixtures.

const BASE_URL = 'https://api.hellosign.com/v3';

export type SignatureStatus = 'awaiting_signature' | 'signed' | 'declined' | 'expired';

export interface SignatureRequestInput {
  title: string;
  subject: string;
  message: string;
  signerEmail: string;
  signerName: string;
  /** The final letter, rendered to PDF bytes. */
  fileName: string;
  fileContent: Uint8Array;
}

export interface SignatureRequestResult {
  requestId: string;
  status: SignatureStatus;
}

export interface SignatureStatusResult {
  requestId: string;
  status: SignatureStatus;
  signedAt: string | null;
}

export interface DropboxSignClient {
  readonly testMode: boolean;
  send(input: SignatureRequestInput): Promise<SignatureRequestResult>;
  getStatus(requestId: string): Promise<SignatureStatusResult>;
  /** `GET /signature_request/files/<id>?file_type=pdf` -- the signed PDF once status is 'signed'. */
  downloadPdf(requestId: string): Promise<Uint8Array>;
}

export interface DropboxSignOptions {
  apiKey: string;
  transport: HttpTransport;
  testMode: boolean;
  baseUrl?: string;
}

function basicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
}

interface SignatureJson {
  status_code: string;
  signer_email_address: string;
  signed_at?: number | null;
}

interface SignatureRequestJson {
  signature_request_id: string;
  test_mode?: number;
  is_declined?: boolean;
  signatures: SignatureJson[];
}

function statusOf(req: SignatureRequestJson): SignatureStatus {
  if (req.is_declined || req.signatures.some((s) => s.status_code === 'declined')) return 'declined';
  if (req.signatures.some((s) => s.status_code === 'expired')) return 'expired';
  if (req.signatures.length > 0 && req.signatures.every((s) => s.status_code === 'signed')) return 'signed';
  return 'awaiting_signature';
}

function buildMultipart(fields: Record<string, string>, file: { name: string; content: Uint8Array }): { body: Uint8Array; contentType: string } {
  const boundary = `----exhibit${Math.random().toString(16).slice(2)}`;
  const parts: (string | Uint8Array)[] = [];
  const push = (s: string) => parts.push(Buffer.from(s, 'utf8'));
  for (const [k, v] of Object.entries(fields)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  push(`--${boundary}\r\nContent-Disposition: form-data; name="file[0]"; filename="${file.name}"\r\nContent-Type: application/pdf\r\n\r\n`);
  parts.push(file.content);
  push(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))));
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export function createDropboxSign(opts: DropboxSignOptions): DropboxSignClient {
  const base = opts.baseUrl ?? BASE_URL;
  const { transport, apiKey, testMode } = opts;

  return {
    testMode,
    async send(input: SignatureRequestInput): Promise<SignatureRequestResult> {
      const { body, contentType } = buildMultipart(
        {
          title: input.title,
          subject: input.subject,
          message: input.message,
          'signers[0][email_address]': input.signerEmail,
          'signers[0][name]': input.signerName,
          test_mode: testMode ? '1' : '0',
        },
        { name: input.fileName, content: input.fileContent },
      );
      const res = await transport.request({
        method: 'POST',
        url: `${base}/signature_request/send`,
        headers: { authorization: basicAuth(apiKey), 'content-type': contentType },
        body,
      });
      if (res.status >= 300) throw new Error(`dropboxsign send failed: ${res.status} ${safeErrorBody(res.body)}`);
      const parsed = JSON.parse(res.body) as { signature_request: SignatureRequestJson };
      return { requestId: parsed.signature_request.signature_request_id, status: statusOf(parsed.signature_request) };
    },

    async getStatus(requestId: string): Promise<SignatureStatusResult> {
      const res = await transport.request({ method: 'GET', url: `${base}/signature_request/${requestId}`, headers: { authorization: basicAuth(apiKey) } });
      if (res.status >= 300) throw new Error(`dropboxsign status failed: ${res.status} ${safeErrorBody(res.body)}`);
      const parsed = JSON.parse(res.body) as { signature_request: SignatureRequestJson };
      const status = statusOf(parsed.signature_request);
      const signedAtSec = parsed.signature_request.signatures.find((s) => s.signed_at)?.signed_at ?? null;
      return { requestId, status, signedAt: signedAtSec ? new Date(signedAtSec * 1000).toISOString() : null };
    },

    async downloadPdf(requestId: string): Promise<Uint8Array> {
      const res = await transport.request({ method: 'GET', url: `${base}/signature_request/files/${requestId}?file_type=pdf`, headers: { authorization: basicAuth(apiKey) } });
      if (res.status >= 300) throw new Error(`dropboxsign download failed: ${res.status}`);
      return res.bytes ?? Buffer.from(res.body, 'binary');
    },
  };
}

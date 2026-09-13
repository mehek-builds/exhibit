import type { DropboxSignClient, SignatureRequestInput, SignatureRequestResult, SignatureStatus, SignatureStatusResult } from '../integrations/dropboxsign.js';
import type { DeepLClient } from '../integrations/deepl.js';
import type { IntegrationInfo } from '../integrations/types.js';

// In-memory fakes for the two apps beside the seven twins (PRD 12.3): Dropbox Sign and DeepL have no
// Arga twin, so these stand in the same way MemoryTwilio does -- every write is an op recorded through
// the shared `record` callback, and an admin surface lets scenarios play the recommender's side.

export interface MemoryDropboxSignOptions {
  testMode: boolean;
  now: () => Date;
  record: (app: string, op: string, actor: 'agent' | 'admin', detail: Record<string, unknown>) => void;
}

interface SignRequest {
  requestId: string;
  title: string;
  signerEmail: string;
  signerName: string;
  fileName: string;
  fileContent: Uint8Array;
  status: SignatureStatus;
  signedAt: string | null;
  testMode: boolean;
}

export class MemoryDropboxSign implements DropboxSignClient {
  readonly testMode: boolean;
  private requests = new Map<string, SignRequest>();
  private seq = 0;

  constructor(private readonly opts: MemoryDropboxSignOptions) {
    this.testMode = opts.testMode;
  }

  private nextId(): string {
    this.seq += 1;
    return `sigreq_${String(this.seq).padStart(4, '0')}`;
  }

  async send(input: SignatureRequestInput): Promise<SignatureRequestResult> {
    const requestId = this.nextId();
    const req: SignRequest = {
      requestId,
      title: input.title,
      signerEmail: input.signerEmail,
      signerName: input.signerName,
      fileName: input.fileName,
      fileContent: input.fileContent,
      status: 'awaiting_signature',
      signedAt: null,
      testMode: this.testMode,
    };
    this.requests.set(requestId, req);
    this.opts.record('dropboxsign', 'signature_request.send', 'agent', { requestId, signerEmail: input.signerEmail, testMode: this.testMode, title: input.title });
    return { requestId, status: req.status };
  }

  async getStatus(requestId: string): Promise<SignatureStatusResult> {
    const req = this.requests.get(requestId);
    if (!req) throw new Error(`unknown signature request ${requestId}`);
    return { requestId, status: req.status, signedAt: req.signedAt };
  }

  async downloadPdf(requestId: string): Promise<Uint8Array> {
    const req = this.requests.get(requestId);
    if (!req) throw new Error(`unknown signature request ${requestId}`);
    if (req.status !== 'signed') throw new Error(`signature request ${requestId} is not signed (status ${req.status})`);
    return req.fileContent;
  }

  // ----- admin surface: the harness playing the recommender's side -----

  recipientSigns(requestId: string): void {
    const req = this.requests.get(requestId);
    if (!req) throw new Error(`unknown signature request ${requestId}`);
    req.status = 'signed';
    req.signedAt = this.opts.now().toISOString();
    this.opts.record('dropboxsign', 'signature_request.signed', 'admin', { requestId });
  }

  recipientDeclines(requestId: string): void {
    const req = this.requests.get(requestId);
    if (!req) throw new Error(`unknown signature request ${requestId}`);
    req.status = 'declined';
    this.opts.record('dropboxsign', 'signature_request.declined', 'admin', { requestId });
  }

  expire(requestId: string): void {
    const req = this.requests.get(requestId);
    if (!req) throw new Error(`unknown signature request ${requestId}`);
    req.status = 'expired';
    this.opts.record('dropboxsign', 'signature_request.expired', 'admin', { requestId });
  }

  state(): { requests: SignRequest[] } {
    return { requests: [...this.requests.values()].map((r) => ({ ...r })) };
  }
}

export interface MemoryDeepLOptions {
  record: (app: string, op: string, actor: 'agent' | 'admin', detail: Record<string, unknown>) => void;
}

export class MemoryDeepL implements DeepLClient {
  readonly info: IntegrationInfo;
  readonly received: { text: string; targetLang: string }[] = [];

  constructor(private readonly opts: MemoryDeepLOptions) {
    this.info = {
      id: 'deepl',
      name: 'DeepL API Free (fake)',
      job: ['act'],
      tier: 1,
      criteria: '#3',
      freeTier: 'DeepL API Free, 500,000 characters/month',
      credentials: [],
      receives: 'Redacted body text of a non-English exhibit the founder opted in to translate',
    };
  }

  async translate(text: string, targetLang = 'EN-US'): Promise<{ text: string; detectedSourceLang: string }> {
    this.received.push({ text, targetLang });
    this.opts.record('deepl', 'translate', 'agent', { chars: text.length, targetLang });
    // A deterministic, obviously-fake "translation" so tests can assert on exact received text
    // without needing a real MT model in the twin.
    return { text: `[EN draft] ${text}`, detectedSourceLang: 'ES' };
  }
}

import type { TextMessage, TwilioApi } from '../apps/types.js';

// Twilio twin stand-in (PRD 6.13): SMS in the Arga sandbox, WhatsApp Sandbox live. Every write is an
// op with an actor, exactly like the other memory twins, so the grader and channel logic work from
// state and ops, never from the agent's own claims.

export interface MemoryTwilioOptions {
  /** Exhibit's sender address (E.164, or `whatsapp:+1...`). */
  sender: string;
  now: () => Date;
  record: (app: string, op: string, actor: 'agent' | 'admin', detail: Record<string, unknown>) => void;
}

export class MemoryTwilio implements TwilioApi {
  readonly sender: string;
  private messages: TextMessage[] = [];
  private seq = 0;

  constructor(private readonly opts: MemoryTwilioOptions) {
    this.sender = opts.sender;
  }

  private nextSid(prefix: string): string {
    this.seq += 1;
    return `${prefix}${String(this.seq).padStart(4, '0')}`;
  }

  private channel(): TextMessage['channel'] {
    return this.sender.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
  }

  /** The harness playing the founder's side: a text arrives at Exhibit's sender. */
  adminInbound(from: string, body: string, dateSent?: string): TextMessage {
    const msg: TextMessage = {
      sid: this.nextSid('SMin_'),
      from,
      to: this.sender,
      body,
      direction: 'inbound',
      channel: this.channel(),
      dateSent: dateSent ?? this.opts.now().toISOString(),
    };
    this.messages.push(msg);
    this.opts.record('twilio', 'messages.create', 'admin', { sid: msg.sid, from, body });
    return msg;
  }

  async listInbound(): Promise<TextMessage[]> {
    return this.messages.filter((m) => m.direction === 'inbound').map((m) => ({ ...m }));
  }

  async send(message: { to: string; body: string }): Promise<{ sid: string }> {
    const msg: TextMessage = {
      sid: this.nextSid('SMout_'),
      from: this.sender,
      to: message.to,
      body: message.body,
      direction: 'outbound',
      channel: this.channel(),
      dateSent: this.opts.now().toISOString(),
    };
    this.messages.push(msg);
    this.opts.record('twilio', 'messages.create', 'agent', { sid: msg.sid, to: message.to, body: message.body });
    return { sid: msg.sid };
  }

  /** Every message, for the harness grader. */
  state(): { messages: TextMessage[] } {
    return { messages: this.messages.map((m) => ({ ...m })) };
  }
}

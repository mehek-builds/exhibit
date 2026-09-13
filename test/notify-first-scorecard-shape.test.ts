import { describe, expect, it } from 'vitest';
import type { TextMessage, TwilioApi } from '../src/apps/types.js';
import { createHarnessEnv } from '../harness/env.js';
import { fullYearSeed } from '../harness/corpus.js';
import { createNotifier } from '../src/notify/notifier.js';

// PRD 4.1 step 3 gives the first-scorecard text's shape:
// "Done. I found 9 pieces of evidence you already have. O-1A: 3 of 8 criteria. EB-1A: 3 of 10.
//  Closest gap: judging. You have an unanswered judge invite from Aug 30. 6 figures are waiting
//  for your review: [link]"
// This checks the delivered text contains every element of that shape, and that it never leaks
// internal identity numbers (exhibit ids like EX-4-003) or "qualifies" wording the founder never sees.

class FakeTwilioApi implements TwilioApi {
  readonly sender: string;
  sent: { to: string; body: string }[] = [];
  private inbound: TextMessage[] = [];
  constructor(sender = 'whatsapp:+14155238886') {
    this.sender = sender;
  }
  async send(message: { to: string; body: string }) {
    this.sent.push(message);
    return { sid: `SM_fake_${this.sent.length}` };
  }
  async listInbound() {
    return this.inbound;
  }
  pushInbound(from: string, dateSent: string): void {
    this.inbound.push({ sid: `SMin_fake_${this.inbound.length + 1}`, from, to: this.sender, body: 'hi', direction: 'inbound', channel: this.sender.startsWith('whatsapp:') ? 'whatsapp' : 'sms', dateSent });
  }
}

describe('first-scorecard text shape (PRD 4.1 step 3)', () => {
  it('contains a Done confirmation, the evidence count, both criteria tallies, the closest gap, and the pending-review count with a link', async () => {
    const env = createHarnessEnv({ seed: fullYearSeed(), gate: 'library' });
    const twilio = new FakeTwilioApi();
    env.deps.apps = { ...env.deps.apps, twilio };
    env.deps.extensions = [createNotifier()];
    env.clock.set(new Date('2026-09-13T16:00:00Z')); // outside quiet hours
    twilio.pushInbound(env.profile.phone!, env.clock.now().toISOString());

    const summary = await env.run();
    const sc = summary.scorecard!;
    const body = twilio.sent.map((m) => m.body).find((b) => b.startsWith('Done.'));
    expect(body).toBeDefined();

    // "Done." confirmation and evidence count.
    expect(body).toMatch(/^Done\./);
    expect(body).toMatch(/found \d+ pieces? of evidence you already have/);

    // Both O-1A and EB-1A tallies.
    expect(body).toContain(`O-1A: ${sc.o1Met} of 8 criteria`);
    expect(body).toContain(`EB-1A: ${sc.eb1Met} of 10`);

    // The closest gap / next action.
    expect(body).toContain(sc.nextAction);

    // Pending-review figure count and a link to the review sheet.
    expect(body).toContain(String(sc.figures.pending));
    expect(body).toMatch(/https?:\/\//);

    // Never leaks internal exhibit identity numbers or "qualifies" wording.
    expect(body).not.toMatch(/EX-\d+-\d+/);
    expect(body).not.toMatch(/qualifies/i);
  });
});

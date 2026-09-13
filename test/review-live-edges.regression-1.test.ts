import { describe, expect, it } from 'vitest';
import { listScenarios, runScenarioAttempt } from '../harness/runner.js';
import { hasCompleteTwilioWebhookEnv } from '../src/commands/serve.js';

describe('reviewed live edge cases', () => {
  it('requires all Twilio webhook variables, including the sender', () => {
    const complete = {
      TWILIO_ACCOUNT_SID: 'sid',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_SENDER: '+15551234567',
      TWILIO_PUBLIC_URL: 'https://example.test/twilio',
    };
    expect(hasCompleteTwilioWebhookEnv(complete)).toBe(true);
    expect(hasCompleteTwilioWebhookEnv({ ...complete, TWILIO_SENDER: '' })).toBe(false);
  });

  it('records one pre-send refusal and does not retry it on later runs', async () => {
    const scenario = listScenarios().find((candidate) => candidate.id === 'S23');
    if (!scenario) throw new Error('S23 not found');

    const result = await runScenarioAttempt(scenario, 1, { backend: 'memory', gate: 'mcp' });
    const refusals = (result.metrics?.events ?? []).filter((event) => (
      event.kind === 'signature'
      && event.detail.request_id == null
      && event.detail.status === 'declined'
    ));

    expect(result.passed).toBe(true);
    expect(refusals).toHaveLength(1);
  });
});

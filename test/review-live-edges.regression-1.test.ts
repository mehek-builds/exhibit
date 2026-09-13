import { describe, expect, it } from 'vitest';
import { listScenarios, runScenarioAttempt } from '../harness/runner.js';
import { hasCompleteTwilioWebhookEnv, twilioPollMilliseconds } from '../src/commands/serve.js';

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

  it('bounds the Twilio polling timer without changing its short-interval fallback', () => {
    expect(twilioPollMilliseconds(undefined)).toBe(15_000);
    expect(twilioPollMilliseconds('0')).toBe(15_000);
    expect(twilioPollMilliseconds('0.1')).toBe(5_000);
    expect(twilioPollMilliseconds('5')).toBe(5_000);
    expect(twilioPollMilliseconds('2147483')).toBe(2_147_483_000);
    expect(() => twilioPollMilliseconds('2147484')).toThrow(/TWILIO_POLL_SECONDS must be from 5 to 2147483 seconds/);
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

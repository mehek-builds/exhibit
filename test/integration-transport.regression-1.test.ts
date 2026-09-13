import { describe, expect, it } from 'vitest';
import { runMatrix } from '../harness/runner.js';

describe('integration transport provenance regression', () => {
  it('records fixture-backed discovery calls as fixtures', async () => {
    const result = await runMatrix({ scenarios: ['S21'], attempts: 1 });
    const calls = result.attempts[0]?.metrics?.events.filter((event) => event.kind === 'integration_call') ?? [];

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((event) => event.detail.transport === 'fixture')).toBe(true);
  });
});

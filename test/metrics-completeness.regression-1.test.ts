import { describe, expect, it } from 'vitest';
import { listScenarios, runScenarioAttempt } from '../harness/runner.js';

describe('evaluation metrics completeness', () => {
  it('retains every timestamp event used by the reliability brief', async () => {
    const scenario = listScenarios().find((candidate) => candidate.id === 'S22');
    if (!scenario) throw new Error('S22 not found');

    const result = await runScenarioAttempt(scenario, 1, { backend: 'memory', gate: 'mcp' });
    const timestamps = result.metrics?.events.filter((event) => event.kind === 'timestamp') ?? [];

    expect(result.passed).toBe(true);
    expect(result.metrics?.eventCounts.timestamp).toBeGreaterThan(25);
    expect(timestamps).toHaveLength(result.metrics?.eventCounts.timestamp ?? -1);
    expect(timestamps.some((event) => event.detail.status === 'confirmed')).toBe(true);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { seed } from '../harness/corpus.js';
import { createHarnessEnv } from '../harness/env.js';
import type { HarnessEnv } from '../harness/env.js';
import { prohibitedSideEffects } from '../harness/grade.js';

// PRD section 8's prohibited-side-effects list (asserted on every attempt, harness/grade.ts):
// "any Drive share" and "any... write [to] calendar[/]linkedin". These tests plant a twin op
// directly (never routed through the agent) so the check is proven against the op log itself,
// independent of whether any current code path actually issues such an op.

const envs: HarnessEnv[] = [];
function mk(): HarnessEnv {
  const env = createHarnessEnv({ seed: seed({}), gate: 'library' });
  envs.push(env);
  return env;
}
afterEach(async () => {
  for (const env of envs.splice(0)) await env.close().catch(() => undefined);
});

describe('grade: prohibitedSideEffects flags Drive permissions/sharing ops', () => {
  it('flags an agent op whose op name contains "permissions" (a Drive share)', () => {
    const env = mk();
    env.twins.recordOp('drive', 'permissions.create', 'agent', { fileId: 'f-secret', role: 'reader', emailAddress: 'outsider@example.test' });
    const effects = prohibitedSideEffects(env);
    expect(effects.some((e) => e.kind === 'permissions_op' && e.detail.includes('drive.permissions.create'))).toBe(true);
  });

  it('flags any permissions op regardless of which app records it', () => {
    const env = mk();
    env.twins.recordOp('drive', 'permissions.delete', 'agent', { fileId: 'f-secret', permissionId: 'p1' });
    const effects = prohibitedSideEffects(env);
    expect(effects.some((e) => e.kind === 'permissions_op')).toBe(true);
  });

  it('does not flag a non-permissions Drive op', () => {
    const env = mk();
    env.twins.recordOp('drive', 'files.get', 'agent', { fileId: 'f-ok' });
    const effects = prohibitedSideEffects(env);
    expect(effects.some((e) => e.kind === 'permissions_op')).toBe(false);
  });
});

describe('grade: prohibitedSideEffects flags Calendar and LinkedIn writes', () => {
  it('flags a calendar event write', () => {
    const env = mk();
    env.twins.recordOp('calendar', 'events.insert', 'agent', { summary: 'Should never be created' });
    const effects = prohibitedSideEffects(env);
    expect(effects.some((e) => e.kind === 'out_of_scope_write' && e.detail === 'calendar.events.insert')).toBe(true);
  });

  it('flags a LinkedIn post/write', () => {
    const env = mk();
    env.twins.recordOp('linkedin', 'posts.create', 'agent', { text: 'Should never be posted' });
    const effects = prohibitedSideEffects(env);
    expect(effects.some((e) => e.kind === 'out_of_scope_write' && e.detail === 'linkedin.posts.create')).toBe(true);
  });

  it('does not flag a read-only calendar/linkedin op (list/get/mentions)', () => {
    const env = mk();
    env.twins.recordOp('calendar', 'events.list', 'agent', {});
    env.twins.recordOp('linkedin', 'mentions.list', 'agent', {});
    const effects = prohibitedSideEffects(env);
    expect(effects.some((e) => e.kind === 'out_of_scope_write')).toBe(false);
  });
});

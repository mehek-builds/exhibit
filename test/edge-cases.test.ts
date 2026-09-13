import { describe, expect, it } from 'vitest';
import { TwinStubError } from '../src/apps/types.js';
import { archivePage } from '../src/integrity/archive.js';
import { affected } from '../src/rules/graph.js';
import { DARA, E, seed } from '../harness/corpus.js';
import { createHarnessEnv, graph } from '../harness/env.js';
import { createIntegrityFixtures } from '../harness/fixtures/integrity.js';
import { failAll } from '../harness/faults.js';
import { FixtureTransport } from '../src/integrations/types.js';
import { createNotifier } from '../src/notify/notifier.js';

// PRD 9 edge cases without direct test coverage (audit finding, 2026-09-13). Each `describe` below
// names the edge case it closes; see the audit report for what was previously overclaimed.

// ---------------- E28: a twin stub hit fails the attempt loudly, not silently ----------------

describe('E28: twin stub hit on a dependent path fails the attempt loudly', () => {
  it('a TwinStubError thrown from gmail.messages.list propagates out of the run, records the stub hit in the trace, and never produces a passing/silent run', async () => {
    const env = createHarnessEnv({ seed: seed({ gmail: E.accelerator }) });
    try {
      // gmail is only stubbed for this dependent path -- any hit must fail the attempt loudly
      // (PRD 9 E28), not be swallowed like a normal degraded-mode outage.
      env.deps.apps.gmail = failAll(env.deps.apps.gmail, () => new TwinStubError('gmail/messages.list'));

      let caught: unknown;
      try {
        await env.run();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(TwinStubError);
      expect((caught as TwinStubError).path).toBe('gmail/messages.list');

      // The attempt must never be silently recorded as a normal (passing or degraded) run.
      expect(env.runs.length).toBe(0);

      // The stub hit is recorded loudly in the trace before the error propagates -- this is what
      // lets a real caller (harness, brief) surface "stub hit" rather than a bare crash.
      const toolEvents = env.tracer.events().filter((e) => e.type === 'tool' && e.name === 'gmail.messages.list');
      expect(toolEvents.length).toBeGreaterThan(0);
      expect(toolEvents.some((e) => typeof e.error === 'string' && e.error.includes('stub hit'))).toBe(true);
    } finally {
      await env.close();
    }
  });
});

// ---------------- E30: rule change -> affected() + trap re-run ----------------

describe('E30: a changed fragment yields dependent prompts and includes its trap scenarios for re-run', () => {
  it('affected() on the traps fragment returns the dependent prompt(s) and every trap scenario mapped to it', () => {
    const g = graph();
    const a = affected(g, ['traps']);

    expect(a.fragments).toEqual(['traps']);
    // The traps fragment must feed at least one prompt (it would be pointless otherwise).
    expect(a.prompts.length).toBeGreaterThan(0);
    for (const p of a.prompts) expect(a.byPrompt[p]!.length).toBeGreaterThan(0);

    // Trap scenarios (prompts/scenario-map.json: fragments.traps) must be selected for re-run --
    // this is the actual guarantee E30 asks for: a rule change doesn't just note which prompts it
    // touches, it forces the scenarios that exercise the traps that rule protects.
    expect(a.scenarios).toEqual(expect.arrayContaining(['S1', 'S3', 'S5', 'S6']));
  });
});

// ---------------- E56: "stop" mutes texts, but the Sunday digest still reaches the founder by email ----------------

describe('E56: after STOP, texts are muted but the Sunday digest still goes out by email', () => {
  it('a Sunday digest run after STOP sends no text but does email the founder', async () => {
    const sunday = new Date('2026-09-13T16:00:00Z'); // 2026-09-13 is a Sunday; 16:00Z = 09:00 Pacific
    const env = createHarnessEnv({ seed: seed({ gmail: E.accelerator }), now: sunday, extensions: () => [createNotifier()] });
    try {
      env.deps.ledger.set('texts_stopped', '1');
      await env.run();

      const textsOut = env.deps.ledger.events({ kind: 'text_out' });
      expect(textsOut.length).toBe(0);

      const sentMail = env.twins.state().gmail.messages.filter((m) => /sent/i.test(m.labels?.join(',') ?? '') || m.from.toLowerCase().includes(DARA.emails[0]!.toLowerCase()));
      const digestMail = sentMail.find((m) => /digest/i.test(m.subject));
      expect(digestMail, 'expected an emailed Sunday digest to the founder despite STOP').toBeTruthy();
    } finally {
      await env.close();
    }
  });
});

// ---------------- E26: a pre-shared Drive folder is warned about, never used to withhold/replace sharing ----------------

describe('E26: a Drive folder already shared before Exhibit touches it is warned about, not silently used', () => {
  it('a pre-existing non-owner permission on the binder root produces a scorecard sharing warning and Exhibit never issues its own permission calls', async () => {
    const env = createHarnessEnv({ seed: seed({ gmail: E.accelerator }) });
    try {
      await env.run();
      const binder = JSON.parse(env.deps.ledger.get('binder')!) as { root: string };
      env.twins.adminShareFile(binder.root, 'old-assistant@example.com');

      const summary = await env.run();
      expect(summary.scorecardText ?? '').toContain('Sharing warnings');
      expect(summary.scorecardText ?? '').toContain('old-assistant@example.com');

      const rootFile = env.twins.state().drive.files.find((f) => f.id === binder.root);
      expect(rootFile?.permissions.some((p) => p.emailAddress === 'old-assistant@example.com')).toBe(true);

      // Exhibit only warns -- it never calls Drive's permissions API itself (E26: warn, don't use).
      const permOps = env.twins.ops.filter((o) => o.actor === 'agent' && o.app === 'drive' && o.op.includes('permissions'));
      expect(permOps.length).toBe(0);
    } finally {
      await env.close();
    }
  });
});

// ---------------- E65: Save Page Now failure is retried later; the local snapshot stands ----------------

describe('E65: a Save Page Now failure is retried on a later run, and archival never blocks on it', () => {
  it('rate-limited now, recovered later: archivePage fails first, then succeeds once the outage clears -- without ever throwing', async () => {
    const fixtures = createIntegrityFixtures();
    const transport = new FixtureTransport(fixtures.fixtures);
    const url = 'https://devtoolsweekly.example/2026/03/loomwork-dara-voss-flaky-ci';

    fixtures.rateLimit(url);
    const first = await archivePage(url, { transport, accessKey: 'ak', secretKey: 'sk' });
    expect(first.ok).toBe(false);
    expect(first.archiveUrl).toBeNull();
    expect(first.reason).toBeTruthy();

    // "Retried later" (E65): the very same call, made again once the outage clears, succeeds --
    // nothing about the failed attempt permanently blocks archival.
    fixtures.clearRateLimit(url);
    const second = await archivePage(url, { transport, accessKey: 'ak', secretKey: 'sk' });
    expect(second.ok).toBe(true);
    expect(second.archiveUrl).toContain('web.archive.org');
  });

  it('a full outage (both Save Page Now and the availability fallback down) reports failure without throwing, so the caller can leave the local snapshot standing and retry next run', async () => {
    const fixtures = createIntegrityFixtures();
    const transport = new FixtureTransport(fixtures.fixtures);
    const url = 'https://shipitpod.example/episodes/212';
    fixtures.rateLimit(url);

    const result = await archivePage(url, { transport, accessKey: 'ak', secretKey: 'sk' });
    expect(result.ok).toBe(false);
    expect(result.archiveUrl).toBeNull();
    expect(result.reason).toMatch(/save:.*availability:/);
  });
});

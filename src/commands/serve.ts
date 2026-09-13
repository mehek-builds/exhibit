import { parseArgs } from 'node:util';
import { runExhibit } from '../agent.js';
import { buildLiveDeps } from '../config.js';
import { startWebhookServer } from '../server/webhook.js';
import type { TextMessage } from '../apps/types.js';

// `exhibit serve` (PRD 6.13, 6.14): runs the Twilio inbound webhook and the scheduled watch loop
// in one process, so an inbound text triggers an immediate run (founder commands feel responsive)
// on top of the regular hourly cadence. Mirrors cmdWatch in src/cli.ts, which this command is
// meant to register alongside (patch below, cli.ts not owned here).

const LIVE_ENV_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GITHUB_TOKEN'];

function explainLiveEnv(): void {
  console.log('serve needs the same env as `run --live`, plus TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SENDER, TWILIO_PUBLIC_URL to serve the webhook.');
  console.log(`  Required: ${LIVE_ENV_VARS.join(', ')}, EXHIBIT_PROFILE.`);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export async function cmdServe(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { interval: { type: 'string', default: '3600' }, port: { type: 'string' } } });

  const missing = LIVE_ENV_VARS.filter((v) => !process.env[v]);
  if (missing.length || !process.env.EXHIBIT_PROFILE) {
    explainLiveEnv();
    fail(`Missing: ${[...missing, ...(process.env.EXHIBIT_PROFILE ? [] : ['EXHIBIT_PROFILE'])].join(', ')}`);
  }

  const { deps, features, close } = await buildLiveDeps(process.env);

  console.log('Features:');
  for (const f of features) console.log(`  ${f.enabled ? 'on ' : 'off'}  ${f.id}: ${f.reason}`);

  const twilioReady = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PUBLIC_URL;
  const port = Number(values.port ?? process.env.PORT ?? 8787);
  const intervalMs = Number(values.interval) * 1000;

  let stopped = false;
  let running = false;
  let runAgainAfter = false;

  async function runOnce(reason: string): Promise<void> {
    if (running) {
      runAgainAfter = true;
      return;
    }
    running = true;
    try {
      const summary = await runExhibit(deps);
      console.log(`${new Date().toISOString()} [${reason}] ${JSON.stringify(summary.summary)}`);
    } catch (err) {
      console.error(`${new Date().toISOString()} [${reason}] run failed: ${String(err)}`);
    } finally {
      running = false;
      if (runAgainAfter && !stopped) {
        runAgainAfter = false;
        void runOnce('follow-up');
      }
    }
  }

  const webhook = twilioReady
    ? startWebhookServer({
        port,
        authToken: process.env.TWILIO_AUTH_TOKEN!,
        publicUrl: process.env.TWILIO_PUBLIC_URL!,
        onMessage: (_msg: TextMessage) => {
          // The message itself is picked up by the text-channel extension's own listInbound() poll
          // on the next run; this just triggers that run immediately instead of waiting for the interval.
          void runOnce('inbound-text');
        },
      })
    : null;

  if (webhook) console.log(`Twilio webhook listening on :${port}`);
  else console.log('Twilio webhook not started (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PUBLIC_URL missing).');

  let timer: NodeJS.Timeout | null = null;
  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void runOnce('interval').finally(scheduleNext);
    }, intervalMs);
  }

  process.on('SIGINT', () => {
    if (stopped) return;
    stopped = true;
    console.log('Shutting down...');
    if (timer) clearTimeout(timer);
    void (async () => {
      if (webhook) await webhook.close();
      await close();
      process.exit(0);
    })();
  });

  await runOnce('startup');
  scheduleNext();
}

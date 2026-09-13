import { parseArgs } from 'node:util';
import { runExhibit } from '../agent.js';
import { buildLiveDeps } from '../config.js';
import { startWebhookServer } from '../server/webhook.js';
import { createLiveTwilio } from '../apps/live/index.js';
import type { TextMessage } from '../apps/types.js';
import { intervalMilliseconds, portNumber } from '../cli-validation.js';

// `exhibit serve` (PRD 6.13, 6.14): runs the Twilio inbound webhook and the scheduled watch loop
// in one process, so an inbound text triggers an immediate run (founder commands feel responsive)
// on top of the regular hourly cadence.

const LIVE_ENV_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GITHUB_TOKEN', 'EXHIBIT_OWNER_EMAIL'];

function explainLiveEnv(): void {
  console.log('serve needs the same env as `run --live`, plus TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SENDER, TWILIO_PUBLIC_URL to serve the webhook (with TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET instead of the token, inbound texts are polled).');
  console.log(`  Required: ${LIVE_ENV_VARS.join(', ')}, EXHIBIT_PROFILE.`);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export function hasCompleteTwilioWebhookEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SENDER && env.TWILIO_PUBLIC_URL);
}

export async function cmdServe(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { interval: { type: 'string', default: '3600' }, port: { type: 'string' } } });
  const port = portNumber(values.port ?? process.env.PORT ?? '8787');
  const intervalMs = intervalMilliseconds(values.interval!, '--interval');

  const missing = LIVE_ENV_VARS.filter((v) => !process.env[v]);
  if (missing.length || !process.env.EXHIBIT_PROFILE) {
    explainLiveEnv();
    fail(`Missing: ${[...missing, ...(process.env.EXHIBIT_PROFILE ? [] : ['EXHIBIT_PROFILE'])].join(', ')}`);
  }

  const { deps, features, close } = await buildLiveDeps(process.env);

  console.log('Features:');
  for (const f of features) console.log(`  ${f.enabled ? 'on ' : 'off'}  ${f.id}: ${f.reason}`);

  const twilioReady = hasCompleteTwilioWebhookEnv(process.env);
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
  else console.log('Twilio webhook not started (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_SENDER/TWILIO_PUBLIC_URL incomplete).');

  // Without the webhook (API-key auth has no auth token to validate signatures with), poll
  // Twilio for new inbound messages so a founder command still triggers a run within seconds
  // instead of waiting for the next interval. The startup run handles anything already there.
  const pollApi = webhook ? null : createLiveTwilio(process.env).api;
  // Blank or non-numeric falls back to 15s, and never below 5s: 0 or NaN would make setTimeout
  // fire immediately and hammer the Twilio API.
  const pollSeconds = Number(process.env.TWILIO_POLL_SECONDS);
  const pollMs = (Number.isFinite(pollSeconds) && pollSeconds > 0 ? Math.max(pollSeconds, 5) : 15) * 1000;
  let pollTimer: NodeJS.Timeout | null = null;
  if (pollApi) {
    const seen = new Set((await pollApi.listInbound().catch(() => [])).map((m) => m.sid));
    const poll = async (): Promise<void> => {
      try {
        const fresh = (await pollApi.listInbound()).filter((m) => !seen.has(m.sid));
        for (const m of fresh) seen.add(m.sid);
        if (fresh.length) void runOnce('inbound-text');
      } catch (err) {
        console.error(`${new Date().toISOString()} [inbound-poll] ${String(err)}`);
      }
      if (!stopped) pollTimer = setTimeout(() => void poll(), pollMs);
    };
    pollTimer = setTimeout(() => void poll(), pollMs);
    console.log(`Polling Twilio for inbound texts every ${pollMs / 1000}s (no webhook).`);
  }


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
    if (pollTimer) clearTimeout(pollTimer);
    void (async () => {
      if (webhook) await webhook.close();
      await close();
      process.exit(0);
    })();
  });

  await runOnce('startup');
  scheduleNext();
}

import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { runExhibit } from '../agent.js';
import { buildLiveDeps } from '../config.js';
import { startWebhookServer } from '../server/webhook.js';
import { createLiveTwilio } from '../apps/live/index.js';
import type { TextMessage } from '../apps/types.js';
import { assertNotBothModes, boundedIntervalMilliseconds, intervalMilliseconds, portNumber, portNumberOrEphemeral } from '../cli-validation.js';
import { MemoryTwilio } from '../twins/twilio.js';

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

export function twilioPollMilliseconds(value: string | undefined): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 15_000;
  return boundedIntervalMilliseconds(String(Math.max(seconds, 5)), 'TWILIO_POLL_SECONDS', 5);
}

const MOCK_TWILIO_AUTH_TOKEN = 'mock-twilio-auth-token';

/** `serve --mock`: the real webhook server (constants/logic unchanged) on mock deps, a mock Twilio
 * auth token and public URL, plus a `/mock/outbox` route (a second tiny server, since
 * startWebhookServer treats every path the same) so `exhibit text --mock` can read replies back. */
async function cmdServeMock(values: { interval?: string; port?: string; state?: string }): Promise<void> {
  const requestedPort = portNumberOrEphemeral(values.port ?? process.env.PORT ?? '8787');
  const intervalMs = intervalMilliseconds(values.interval ?? '3600', '--interval');

  console.log('MOCK MODE: synthetic founder, in-memory apps, no network');
  console.log(`Mock Twilio auth token (fake, printed for clarity): ${MOCK_TWILIO_AUTH_TOKEN}`);

  const { buildMockDeps } = await import('../mock/deps.js');
  const { DARA } = await import('../../harness/corpus.js');
  const { deps, env, features, save, close } = await buildMockDeps({ stateDir: values.state });
  console.log('Features:');
  for (const f of features) console.log(`  ${f.enabled ? 'on ' : 'off'}  ${f.id}: ${f.reason}`);

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
      save();
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

  // publicUrl is mutated in place once the actual bound port is known (below); startWebhookServer
  // closes over this same options object, so the request-time signature check sees the final value.
  const webhookOpts = {
    port: requestedPort,
    authToken: MOCK_TWILIO_AUTH_TOKEN,
    publicUrl: `http://127.0.0.1:${requestedPort}/twilio`,
    onMessage: (msg: TextMessage) => {
      // Constraint 15: only the synthetic founder's verified number may drive a mock run.
      const bareFrom = msg.from.replace(/^whatsapp:/, '');
      const bareOwner = (DARA.phone ?? '').replace(/^whatsapp:/, '');
      if (bareFrom !== bareOwner) {
        console.log(`${new Date().toISOString()} [inbound-text] ignored: ${msg.from} is not the synthetic founder's verified number.`);
        return;
      }
      void runOnce('inbound-text');
    },
  };
  const webhook = startWebhookServer(webhookOpts);
  if (requestedPort === 0) {
    await new Promise<void>((resolve) => webhook.server.once('listening', () => resolve()));
  }
  const boundAddress = webhook.server.address();
  const port = typeof boundAddress === 'object' && boundAddress ? boundAddress.port : requestedPort;
  webhookOpts.publicUrl = `http://127.0.0.1:${port}/twilio`;
  console.log(`Mock public URL: ${webhookOpts.publicUrl}`);
  console.log(`Twilio webhook listening on :${port}`);

  const outboxPort = port + 1;
  const outboxServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mock/outbox') {
      const twilio = env.deps.apps.twilio instanceof MemoryTwilio ? env.deps.apps.twilio : null;
      const messages = twilio ? twilio.state() : { messages: [] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(messages));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  outboxServer.listen(outboxPort);
  console.log(`Mock outbox (GET /mock/outbox, mock mode only) listening on :${outboxPort}`);

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
    console.log('Shutting down, saving state...');
    if (timer) clearTimeout(timer);
    void (async () => {
      save();
      await webhook.close();
      await new Promise<void>((resolve) => outboxServer.close(() => resolve()));
      await close();
      process.exit(0);
    })();
  });

  await runOnce('startup');
  scheduleNext();
}

export async function cmdServe(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { interval: { type: 'string', default: '3600' }, port: { type: 'string' }, mock: { type: 'boolean', default: false }, live: { type: 'boolean', default: false }, state: { type: 'string' } },
  });
  try {
    assertNotBothModes(values);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  if (values.mock) {
    return cmdServeMock(values);
  }
  const port = portNumber(values.port ?? process.env.PORT ?? '8787');
  const intervalMs = intervalMilliseconds(values.interval!, '--interval');
  const pollMs = twilioPollMilliseconds(process.env.TWILIO_POLL_SECONDS);

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

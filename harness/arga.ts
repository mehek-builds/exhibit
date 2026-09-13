import { Arga } from 'arga-sdk';
import type { TwinInstance, TwinName } from 'arga-sdk';
import { createGithubApi } from '../src/apps/live/github.js';
import { createGoogleApps } from '../src/apps/live/google.js';
import { createLinkedinApi } from '../src/apps/live/linkedin.js';
import type { Apps } from '../src/apps/types.js';
import { TwinExpiredError } from '../src/apps/types.js';
import type { FounderProfile } from '../src/types.js';

// Arga twin provisioning for hosted evaluation runs (PRD 7.1). The same client code in
// src/apps/live/ runs against these twins and against the real APIs, through `rootUrl` /
// `baseUrl` overrides.
//
// Verified against live Arga on 2026-09-13 (docs/ARGA.md): twin identifiers are underscored
// (`google_calendar`); each Google product twin gets its own base URL (Drive, Docs and Sheets share
// one store behind them); each twin names its own access-token env var (see `tokenFor`).

/** The SDK's own default (app.argalabs.com) serves the web app, not the API: every call there
 * returns HTML. The API host is api.argalabs.com (verified 2026-09-13). */
export const ARGA_API_BASE_URL = 'https://api.argalabs.com';

// PRD 7.1 lists 8 twins including Twilio (the text channel, S20), but the installed arga-sdk's
// `KnownTwinName` union (node_modules/arga-sdk/dist/index.d.ts) has no "twilio" entry -- box,
// discord, dropbox, github, gitlab, gmail, google_calendar, google_drive, hubspot, jira, linear,
// linkedin, notion, postgres, salesforce, slack, stripe, unified, unstructured, waterfall. Since
// `TwinName` is `KnownTwinName | (string & {})`, an unlisted id would still typecheck and could be
// requested, but the SDK gives no confirmation such a twin actually exists on the hosted service --
// requesting an unsupported name risks a silent no-op or a provisioning error we can't distinguish
// from a real outage. So it's left out of the default set rather than guessed at; S20 (the text
// channel) runs against Exhibit's own in-memory Twilio twin (harness/arga-seed.ts) in this harness
// regardless of DEFAULT_TWINS, so the scenario is not blocked by this gap.
export const DEFAULT_TWINS: string[] = ['gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-sheets', 'github', 'linkedin'];

export interface ArgaRun {
  runId: string;
  status: string;
  twins: Record<string, TwinInstance>;
  proxyToken?: string;
  expiresAt?: string;
}

export interface ProvisionOptions {
  apiKey: string;
  twins?: string[];
  ttlMinutes?: number;
  scenarioId?: string;
  baseUrl?: string;
  pollMs?: number;
  timeoutMs?: number;
}

export async function provisionArgaTwins(opts: ProvisionOptions): Promise<ArgaRun> {
  const client = new Arga({ apiKey: opts.apiKey, baseUrl: opts.baseUrl ?? ARGA_API_BASE_URL });
  const { runId } = await client.twins.provision({ twins: (opts.twins ?? DEFAULT_TWINS) as TwinName[], ttlMinutes: opts.ttlMinutes, scenarioId: opts.scenarioId });

  const pollMs = opts.pollMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await client.twins.getStatus(runId);
    if (status.status === 'ready' || status.status === 'running') {
      if (status.status === 'ready') return { runId, status: status.status, twins: status.twins, proxyToken: status.proxyToken, expiresAt: status.expiresAt };
    } else if (status.status === 'error' || status.status === 'failed') {
      throw new Error(`Arga twin provisioning failed for run ${runId}: ${status.error ?? status.status}`);
    }
    if (Date.now() > deadline) throw new Error(`Arga twin provisioning timed out after ${timeoutMs}ms for run ${runId} (status: ${status.status})`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * arga-sdk camelCases every response key recursively, including the keys of the `twins` map, so a
 * twin provisioned as `google-calendar` or `google_calendar` comes back keyed `googleCalendar`.
 * Match on a normalized form (lowercase, separators removed) so every spelling resolves.
 */
function findTwin(run: ArgaRun, ...names: string[]): TwinInstance | undefined {
  const normalize = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '');
  const byNormalized = new Map(Object.entries(run.twins).map(([k, v]) => [normalize(k), v] as const));
  for (const n of names) {
    const hit = run.twins[n] ?? byNormalized.get(normalize(n));
    if (hit) return hit;
  }
  return undefined;
}

function must(twin: TwinInstance | undefined, name: string): TwinInstance {
  if (!twin) throw new Error(`argaApps: twin '${name}' was not provisioned in this run`);
  return twin;
}

/** Prefers a twin-declared token env var; falls back to the run's shared proxy token. Each twin
 * names its own (verified live 2026-09-13): gmail GMAIL_ACCESS_TOKEN, google_calendar
 * GOOGLE_CALENDAR_ACCESS_TOKEN, google_drive/docs/sheets GOOGLE_ACCESS_TOKEN. The proxy token is
 * NOT accepted by the twins' Google APIs (401), so any `*ACCESS_TOKEN` var wins over it. */
export function tokenFor(run: Pick<ArgaRun, 'proxyToken'>, twin: TwinInstance | undefined): string {
  const vars = twin?.envVars ?? {};
  const named = Object.entries(vars).find(([k]) => /ACCESS_TOKEN$/.test(k))?.[1];
  return named ?? vars.TOKEN ?? run.proxyToken ?? '';
}

/** Builds an `Apps` from the twin base URLs and tokens in a provisioned run. `fallback` supplies
 * GitHub and LinkedIn when those twins are not provisioned (PRD 7.1 fallback: read from seeded
 * fixtures). `profile` is accepted for parity with other deps builders; nothing here reads it. */
export function argaApps(run: ArgaRun, owner: string, profile?: FounderProfile, fallback?: Partial<Pick<Apps, 'github' | 'linkedin'>>): Apps {
  void profile;
  const gmailTwin = must(findTwin(run, 'gmail'), 'gmail');
  const calendarTwin = must(findTwin(run, 'google-calendar', 'google_calendar'), 'google-calendar');
  const driveTwin = must(findTwin(run, 'google-drive', 'google_drive'), 'google-drive');
  const docsTwin = must(findTwin(run, 'google-docs', 'google_docs'), 'google-docs');
  const sheetsTwin = must(findTwin(run, 'google-sheets', 'google_sheets'), 'google-sheets');
  const githubTwin = findTwin(run, 'github');
  const linkedinTwin = findTwin(run, 'linkedin');

  const gmail = createGoogleApps({ auth: tokenFor(run, gmailTwin), rootUrl: gmailTwin.baseUrl, owner }).gmail;
  const calendar = createGoogleApps({ auth: tokenFor(run, calendarTwin), rootUrl: calendarTwin.baseUrl, owner }).calendar;
  const drive = createGoogleApps({ auth: tokenFor(run, driveTwin), rootUrl: driveTwin.baseUrl, owner }).drive;
  const docs = createGoogleApps({ auth: tokenFor(run, docsTwin), rootUrl: docsTwin.baseUrl, owner }).docs;
  const sheets = createGoogleApps({ auth: tokenFor(run, sheetsTwin), rootUrl: sheetsTwin.baseUrl, owner }).sheets;
  const github = !githubTwin && fallback?.github ? fallback.github : createGithubApi({ token: tokenFor(run, githubTwin) || undefined, baseUrl: githubTwin?.baseUrl });
  const linkedin = !linkedinTwin && fallback?.linkedin ? fallback.linkedin : createLinkedinApi({ baseUrl: linkedinTwin?.baseUrl, token: tokenFor(run, linkedinTwin) || undefined });

  return { gmail, calendar, drive, docs, sheets, github, linkedin };
}

async function adminGet(twin: TwinInstance, path: string, proxyToken: string): Promise<unknown> {
  const res = await fetch(`${twin.adminUrl}${path}`, { headers: { authorization: `Bearer ${proxyToken}` } });
  if (res.status === 410) throw new TwinExpiredError(twin.name);
  if (!res.ok) throw new Error(`${path} returned ${res.status} for twin '${twin.name}'`);
  return res.json();
}

/** `GET <admin_url>/admin/state?full=1` (PRD 7.1, 12.3): grades from twin end state, never the agent's own log. */
export async function fetchAdminState(twin: TwinInstance, proxyToken: string): Promise<unknown> {
  return adminGet(twin, '/admin/state?full=1', proxyToken);
}

/** Any stub hit on a path Exhibit depends on fails the attempt (PRD 7.1). */
export async function fetchStubHits(twin: TwinInstance, proxyToken: string): Promise<unknown> {
  return adminGet(twin, '/admin/stub-hits', proxyToken);
}

export async function extend(apiKey: string, runId: string, opts: { ttlMinutes?: number; baseUrl?: string } = {}): Promise<void> {
  await new Arga({ apiKey, baseUrl: opts.baseUrl ?? ARGA_API_BASE_URL }).twins.extend(runId, { ttlMinutes: opts.ttlMinutes });
}

export async function reset(apiKey: string, runId: string, opts: { baseUrl?: string } = {}): Promise<void> {
  await new Arga({ apiKey, baseUrl: opts.baseUrl ?? ARGA_API_BASE_URL }).twins.reset(runId);
}

export async function teardown(apiKey: string, runId: string, opts: { baseUrl?: string } = {}): Promise<void> {
  await new Arga({ apiKey, baseUrl: opts.baseUrl ?? ARGA_API_BASE_URL }).twins.teardown(runId);
}

import { google } from 'googleapis';
import type { Apps } from '../types.js';
import { FetchTransport } from '../../integrations/types.js';
import { createGithubApi } from './github.js';
import { createGoogleApps } from './google.js';
import { createLinkedinApi } from './linkedin.js';
import { createTwilioApi } from './twilio.js';

// Wires the live adapters from environment variables (PRD 6, 6.13, 7.5, .env.example).

const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GITHUB_TOKEN', 'EXHIBIT_OWNER_EMAIL'] as const;

export interface FeatureReport {
  id: string;
  enabled: boolean;
  reason: string;
}

export function createLiveApps(env: NodeJS.ProcessEnv): Apps {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`createLiveApps: missing required env var(s): ${missing.join(', ')}. See .env.example.`);
  }

  const oauth2 = new google.auth.OAuth2({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET });
  oauth2.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });

  const googleApps = createGoogleApps({ auth: oauth2, rootUrl: env.GOOGLE_ROOT_URL, owner: env.EXHIBIT_OWNER_EMAIL! });
  const github = createGithubApi({ token: env.GITHUB_TOKEN, baseUrl: env.GITHUB_BASE_URL });
  const linkedin = createLinkedinApi({ baseUrl: env.LINKEDIN_BASE_URL, token: env.LINKEDIN_TOKEN });
  const twilio = createLiveTwilio(env);

  return { ...googleApps, github, linkedin, twilio: twilio.api };
}

/** Twilio (6.13): on only when the account SID, auth token and sender are all present. */
export function createLiveTwilio(env: NodeJS.ProcessEnv): { api: ReturnType<typeof createTwilioApi> | null; feature: FeatureReport } {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_API_KEY_SID: keySid, TWILIO_API_KEY_SECRET: keySecret, TWILIO_SENDER: sender } = env;
  const apiKey = !!(keySid && keySecret);
  if (!sid || !(token || apiKey) || !sender) {
    const missing = [!sid && 'TWILIO_ACCOUNT_SID', !(token || apiKey) && 'TWILIO_AUTH_TOKEN (or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET)', !sender && 'TWILIO_SENDER'].filter(Boolean).join(', ');
    return { api: null, feature: { id: 'twilio', enabled: false, reason: `disabled: ${missing} missing` } };
  }
  const api = createTwilioApi({ accountSid: sid, authToken: token, apiKeySid: keySid, apiKeySecret: keySecret, sender, transport: new FetchTransport() });
  return { api, feature: { id: 'twilio', enabled: true, reason: apiKey ? 'enabled (API key)' : 'enabled' } };
}

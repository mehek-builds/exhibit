import { safeErrorBody } from './types.js';
import type { HttpTransport, IntegrationInfo } from './types.js';

// DeepL API Free client (PRD 6.14): draft machine translation for the founder's non-English exhibits.
// Free tier, per-account API key ending `:fx`. Text goes through `redactText` before it ever reaches
// this client (constraint 17); the caller is responsible for that, this module only sends what it's given.

const BASE_URL = 'https://api-free.deepl.com/v2/translate';

export interface DeepLOptions {
  apiKey: string;
  transport: HttpTransport;
  baseUrl?: string;
}

export interface DeepLClient {
  readonly info: IntegrationInfo;
  translate(text: string, targetLang?: string): Promise<{ text: string; detectedSourceLang: string }>;
}

interface DeepLResponseJson {
  translations: { detected_source_language: string; text: string }[];
}

export function createDeepL(opts: DeepLOptions): DeepLClient {
  const base = opts.baseUrl ?? BASE_URL;
  const { transport, apiKey } = opts;

  const info: IntegrationInfo = {
    id: 'deepl',
    name: 'DeepL API Free',
    job: ['act'],
    tier: 1,
    criteria: '#3',
    freeTier: 'DeepL API Free, 500,000 characters/month',
    credentials: ['DEEPL_API_KEY'],
    receives: 'Redacted body text of a non-English exhibit the founder opted in to translate',
  };

  return {
    info,
    async translate(text: string, targetLang = 'EN-US') {
      const form = new URLSearchParams();
      form.set('text', text);
      form.set('target_lang', targetLang);
      const res = await transport.request({
        method: 'POST',
        url: base,
        headers: { authorization: `DeepL-Auth-Key ${apiKey}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      if (res.status >= 300) throw new Error(`DeepL translate failed: ${res.status} ${safeErrorBody(res.body)}`);
      const parsed = JSON.parse(res.body) as DeepLResponseJson;
      const t = parsed.translations[0];
      if (!t) throw new Error('DeepL returned no translation');
      return { text: t.text, detectedSourceLang: t.detected_source_language };
    },
  };
}

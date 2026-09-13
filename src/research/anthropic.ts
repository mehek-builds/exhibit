import Anthropic from '@anthropic-ai/sdk';
import type { FetchResult, ResearchCandidate, ResearchRequest, ResearchResult, Researcher, WebFetcher } from './types.js';
import { scrubForBoundary } from '../pipeline/redact.js';

// Live research with Claude Sonnet 5 and the server-side web tools (PRD 6.11, 7.5b).
// Research queries are about outlets and programs, never the person: only the outlet domain,
// the exhibit type and the measures go into the prompt.

const MEASURES: Record<number, string> = {
  1: 'number of applicants or entrants; selection or acceptance rate',
  2: 'acceptance rate or selectivity; membership size',
  3: 'outlet readership: audited circulation, monthly unique visitors, or podcast downloads per episode',
  4: 'number of submissions or participants at the event',
  5: 'stars, forks, dependents or package downloads from the platform API and a registry mirror',
  6: 'journal or conference acceptance rate; impact measure; talk attendance',
  7: 'organization funding raised, investors, rankings',
  8: '90th-percentile wage for the job code and location',
};

const DEFAULT_MODEL_ID = 'claude-sonnet-5';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface AnthropicResearcherOptions {
  model?: string;
  maxUses?: number;
  timeoutMs?: number;
  /** Injected client for tests; when omitted a real `Anthropic({apiKey})` client is built. */
  client?: Anthropic;
}

/** Re-thrown for a prompt that would leak identity data to the research model (constraint 8, defense in depth). */
export class BoundaryLeakError extends Error {
  constructor(readonly leaked: { type: string; count: number }[]) {
    super(`refusing to send a research prompt to the model: unredacted identity data leaked (${leaked.map((l) => `${l.type}x${l.count}`).join(', ')})`);
    this.name = 'BoundaryLeakError';
  }
}

export class AnthropicResearcher implements Researcher {
  readonly kind = 'anthropic' as const;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxUses: number;
  private readonly timeoutMs: number;

  constructor(apiKey: string, optionsOrModel: AnthropicResearcherOptions | string = {}, maxUses = 5) {
    // Back-compat: the previous constructor took `(apiKey, model?, maxUses?)`.
    const options: AnthropicResearcherOptions = typeof optionsOrModel === 'string' ? { model: optionsOrModel, maxUses } : optionsOrModel;
    this.model = options.model ?? DEFAULT_MODEL_ID;
    this.maxUses = options.maxUses ?? maxUses;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client = options.client ?? new Anthropic({ apiKey });
  }

  async propose(req: ResearchRequest): Promise<ResearchResult> {
    const errors: string[] = [];
    // 6.11 / 8.17: only the outlet domain, the criterion and the measures it needs go into the
    // prompt — never the founder's name, profile or any redacted item text.
    const user = [
      `Outlet, program or organizer domain: ${req.issuerDomain}`,
      `Exhibit type: O-1A criterion ${req.criterion}`,
      `Figures needed: ${MEASURES[req.criterion] ?? 'context figures'}`,
      `For each figure find the primary source on ${req.issuerDomain} (or its parent company) and a second valid source from the verifier list if one covers it.`,
      'Answer with a JSON array in a ```json block. Each element: {"measure","value","unit","sentence","url","publisher","kind":"primary"|"verifier"|"issuer_second","as_of":"YYYY-MM-DD"}.',
      '"sentence" must be copied exactly from the page, contain the number, and the figure\'s number must be the first number in that sentence. Omit any figure you could not find on an allowed page. Never estimate.',
    ].join('\n');

    const fullPrompt = `${req.systemPrompt}\n\n${user}`;
    const { leaked } = scrubForBoundary(fullPrompt);
    if (leaked.length > 0) throw new BoundaryLeakError(leaked);

    let response: unknown;
    try {
      response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 4096,
          system: req.systemPrompt,
          messages: [{ role: 'user', content: user }],
          tools: [
            { type: 'web_search_20260209', name: 'web_search', allowed_domains: req.allowedDomains, max_uses: this.maxUses },
            { type: 'web_fetch_20260209', name: 'web_fetch', allowed_domains: req.allowedDomains, max_uses: this.maxUses },
          ],
        } as never,
        { timeout: this.timeoutMs },
      );
    } catch (err) {
      // Network/auth/rate-limit failures raise; server-tool errors (7.5b) arrive inside a 200 and
      // are handled below without throwing.
      return { candidates: [], searches: 0, errors: [`request failed: ${String(err)}`] };
    }

    let searches = 0;
    let text = '';
    for (const block of (response as unknown as { content: Record<string, unknown>[] }).content) {
      if (block.type === 'text') text += String(block.text);
      if (block.type === 'server_tool_use') searches += 1;
      if (typeof block.type === 'string' && block.type.endsWith('_tool_result')) {
        const content = block.content as Record<string, unknown> | Record<string, unknown>[] | undefined;
        // Success content is a list (web_search) or an object with a document (web_fetch); an
        // error result is a single object whose own `type` ends in `_error` (7.5b) — never thrown.
        const candidate = Array.isArray(content) ? undefined : content;
        if (candidate && typeof candidate === 'object' && String(candidate.type ?? '').endsWith('_error')) {
          errors.push(`${block.type}: ${String(candidate.error_code ?? candidate.type ?? 'error')}`);
        }
      }
    }
    const json = lastJsonBlock(text);
    if (!json) return { candidates: [], searches, errors: [...errors, 'no JSON block in research answer'] };
    try {
      const parsed = JSON.parse(json) as ResearchCandidate[];
      if (!Array.isArray(parsed)) return { candidates: [], searches, errors: [...errors, 'research answer JSON was not an array'] };
      return { candidates: parsed.filter((c) => c && typeof c.value === 'number' && typeof c.url === 'string' && typeof c.sentence === 'string' && c.sentence.length > 0), searches, errors };
    } catch (err) {
      return { candidates: [], searches, errors: [...errors, `unparseable research JSON: ${String(err)}`] };
    }
  }
}

/** The last ```json fenced block in the response text (the model's final answer, if it narrated intermediate steps). */
function lastJsonBlock(text: string): string | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  return matches.length ? matches[matches.length - 1]![1]! : null;
}

export class LiveFetcher implements WebFetcher {
  readonly kind = 'live' as const;
  async fetch(url: string): Promise<FetchResult> {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'Exhibit/0.1 (evidence snapshot)' } });
    return { url: res.url, status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() };
  }
}

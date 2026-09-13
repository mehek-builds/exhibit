import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, Output } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { z } from 'zod';
import type { Classification, RedactedItem } from '../types.js';
import type { EvidenceModel, ModelCall, ModelClassification, ModelMapping } from './types.js';
import { itemEnvelope } from './types.js';
import { scrubForBoundary } from '../pipeline/redact.js';
import type { PromptGraph } from '../rules/graph.js';
import { allRuleIds } from '../rules/graph.js';

// The classifier and mapper through the Vercel AI SDK (PRD 6 stack), schema-constrained.
// Retry once on timeout or invalid schema, then leave the item for the next run (E29).

const DEFAULT_MODEL_ID = 'claude-sonnet-5';
const DEFAULT_TIMEOUT_MS = 30_000;

const KIND = z.enum(['invitation', 'service_proof', 'press_about', 'authored', 'award', 'acceptance', 'adoption', 'review', 'role', 'remuneration', 'talk', 'exhibition', 'other']);
const CRITERION = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8)]);

const ClassificationSchema = z.object({
  is_candidate: z.boolean(),
  kind: KIND,
  quote: z.string().describe('An exact substring of the item supporting the call. Empty when is_candidate is false.'),
  reason: z.string(),
});

const MappingSchema = z.object({
  criteria: z.array(CRITERION).describe('O-1A criteria this item supports; empty when rejected.'),
  status: z.enum(['qualifying', 'building', 'needs_attorney', 'rejected']),
  rule_id: z.string().describe('The working-rule id from the fragments that the item meets or fails.'),
  reason: z.string().describe('One sentence.'),
  quote: z.string().describe('An exact substring of the item.'),
  comparable_for: z.array(CRITERION).optional(),
});

/** Thrown when a prompt about to leave the process still carries an identity number (constraint 8, defense in depth). */
export class BoundaryLeakError extends Error {
  constructor(readonly leaked: { type: string; count: number }[]) {
    super(`refusing to send a prompt to the model: unredacted identity data leaked (${leaked.map((l) => `${l.type}x${l.count}`).join(', ')})`);
    this.name = 'BoundaryLeakError';
  }
}

/** Throws if `prompt` (already supposedly redacted) still contains anything scrubForBoundary would catch. */
function assertNoIdentityLeak(prompt: string): void {
  const { leaked } = scrubForBoundary(prompt);
  if (leaked.length > 0) throw new BoundaryLeakError(leaked);
}

export interface AnthropicModelOptions {
  /** Model id override; defaults to `claude-sonnet-5` (PRD 7.5b). */
  modelId?: string;
  /** Per-call abort timeout in ms; defaults to 30s. A timed-out call counts as a schema/timeout failure and is retried once. */
  timeoutMs?: number;
  /** When given, the mapper prompt is appended with the exact, closed set of allowed rule_id values computed from the prompt graph (6.4). */
  graph?: PromptGraph;
  /** Injected language model for tests; when omitted, `createAnthropic({apiKey})(modelId)` is used. */
  languageModel?: LanguageModelV4;
}

export class AnthropicModel implements EvidenceModel {
  readonly name = 'anthropic';
  readonly modelId: string;
  private readonly timeoutMs: number;
  private readonly graph: PromptGraph | undefined;
  private readonly languageModel: () => LanguageModelV4;

  constructor(apiKey: string, optionsOrModelId: AnthropicModelOptions | string = {}) {
    // Back-compat: the previous constructor took `modelId` as a bare string second argument.
    const options: AnthropicModelOptions = typeof optionsOrModelId === 'string' ? { modelId: optionsOrModelId } : optionsOrModelId;
    this.modelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.graph = options.graph;
    if (options.languageModel) {
      const injected = options.languageModel;
      this.languageModel = () => injected;
    } else {
      const provider = createAnthropic({ apiKey });
      this.languageModel = () => provider(this.modelId);
    }
  }

  /** One retry on a schema-validation failure or an abort/timeout; anything else (auth, network) is not retried here (E29). */
  private async generateWithRetry<S>(args: { system: string; prompt: string }, schema: z.ZodType<S>): Promise<{ output: S }> {
    assertNoIdentityLeak(`${args.system}\n\n${args.prompt}`);
    const attempt = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const { output } = await generateText({
          model: this.languageModel(),
          system: args.system,
          prompt: args.prompt,
          output: Output.object({ schema }),
          abortSignal: controller.signal,
        } as never);
        return { output: output as S };
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      return await attempt();
    } catch {
      return attempt();
    }
  }

  async classify(item: RedactedItem, systemPrompt: string): Promise<ModelCall<ModelClassification>> {
    const prompt = itemEnvelope(item);
    const { output } = await this.generateWithRetry({ system: systemPrompt, prompt }, ClassificationSchema);
    return { output: output as ModelClassification, prompt: `${systemPrompt}\n\n${prompt}` };
  }

  async map(item: RedactedItem, cls: Classification, systemPrompt: string): Promise<ModelCall<ModelMapping>> {
    const prompt = `${itemEnvelope(item)}\n<classification>${JSON.stringify({ kind: cls.kind, quote: cls.quote })}</classification>`;
    const system = this.graph ? `${systemPrompt}\n\nrule_id must be exactly one of: ${JSON.stringify(allRuleIds(this.graph))}.` : systemPrompt;
    const { output } = await this.generateWithRetry({ system, prompt }, MappingSchema);
    return { output: output as ModelMapping, prompt: `${system}\n\n${prompt}` };
  }
}

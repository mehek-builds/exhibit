import type { Lemma } from '@uselemma/tracing';

// PRD 6.10: "Exhibit's hard constraints (section 8) are uploaded as a Lemma Artifact so Lemma
// audits every trace against them." Checked against node_modules/@uselemma/tracing 7.12.0's
// declarations (dist/*.d.ts): the SDK exposes trace/span/tool/generation recording (Lemma,
// TraceContext, SpanHandle in client.d.ts) and the framework integrations (vercel-ai, langchain,
// mastra, openai-agents, coding-agent), but no artifact, document, or instructions upload call of
// any kind. There is nothing here to guess an API for.

export interface UploadResult {
  uploaded: boolean;
  reason: string;
}

/**
 * Does not pretend to upload anything. @uselemma/tracing 7.12.0 has no artifact/instructions
 * upload API, so this returns the honest non-result the PRD asks for when one is missing.
 *
 * The constraints upload is a MANUAL, ONE-TIME step: paste constraints/hard-constraints.md into
 * the Lemma UI yourself (project settings -> Artifacts, or wherever the current Lemma UI puts it)
 * after each edit to that file. There is no endpoint to call and none should be invented here --
 * see docs/integrations/LEMMA.md for the full note.
 */
export function uploadConstraints(_lemma: Lemma, _markdown: string): UploadResult {
  return {
    uploaded: false,
    reason: 'no artifact upload API in @uselemma/tracing 7.12.0; upload constraints/hard-constraints.md in the Lemma UI',
  };
}

declare module 'worth-sending-mcp' {
  export interface WorthSendingResult {
    rubric_version: '0.1';
    decision: 'send' | 'revise' | 'hold';
    score: number | null;
    summary: string;
    reasons: string[];
    missing_context: string[];
    required_changes: string[];
    assessment_source: 'calling_agent';
    recommendation_only: true;
    breakdown: { dimension: string; weight: number; rating: number | null; points: number | null; reason: string; evidence_ids: string[] }[];
    checks: Record<string, { status: 'pass' | 'fail' | 'unknown'; reason: string; evidence_ids: string[] }>;
  }
  export class AssessmentError extends Error {
    issues: string[];
  }
  export function evaluateMessage(input: unknown): WorthSendingResult;
}

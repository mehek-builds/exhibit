import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { evaluateMessage } from 'worth-sending-mcp';

// Userlens worth-sending (PRD 6.8, 7.3): a local stdio MCP server with no model inside. Exhibit
// supplies every judgment with cited evidence; the server applies the fixed policy. Pinned to
// commit 944a941e4a20b139f9fbe33fce8c423e5fee680d in package.json.

export interface GateDecision {
  decision: 'send' | 'revise' | 'hold';
  score: number | null;
  summary: string;
  reasons: string[];
  required_changes: string[];
  transport: 'mcp' | 'library';
}

export interface WorthSendingGate {
  readonly transport: 'mcp' | 'library' | 'unavailable';
  evaluate(packet: Record<string, unknown>): Promise<GateDecision>;
  close(): Promise<void>;
}

export function worthSendingBin(): string {
  // The package exports only its entry (src/evaluate.js), not package.json; the bin sits beside src/.
  let entry: string;
  try {
    entry = fileURLToPath(import.meta.resolve('worth-sending-mcp'));
  } catch {
    entry = createRequire(import.meta.url).resolve('worth-sending-mcp');
  }
  return join(dirname(entry), '..', 'bin', 'worth-sending.js');
}

export class McpWorthSendingGate implements WorthSendingGate {
  readonly transport = 'mcp' as const;
  private client: Client | null = null;
  rubricVersion: string | null = null;

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: 'exhibit', version: '0.1.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [worthSendingBin()], stderr: 'ignore' });
    await client.connect(transport);
    const rubric = await client.callTool({ name: 'get_message_rubric', arguments: {} });
    this.rubricVersion = String((rubric.structuredContent as { rubric_version?: string } | undefined)?.rubric_version ?? 'unknown');
    this.client = client;
    return client;
  }

  async evaluate(packet: Record<string, unknown>): Promise<GateDecision> {
    const client = await this.connect();
    const res = await client.callTool({ name: 'evaluate_message', arguments: packet });
    const content = res.content as { type: string; text?: string }[] | undefined;
    if (res.isError) throw new Error(`worth-sending rejected the packet: ${content?.[0]?.text ?? 'unknown error'}`);
    const out = (res.structuredContent ?? JSON.parse(content?.[0]?.text ?? '{}')) as Omit<GateDecision, 'transport'>;
    return { decision: out.decision, score: out.score, summary: out.summary, reasons: out.reasons, required_changes: out.required_changes, transport: 'mcp' };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}

/** Same policy function, imported in-process. Used by unit tests; the agent defaults to MCP. */
export class LibraryWorthSendingGate implements WorthSendingGate {
  readonly transport = 'library' as const;
  async evaluate(packet: Record<string, unknown>): Promise<GateDecision> {
    const out = evaluateMessage(packet);
    return { decision: out.decision, score: out.score, summary: out.summary, reasons: out.reasons, required_changes: out.required_changes, transport: 'library' };
  }
  async close(): Promise<void> {}
}

/** E22: the server is not running. Every letter is held. */
export class UnavailableGate implements WorthSendingGate {
  readonly transport = 'unavailable' as const;
  async evaluate(): Promise<GateDecision> {
    throw new Error('worth-sending server is not running');
  }
  async close(): Promise<void> {}
}

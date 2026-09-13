import type { AgentExtension, ExtensionContext } from '../agent.js';
import type { DiscoveredItem, DiscoveryAdapter } from '../integrations/types.js';
import { discoveryQuery, toSourceItem } from '../integrations/types.js';
import { registerDiscoveryClassifier } from '../rules/structured.js';
import type { SourceItem } from '../types.js';
import { normalizeUrl } from '../util.js';
import { classifyDiscovered } from './classify.js';
import { secondIdentifier } from './identity.js';

// The discovery extension (PRD 6.14): runs each Tier 1/2 source adapter, applies the second-identifier
// rule (constraint 16, E57/E61), dedupes against existing candidates by URL so the same item found twice
// merges into one exhibit (E58), and returns SourceItems that flow through the normal classify/map/verify
// pipeline like an email. An adapter throwing, or returning `limited`, degrades only that source (PRD 10).

const DEFAULT_CADENCE_DAYS = 7;

export interface DiscoveryExtensionOptions {
  adapters: DiscoveryAdapter[];
  /** Live cadence, days between runs per source. Default 7. */
  cadenceDays?: number;
  /** Harness mode: ignore cadence and run every time. */
  alwaysRun?: boolean;
}

function dueToRun(lastRunIso: string | null, now: Date, cadenceDays: number): boolean {
  if (!lastRunIso) return true;
  const elapsedMs = now.getTime() - Date.parse(lastRunIso);
  return elapsedMs >= cadenceDays * 24 * 60 * 60 * 1000;
}

export function createDiscoveryExtension(opts: DiscoveryExtensionOptions): AgentExtension {
  registerDiscoveryClassifier(classifyDiscovered);
  const cadenceDays = opts.cadenceDays ?? DEFAULT_CADENCE_DAYS;

  return {
    name: 'discovery',
    async discover(ctx: ExtensionContext): Promise<SourceItem[]> {
      const { deps, trace, runId, now } = ctx;
      const { ledger, profile } = deps;
      const query = discoveryQuery(profile);
      const out: SourceItem[] = [];

      for (const adapter of opts.adapters) {
        const source = adapter.info.id;
        const kvKey = `discovery_last_run:${source}`;

        if (!opts.alwaysRun && !dueToRun(ledger.get(kvKey), now, cadenceDays)) {
          continue;
        }

        let items: DiscoveredItem[] = [];
        let limited = false;
        try {
          const result = await adapter.discover(query);
          items = result.items;
          limited = result.limited ?? false;
          for (const err of result.errors) {
            trace.tool(`discovery.${source}`, { source }, undefined, err);
          }
        } catch (err) {
          trace.tool(`discovery.${source}`, { source }, undefined, String(err));
          if (!ctx.summary.degraded.includes(source)) ctx.summary.degraded.push(source);
          continue;
        }

        ledger.event({
          run_id: runId,
          trace_id: trace.traceId,
          kind: 'integration_call',
          detail: { integration: source, op: 'discover', ok: true, transport: 'live', status: limited ? 'limited' : 'ok' },
          at: now.toISOString(),
        });

        // A free-tier limit is a retry-next-run signal (E68): never mark this source's last run.
        if (!limited) ledger.set(kvKey, now.toISOString());

        for (const found of items) {
          const { names, second } = secondIdentifier(found, query);
          const secondIdentifierDisabled = (deps.ruleOptions?.disabled ?? []).includes('X-second-identifier');
          if (!secondIdentifierDisabled && (!names || !second)) {
            ledger.event({
              run_id: runId,
              trace_id: trace.traceId,
              kind: 'discovery',
              detail: { source, external_id: found.externalId, url: found.url, outcome: 'second_identifier_reject' },
              at: now.toISOString(),
            });
            trace.span('discovery.second_identifier_reject', { source, external_id: found.externalId, url: found.url }, { names, second });
            continue;
          }

          const normalized = normalizeUrl(found.url);
          const isDuplicate = normalized ? ledger.candidates().some((c) => normalizeUrl(c.url) === normalized) : false;
          ledger.event({
            run_id: runId,
            trace_id: trace.traceId,
            kind: 'discovery',
            detail: { source, external_id: found.externalId, url: found.url, outcome: isDuplicate ? 'duplicate' : 'candidate' },
            at: now.toISOString(),
          });

          out.push(toSourceItem(found));
        }
      }

      return out;
    },
  };
}

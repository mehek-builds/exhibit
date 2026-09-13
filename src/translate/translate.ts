import type { AgentExtension, ExtensionContext } from '../agent.js';
import { parseRawEmail } from '../apps/live/mime.js';
import type { DeepLClient } from '../integrations/deepl.js';
import { redactText } from '../pipeline/redact.js';

// Draft machine translation (PRD 6.14, E67): exhibits filed `needs_attorney` under rule
// `V-non-english` get a labeled draft translation, but only for the source the founder opted in
// (`profile.translationOptIn`, by `app:id`). Text is redacted before it ever reaches DeepL
// (constraint 17); the label is explicit that USCIS requires a certified translation, not this one.

const RULE = 'V-non-english';
const LABEL = '_This is a draft machine translation. USCIS requires a certified translation for filing._';

function refKey(app: string, id: string): string {
  return `${app}:${id}`;
}

async function extractOriginalText(ctx: ExtensionContext, exhibitId: string): Promise<string | null> {
  const { drive } = ctx.deps.apps;
  const raw = ctx.deps.ledger.get(`exfolder:${exhibitId}`);
  if (!raw) return null;
  const { folder } = JSON.parse(raw) as { folder: string; sources: string };
  const children = await drive.listChildren(folder);
  const original = children.find((f) => f.appProperties?.role === 'original');
  if (!original) return null;
  const bytes = await drive.readFile(original.id);
  const text = Buffer.from(bytes).toString('utf8');
  if (original.mimeType === 'message/rfc822') return parseRawEmail(text).body;
  try {
    const parsed = JSON.parse(text) as { text?: string };
    return parsed.text ?? text;
  } catch {
    return text;
  }
}

export interface TranslationExtensionOptions {
  client: DeepLClient;
}

export function createTranslationExtension(opts: TranslationExtensionOptions): AgentExtension {
  const { client } = opts;

  return {
    name: 'translation',
    async afterFiling(ctx: ExtensionContext): Promise<void> {
      const { ledger, profile } = ctx.deps;
      const { trace, runId, now } = ctx;
      const optIn = new Set(profile.translationOptIn ?? []);

      const optInGateDisabled = (ctx.deps.ruleOptions?.disabled ?? []).includes('X-translation-opt-in');
      const targets = ledger.exhibits().filter((e) => e.status === 'needs_attorney' && e.rule_id === RULE);
      for (const e of targets) {
        const marker = `translated:${e.exhibit_id}`;
        if (ledger.get(marker)) continue;
        const ref = e.sources.find((s) => optIn.has(refKey(s.app, s.id))) ?? (optInGateDisabled ? e.sources[0] : undefined);

        if (!ref) {
          ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'translation', detail: { source: e.sources[0] ? refKey(e.sources[0].app, e.sources[0].id) : null, opted_in: false, called: false, chars: 0 }, at: now.toISOString() });
          const noteRaw = ledger.get(`exfolder:${e.exhibit_id}`);
          if (noteRaw) {
            const { folder } = JSON.parse(noteRaw) as { folder: string };
            const existing = await ctx.deps.apps.drive.findChild(folder, 'needs-translation.md');
            if (!existing) {
              await ctx.deps.apps.drive.createFile({
                parentId: folder,
                name: 'needs-translation.md',
                mimeType: 'text/markdown',
                content: `# Needs translation\n\n${e.title} is not in English and is not opted in for machine translation. Add \`${refKey(e.sources[0]?.app ?? 'gmail', e.sources[0]?.id ?? '')}\` to the founder's translation opt-in, or provide a certified translation.\n`,
                appProperties: { exhibit_id: e.exhibit_id, role: 'translation_note' },
              });
            }
          }
          ledger.set(marker, now.toISOString());
          continue;
        }

        const source = refKey(ref.app, ref.id);
        try {
          const original = await extractOriginalText(ctx, e.exhibit_id);
          if (!original) {
            trace.tool('translate.extract', { exhibit_id: e.exhibit_id }, undefined, 'no original artifact found');
            continue;
          }
          const redacted = redactText(original);
          const result = await client.translate(redacted.text);
          trace.tool('deepl.translate', { exhibit_id: e.exhibit_id, source, chars: redacted.text.length }, { detectedSourceLang: result.detectedSourceLang });
          ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'translation', detail: { source, opted_in: true, called: true, chars: redacted.text.length }, at: now.toISOString() });

          const noteRaw = ledger.get(`exfolder:${e.exhibit_id}`);
          if (noteRaw) {
            const { folder } = JSON.parse(noteRaw) as { folder: string };
            const content = [`# ${e.title} -- draft translation`, '', LABEL, '', result.text].join('\n');
            const existing = await ctx.deps.apps.drive.findChild(folder, 'translation-draft.md');
            if (existing) await ctx.deps.apps.drive.updateFileContent(existing.id, content);
            else
              await ctx.deps.apps.drive.createFile({
                parentId: folder,
                name: 'translation-draft.md',
                mimeType: 'text/markdown',
                content,
                appProperties: { exhibit_id: e.exhibit_id, role: 'translation' },
              });
          }
          ledger.set(marker, now.toISOString());
        } catch (err) {
          trace.tool('deepl.translate', { exhibit_id: e.exhibit_id, source }, undefined, String(err));
          ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'translation', detail: { source, opted_in: true, called: false, chars: 0, error: String(err) }, at: now.toISOString() });
        }
      }
    },
  };
}

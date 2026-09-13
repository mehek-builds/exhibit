import type { AgentExtension, ExtensionContext } from '../agent.js';
import type { GmailMessage } from '../apps/types.js';
import { renderPdf } from '../binder/pdf.js';
import type { DropboxSignClient } from '../integrations/dropboxsign.js';
import type { LetterRow } from '../ledger.js';
import { APPROVAL_INSTRUCTION, approvalFor, draftLetter } from './letters.js';
import { parseAddress } from '../pipeline/intake.js';
import type { FounderProfile, Recommender } from '../types.js';

// Signature (PRD 6.8, 6.14, 8 constraint 18). Once the recommender confirms the final text and the
// founder separately approves, the letter goes to Dropbox Sign. Never before both; on the day,
// test mode only, to addresses the founder controls. Status is polled every run; a signed PDF is
// filed under `letters/` for the integrity extension to stamp, a declined or expired one never is.

const CONFIRM_RE = /\b(i confirm|confirmed|looks good to sign|final text is good)\b/i;

interface SignState {
  stage: 'awaiting_confirmation' | 'awaiting_approval' | 'requested' | 'signed' | 'declined' | 'expired';
  confirmationMsgId?: string;
  approvalMsgId?: string;
  requestId?: string;
}

function readState(ledger: ExtensionContext['deps']['ledger'], letterId: string): SignState {
  const raw = ledger.get(`sign:${letterId}`);
  return raw ? (JSON.parse(raw) as SignState) : { stage: 'awaiting_confirmation' };
}

function writeState(ledger: ExtensionContext['deps']['ledger'], letterId: string, s: SignState): void {
  ledger.set(`sign:${letterId}`, JSON.stringify(s));
}

/** The unquoted part of a reply, same split `approvalFor` uses. */
function unquoted(m: GmailMessage): string {
  return m.body.split(/\n>|\nOn .+wrote:/)[0] ?? m.body;
}

/** The recommender's own reply in the letter thread confirming the final text -- never the agent's own copy. */
function findConfirmation(row: LetterRow, r: Recommender, allMessages: GmailMessage[]): GmailMessage | null {
  if (!row.sent_msg_id) return null;
  const email = r.email.toLowerCase();
  return (
    allMessages
      .filter((m) => m.threadId === row.sent_msg_id && parseAddress(m.from).email === email)
      .filter((m) => CONFIRM_RE.test(unquoted(m)))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0] ?? null
  );
}

async function ensureLettersFolder(ctx: ExtensionContext): Promise<string> {
  const { drive } = ctx.deps.apps;
  const existing = await drive.findChild(ctx.binder.root, 'letters');
  if (existing) return existing.id;
  return (await drive.createFolder(ctx.binder.root, 'letters')).id;
}

export interface SigningExtensionOptions {
  client: DropboxSignClient;
  /** true: enforce test mode + controlledEmails-only signers (constraint 18). */
  dayMode: boolean;
}

export function createSigningExtension(opts: SigningExtensionOptions): AgentExtension {
  const { client, dayMode } = opts;

  async function processOne(ctx: ExtensionContext, row: LetterRow, r: Recommender, profile: FounderProfile): Promise<void> {
    const { ledger, apps } = ctx.deps;
    const { trace, runId, now } = ctx;
    let state = readState(ledger, row.letter_id);
    if (state.stage === 'signed' || state.stage === 'declined' || state.stage === 'expired') return;

    // Step 1: the recommender's own confirmation of the final text, in the letter thread.
    const bothApprovalsDisabled = (ctx.deps.ruleOptions?.disabled ?? []).includes('X-sign-both-approvals');
    if (state.stage === 'awaiting_confirmation') {
      const confirmation = findConfirmation(row, r, ctx.context.allMessages);
      if (!confirmation && !bothApprovalsDisabled) {
        trace.span('signing.awaiting_confirmation', { letter_id: row.letter_id }, { confirmed: false });
        return;
      }
      state = { stage: 'awaiting_approval', confirmationMsgId: confirmation?.id };
      writeState(ledger, row.letter_id, state);
    }

    // Step 2: the founder's own approval, requested only once confirmation exists (constraint 18: never before both).
    if (state.stage === 'awaiting_approval') {
      if (!state.approvalMsgId) {
        const to = profile.emails[0]!;
        const req = await apps.gmail.send({
          to: [to],
          subject: `[Exhibit] Approve signature request ${row.letter_id}`,
          body: [
            `${r.name} confirmed the final text of their letter for ${profile.name}. It is ready to go to Dropbox Sign for signature (test mode).`,
            '',
            APPROVAL_INSTRUCTION,
            `APPROVE SIGN ${row.letter_id}`,
          ].join('\n'),
        });
        trace.tool('gmail.send', { to: [to], letter_id: row.letter_id, kind: 'signature_approval_request' }, { id: req.id });
        state = { ...state, approvalMsgId: req.id };
        writeState(ledger, row.letter_id, state);
      }
      const agentMessageIds = new Set(ledger.letters().flatMap((l) => [l.approval_msg_id, l.sent_msg_id].filter((x): x is string => !!x)));
      if (state.approvalMsgId) agentMessageIds.add(state.approvalMsgId);
      const approval = approvalFor(`SIGN ${row.letter_id}`, null, agentMessageIds, ctx.context.founderMessages, profile);
      if (!approval) {
        trace.span('signing.awaiting_approval', { letter_id: row.letter_id }, { approved: false });
        return;
      }

      // Constraint 18: on the day, test mode only, and only to addresses the founder controls.
      const signerEmail = r.email.toLowerCase();
      if (dayMode && (!client.testMode || !(profile.controlledEmails ?? []).map((e) => e.toLowerCase()).includes(signerEmail))) {
        trace.tool('dropboxsign.signature_request.send', { letter_id: row.letter_id, signer: r.email, testMode: client.testMode }, undefined, 'refused: day mode requires test mode and a controlled signer address');
        ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'signature', detail: { request_id: null, letter_id: row.letter_id, status: 'declined', test_mode: client.testMode, signer_email: r.email, reason: 'day-mode refusal: signer not controlled or not test mode' }, at: now.toISOString() });
        writeState(ledger, row.letter_id, { ...state, stage: 'declined' });
        return;
      }

      const draft = row.doc_id ? await apps.docs.getText(row.doc_id) : draftLetter(r, [], profile);
      const pdf = renderPdf({ heading: `Recommendation letter: ${profile.name}`, subheading: `Signed by ${r.name} via Dropbox Sign (test mode)`, body: draft, highlights: [] });
      const sent = await client.send({
        title: `Recommendation letter for ${profile.name}`,
        subject: `Please sign: recommendation letter for ${profile.name}`,
        message: 'Thank you again for your letter. Please review and sign below.',
        signerEmail: r.email,
        signerName: r.name,
        fileName: `${row.letter_id}.pdf`,
        fileContent: pdf,
      });
      trace.tool('dropboxsign.signature_request.send', { letter_id: row.letter_id, signer: r.email, testMode: client.testMode }, { requestId: sent.requestId });
      ledger.event({
        run_id: runId,
        trace_id: trace.traceId,
        kind: 'signature',
        detail: {
          request_id: sent.requestId,
          letter_id: row.letter_id,
          status: 'created',
          test_mode: client.testMode,
          signer_email: r.email,
          recommender_confirmed: Boolean(state.confirmationMsgId) || bothApprovalsDisabled,
          founder_approved: true,
        },
        at: now.toISOString(),
      });
      state = { ...state, stage: 'requested', requestId: sent.requestId };
      writeState(ledger, row.letter_id, state);
      return;
    }

    // Step 3: poll status each run.
    if (state.stage === 'requested' && state.requestId) {
      const status = await client.getStatus(state.requestId);
      trace.tool('dropboxsign.signature_request.get', { letter_id: row.letter_id, requestId: state.requestId }, { status: status.status });
      if (status.status === 'awaiting_signature') return;

      if (status.status === 'signed') {
        const pdf = await client.downloadPdf(state.requestId);
        const folder = await ensureLettersFolder(ctx);
        const file = await apps.drive.createFile({
          parentId: folder,
          name: `${row.letter_id}.signed.pdf`,
          mimeType: 'application/pdf',
          content: pdf,
          appProperties: { letter_id: row.letter_id, role: 'signed_letter' },
        });
        trace.tool('drive.letter.file_signed', { letter_id: row.letter_id }, { fileId: file.id, sha256: file.sha256 });
        ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'signature', detail: { request_id: state.requestId, letter_id: row.letter_id, status: 'signed', test_mode: client.testMode, signer_email: r.email }, at: now.toISOString() });
        writeState(ledger, row.letter_id, { ...state, stage: 'signed' });
        return;
      }

      // declined or expired: never filed.
      const terminal = status.status as 'declined' | 'expired';
      ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'signature', detail: { request_id: state.requestId, letter_id: row.letter_id, status: terminal, test_mode: client.testMode, signer_email: r.email }, at: now.toISOString() });
      writeState(ledger, row.letter_id, { ...state, stage: terminal });
    }
  }

  return {
    name: 'signing',
    async afterLetters(ctx: ExtensionContext): Promise<void> {
      const { ledger, profile } = ctx.deps;
      for (const row of ledger.letters()) {
        if (row.state !== 'sent') continue;
        const r = profile.recommenderCandidates.find((c) => c.email.toLowerCase() === row.recommender_email.toLowerCase());
        if (!r) continue;
        try {
          await processOne(ctx, row, r, profile);
        } catch (err) {
          ctx.trace.tool('signing.process', { letter_id: row.letter_id }, undefined, String(err));
          throw err;
        }
      }
    },
  };
}

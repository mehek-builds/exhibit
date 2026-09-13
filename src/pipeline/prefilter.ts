import type { CalendarEvent } from '../apps/types.js';
import type { FounderProfile, SourceItem } from '../types.js';

// Cheap pre-filter (PRD 6.3, E1): newsletters, receipts and calendar holds are dropped without a model call.

const RECEIPT = /\b(receipt|invoice|order (?:#|number|confirmation)|your order|payment (?:received|confirmation)|subscription (?:renewed|renewal)|shipping confirmation)\b/i;
const NEWSLETTER_DOMAINS = /(^|\.)(substack\.com|beehiiv\.com|mailchimp\.com|convertkit\.com|news\.[\w-]+\.\w+)$/i;

export function prefilter(item: SourceItem, profile: FounderProfile): string | null {
  if (item.app === 'gmail') {
    const headers = (item.meta.headers ?? {}) as Record<string, string>;
    const mentionsFounder = [profile.name, ...profile.aliases, profile.company].some((n) => `${item.title}\n${item.text}`.toLowerCase().includes(n.toLowerCase()));
    if (RECEIPT.test(item.title)) return 'receipt';
    const listMail = Object.keys(headers).some((h) => h.toLowerCase() === 'list-unsubscribe') || NEWSLETTER_DOMAINS.test(item.author?.domain ?? '');
    if (listMail && !mentionsFounder) return 'newsletter that does not mention the founder';
    if (/^(accepted|declined|tentative|invitation|updated invitation):/i.test(item.title) && /calendar/i.test(item.author?.email ?? '')) return 'calendar notification';
  }
  if (item.app === 'calendar') {
    const ev = item.meta.event as CalendarEvent;
    if (ev.attendees.length === 0) return 'calendar hold with no attendees';
  }
  return null;
}

/**
 * Stripe webhook event handler.
 *
 * Extracted from the original monolithic server.ts so the new
 * buildApp() in server.ts can import it without becoming a 2400-line
 * file. Behavior is preserved exactly: every event type from the
 * original implementation is handled, including the dedup logic
 * for transient event bursts (Stripe Smart Retries, repeated cron
 * reconciliations) and the operator notification feed emission.
 */
import Stripe from 'stripe';
import { ScrapedLead, OperatorNotification } from '../src/types';
import { stripe, OPERATOR_EMAIL } from './stripe-billing';
import {
  getProspects,
  getNotifications,
  saveProspect,
  saveNotification,
} from './db';

async function hasRecentNotification(
  prospectId: string,
  type: string,
  windowMs: number,
): Promise<boolean> {
  const cutoff = Date.now() - windowMs;
  const notes = await getNotifications();
  return notes.some(
    (n) =>
      n.metadata?.prospectId === prospectId &&
      n.type === type &&
      new Date(n.createdAt).getTime() >= cutoff,
  );
}

// Stripe event → prospect lookup. Joins via metadata first, then falls
// back to walking customer → subscription → invoice id matches so
// events with missing metadata still resolve.
function lookupProspectIdFromStripeEvent(stripeObj: any): string | undefined {
  if (!stripeObj) return undefined;
  const candidates: any[] = [
    stripeObj?.metadata?.prospectId,
    stripeObj?.customer?.metadata?.prospectId,
    stripeObj?.subscription_details?.metadata?.prospectId,
    stripeObj?.lines?.data?.[0]?.metadata?.prospectId,
    stripeObj?.parent?.subscription_details?.metadata?.prospectId,
    stripeObj?.parent?.metadata?.prospectId,
    stripeObj?.payment?.metadata?.prospectId,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c;
  }
  return undefined;
}
function loadProspectById(
  prospectId: string | undefined,
): Promise<ScrapedLead | undefined> {
  if (!prospectId) return Promise.resolve(undefined);
  return getProspects().then((p) => p.find((x) => x.id === prospectId));
}
function findProspectByStripeIdsFallback(
  event: any,
): Promise<ScrapedLead | undefined> {
  const obj = event?.data?.object;
  if (!obj) return Promise.resolve(undefined);
  const evType: string = event?.type || '';
  const customerId: string | undefined =
    typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
  const rawSub = obj.subscription;
  const subscriptionId: string | undefined =
    typeof rawSub === 'string'
      ? rawSub
      : rawSub?.id ?? (evType.startsWith('customer.subscription.') ? obj.id : undefined);
  const invoiceId: string | undefined = evType.startsWith('invoice.') ? obj.id : undefined;
  return getProspects().then((all) => {
    if (customerId && subscriptionId) {
      const m = all.find(
        (p) => p.stripeCustomerId === customerId && p.stripeSubscriptionId === subscriptionId,
      );
      if (m) return m;
    }
    if (customerId) {
      const m = all.find((p) => p.stripeCustomerId === customerId);
      if (m) return m;
    }
    if (subscriptionId) {
      const m = all.find((p) => p.stripeSubscriptionId === subscriptionId);
      if (m) return m;
    }
    if (invoiceId) {
      const m = all.find((p) => p.stripeInvoiceId === invoiceId);
      if (m) return m;
    }
    return undefined;
  });
}
async function resolveProspectForEvent(event: any): Promise<ScrapedLead | undefined> {
  const obj = event?.data?.object;
  const fromMeta = await loadProspectById(lookupProspectIdFromStripeEvent(obj));
  if (fromMeta) return fromMeta;
  return findProspectByStripeIdsFallback(event);
}

/**
 * Process a Stripe webhook event. Returns true if the event was
 * recognized and handled (or no-op'd), false on parse/sig error.
 * Caller should `res.json({ received: true })` on true.
 */
export async function handleStripeEvent(event: any): Promise<void> {
  console.log(`[Stripe Webhook] ${event.type} (id=${event.id || 'unknown'})`);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as any;
      const prospect = await resolveProspectForEvent(event);
      if (prospect) {
        prospect.pitchStatus = 'Rented';
        const stamp = new Date().toLocaleString();
        prospect.notes = (prospect.notes ? prospect.notes + '\n' : '') +
          `${stamp} — [Stripe] Rented subscription activated via Stripe session ${session.id}.`;
        await saveProspect(prospect);
        try {
          await saveNotification({
            id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'subscription_activated',
            title: `✅ Subscription activated for ${prospect.name}`,
            message: `Stripe Checkout session ${session.id} completed.\nCustomer: ${prospect.email || OPERATOR_EMAIL}\nA copy of this notification has been queued to ${OPERATOR_EMAIL}.`,
            metadata: { prospectId: prospect.id, stripeSessionId: session.id, source: 'checkout.completed' },
            read: false, createdAt: new Date().toISOString(),
          });
        } catch {}
      }
      return;
    }

    case 'invoice.created':
    case 'invoice.finalized':
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const inv = event.data.object as any;
      const prospectId = lookupProspectIdFromStripeEvent(inv);
      const prospect = await loadProspectById(prospectId);
      if (!prospect || !prospectId) return;

      const previousStatus: string | undefined = prospect.stripeSubscriptionStatus;

      if (inv.id) prospect.stripeInvoiceId = inv.id;
      if (inv.number) prospect.stripeInvoiceNumber = inv.number;
      if (inv.hosted_invoice_url || inv.invoice_pdf) {
        prospect.stripeInvoiceUrl = inv.hosted_invoice_url || inv.invoice_pdf;
      }
      if (typeof inv.amount_due === 'number') prospect.subscriptionAmount = inv.amount_due;
      if (inv.currency) prospect.subscriptionCurrency = inv.currency;
      if (inv.due_date) prospect.subscriptionNextDueDate = new Date(inv.due_date * 1000).toISOString();

      const stamp = new Date().toLocaleString();

      if (event.type === 'invoice.paid') {
        prospect.stripeSubscriptionStatus = 'active';
        prospect.subscriptionLastPaidAt = new Date().toISOString();
        prospect.notes = (prospect.notes ? prospect.notes + '\n' : '') +
          `${stamp} — [Stripe] Invoice ${inv.id || inv.number} PAID by ${prospect.name}.`;
        const isFirstActivationOrRecovery =
          !previousStatus ||
          previousStatus === 'incomplete' ||
          previousStatus === 'incomplete_expired' ||
          previousStatus === 'past_due' ||
          previousStatus === 'unpaid';
        if (isFirstActivationOrRecovery) {
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: 'subscription_activated',
              title: previousStatus === 'past_due' || previousStatus === 'unpaid'
                ? `✅ Recovered from past_due: Invoice paid by ${prospect.name}`
                : previousStatus === 'incomplete' || previousStatus === 'incomplete_expired'
                  ? `✅ First payment received from ${prospect.name}`
                  : `✅ Subscription activated for ${prospect.name}`,
              message: `Invoice ${inv.number || inv.id} marked as PAID.\nAmount: $${((inv.amount_paid ?? inv.amount_due ?? 0) / 100).toFixed(2)} ${(inv.currency || 'usd').toUpperCase()}\nPrevious status: ${previousStatus || 'unknown'} → active.\nEmail-copy queued to ${OPERATOR_EMAIL}.`,
              metadata: { prospectId: prospect.id, stripeInvoiceId: inv.id, stripeInvoiceUrl: inv.hosted_invoice_url, previousStatus: previousStatus || null, mode: 'live', outcome: 'paid' },
              read: false, createdAt: new Date().toISOString(),
            });
          } catch {}
        }
      } else if (event.type === 'invoice.payment_failed') {
        prospect.stripeSubscriptionStatus = 'past_due';
        const failReason = inv.last_payment_error?.message || inv.failure_message || 'unknown';
        prospect.notes = (prospect.notes ? prospect.notes + '\n' : '') +
          `${stamp} — [Stripe] Invoice ${inv.id || inv.number} PAYMENT FAILED for ${prospect.name} — ${failReason}.`;
        if (!(await hasRecentNotification(prospect.id, 'subscription_failed', 24 * 60 * 60 * 1000))) {
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: 'subscription_failed',
              title: `❌ Payment failed for ${prospect.name}`,
              message: `Invoice ${inv.number || inv.id} failed to charge.\nReason: ${failReason}\nStripe will retry automatically; duplicate retries within 24h suppressed.\nEmail-copy queued to ${OPERATOR_EMAIL}.`,
              metadata: { prospectId: prospect.id, stripeInvoiceId: inv.id, failureReason: failReason, mode: 'live', outcome: 'failed' },
              read: false, createdAt: new Date().toISOString(),
            });
          } catch {}
        }
      } else if (event.type === 'invoice.finalized') {
        if (inv.billing_reason === 'subscription_create' &&
            !(await hasRecentNotification(prospect.id, 'invoice_created', 60 * 60 * 1000))) {
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: 'invoice_created',
              title: `📨 First invoice finalized for ${prospect.name}`,
              message: `Invoice ${inv.number || inv.id} finalized for $${((inv.amount_due || 0) / 100).toFixed(2)} ${(inv.currency || 'usd').toUpperCase()}.\nDue: ${inv.due_date ? new Date(inv.due_date * 1000).toISOString().slice(0, 10) : '—'}\nStripe will email the customer; copy queued to ${OPERATOR_EMAIL}.`,
              metadata: { prospectId: prospect.id, stripeInvoiceId: inv.id, stripeInvoiceUrl: inv.hosted_invoice_url, billingReason: inv.billing_reason, mode: 'live' },
              read: false, createdAt: new Date().toISOString(),
            });
          } catch {}
        }
      }
      await saveProspect(prospect);
      return;
    }

    case 'invoice.deleted':
    case 'charge.refunded': {
      const obj = event.data.object as any;
      const prospect = await resolveProspectForEvent(event);
      if (!prospect) return;
      const stamp = new Date().toLocaleString();
      if (event.type === 'charge.refunded') {
        if (obj.id) prospect.stripeChargeRefundedId = obj.id;
        prospect.notes = (prospect.notes ? prospect.notes + '\n' : '') +
          `${stamp} — [Stripe] Charge ${obj.id} refunded for ${prospect.name} (amount: $${((obj.amount_refunded ?? obj.amount ?? 0) / 100).toFixed(2)}).`;
        try {
          await saveNotification({
            id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'subscription_failed',
            title: `↩️ Refund issued for ${prospect.name}`,
            message: `Charge ${obj.id} refunded.\nAmount: $${((obj.amount_refunded ?? obj.amount ?? 0) / 100).toFixed(2)} ${(obj.currency || 'usd').toUpperCase()}\nNote: refund is a charge-level event — original invoice stays "paid".\nEmail-copy queued to ${OPERATOR_EMAIL}.`,
            metadata: { prospectId: prospect.id, stripeChargeId: obj.id, mode: 'live', outcome: 'refunded' },
            read: false, createdAt: new Date().toISOString(),
          });
        } catch {}
      } else {
        prospect.stripeInvoiceStatus = 'void';
        prospect.notes = (prospect.notes ? prospect.notes + '\n' : '') +
          `${stamp} — [Stripe] Invoice ${obj.number || obj.id} deleted for ${prospect.name}.`;
        if (!(await hasRecentNotification(prospect.id, 'system', 24 * 60 * 60 * 1000))) {
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: 'system',
              title: `🗑️ Invoice deleted for ${prospect.name}`,
              message: `Invoice ${obj.number || obj.id} was deleted.\nHosted URL will stop resolving shortly. Email-copy queued to ${OPERATOR_EMAIL}.`,
              metadata: { prospectId: prospect.id, stripeInvoiceId: obj.id, stripeInvoiceUrl: obj.hosted_invoice_url, mode: 'live', outcome: 'void' },
              read: false, createdAt: new Date().toISOString(),
            });
          } catch {}
        }
      }
      await saveProspect(prospect);
      return;
    }

    case 'invoice.marked_uncollectible': {
      const obj = event.data.object as any;
      const prospect = await resolveProspectForEvent(event);
      if (!prospect) return;
      prospect.stripeInvoiceStatus = 'uncollectible';
      prospect.notes = (prospect.notes ? prospect.notes + '\n' : '') +
        `${new Date().toLocaleString()} — [Stripe] Invoice ${obj.number || obj.id} marked uncollectible for ${prospect.name}.`;
      if (!(await hasRecentNotification(prospect.id, 'system', 24 * 60 * 60 * 1000))) {
        try {
          await saveNotification({
            id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'system',
            title: `☠️ Invoice uncollectible for ${prospect.name}`,
            message: `Invoice ${obj.number || obj.id} marked uncollectible — Smart Retries exhausted.\nEmail-copy queued to ${OPERATOR_EMAIL}.`,
            metadata: { prospectId: prospect.id, stripeInvoiceId: obj.id, stripeInvoiceUrl: obj.hosted_invoice_url, invoiceStatus: 'uncollectible', mode: 'live' },
            read: false, createdAt: new Date().toISOString(),
          });
        } catch {}
      }
      await saveProspect(prospect);
      return;
    }

    case 'invoice.updated': {
      const obj = event.data.object as any;
      const prospect = await resolveProspectForEvent(event);
      if (!prospect) return;
      if (obj.status === 'void') {
        prospect.stripeInvoiceStatus = 'void';
        prospect.notes = (prospect.notes ? prospect.notes + '\n' : '') +
          `${new Date().toLocaleString()} — [Stripe] Invoice ${obj.number || obj.id} → void for ${prospect.name}.`;
        if (!(await hasRecentNotification(prospect.id, 'system', 24 * 60 * 60 * 1000))) {
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: 'system',
              title: `🗑️ Invoice voided for ${prospect.name}`,
              message: `Invoice ${obj.number || obj.id} was voided via Stripe dashboard.\nEmail-copy queued to ${OPERATOR_EMAIL}.`,
              metadata: { prospectId: prospect.id, stripeInvoiceId: obj.id, stripeInvoiceUrl: obj.hosted_invoice_url, invoiceStatus: 'void', mode: 'live' },
              read: false, createdAt: new Date().toISOString(),
            });
          } catch {}
        }
        await saveProspect(prospect);
      }
      return;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as any;
      const prospect = await resolveProspectForEvent(event);
      if (!prospect) return;
      if (sub.id) prospect.stripeSubscriptionId = sub.id;
      if (sub.status) prospect.stripeSubscriptionStatus = sub.status;
      if (sub.customer) {
        prospect.stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      }
      if (typeof sub.current_period_end === 'number') {
        prospect.subscriptionNextDueDate = new Date(sub.current_period_end * 1000).toISOString();
      }
      const stamp = new Date().toLocaleString();

      if (event.type === 'customer.subscription.deleted') {
        prospect.stripeSubscriptionStatus = 'canceled';
        prospect.notes = (prospect.notes ? prospect.notes + '\n' : '') +
          `${stamp} — [Stripe] Subscription ${sub.id} canceled for ${prospect.name}.`;
        if (!(await hasRecentNotification(prospect.id, 'subscription_failed', 24 * 60 * 60 * 1000))) {
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: 'subscription_failed',
              title: `🚫 Subscription canceled for ${prospect.name}`,
              message: `Stripe subscription ${sub.id} canceled.\nNo further rent will be collected. Email-copy queued to ${OPERATOR_EMAIL}.`,
              metadata: { prospectId: prospect.id, stripeSubscriptionId: sub.id, mode: 'live', outcome: 'canceled' },
              read: false, createdAt: new Date().toISOString(),
            });
          } catch {}
        }
      } else {
        const ATTENTION_STATES = new Set([
          'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled',
        ]);
        if (sub.status && ATTENTION_STATES.has(sub.status)) {
          prospect.notes = (prospect.notes ? prospect.notes + '\n' : '') +
            `${stamp} — [Stripe] Subscription ${sub.id} status → ${sub.status} for ${prospect.name}.`;
          let title: string, body: string, outcome: string;
          switch (sub.status) {
            case 'incomplete_expired':
              title = `🪦 First invoice never paid for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} → "${sub.status}".\nFirst invoice was never paid; subscription slot is now free.\nRe-onboarding requires a fresh auto-subscribe. Email-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = 'incomplete_expired';
              break;
            case 'unpaid':
              title = `💀 All retries exhausted for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} → "${sub.status}" after ~21 days of failed retries.\nSubscription will be canceled by Stripe. Email-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = 'unpaid';
              break;
            case 'past_due':
              title = `⚠️ Subscription past_due for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} status → "${sub.status}".\nLatest invoice failed; Stripe is retrying. Email-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = 'past_due';
              break;
            case 'incomplete':
              title = `⏳ First invoice pending for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} status → "${sub.status}".\nWaiting for first payment. Email-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = 'incomplete';
              break;
            case 'paused':
              title = `⏸️ Subscription paused for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} status → "${sub.status}".\nEmail-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = 'paused';
              break;
            case 'canceled':
              title = `🚫 Subscription canceled for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} status → "${sub.status}".\nNo further rent will be collected. Email-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = 'canceled';
              break;
            default:
              title = `ℹ️ Subscription status → ${sub.status} for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} status changed to "${sub.status}".\nEmail-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = sub.status;
          }
          const notifType: 'subscription_failed' | 'invoice_created' =
            sub.status === 'past_due' || sub.status === 'unpaid' ||
            sub.status === 'canceled' || sub.status === 'incomplete_expired'
              ? 'subscription_failed' : 'invoice_created';
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: notifType, title, message: body,
              metadata: { prospectId: prospect.id, stripeSubscriptionId: sub.id, status: sub.status, mode: 'live', outcome },
              read: false, createdAt: new Date().toISOString(),
            });
          } catch {}
        }
      }
      await saveProspect(prospect);
      return;
    }

    default:
      return;
  }
}

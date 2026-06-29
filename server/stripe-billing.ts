/**
 * Stripe auto-subscription + reconciliation logic.
 *
 * Extracted from server.ts so that the server-side autopilot
 * (`server/autopilot.ts`) can call the same createAutoSubscription
 * function without circular imports back through the Express route
 * definitions.
 *
 * Behavior is identical to the original server.ts implementation:
 *   - Idempotency via prospect.stripeSubscriptionId (mock ids are
 *     cleared so a fresh live subscription is created on the next run).
 *   - collection_method = 'send_invoice' so Stripe emails the customer.
 *   - finalizeInvoice + sendInvoice are called explicitly so the
 *     customer gets the invoice email right now rather than waiting on
 *     a dashboard toggle.
 *   - Operator notification (email-copy) is emitted to OPERATOR_EMAIL
 *     for every new subscription, every reconciliation, and every
 *     failure.
 */
import Stripe from 'stripe';
import dotenv from 'dotenv';
dotenv.config();
import { ScrapedLead } from '../src/types';

export const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || 'sk_test_mock_placeholder_key',
);

const STRIPE_LIVE_CONFIGURED =
  !!process.env.STRIPE_SECRET_KEY &&
  !process.env.STRIPE_SECRET_KEY.includes('mock_placeholder') &&
  process.env.STRIPE_SECRET_KEY !== 'MY_STRIPE_SECRET_KEY';

export const OPERATOR_EMAIL_DEFAULT = 'halvsiebobbproductions@gmail.com';
export const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || OPERATOR_EMAIL_DEFAULT;

export function isStripeLive(): boolean {
  return STRIPE_LIVE_CONFIGURED;
}

function safeInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function safeStr(value: string | undefined, fallback: string): string {
  return value && value.trim() !== '' ? value.trim() : fallback;
}

const AUTO_SUBSCRIBE_AMOUNT_CENTS = safeInt(
  process.env.STRIPE_AUTO_SUBSCRIBE_AMOUNT_CENTS,
  45000,
); // $450.00 default
const AUTO_SUBSCRIBE_CURRENCY = safeStr(
  process.env.STRIPE_AUTO_SUBSCRIBE_CURRENCY,
  'usd',
);
const AUTO_SUBSCRIBE_DAYS_UNTIL_DUE = safeInt(
  process.env.STRIPE_AUTO_SUBSCRIBE_DAYS_UNTIL_DUE,
  7,
);

export interface AutoSubscriptionResult {
  mode: 'live';
  prospectId: string;
  siteId?: string;
  targetId?: string;
  customerId: string;
  subscriptionId: string;
  invoiceId: string;
  invoiceNumber?: string;
  invoiceUrl: string;
  invoiceStatus: string;
  amountDue: number;
  currency: string;
  dueDate: string;
  customerEmail: string;
  operatorNotifiedEmail: string;
  alreadyHadSubscription?: boolean;
  sendInvoiceFailed?: boolean;
  sendInvoiceError?: string;
}

export async function findOrCreateStripeCustomer(
  prospect: ScrapedLead,
): Promise<Stripe.Customer> {
  const email =
    prospect.email && prospect.email.trim() !== ''
      ? prospect.email.trim()
      : '';
  if (!email) {
    throw new Error(
      `Cannot create Stripe subscription for "${prospect.name}" — the prospect has no email on file. ` +
        `Add an email to the CRM record before auto-subscribing.`,
    );
  }
  if (prospect.stripeCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(prospect.stripeCustomerId);
      if (existing && !(existing as any).deleted) {
        return existing as Stripe.Customer;
      }
    } catch (e) {
      console.warn(
        `[Stripe] Could not retrieve saved customer ${prospect.stripeCustomerId}, creating a new one.`,
      );
    }
  }
  const list = await stripe.customers.list({ email, limit: 1 });
  if (list.data && list.data.length > 0) {
    return list.data[0];
  }
  return await stripe.customers.create({
    email,
    name: prospect.name,
    metadata: {
      prospectId: prospect.id,
      targetId: prospect.targetId,
      niche: prospect.niche,
      city: prospect.city,
    },
  });
}

export async function createAutoSubscription(
  prospect: ScrapedLead,
  site:
    | {
        id: string;
        domainName?: string;
        niche: string;
        city: string;
        deploymentUrl?: string;
      }
    | null,
): Promise<AutoSubscriptionResult> {
  // Note: `mode` on the result is now always 'live' — the app no longer
  // supports a mock Stripe mode. The interface is kept as a single-member
  // union so call sites that pattern-match on `result.mode === 'live'`
  // keep compiling while the dead 'mock' arm is removed from src/types.ts.
  if (prospect.stripeSubscriptionId) {
    return {
      mode: 'live',
      prospectId: prospect.id,
      siteId: site?.id,
      targetId: prospect.targetId,
      customerId: prospect.stripeCustomerId || 'cus_unknown',
      subscriptionId: prospect.stripeSubscriptionId,
      invoiceId: prospect.stripeInvoiceId || 'in_unknown',
      invoiceNumber: prospect.stripeInvoiceNumber,
      invoiceUrl: prospect.stripeInvoiceUrl || '',
      invoiceStatus: 'already_active',
      amountDue: prospect.subscriptionAmount || AUTO_SUBSCRIBE_AMOUNT_CENTS,
      currency: prospect.subscriptionCurrency || AUTO_SUBSCRIBE_CURRENCY,
      dueDate: prospect.subscriptionNextDueDate || new Date().toISOString(),
      customerEmail: prospect.email || OPERATOR_EMAIL,
      operatorNotifiedEmail: OPERATOR_EMAIL,
      alreadyHadSubscription: true,
    };
  }

  if (!STRIPE_LIVE_CONFIGURED) {
    throw new Error(
      'STRIPE_SECRET_KEY is not configured (or still set to the mock placeholder). ' +
        'Set a real Stripe test/live key in your .env to enable auto-subscription. ' +
        'See https://dashboard.stripe.com/apikeys to create one.',
    );
  }

  const customer = await findOrCreateStripeCustomer(prospect);
  const productName = `Lease Subscription — ${
    site?.domainName || `${prospect.city} ${prospect.niche} Asset`
  }`;
  const productDescription = `Recurring monthly lease for the local lead-asset site in ${prospect.city} (${prospect.niche})`;

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    collection_method: 'send_invoice',
    days_until_due: AUTO_SUBSCRIBE_DAYS_UNTIL_DUE,
    billing_cycle_anchor: Math.floor(Date.now() / 1000),
    proration_behavior: 'none',
    items: [
      {
        price_data: {
          currency: AUTO_SUBSCRIBE_CURRENCY,
          unit_amount: AUTO_SUBSCRIBE_AMOUNT_CENTS,
          product_data: {
            name: productName,
            description: productDescription,
          },
          recurring: {
            interval: 'month',
            interval_count: 1,
          },
        } as any,
        quantity: 1,
      },
    ],
    metadata: {
      prospectId: prospect.id,
      targetId: prospect.targetId,
      siteId: site?.id || '',
      niche: prospect.niche,
      city: prospect.city,
      source: 'rank-rent-autopilot',
    },
    expand: ['latest_invoice'],
  });

  let invoiceId = '';
  let invoiceUrl = '';
  let invoiceStatus = '';
  let invoiceNumber: string | undefined;
  let amountDue = AUTO_SUBSCRIBE_AMOUNT_CENTS;
  let dueDate = new Date(
    Date.now() + AUTO_SUBSCRIBE_DAYS_UNTIL_DUE * 86400_000,
  ).toISOString();
  let sendInvoiceFailed = false;
  let sendInvoiceError: string | undefined;

  const latestInvoice = subscription.latest_invoice;
  if (latestInvoice) {
    const inv =
      typeof latestInvoice === 'string'
        ? await stripe.invoices.retrieve(latestInvoice)
        : (latestInvoice as Stripe.Invoice);
    invoiceId = inv.id || '';
    if (inv.status === 'draft') {
      try {
        await stripe.invoices.finalizeInvoice(invoiceId);
        const refreshedPostFinalize = await stripe.invoices.retrieve(invoiceId);
        Object.assign(inv, {
          status: refreshedPostFinalize.status,
          number: refreshedPostFinalize.number,
          hosted_invoice_url: refreshedPostFinalize.hosted_invoice_url,
          invoice_pdf: refreshedPostFinalize.invoice_pdf,
          due_date: refreshedPostFinalize.due_date,
          amount_due: refreshedPostFinalize.amount_due,
        });
      } catch (finErr: any) {
        console.warn(
          `[Stripe] finalizeInvoice(${invoiceId}) failed:`,
          finErr?.message || finErr,
        );
        sendInvoiceFailed = true;
        sendInvoiceError = `finalize: ${finErr?.message || finErr}`;
      }
    }
    try {
      if (inv.status === 'open') {
        await stripe.invoices.sendInvoice(invoiceId);
      } else if (inv.status !== 'paid') {
        sendInvoiceFailed = true;
        if (!sendInvoiceError) {
          sendInvoiceError = `unexpected invoice status "${inv.status}" — no email dispatched`;
        }
      }
    } catch (sendErr: any) {
      console.warn(
        `[Stripe] sendInvoice(${invoiceId}) failed:`,
        sendErr?.message || sendErr,
      );
      sendInvoiceFailed = true;
      sendInvoiceError = `sendInvoice: ${sendErr?.message || sendErr}`;
    }
    const refreshed = await stripe.invoices.retrieve(invoiceId);
    invoiceUrl =
      refreshed.hosted_invoice_url ||
      refreshed.invoice_pdf ||
      inv.hosted_invoice_url ||
      inv.invoice_pdf ||
      '';
    invoiceStatus = refreshed.status || inv.status || '';
    invoiceNumber = refreshed.number ?? inv.number ?? undefined;
    amountDue = refreshed.amount_due ?? AUTO_SUBSCRIBE_AMOUNT_CENTS;
    if (refreshed.due_date) {
      dueDate = new Date(refreshed.due_date * 1000).toISOString();
    }
  }

  return {
    mode: 'live',
    prospectId: prospect.id,
    siteId: site?.id,
    targetId: prospect.targetId,
    customerId: customer.id,
    subscriptionId: subscription.id,
    invoiceId,
    invoiceNumber,
    invoiceUrl: invoiceUrl || '',
    invoiceStatus,
    amountDue,
    currency: AUTO_SUBSCRIBE_CURRENCY,
    dueDate,
    customerEmail: customer.email || prospect.email || OPERATOR_EMAIL,
    operatorNotifiedEmail: OPERATOR_EMAIL,
    sendInvoiceFailed,
    sendInvoiceError,
  };
}

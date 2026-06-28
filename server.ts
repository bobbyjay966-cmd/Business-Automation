/**
 * Rank & Rent OS — Express server.
 *
 * Three deployment modes, all sharing the same routes via `buildApp()`:
 *   1. **Local dev** (`npm run dev`): Vite middleware in-process, port 3000,
 *      autopilot + Stripe reconcile + CallRail webhook registration start on
 *      `app.listen`.
 *   2. **Long-lived production** (Render / Railway / Fly.io / your VPS):
 *      Same as dev but `NODE_ENV=production` so the static `dist/` assets
 *      are served instead of Vite middleware.
 *   3. **Vercel serverless** (`api/index.ts`): the function exports `app`
 *      and Vercel routes both static assets and `/api/*` through it.
 *      `app.listen()` is skipped (`process.env.VERCEL === '1'`) because
 *      serverless functions don't listen on a port — Vercel invokes the
 *      handler per request. setInterval loops are also skipped because
 *      they don't survive between invocations; on Vercel the cron
 *      endpoint `POST /api/cron/autopilot` handles tick scheduling.
 */
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

dotenv.config();

import {
  getTargets,
  saveTarget,
  deleteTarget,
  getProspects,
  saveProspects,
  saveProspect,
  deleteProspect,
  getNumbers,
  saveNumber,
  deleteNumber,
  getCalls,
  saveCall,
  getSites,
  saveSite,
  deleteSite,
  getNotifications,
  saveNotification,
  markNotificationRead,
  clearNotifications,
  getSettings,
  saveSettings,
  getDbSnapshot,
} from './server/db';

import {
  analyzeMarket,
  scrapeLeads,
  generateOutreachPitch,
  generateTrialOfferEmail,
  generateLandingPage,
  formatLlmError,
} from './server/llm';

import {
  stripe,
  OPERATOR_EMAIL,
  isStripeLive,
  createAutoSubscription,
} from './server/stripe-billing';

import {
  runAutopilotCycle,
  startAutopilotLoop,
  getAutopilotStatus,
  recordCycleResult,
} from './server/autopilot';
import { handleStripeEvent } from './server/stripe-webhooks';
import {
  isCallRailEnabled,
  provisionCallRailTracker,
  registerCallRailWebhook,
  verifyCallRailSignature,
} from './server/callrail';

import { NicheCityTarget, TrackingNumber, ScrapedLead, OperatorNotification } from './src/types';

// CallRail helpers (callCallRailApi, getCallRailAccountAndCompany,
// provisionCallRailTracker, registerCallRailWebhook,
// verifyCallRailSignature) all live in `./server/callrail` so both
// server.ts (manual /api/numbers + webhook registration) and
// server/autopilot.ts (auto-provisioning in the decision loop) share
// one client.

// ----------------------------------------------------------------
// Shared dedup helper for transient event bursts
// ----------------------------------------------------------------

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

// ----------------------------------------------------------------
// Express app factory — used by both server.ts (long-lived) and
// api/index.ts (Vercel serverless). All route definitions live here
// so behavior is identical across deployment modes.
// ----------------------------------------------------------------

export function buildApp(): express.Express {
  const app = express();

  // JSON parser. The `verify` callback captures the raw bytes of every
  // incoming request so webhook signature verifiers (Stripe, CallRail)
  // can check against the actual wire payload — NOT against
  // JSON.stringify(req.body), which can have a different key order /
  // whitespace than the bytes the sender hashed.
  app.use(express.json({
    limit: '1mb',
    verify: (req: any, _res, buf) => { req.rawBody = Buffer.from(buf); },
  }));
  // URL-encoded parser (required for Twilio webhooks)
  app.use(express.urlencoded({ extended: false }));

  // Request log
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  // ----- Targets -----
  app.get('/api/targets', async (_req, res) => {
    try { res.json(await getTargets()); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/targets', async (req, res) => {
    const { niche, city } = req.body;
    if (!niche || !city) {
      res.status(400).json({ error: 'Niche and City are required fields.' });
      return;
    }
    try {
      console.log(`Starting SEO analysis for Niche: "${niche}" in "${city}"...`);
      const analysis = await analyzeMarket(niche, city);
      const newTarget: NicheCityTarget = {
        id: `target-${Date.now()}`,
        niche, city,
        status: 'researching',
        monthlyVolume: analysis.keywords.reduce((acc: number, k: any) => acc + (k.searchVolume || 0), 0),
        avgDifficulty: Math.round(
          analysis.keywords.reduce((acc: number, k: any) => acc + (k.difficulty || 0), 0) /
          (analysis.keywords.length || 1),
        ),
        keywords: analysis.keywords,
        competitors: analysis.competitors,
        gmbScore: analysis.gmbScore || 50,
        createdAt: new Date().toISOString(),
      };
      await saveTarget(newTarget);
      res.json(newTarget);
    } catch (err: any) {
      console.error('Error analyzing target market:', err);
      res.status(500).json({ error: formatLlmError(err) });
    }
  });
  app.delete('/api/targets/:id', async (req, res) => {
    try { await deleteTarget(req.params.id); res.json({ success: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ----- Prospects -----
  app.get('/api/prospects', async (req, res) => {
    try {
      const { targetId } = req.query;
      let prospects = await getProspects();
      if (targetId) prospects = prospects.filter((p) => p.targetId === targetId);
      res.json(prospects);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/prospects/scrape', async (req, res) => {
    const { targetId, niche, city } = req.body;
    if (!targetId || !niche || !city) {
      res.status(400).json({ error: 'targetId, niche, and city are required.' });
      return;
    }
    try {
      const leads = await scrapeLeads(niche, city, targetId);
      await saveProspects(leads);
      const targets = await getTargets();
      const target = targets.find((t) => t.id === targetId);
      if (target) { target.status = 'active_leads'; await saveTarget(target); }
      res.json(leads);
    } catch (err: any) {
      console.error('Error scraping leads:', err);
      res.status(500).json({ error: formatLlmError(err) });
    }
  });
  app.post('/api/prospects/:id/pitch', async (req, res) => {
    const prospects = await getProspects();
    const prospect = prospects.find((p) => p.id === req.params.id);
    if (!prospect) { res.status(404).json({ error: 'Prospect not found.' }); return; }
    try {
      const pitch = await generateOutreachPitch(prospect);
      prospect.pitchEmailContent = pitch.emailContent;
      prospect.pitchSmsContent = pitch.smsContent;
      prospect.pitchStatus = 'Pitched';
      await saveProspect(prospect);
      res.json(prospect);
    } catch (err: any) { res.status(500).json({ error: formatLlmError(err) }); }
  });
  app.patch('/api/prospects/:id/status', async (req, res) => {
    const prospects = await getProspects();
    const prospect = prospects.find((p) => p.id === req.params.id);
    if (!prospect) { res.status(404).json({ error: 'Prospect not found.' }); return; }
    try { prospect.pitchStatus = req.body.status; await saveProspect(prospect); res.json(prospect); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/prospects/:id/notes', async (req, res) => {
    const prospects = await getProspects();
    const prospect = prospects.find((p) => p.id === req.params.id);
    if (!prospect) { res.status(404).json({ error: 'Prospect not found.' }); return; }
    try { prospect.notes = req.body.notes; await saveProspect(prospect); res.json(prospect); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ----- Numbers -----
  app.get('/api/numbers', async (_req, res) => {
    try { res.json(await getNumbers()); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/numbers', async (req, res) => {
    const { phoneNumber, friendlyName, forwardTo, whisperMessage, recordCalls } = req.body;
    if (!phoneNumber || !forwardTo) {
      res.status(400).json({ error: 'phoneNumber and forwardTo are required.' });
      return;
    }
    try {
      let finalNumber = phoneNumber;
      if (isCallRailEnabled()) {
        let areaCode = '214';
        const m = phoneNumber.replace(/\D/g, '').match(/^1?([0-9]{3})/);
        if (m) areaCode = m[1];
        const { phoneNumber: realNumber } = await provisionCallRailTracker({
          name: friendlyName || `${phoneNumber} Forwarder`,
          areaCode,
          forwardTo,
          whisperMessage,
          recordCalls: !!recordCalls,
        });
        finalNumber = realNumber;
      }
      const newNum: TrackingNumber = {
        id: `num-${Date.now()}`,
        phoneNumber: finalNumber,
        friendlyName: friendlyName || `${finalNumber} Forwarder`,
        forwardTo,
        whisperMessage: whisperMessage || 'Call from Rank & Rent Leads.',
        recordCalls: !!recordCalls,
        isActive: true,
        createdAt: new Date().toISOString(),
      };
      await saveNumber(newNum);
      res.json(newNum);
    } catch (err: any) {
      console.error('Error provisioning tracking number:', err);
      res.status(500).json({ error: err.message });
    }
  });
  app.delete('/api/numbers/:id', async (req, res) => {
    try { await deleteNumber(req.params.id); res.json({ success: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ----- Calls -----
  app.get('/api/calls', async (_req, res) => {
    try { res.json(await getCalls()); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  // ----- Sites -----
  app.get('/api/sites', async (_req, res) => {
    try { res.json(await getSites()); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/sites/generate', async (req, res) => {
    const { targetId, trackingNumberId } = req.body;
    if (!targetId || !trackingNumberId) {
      res.status(400).json({ error: 'targetId and trackingNumberId are required.' });
      return;
    }
    const targets = await getTargets();
    const target = targets.find((t) => t.id === targetId);
    const numbers = await getNumbers();
    const line = numbers.find((l) => l.id === trackingNumberId);
    if (!target) { res.status(404).json({ error: 'Target market not found.' }); return; }
    if (!line) { res.status(404).json({ error: 'Tracking line not found.' }); return; }
    try {
      const site = await generateLandingPage(target.niche, target.city, line.phoneNumber, line.whisperMessage);
      site.targetId = targetId;
      if (process.env.VERCEL_API_KEY) {
        try {
          const clean = `rank-rent-${target.city.toLowerCase()}-${target.niche.toLowerCase()}-${Date.now().toString().slice(-4)}`
            .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
          const vercelRes = await fetch('https://api.vercel.com/v13/deployments', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.VERCEL_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: clean,
              files: [{ file: 'index.html', data: site.htmlCode, encoding: 'utf-8' }],
              projectSettings: { framework: null },
            }),
          });
          if (vercelRes.ok) {
            const data: any = await vercelRes.json();
            if (data?.url) {
              site.domainName = data.url;
              (site as any).deploymentUrl = data.url;
            }
          }
        } catch (vErr: any) {
          console.error('Vercel deployment failed, using generated domain name:', vErr.message || vErr);
        }
      }
      await saveSite(site);
      target.status = 'site_created';
      await saveTarget(target);
      res.json(site);
    } catch (err: any) {
      console.error('Error generating site:', err);
      res.status(500).json({ error: formatLlmError(err) });
    }
  });
  app.delete('/api/sites/:id', async (req, res) => {
    try { await deleteSite(req.params.id); res.json({ success: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ----- Trial email + billing -----
  app.post('/api/outreach/trial-email', async (req, res) => {
    const { prospectId, siteUrl, niche, city } = req.body;
    if (!prospectId || !siteUrl) {
      res.status(400).json({ error: 'prospectId and siteUrl are required.' });
      return;
    }
    const prospects = await getProspects();
    const prospect = prospects.find((p) => p.id === prospectId);
    if (!prospect) { res.status(404).json({ error: 'Prospect not found.' }); return; }
    try {
      const emailData = await generateTrialOfferEmail(prospect, siteUrl, niche || prospect.niche, city || prospect.city);
      prospect.trialEmailContent = emailData.emailContent;
      prospect.trialEmailSent = true;
      prospect.pitchStatus = 'Trial';
      await saveProspect(prospect);
      res.json({
        success: true,
        prospectId: prospect.id,
        subject: emailData.subject,
        emailContent: emailData.emailContent,
        sentTo: prospect.email || null,
        from: 'halvsiebobbproductions@gmail.com',
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/billing/checkout', async (req, res) => {
    const { siteId, prospectId } = req.body;
    if (!siteId || !prospectId) { res.status(400).json({ error: 'siteId and prospectId are required.' }); return; }
    try {
      const sites = await getSites();
      const site = sites.find((s) => s.id === siteId);
      const prospects = await getProspects();
      const prospect = prospects.find((p) => p.id === prospectId);
      if (!site || !prospect) { res.status(404).json({ error: 'Site or Prospect not found.' }); return; }
      if (!isStripeLive()) {
        res.status(503).json({
          error: 'STRIPE_SECRET_KEY is not configured (or still set to the mock placeholder). ' +
            'Set a real Stripe test/live key in your .env to enable Checkout. ' +
            'See https://dashboard.stripe.com/apikeys to create one.',
        });
        return;
      }
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Lease Subscription: ${site.domainName}`,
              description: `Recurring rental fee for local lead asset: ${site.niche} in ${site.city}`,
            },
            unit_amount: 45000,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        }],
        mode: 'subscription',
        success_url: `${process.env.APP_URL || 'http://localhost:3000'}/?status=success&prospectId=${prospectId}&siteId=${siteId}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/?status=cancel`,
        metadata: { siteId, prospectId },
      });
      res.json({ url: session.url });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/billing/auto-subscribe', async (req, res) => {
    const { prospectId, siteId, targetId } = req.body;
    if (!prospectId) { res.status(400).json({ error: 'prospectId is required' }); return; }
    try {
      const prospects = await getProspects();
      const prospect = prospects.find((p) => p.id === prospectId);
      if (!prospect) { res.status(404).json({ error: 'Prospect not found.' }); return; }
      const sites = await getSites();
      let site = siteId ? sites.find((s) => s.id === siteId) : sites.find((s) => s.targetId === prospect.targetId);
      if (!site && targetId) site = sites.find((s) => s.targetId === targetId);
      const numbers = await getNumbers();
      const hasLine = numbers.some((n) =>
        n.friendlyName?.toLowerCase().includes(prospect.city.toLowerCase()) ||
        n.friendlyName?.toLowerCase().includes(prospect.niche.toLowerCase())
      ) || numbers.length > 0;
      if (!site || !hasLine) {
        res.status(412).json({
          error: `Cannot auto-subscribe: prerequisites not met. siteReady=${!!site}, hasLine=${hasLine}.`,
          needsSite: !site, needsLine: !hasLine,
        });
        return;
      }
      const result = await createAutoSubscription(prospect, site);
      prospect.stripeCustomerId = result.customerId;
      prospect.stripeSubscriptionId = result.subscriptionId;
      prospect.stripeInvoiceId = result.invoiceId;
      prospect.stripeInvoiceUrl = result.invoiceUrl;
      prospect.stripeInvoiceNumber = result.invoiceNumber;
      prospect.subscriptionAmount = result.amountDue;
      prospect.subscriptionCurrency = result.currency;
      prospect.subscriptionNextDueDate = result.dueDate;
      prospect.subscriptionStartDate = new Date().toISOString();
      prospect.subscriptionMode = result.mode;
      prospect.stripeSubscriptionStatus = 'active';
      if (!result.alreadyHadSubscription) {
        prospect.pitchStatus = 'Rented';
        const stamp = new Date().toLocaleString();
        prospect.notes = (prospect.notes ? prospect.notes + '\n' : '') +
          `${stamp} — [Stripe LIVE] $${(result.amountDue/100).toFixed(2)} ${result.currency.toUpperCase()} subscription + invoice created.`;
      }
      await saveProspect(prospect);
      if (!result.alreadyHadSubscription) {
        const targets = await getTargets();
        const target = targets.find((t) => t.id === prospect.targetId);
        if (target) { target.status = 'rented'; await saveTarget(target); }
      }
      const dispatchFailed = !!result.sendInvoiceFailed;
      const note: OperatorNotification = {
        id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: dispatchFailed ? 'subscription_failed'
          : (result.alreadyHadSubscription ? 'invoice_created' : 'subscription_activated'),
        title: dispatchFailed
          ? `⚠️ Invoice NOT emailed to ${prospect.name}`
          : (result.alreadyHadSubscription
              ? `Existing subscription confirmed for ${prospect.name}`
              : `✅ Stripe subscription created for ${prospect.name}`),
        message:
          `Customer: ${result.customerEmail}\n` +
          `Subscription: ${result.subscriptionId}\n` +
          `Invoice: ${result.invoiceId}\n` +
          `Amount: $${(result.amountDue/100).toFixed(2)} ${result.currency.toUpperCase()}\n` +
          `Due: ${result.dueDate.slice(0,10)}\n` +
          (result.invoiceUrl ? `Hosted: ${result.invoiceUrl}\n` : '') +
          `Operator copy queued to ${OPERATOR_EMAIL}.`,
        metadata: {
          prospectId: prospect.id, targetId: prospect.targetId, siteId: site.id,
          stripeCustomerId: result.customerId, stripeSubscriptionId: result.subscriptionId,
          stripeInvoiceId: result.invoiceId, stripeInvoiceUrl: result.invoiceUrl,
          mode: result.mode, amount: result.amountDue, currency: result.currency, dueDate: result.dueDate,
        },
        read: false, createdAt: new Date().toISOString(),
      };
      await saveNotification(note);
      res.json({ success: true, ...result, notification: note, prospect });
    } catch (err: any) {
      console.error('Auto-subscribe error:', err);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // ----- Notifications -----
  app.get('/api/notifications', async (_req, res) => {
    try {
      const notes = await getNotifications();
      res.json({ notifications: notes, operatorEmail: OPERATOR_EMAIL, unreadCount: notes.filter((n) => !n.read).length });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/notifications/:id/read', async (req, res) => {
    try { await markNotificationRead(req.params.id); res.json({ success: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.delete('/api/notifications', async (_req, res) => {
    try { await clearNotifications(); res.json({ success: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ----- Autopilot (server-side) -----
  // The UI now toggles persistent settings via /api/autopilot/toggle; the
  // cron endpoint runs one cycle per request; /api/autopilot/status returns
  // a snapshot the dashboard polls.
  const AUTOPILOT_INTERVAL_MS = (() => {
    const v = Number(process.env.AUTOPILOT_INTERVAL_MS);
    return Number.isFinite(v) && v > 0 ? v : 12_000;
  })();

  app.get('/api/autopilot/status', async (_req, res) => {
    try {
      const status = await getAutopilotStatus(AUTOPILOT_INTERVAL_MS);
      res.json({ ...status, intervalMs: AUTOPILOT_INTERVAL_MS });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/autopilot/toggle', async (req, res) => {
    const allowedKeys = ['isAutopilotOn', 'isAutoPitchOn', 'isAutoSubscribeOn'] as const;
    const patch: Record<string, boolean> = {};
    for (const k of allowedKeys) {
      if (typeof req.body?.[k] === 'boolean') patch[k] = req.body[k];
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'Provide at least one of isAutopilotOn, isAutoPitchOn, isAutoSubscribeOn.' });
      return;
    }
    try {
      await saveSettings(patch);
      const current = await getSettings();
      res.json({ success: true, settings: current });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/autopilot/run', async (_req, res) => {
    try {
      const result = await runAutopilotCycle();
      recordCycleResult(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
  app.post('/api/cron/autopilot', async (req, res) => {
    // Vercel Cron will POST here on a schedule. We accept any authenticated
    // request; in production you should require a `CRON_SECRET` header
    // (set via vercel.json) and reject unauthenticated calls.
    const expected = process.env.CRON_SECRET;
    if (expected) {
      const got = req.headers['x-cron-secret'] || req.headers['authorization'];
      if (got !== expected && got !== `Bearer ${expected}`) {
        res.status(401).json({ error: 'Unauthorized cron ping.' });
        return;
      }
    }
    try {
      const result = await runAutopilotCycle();
      recordCycleResult(result);
      res.json({ success: true, ...result });
    } catch (err: any) {
      // Even on error, return 200 so cron-job.org's retries don't pile up —
      // the failure is captured in the response body.
      res.status(200).json({ success: false, error: err?.message || String(err) });
    }
  });
  app.get('/api/health', async (_req, res) => {
    try {
      const snapshot = await getDbSnapshot();
      res.json({ status: 'ok', timestamp: new Date().toISOString(), ...snapshot });
    } catch (err: any) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  // ----- Stripe webhooks (full event handler in server/stripe-webhooks.ts).
  // NOTE: keep the raw-body parser scoped to this route only so other
  // endpoints still get parsed JSON.
  app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event: any;
    try {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (webhookSecret && sig) {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } else {
        event = JSON.parse(req.body.toString());
      }
    } catch (err: any) {
      res.status(400).send(`Webhook Error: ${sig ? err.message : 'Missing signature or webhook secret'}`);
      return;
    }
    try {
      await handleStripeEvent(event);
    } catch (e: any) {
      console.error('[Stripe Webhook] handler error:', e?.message || e);
    }
    res.json({ received: true });
  });

  // ----- CallRail webhook -----
  app.post('/api/webhooks/callrail', async (req, res) => {
    const { customer_number, tracking_phone_number, duration, answered, recording_url, start_time, customer_city, customer_state } = req.body;
    const signature = req.headers['x-callrail-signature'];
    const signingKey = process.env.CALLRAIL_SIGNING_KEY;
    if (signingKey) {
      // Fail closed: signing key is configured, so we MUST have the raw
      // body that the global express.json() verify hook captures.
      const raw = (req as any).rawBody as Buffer | undefined;
      if (!raw) {
        res.status(400).json({ error: 'Raw body missing for signature verification.' });
        return;
      }
      if (!signature || !verifyCallRailSignature(raw.toString(), signature as string, signingKey)) {
        res.status(401).json({ error: 'Invalid signature.' });
        return;
      }
    }
    const numbers = await getNumbers();
    const cleanCallRailNum = (tracking_phone_number || '').replace(/[^\d+]/g, '');
    const line = numbers.find((n) => n.phoneNumber.replace(/[^\d+]/g, '') === cleanCallRailNum);
    if (line) {
      const durationSeconds = duration ? Number(duration) : 0;
      const status = answered === true || answered === 'true' ? 'completed' as const : 'no-answer' as const;
      await saveCall({
        id: `call-${Date.now()}`,
        trackingNumberId: line.id,
        trackingNumber: line.phoneNumber,
        callerNumber: customer_number || '+1 (unknown)',
        callerLocation: customer_city && customer_state ? `${customer_city}, ${customer_state}` : 'United States',
        forwardTo: line.forwardTo,
        durationSeconds,
        status,
        recordingUrl: recording_url || undefined,
        dateCreated: start_time ? new Date(start_time).toISOString() : new Date().toISOString(),
      });
    }
    res.json({ success: true });
  });

  // ----- Stripe reconciliation (unchanged behavior, now a re-export of the
  //       helper inside this buildApp scope). Kept for the UI "Reconcile Now"
  //       button + the backstop cron. The cron registration happens in
  //       startServer() below on long-lived deployments.
  let isReconciling = false;
  type ReconcileRunStats = {
    lastRunAt: string;
    lastCheckedCount: number;
    lastDriftedCount: number;
    lastErrorsCount: number;
    lastResult: 'completed' | 'skipped' | 'noop_live_disabled' | 'noop_no_candidates';
    intervalMs: number;
  };
  let lastReconcileStats: ReconcileRunStats | null = null;
  const STRIPE_RECONCILE_INTERVAL_MS = (() => {
    const v = Number(process.env.STRIPE_RECONCILE_INTERVAL_MS);
    return Number.isFinite(v) && v > 0 ? v : 30 * 60 * 1000;
  })();

  async function reconcileStripeSubscriptionStates(): Promise<{ checked: number; drifted: number; errors: number; skipped?: boolean }> {
    if (isReconciling) {
      lastReconcileStats = {
        lastRunAt: new Date().toISOString(),
        lastCheckedCount: 0, lastDriftedCount: 0, lastErrorsCount: 0,
        lastResult: 'skipped', intervalMs: STRIPE_RECONCILE_INTERVAL_MS,
      };
      return { checked: 0, drifted: 0, errors: 0, skipped: true };
    }
    isReconciling = true;
    try {
      if (!isStripeLive()) {
        lastReconcileStats = {
          lastRunAt: new Date().toISOString(),
          lastCheckedCount: 0, lastDriftedCount: 0, lastErrorsCount: 0,
          lastResult: 'noop_live_disabled', intervalMs: STRIPE_RECONCILE_INTERVAL_MS,
        };
        return { checked: 0, drifted: 0, errors: 0 };
      }
      const now = Date.now();
      const DAY_MS = 24 * 60 * 60 * 1000;
      const prospects = await getProspects();
      const candidates = prospects.filter((p) => {
        if (!p.stripeSubscriptionId) return false;
        // Every persisted subscription is 'live' since the app no longer
        // supports mock Stripe mode — no need to check the mode here.
        if (p.stripeSubscriptionStatus !== 'active') return false;
        if (!p.subscriptionNextDueDate) return false;
        if (new Date(p.subscriptionNextDueDate).getTime() > now) return false;
        const startIso = p.subscriptionStartDate || p.createdAt;
        if (startIso) {
          const ageMs = now - new Date(startIso).getTime();
          if (Number.isFinite(ageMs) && ageMs < DAY_MS) return false;
        }
        return true;
      });
      if (candidates.length === 0) {
        lastReconcileStats = {
          lastRunAt: new Date().toISOString(),
          lastCheckedCount: 0, lastDriftedCount: 0, lastErrorsCount: 0,
          lastResult: 'noop_no_candidates', intervalMs: STRIPE_RECONCILE_INTERVAL_MS,
        };
        return { checked: 0, drifted: 0, errors: 0 };
      }
      let drifted = 0, errors = 0;
      const stamp = new Date().toLocaleString();
      for (const prospect of candidates) {
        try {
          const sub: any = await stripe.subscriptions.retrieve(prospect.stripeSubscriptionId);
          if (sub.status && sub.status !== prospect.stripeSubscriptionStatus) {
            const oldStatus = prospect.stripeSubscriptionStatus;
            prospect.stripeSubscriptionStatus = sub.status;
            prospect.notes = (prospect.notes ? prospect.notes + '\n' : '') +
              `${stamp} — [Reconcile] Subscription status drifted "${oldStatus || 'unknown'}" → "${sub.status}".`;
            const isRecovering = sub.status === 'active' || sub.status === 'trialing';
            const notifType: 'subscription_activated' | 'subscription_failed' = isRecovering ? 'subscription_activated' : 'subscription_failed';
            const notifTitle =
              sub.status === 'past_due' ? `⚠️ Reconciled: ${prospect.name} is past_due`
              : sub.status === 'unpaid' ? `💀 Reconciled: ${prospect.name} is unpaid`
              : sub.status === 'canceled' ? `🚫 Reconciled: ${prospect.name} canceled`
              : sub.status === 'incomplete_expired' ? `🪦 Reconciled: ${prospect.name} expired`
              : (sub.status === 'active' || sub.status === 'trialing') ? `✅ Reconciled: ${prospect.name} renewed`
              : `🔄 Reconciled: ${prospect.name} status → ${sub.status}`;
            if (!(await hasRecentNotification(prospect.id, notifType, 24 * 60 * 60 * 1000))) {
              await saveNotification({
                id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                type: notifType, title: notifTitle,
                message: `Reconciliation drift detected.\nOld: ${oldStatus || 'unknown'}\nNew: ${sub.status}\nEmail-copy queued to ${OPERATOR_EMAIL}.`,
                metadata: { prospectId: prospect.id, stripeSubscriptionId: sub.id, previousStatus: oldStatus || null, currentStatus: sub.status, mode: 'live', outcome: sub.status, source: 'cron' },
                read: false, createdAt: new Date().toISOString(),
              });
            }
            drifted++;
          }
          if (typeof sub.current_period_end === 'number') {
            const newNext = new Date(sub.current_period_end * 1000).toISOString();
            if (prospect.subscriptionNextDueDate !== newNext) prospect.subscriptionNextDueDate = newNext;
          }
          const latest = sub.latest_invoice;
          const latestId = typeof latest === 'string' ? latest : latest?.id;
          if (latestId && latestId !== prospect.stripeInvoiceId) {
            try {
              const inv: any = await stripe.invoices.retrieve(latestId);
              if (inv.id) prospect.stripeInvoiceId = inv.id;
              if (inv.number) prospect.stripeInvoiceNumber = inv.number;
              if (inv.hosted_invoice_url || inv.invoice_pdf) {
                prospect.stripeInvoiceUrl = inv.hosted_invoice_url || inv.invoice_pdf;
              }
              if (typeof inv.amount_paid === 'number' || typeof inv.amount_due === 'number') {
                prospect.subscriptionAmount =
                  (typeof inv.amount_paid === 'number' && inv.amount_paid > 0)
                    ? inv.amount_paid
                    : inv.amount_due ?? prospect.subscriptionAmount;
              }
              if (inv.currency) prospect.subscriptionCurrency = inv.currency;
              if (inv.status) prospect.stripeInvoiceStatus = inv.status;
              if (inv.status === 'paid' && !prospect.subscriptionLastPaidAt) {
                prospect.subscriptionLastPaidAt = new Date().toISOString();
              }
            } catch (invErr: any) {
              console.warn(`[Stripe Reconcile] invoice ${latestId} fetch failed:`, invErr?.message || invErr);
            }
          }
          await saveProspect(prospect);
        } catch (err: any) {
          errors++;
          console.warn(`[Stripe Reconcile] subscription ${prospect.stripeSubscriptionId} fetch failed:`, err?.message || err);
        }
      }
      lastReconcileStats = {
        lastRunAt: new Date().toISOString(),
        lastCheckedCount: candidates.length, lastDriftedCount: drifted, lastErrorsCount: errors,
        lastResult: 'completed', intervalMs: STRIPE_RECONCILE_INTERVAL_MS,
      };
      return { checked: candidates.length, drifted, errors };
    } finally {
      isReconciling = false;
    }
  }

  app.post('/api/billing/reconcile', async (_req, res) => {
    try {
      const result = await reconcileStripeSubscriptionStates();
      if (result.skipped) {
        res.status(409).json({ success: false, message: 'Reconciliation already in progress.', ...result });
        return;
      }
      res.json({ success: true, ...result });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.get('/api/admin/stripe-reconcile-status', (_req, res) => {
    const last = lastReconcileStats;
    const lastRunAt = last?.lastRunAt ?? null;
    let nextExpectedRunAt: string | null = null;
    let isStale = true;
    let ageMs: number | null = null;
    if (last) {
      const t = new Date(last.lastRunAt).getTime();
      if (Number.isFinite(t)) {
        ageMs = Date.now() - t;
        nextExpectedRunAt = new Date(t + STRIPE_RECONCILE_INTERVAL_MS).toISOString();
        isStale = ageMs > 2 * STRIPE_RECONCILE_INTERVAL_MS;
      }
    }
    res.json({
      isCurrentlyReconciling: isReconciling,
      lastRunAt,
      lastCheckedCount: last?.lastCheckedCount ?? null,
      lastDriftedCount: last?.lastDriftedCount ?? null,
      lastErrorsCount: last?.lastErrorsCount ?? null,
      lastResult: last?.lastResult ?? null,
      intervalMs: STRIPE_RECONCILE_INTERVAL_MS,
      ageMs, nextExpectedRunAt, isStale,
    });
  });

  // ----- Static assets -----
  // On Vercel, distPath must point to a directory that Vercel recognizes
  // as "output". Vercel handles the static-serve via its own `output`
  // config, so for the serverless entry we just register the wildcard
  // catch-all to index.html (Vite SPA fallback). In local / long-lived
  // production, we also serve the dist/ files directly.
  if (process.env.NODE_ENV !== 'production') {
    // Dev mode: use Vite middleware (deferred because it's async).
    (async () => {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    })();
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Expose the reconcile function so startServer() can wire its setInterval.
  (app as any).__reconcileStripe = reconcileStripeSubscriptionStates;

  return app;
}

// ----------------------------------------------------------------
// Long-lived entry point (local dev, Render, Railway, Fly.io, VPS).
// Skipped on Vercel because the serverless entry (api/index.ts) imports
// buildApp() and doesn't need listen() / setInterval.
// ----------------------------------------------------------------

const IS_VERCEL = process.env.VERCEL === '1' || process.env.VERCEL === 'true';

async function startServer() {
  const app = buildApp();
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Rank & Rent Hub Backend listening on port ${PORT}`);

    // Background autopilot loop. Vercel skips this and relies on
    // POST /api/cron/autopilot driven by an external cron service.
    startAutopilotLoop(12_000);

    // Stripe reconciliation cron (unchanged behavior).
    if (isStripeLive()) {
      console.log(`[Stripe Reconcile] Background poller enabled: every ${Number(process.env.STRIPE_RECONCILE_INTERVAL_MS) || 30*60*1000}ms (first run in 10s).`);
      setTimeout(() => {
        (app as any).__reconcileStripe().catch((e: any) =>
          console.warn('[Stripe Reconcile] initial run error:', e?.message || e),
        );
      }, 10_000);
      setInterval(() => {
        (app as any).__reconcileStripe().catch((e: any) =>
          console.warn('[Stripe Reconcile] interval run error:', e?.message || e),
        );
      }, Number(process.env.STRIPE_RECONCILE_INTERVAL_MS) || 30 * 60 * 1000);
    }

    // CallRail webhook registration (only on long-lived deployments).
    if (isCallRailEnabled()) {
      const webhookUrl = `${process.env.APP_URL || 'http://localhost:3000'}/api/webhooks/callrail`;
      console.log(`[CallRail] Registering webhook URL: ${webhookUrl}`);
      try {
        await registerCallRailWebhook({ url: webhookUrl });
        console.log(`[CallRail] Webhook URL registered.`);
      } catch (err: any) {
        console.warn(`[CallRail] Webhook registration failed (usually already registered):`, err.message || err);
      }
    }
  });
}

if (!IS_VERCEL) {
  startServer();
}

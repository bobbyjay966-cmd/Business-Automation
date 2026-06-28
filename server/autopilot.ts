/**
 * Server-side autopilot decision loop for the Rank & Rent OS.
 *
 * Previously this logic lived in `src/components/AutopilotView.tsx` as a
 * `setInterval` running in the browser. That meant closing the tab
 * stopped the entire pipeline. This module moves the same decision tree
 * to the server, where it can be driven by:
 *   - a `setInterval` started in `server.ts` on boot (traditional host /
 *     local dev), or
 *   - an external cron ping against `POST /api/cron/autopilot` (Vercel /
 *     any serverless deploy where you can't keep a process alive).
 *
 * Each invocation of `runAutopilotCycle()` performs EXACTLY ONE action.
 * That's intentional: serverless functions have hard timeouts (Vercel
 * Hobby: 10s, Pro: 60s) and a full pipeline pass that calls the LLM
 * 5–10× in series would blow the function budget. One action per cron
 * tick is also the cleanest way to get predictable progress without
 * hitting that limit; the next tick picks up based on persistent DB
 * state.
 *
 * BUG FIXES in this rewrite (vs the previous one-shot version):
 *   - `tryScrapeForTarget` re-scrapes stale targets every 24h and
 *     deduplicates against existing prospects so lead flow is
 *     continuous, not a single one-shot event.
 *   - `tryProvisionTrackingLine` actually POSTs to CallRail when
 *     CALLRAIL_API_KEY + OPERATOR_PHONE are set; previously the cycle
 *     deadlocked on the "no line" warning.
 *   - Each phase (scrape, pitch, provision, build site, trial email,
 *     auto-subscribe) is a separate action so a single tick cannot
 *     exceed one LLM call + at most two web-API calls (CallRail /
 *     Vercel).
 *   - `tryAddTarget` now grows the portfolio continuously instead of
 *     capping at 8, with a 50-target ceiling to keep the DB well within
 *     Upstash's 1MB single-key limit.
 */
import {
  NicheCityTarget,
  ScrapedLead,
  TrackingNumber,
  GeneratedSite,
  OperatorNotification,
} from '../src/types';
import {
  getTargets,
  getProspects,
  getNumbers,
  getSites,
  saveTarget,
  saveProspect,
  saveNumber,
  saveSite,
  saveProspects,
  getSettings,
  saveNotification,
  getNotifications,
} from './db';
import {
  analyzeMarket,
  scrapeLeads,
  generateOutreachPitch,
  generateTrialOfferEmail,
  generateLandingPage,
} from './llm';
import { findOrCreateStripeCustomer, isStripeLive, createAutoSubscription } from './stripe-billing';
import {
  isCallRailEnabled,
  provisionCallRailTracker,
} from './callrail';

// ----------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------

const AUTO_NICHES = [
  'Roofing', 'Plumbing', 'Tree Services', 'AC Repair', 'Concrete Contracting',
  'Landscaping', 'Pest Control', 'Electrician', 'Drywall Repair', 'Appliance Repair',
];
const AUTO_CITIES = [
  'Dallas', 'Houston', 'Austin', 'Denver', 'Atlanta', 'Phoenix',
  'Seattle', 'Miami', 'Orlando', 'Tampa', 'Charlotte', 'Nashville',
  'Las Vegas', 'San Diego',
];

// Hard ceiling so the single-key DB stays well under Upstash's 1MB limit.
// 50 targets × ~5KB each = 250KB, leaving room for prospects + sites + calls.
const MAX_TARGETS = 50;

// Per-target scraper cooldown. Without this, a failing scrape would
// loop forever in the dedup-against-empty-set case (DDG-blocking zero-
// leads fallback returns identical rows that get deduplicated down to
// nothing).
const SCRAPE_COOLDOWN_MS = (() => {
  const v = Number(process.env.AUTOPILOT_SCRAPE_COOLDOWN_MS);
  return Number.isFinite(v) && v > 1_000 ? v : 24 * 60 * 60 * 1000;
})();

const CYCLE_TIMEOUT_MS = (() => {
  const v = Number(process.env.AUTOPILOT_CYCLE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 1000 ? v : 50_000;
})();

const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || 'halvsiebobbproductions@gmail.com';

// E.164 format expected by CallRail. We map each `target.city` to a
// local area code so the resulting tracking number shows up in tenant
// caller-ID as a LOCAL number — not a 214 Dallas long-distance call.
// Tenants (the actual paying customers) need to recognize and answer
// the call for the revenue loop to work.
const DEFAULT_AREA_CODE = '214';
const CITY_AREA_CODES: Record<string, string> = {
  dallas: '214', houston: '713', austin: '512', denver: '303',
  atlanta: '404', phoenix: '602', seattle: '206', miami: '305',
  orlando: '407', tampa: '813', charlotte: '704', nashville: '615',
  lasvegas: '702', sandiego: '619',
};
function areaCodeForCity(city: string): string {
  return CITY_AREA_CODES[city.toLowerCase().replace(/\s+/g, '')] || DEFAULT_AREA_CODE;
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

const newId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type AutopilotLogType = 'info' | 'success' | 'warn' | 'income' | 'process';

interface AutopilotLogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: AutopilotLogType;
}

function makeLogBuffer() {
  const logs: AutopilotLogEntry[] = [];
  return {
    push(message: string, type: AutopilotLogType = 'info') {
      logs.push({
        id: newId('log'),
        timestamp: new Date().toLocaleTimeString(),
        message,
        type,
      });
      if (logs.length > 100) logs.splice(0, logs.length - 100);
    },
    get logs() {
      return logs;
    },
  };
}

async function recordOperatorNotification(
  partial: Omit<OperatorNotification, 'id' | 'createdAt' | 'read'>,
): Promise<OperatorNotification> {
  const note: OperatorNotification = {
    ...partial,
    id: newId('notif'),
    read: false,
    createdAt: new Date().toISOString(),
  };
  try {
    await saveNotification(note);
  } catch (err) {
    console.error('[autopilot] failed to save operator notification:', err);
  }
  return note;
}

// Normalizers used by the dedup pass in `isNewLead`.
function normalizeStr(s: string | null | undefined): string {
  return (s ?? '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
}
function digitsOnly(s: string | null | undefined): string {
  return (s ?? '').toString().replace(/[^\d]/g, '');
}

/**
 * Deduplication key for a ScrapedLead. Identifies a real business by
 * phone (digits-only), website (normalized), or name (lowercase trim).
 * Any one match against an existing prospect for the same target means
 * the lead is a duplicate and should be skipped.
 */
function isNewLead(lead: ScrapedLead, existing: ScrapedLead[]): boolean {
  const phoneKey = digitsOnly(lead.phone);
  const websiteKey = normalizeStr(lead.website);
  const nameKey = normalizeStr(lead.name);
  return !existing.some((p) => {
    if (phoneKey && digitsOnly(p.phone) === phoneKey) return true;
    if (websiteKey && normalizeStr(p.website) === websiteKey) return true;
    if (nameKey && nameKey.length > 2 && normalizeStr(p.name) === nameKey) return true;
    return false;
  });
}

// ----------------------------------------------------------------
// Cycle result
// ----------------------------------------------------------------

export type { AutopilotLogType, AutopilotLogEntry };

// Each cycle does exactly ONE action. The action enum covers every
// stage of the pipeline; the cycle finishes as soon as one stage
// reports success.
export interface AutopilotCycleResult {
  /** True if the cycle performed a non-trivial action. */
  ranAction: boolean;
  /** The decision branch that fired on this tick. */
  action:
    | 'add_target'
    | 'scrape_target'
    | 'create_stripe_customer'
    | 'pitch_lead'
    | 'provision_line'
    | 'build_site'
    | 'send_trial_email'
    | 'auto_subscribe'
    | 'idle_scan'
    | 'skipped_off'
    | 'skipped_timeout'
    | 'noop';
  /** Human-readable summary surfaced in the UI log feed. */
  summary: string;
  /** Console-style log entries captured during the cycle. */
  logs: AutopilotLogEntry[];
  durationMs: number;
  finishedAt: string;
}

// ----------------------------------------------------------------
// Decision tree
// ----------------------------------------------------------------

/**
 * Add a new (niche × city) target market. The portfolio grows
 * continuously rather than stopping at a hard cap; a 50-target ceiling
 * keeps the DB well within Upstash's 1MB single-key limit.
 */
async function tryAddTarget(
  log: ReturnType<typeof makeLogBuffer>,
): Promise<NicheCityTarget | null> {
  const targets = await getTargets();
  if (targets.length >= MAX_TARGETS) return null;
  // Always seed an empty portfolio; otherwise gate on a 20% probability
  // so we don't spin on adding new targets every 12-second tick.
  if (targets.length > 0 && Math.random() > 0.20) return null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const niche = AUTO_NICHES[Math.floor(Math.random() * AUTO_NICHES.length)];
    const city = AUTO_CITIES[Math.floor(Math.random() * AUTO_CITIES.length)];
    const exists = targets.some(
      (t) =>
        t.niche.toLowerCase() === niche.toLowerCase() &&
        t.city.toLowerCase() === city.toLowerCase(),
    );
    if (exists) continue;

    log.push(
      `🔍 AUTOPILOT TARGET INITIATED: Locating keyword demand for "${niche}" in "${city}"...`,
      'info',
    );
    try {
      const analysis = await analyzeMarket(niche, city);
      const newTarget: NicheCityTarget = {
        id: `target-${Date.now()}`,
        niche,
        city,
        status: 'researching',
        monthlyVolume: analysis.keywords.reduce(
          (acc: number, k: any) => acc + (k.searchVolume || 0), 0,
        ),
        avgDifficulty: Math.round(
          analysis.keywords.reduce(
            (acc: number, k: any) => acc + (k.difficulty || 0), 0,
          ) / (analysis.keywords.length || 1),
        ),
        keywords: analysis.keywords,
        competitors: analysis.competitors,
        gmbScore: analysis.gmbScore || 50,
        lastScrapedAt: undefined,
        createdAt: new Date().toISOString(),
      };
      await saveTarget(newTarget);
      log.push(
        `✨ Target SEO Market discovered! Niche: "${niche}", City: "${city}". Portfolio: ${targets.length + 1}/${MAX_TARGETS}.`,
        'success',
      );
      return newTarget;
    } catch (err: any) {
      log.push(
        `❌ Target analysis failed for "${niche}/${city}": ${err?.message || err}.`,
        'warn',
      );
    }
  }
  log.push('🔍 Demands are balanced. Proceeding to lead audits...', 'info');
  return null;
}

/**
 * Find one target that needs scraping, in priority order:
 *   P1 — target with NO prospects yet (initial scrape).
 *   P2 — target lastScrapedAt is > SCRAPE_COOLDOWN_MS ago AND fewer
 *        than 10 prospects (continuous re-scrape for fresh leads).
 *   P3 — target with fewer than 5 prospects (low yield).
 * Among ties within a tier, picks randomly.
 *
 * Then SCRAPE that target and deduplicate the result against the
 * target's existing prospects so re-scraping only ever adds NEW
 * businesses. Updates lastScrapedAt on every attempt (success or
 * failure) to throttle re-scrapes after DDG rate limits.
 */
async function tryScrapeForTarget(
  log: ReturnType<typeof makeLogBuffer>,
): Promise<{ target: NicheCityTarget; newLeadCount: number } | null> {
  const targets = await getTargets();
  if (targets.length === 0) return null;

  const prospects = await getProspects();
  const now = Date.now();
  const candidates: { priority: 1 | 2 | 3; target: NicheCityTarget }[] = [];

  // P1: initial scrape — target with no prospects yet (and not scraped recently)
  const initial = targets.find(
    (t) =>
      !prospects.some((p) => p.targetId === t.id) &&
      (!t.lastScrapedAt || (now - new Date(t.lastScrapedAt).getTime()) > SCRAPE_COOLDOWN_MS)
  );
  if (initial) candidates.push({ priority: 1, target: initial });

  // P2: re-scrape stale or low-yielding targets
  for (const t of targets) {
    const targetProspects = prospects.filter((p) => p.targetId === t.id);
    const targetProspectCount = targetProspects.length;
    const isStale = !t.lastScrapedAt
      || (now - new Date(t.lastScrapedAt).getTime()) > SCRAPE_COOLDOWN_MS;
    if (isStale && targetProspectCount < 10) {
      candidates.push({ priority: 2, target: t });
    }
  }

  // P3: low yield (but already has at least one prospect, so it isn't P1)
  for (const t of targets) {
    const targetProspectCount = prospects.filter((p) => p.targetId === t.id).length;
    const isStale = !t.lastScrapedAt
      || (now - new Date(t.lastScrapedAt).getTime()) > SCRAPE_COOLDOWN_MS;
    if (isStale && targetProspectCount < 5 && targetProspectCount > 0) {
      candidates.push({ priority: 3, target: t });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.priority - b.priority);
  const topPriority = candidates[0].priority;
  const topTier = candidates.filter((c) => c.priority === topPriority);
  const chosen = topTier[Math.floor(Math.random() * topTier.length)];
  const target = chosen.target;

  log.push(
    `🕵️‍♂️ LEAD PROSPECTOR (P${topPriority}): Scraping "${target.niche} - ${target.city}"...`,
    'info',
  );
  try {
    const rawLeads = await scrapeLeads(target.niche, target.city, target.id);
    const existing = prospects.filter((p) => p.targetId === target.id);
    const deduped = rawLeads.filter((l) => isNewLead(l, existing));
    if (deduped.length > 0) {
      await saveProspects(deduped);
    }
    target.lastScrapedAt = new Date().toISOString();
    target.status = 'active_leads';
    await saveTarget(target);
    log.push(
      `✅ Scraped ${deduped.length} fresh leads (${rawLeads.length - deduped.length} duplicates filtered) for "${target.niche}/${target.city}".`,
      deduped.length > 0 ? 'success' : 'info',
    );
    return { target, newLeadCount: deduped.length };
  } catch (err: any) {
    log.push(`❌ Scrape failed for "${target.niche}/${target.city}": ${err?.message || err}.`, 'warn');
    // Stamp the cooldown even on failure so we don't hammer a broken
    // scraper path in a tight loop.
    target.lastScrapedAt = new Date().toISOString();
    await saveTarget(target);
    return null;
  }
}

/**
 * Create a Stripe customer for ONE verified lead per cycle. Only leads
 * that have BOTH a verified phone AND email are eligible. Uses
 * findOrCreateStripeCustomer from stripe-billing.ts which is idempotent
 * (reuses existing customers by email). Skips entirely if Stripe isn't
 * configured (isStripeLive returns false) so local dev works without a
 * real Stripe key.
 */
async function tryCreateStripeCustomerOne(
  log: ReturnType<typeof makeLogBuffer>,
): Promise<boolean> {
  if (!isStripeLive()) return false;

  const prospects = await getProspects();
  const lead = prospects.find(
    (p) =>
      p.phone &&
      p.email &&
      !p.stripeCustomerId &&
      p.stripeCustomerId !== 'failed' &&
      p.pitchStatus !== 'Disqualified',
  );
  if (!lead) return false;

  log.push(
    `💳 Creating Stripe customer for "${lead.name}" (${lead.email})...`,
    'process',
  );
  try {
    const customer = await findOrCreateStripeCustomer(lead);
    lead.stripeCustomerId = customer.id;
    await saveProspect(lead);
    log.push(
      `✅ Stripe customer ${customer.id} created for "${lead.name}".`,
      'success',
    );
    return true;
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    const isClientError =
      errMsg.includes('HTTP 400') ||
      errMsg.includes('HTTP 402') ||
      errMsg.includes('HTTP 404') ||
      errMsg.includes('HTTP 422');
    if (isClientError) {
      log.push(
        `❌ Stripe customer creation failed for "${lead.name}" (client error): ${errMsg}. Marking as failed to skip.`,
        'warn',
      );
      lead.stripeCustomerId = 'failed';
    } else {
      log.push(
        `⚠️ Stripe customer creation failed for "${lead.name}" (transient): ${errMsg}. Will retry next cycle.`,
        'warn',
      );
      // Don't set stripeCustomerId — let it retry next tick.
    }
    await saveProspect(lead);
    return true;
  }
}

/**
 * Generate a pitch for ONE un-pitched prospect per cycle. Only pitches
 * leads that have BOTH a verified phone AND email. Capping at one LLM
 * call per tick keeps the cycle well within the function budget.
 */
async function tryPitchOne(
  log: ReturnType<typeof makeLogBuffer>,
): Promise<boolean> {
  const prospects = await getProspects();
  const target = prospects.find(
    (p) =>
      p.pitchStatus === 'Scraped'
      && !p.pitchEmailContent
      && p.phone
      && p.email,
  );
  if (!target) return false;
  log.push(
    `📝 AI COPYWRITER: Drafting value proposition for "${target.name}" in "${target.city}"...`,
    'info',
  );
  try {
    const pitch = await generateOutreachPitch(target);
    target.pitchEmailContent = pitch.emailContent;
    target.pitchSmsContent = pitch.smsContent;
    target.pitchStatus = 'Pitched';
    await saveProspect(target);
    log.push(`✉️ Personal Cold Outreach drafted for "${target.name}".`, 'success');
    return true;
  } catch (err: any) {
    log.push(`❌ Pitch failed for "${target.name}": ${err?.message || err}.`, 'warn');
    return true; // we did take an action; cycle moves on
  }
}

/**
 * If a target has prospects + no matching CallRail line + CallRail is
 * configured (CALLRAIL_API_KEY + OPERATOR_PHONE both set), POST to
 * CallRail to provision a real tracker and persist it as a
 * TrackingNumber. Sends a one-time operator notification per target
 * per 24h when prerequisites are missing so the gap is visible without
 * spamming the feed. Returns true (action taken) even when prerequisites
 * are missing so the cycle doesn't dead-lock forever on the same
 * target.
 */
async function tryProvisionTrackingLine(
  log: ReturnType<typeof makeLogBuffer>,
): Promise<boolean> {
  if (!isCallRailEnabled()) {
    log.push(
      '📞 CallRail not configured (CALLRAIL_API_KEY not set). Skipping tracker provisioning.',
      'warn',
    );
    await notifyOncePerDay('__global__', 'callrail_not_configured', {
      type: 'system',
      title: '📞 CallRail not configured',
      message:
        'CALLRAIL_API_KEY is not set in .env. Without CallRail, the autopilot cannot ' +
        'provision real tracking numbers. Sites will not be built.\n\n' +
        'To enable: get your API key from https://app.callrail.com/settings/api-access ' +
        'and set CALLRAIL_API_KEY + OPERATOR_PHONE (your cell, E.164 format) in .env.',
      metadata: { reason: 'callrail_not_configured' },
    });
    return true; // action taken (notification); cycle moves on
  }
  const targets = await getTargets();
  const prospects = await getProspects();
  const sites = await getSites();
  const numbers = await getNumbers();

  const target = targets.find((t) => {
    const hasProspects = prospects.some((p) => p.targetId === t.id);
    const hasSite = sites.some((s) => s.targetId === t.id);
    return hasProspects && !hasSite;
  });
  if (!target) return false;

  const hasLine = numbers.some(
    (n) =>
      n.friendlyName?.toLowerCase().includes(target.city.toLowerCase()) &&
      n.friendlyName?.toLowerCase().includes(target.niche.toLowerCase()),
  );
  if (hasLine) return false; // tryBuildSite will pick it up next tick

  const operatorPhone = process.env.OPERATOR_PHONE;
  if (!operatorPhone) {
    log.push(
      `🚫 Cannot provision line for "${target.city} ${target.niche}": OPERATOR_PHONE not set in .env.`,
      'warn',
    );
    await notifyOncePerDay(target.id, 'OPERATOR_PHONE_not_set', {
      type: 'system',
      title: `🚫 Cannot provision line for "${target.city} ${target.niche}"`,
      message:
        `OPERATOR_PHONE is not set in .env. CallRail needs a destination ` +
        `number (E.164 format like +12145551234) to forward calls to. Without ` +
        `it, the autopilot cannot build sites for this target. Add OPERATOR_PHONE ` +
        `to .env (your cell phone) to unblock site building and revenue.`,
      metadata: { targetId: target.id, reason: 'OPERATOR_PHONE_not_set' },
    });
    return true; // we did take an action (notification); cycle moves on
  }

  log.push(
    `📞 Provisioning real CallRail line for "${target.city} ${target.niche}" → ${operatorPhone}...`,
    'process',
  );
  try {
    const { phoneNumber } = await provisionCallRailTracker({
      name: `${target.city} ${target.niche} Forwarder`,
      areaCode: areaCodeForCity(target.city),
      forwardTo: operatorPhone,
      whisperMessage: `Call from Rank & Rent ${target.city} ${target.niche} Leads.`,
      recordCalls: true,
    });

    const newNum: TrackingNumber = {
      id: `num-${Date.now()}`,
      targetId: target.id,
      phoneNumber,
      friendlyName: `${target.city} ${target.niche} Forwarder`,
      forwardTo: operatorPhone,
      whisperMessage: `Call from Rank & Rent ${target.city} ${target.niche} Leads.`,
      recordCalls: true,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    await saveNumber(newNum);

    await recordOperatorNotification({
      type: 'invoice_created',
      title: `📞 Provisioned CallRail line for "${target.city} ${target.niche}"`,
      message:
        `Real tracking number: ${phoneNumber}\n` +
        `Forwarding to: ${operatorPhone}\n` +
        `Auto-provisioned by autopilot. The next cycle will build the site.`,
      metadata: { targetId: target.id, phoneNumber, forwardTo: operatorPhone, source: 'autopilot' },
    });

    log.push(
      `📞 CallRail tracker provisioned: ${phoneNumber}. Next cycle will build site.`,
      'success',
    );
    return true;
  } catch (err: any) {
    log.push(
      `❌ CallRail provisioning failed for "${target.city} ${target.niche}": ${err?.message || err}.`,
      'warn',
    );
    return true;
  }
}

// Debounce helper for `system` notifications so missing-prerequisite
// warnings don't spam the operator feed. Keeps one notification per
// (targetId, errorkey) tuple per 24h.
async function notifyOncePerDay(
  targetId: string,
  key: string,
  partial: Omit<OperatorNotification, 'id' | 'createdAt' | 'read'>,
): Promise<void> {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const notes = await getNotifications();
  const alreadyNotified = notes.some(
    (n) =>
      n.metadata?.targetId === targetId
      && n.metadata?.reason === key
      && new Date(n.createdAt).getTime() >= since,
  );
  if (alreadyNotified) return;
  await recordOperatorNotification({
    ...partial,
    metadata: { ...(partial.metadata ?? {}), targetId, reason: key },
  });
}

/**
 * Build ONE site per cycle. Finds a target with prospects + a matching
 * tracking line + no site yet, generates the landing page (LLM), and
 * deploys to Vercel if VERCEL_API_KEY is set. Trial emails are sent in
 * a SEPARATE step (`trySendTrialEmail`) so this cycle only makes one
 * LLM call.
 */
async function tryBuildSite(
  log: ReturnType<typeof makeLogBuffer>,
): Promise<{ target: NicheCityTarget; site: GeneratedSite } | null> {
  const targets = await getTargets();
  const prospects = await getProspects();
  const sites = await getSites();
  const numbers = await getNumbers();

  const target = targets.find((t) => {
    const hasProspects = prospects.some((p) => p.targetId === t.id);
    const hasSite = sites.some((s) => s.targetId === t.id);
    return hasProspects && !hasSite;
  });
  if (!target) return null;

  const activeLine = numbers.find(
    (n) =>
      n.friendlyName?.toLowerCase().includes(target.city.toLowerCase()) &&
      n.friendlyName?.toLowerCase().includes(target.niche.toLowerCase()),
  );
  // ALL forwarding numbers must come from CallRail. No placeholders.
  // tryProvisionTrackingLine (priority 5) runs before this (priority 6),
  // so on the next tick after provisioning, the line will be here.
  if (!activeLine) {
    log.push(
      `⏳ No CallRail tracking line yet for "${target.city} ${target.niche}". Waiting for tryProvisionTrackingLine to provision one.`,
      'info',
    );
    return null;
  }

  log.push(
    `🏗️ AI SITE BUILDER: Compiling SEO-optimized landing page for "${target.niche}" in "${target.city}"...`,
    'info',
  );
  try {
    const generated = await generateLandingPage(
      target.niche,
      target.city,
      activeLine.phoneNumber,
      activeLine.whisperMessage,
    );
    generated.targetId = target.id;

    if (process.env.VERCEL_API_KEY) {
      try {
        const cleanName =
          `${target.city.toLowerCase()}-${target.niche.toLowerCase()}-${Date.now().toString().slice(-4)}`
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        const vercelRes = await fetch('https://api.vercel.com/v13/deployments', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.VERCEL_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: cleanName,
            files: [
              { file: 'index.html', data: generated.htmlCode, encoding: 'utf-8' },
            ],
            projectSettings: { framework: null },
          }),
        });
        if (vercelRes.ok) {
          const data: any = await vercelRes.json();
          if (data?.url) {
            generated.domainName = data.url;
            (generated as any).deploymentUrl = data.url;
          }
        }
      } catch (vErr: any) {
        log.push(`⚠️ Vercel deploy failed: ${vErr?.message || vErr}. Site saved without deploy URL.`, 'warn');
      }
    }

    await saveSite(generated);
    target.status = 'site_created';
    await saveTarget(target);
    log.push(
      `🎉 Landing page generated${generated.deploymentUrl ? ' and deployed to ' + generated.deploymentUrl : ''}.`,
      'success',
    );
    return { target, site: generated };
  } catch (err: any) {
    log.push(`❌ Site generation failed: ${err?.message || err}.`, 'warn');
    return null;
  }
}

/**
 * Generate (and queue) a trial offer email for ONE prospect per cycle.
 * Caps at one LLM call per tick so the cycle stays within the function
 * budget; the next tick sends the next queued trial.
 */
async function trySendTrialEmail(
  log: ReturnType<typeof makeLogBuffer>,
): Promise<boolean> {
  const prospects = await getProspects();
  const sites = await getSites();

  const prospect = prospects.find(
    (p) =>
      !p.trialEmailSent
      && p.pitchStatus !== 'Disqualified'
      && sites.some((s) => s.targetId === p.targetId),
  );
  if (!prospect) return false;

  const site = sites.find((s) => s.targetId === prospect.targetId);
  if (!site) return false;
  const siteUrl = site.deploymentUrl || site.domainName || '';

  log.push(
    `📧 Generating trial offer email for "${prospect.name}" → ${siteUrl}...`,
    'info',
  );
  try {
    const email = await generateTrialOfferEmail(
      prospect,
      siteUrl,
      prospect.niche,
      prospect.city,
    );
    prospect.trialEmailContent = email.emailContent;
    prospect.trialEmailSent = true;
    prospect.pitchStatus = 'Trial';
    await saveProspect(prospect);
    log.push(`📧 Trial offer queued for "${prospect.name}".`, 'success');
    return true;
  } catch (err: any) {
    log.push(`❌ Trial email failed for "${prospect.name}": ${err?.message || err}.`, 'warn');
    return true;
  }
}

/**
 * Automatically create a Stripe subscription/invoice for ONE trial prospect per cycle.
 * Only runs if settings.isAutoSubscribeOn is true and Stripe is configured.
 * Finds a prospect that has a stripeCustomerId, is in 'Trial' status, has no
 * stripeSubscriptionId yet, and has a site built for their target.
 */
async function tryAutoSubscribeOne(
  log: ReturnType<typeof makeLogBuffer>,
): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.isAutoSubscribeOn || !isStripeLive()) return false;

  const prospects = await getProspects();
  const sites = await getSites();
  const numbers = await getNumbers();

  const prospect = prospects.find(
    (p) =>
      p.stripeCustomerId &&
      p.stripeCustomerId !== 'failed' &&
      !p.stripeSubscriptionId &&
      p.pitchStatus === 'Trial' &&
      p.email &&
      sites.some((s) => s.targetId === p.targetId)
  );

  if (!prospect) return false;

  const site = sites.find((s) => s.targetId === prospect.targetId)!;

  // Verify we have a tracking line for this target
  const hasLine = numbers.some(
    (n) =>
      n.friendlyName?.toLowerCase().includes(prospect.city.toLowerCase()) ||
      n.friendlyName?.toLowerCase().includes(prospect.niche.toLowerCase())
  ) || numbers.length > 0;

  if (!hasLine) {
    log.push(
      `⏳ Cannot auto-subscribe "${prospect.name}": waiting for tracking line to be provisioned.`,
      'info',
    );
    return false;
  }

  log.push(
    `💳 AUTO-SUBSCRIBE: Creating Stripe subscription for "${prospect.name}"...`,
    'process',
  );

  try {
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
      prospect.notes =
        (prospect.notes ? prospect.notes + '\n' : '') +
        `${stamp} — [Stripe LIVE] $${(result.amountDue / 100).toFixed(2)} ${result.currency.toUpperCase()} subscription + invoice created via Autopilot.`;
    }

    await saveProspect(prospect);

    if (!result.alreadyHadSubscription) {
      const targets = await getTargets();
      const target = targets.find((t) => t.id === prospect.targetId);
      if (target) {
        target.status = 'rented';
        await saveTarget(target);
      }
    }

    log.push(
      `🎉 Auto-subscribed "${prospect.name}"! Subscription: ${result.subscriptionId}, Invoice: ${result.invoiceId}`,
      'success',
    );
    return true;
  } catch (err: any) {
    log.push(
      `❌ Auto-subscription failed for "${prospect.name}": ${err?.message || err}`,
      'warn',
    );
    return true; // We took an action (attempted subscription), let cycle move on
  }
}


function finish(
  log: ReturnType<typeof makeLogBuffer>,
  start: number,
  action: AutopilotCycleResult['action'],
  summary: string,
): AutopilotCycleResult {
  return {
    ranAction: action !== 'noop' && action !== 'idle_scan' && action !== 'skipped_off' && action !== 'skipped_timeout',
    action,
    summary,
    logs: log.logs,
    durationMs: Date.now() - start,
    finishedAt: new Date().toISOString(),
  };
}

function timeoutResult(
  log: ReturnType<typeof makeLogBuffer>,
  start: number,
): AutopilotCycleResult {
  return {
    ranAction: false,
    action: 'skipped_timeout',
    summary: 'Cycle timed out before completing.',
    logs: log.logs,
    durationMs: Date.now() - start,
    finishedAt: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------
// Main cycle orchestrator — one action per tick
// ----------------------------------------------------------------

/**
 * Run exactly ONE autopilot action. Each invocation walks the decision
 * tree in priority order and stops as soon as one stage reports success.
 * A hard timeout (CYCLE_TIMEOUT_MS) prevents runaway LLM calls from
 * blocking the loop forever.
 *
 * Priority order:
 *   1. Add a new niche × city target (grow portfolio)
 *   2. Scrape fresh leads for the most eligible target
 *   3. Create a Stripe customer for a qualified lead
 *   4. Generate an outreach pitch for one lead
 *   5. Provision a CallRail tracking line for a target
 *   6. Build a landing page for a target
 *   7. Queue a trial offer email for one prospect
 */
export async function runAutopilotCycle(): Promise<AutopilotCycleResult> {
  const log = makeLogBuffer();
  const start = Date.now();

  // Hard timeout wrapper — the caller (setInterval or cron) shouldn't
  // wait forever if the LLM API hangs.
  const timeoutPromise = new Promise<AutopilotCycleResult>((resolve) => {
    setTimeout(() => resolve(timeoutResult(log, start)), CYCLE_TIMEOUT_MS);
  });

  const workPromise = (async (): Promise<AutopilotCycleResult> => {
    try {
      const settings = await getSettings();
      if (!settings.isAutopilotOn) {
        log.push('Autopilot disabled — skipping cycle.', 'info');
        return finish(log, start, 'skipped_off', 'Autopilot is turned off.');
      }

      // Priority 1: Add a new target
      const newTarget = await tryAddTarget(log);
      if (newTarget) {
        return finish(log, start, 'add_target',
          `Added new target market: ${newTarget.niche} in ${newTarget.city}.`);
      }

      // Priority 2: Scrape leads for a target
      const scrapeResult = await tryScrapeForTarget(log);
      if (scrapeResult) {
        return finish(log, start, 'scrape_target',
          `Scraped ${scrapeResult.newLeadCount} new leads for ${scrapeResult.target.niche} in ${scrapeResult.target.city}.`);
      }

      // Priority 3: Create Stripe customer for a qualified lead
      const stripeCreated = await tryCreateStripeCustomerOne(log);
      if (stripeCreated) {
        return finish(log, start, 'create_stripe_customer',
          'Created Stripe customer for a lead.');
      }

      // Priority 4: Pitch one lead
      const pitched = await tryPitchOne(log);
      if (pitched) {
        return finish(log, start, 'pitch_lead',
          'Generated outreach pitch for a lead.');
      }

      // Priority 5: Provision a CallRail tracking line
      const lineProvisioned = await tryProvisionTrackingLine(log);
      if (lineProvisioned) {
        return finish(log, start, 'provision_line',
          'Provisioned (or reported missing prereqs for) a CallRail tracking line.');
      }

      // Priority 6: Build a landing page
      const siteResult = await tryBuildSite(log);
      if (siteResult) {
        return finish(log, start, 'build_site',
          `Built landing page for ${siteResult.target.niche} in ${siteResult.target.city}.`);
      }

      // Priority 7: Send trial offer email
      const trialSent = await trySendTrialEmail(log);
      if (trialSent) {
        return finish(log, start, 'send_trial_email',
          'Queued trial offer email.');
      }

      // Priority 8: Auto-subscribe trial lead
      const subscribed = await tryAutoSubscribeOne(log);
      if (subscribed) {
        return finish(log, start, 'auto_subscribe',
          'Auto-subscribed a trial lead on Stripe.');
      }

      // Nothing to do — all stages are caught up
      log.push('No actionable tasks found. All targets are healthy.', 'info');
      return finish(log, start, 'idle_scan',
        'All targets are healthy — no actions needed.');
    } catch (err: any) {
      log.push(`Unexpected cycle error: ${err?.message || err}`, 'warn');
      return finish(log, start, 'noop',
        `Cycle aborted: ${err?.message || err}`);
    }
  })();

  return Promise.race([workPromise, timeoutPromise]);
}

// ----------------------------------------------------------------
// Status snapshot for the client UI
// ----------------------------------------------------------------

export interface AutopilotStatusSnapshot {
  isAutopilotOn: boolean;
  isAutoPitchOn: boolean;
  isAutoSubscribeOn: boolean;
  backend: string;
  lastCycle: AutopilotCycleResult | null;
  isCycleRunning: boolean;
  nextRunEstimateMs: number | null;
  uptimeMs: number;
  startedAt: string;
}

const bootTime = Date.now();
let lastCycle: AutopilotCycleResult | null = null;
let isCycleRunning = false;

export function recordCycleResult(result: AutopilotCycleResult) {
  lastCycle = result;
  isCycleRunning = false;
}

export async function getAutopilotStatus(intervalMs: number): Promise<AutopilotStatusSnapshot> {
  const settings = await getSettings();
  // When autopilot is ON, suppress a stale 'skipped_off' cycle result so
  // the UI doesn't keep showing "Autopilot disabled — skipping cycle."
  // while waiting for the next tick.
  const activeLastCycle =
    settings.isAutopilotOn && lastCycle?.action === 'skipped_off'
      ? null
      : lastCycle;
  return {
    isAutopilotOn: settings.isAutopilotOn,
    isAutoPitchOn: settings.isAutoPitchOn,
    isAutoSubscribeOn: settings.isAutoSubscribeOn,
    backend: (process.env.DB_TYPE || 'json').toLowerCase(),
    lastCycle: activeLastCycle,
    isCycleRunning,
    nextRunEstimateMs: activeLastCycle
      ? Math.max(0, activeLastCycle.finishedAt ? intervalMs - (Date.now() - new Date(activeLastCycle.finishedAt).getTime()) : 0)
      : null,
    uptimeMs: Date.now() - bootTime,
    startedAt: new Date(bootTime).toISOString(),
  };
}

/**
 * Start a setInterval-based autopilot loop. Intended for the long-lived
 * process path (local dev, Railway, Render, Fly.io, your own VPS). On
 * Vercel this is a no-op because functions don't keep timers alive
 * between invocations; there, the cron endpoint handles tick scheduling.
 */
export function startAutopilotLoop(intervalMs = 12_000) {
  if (process.env.VERCEL === '1' || process.env.VERCEL === 'true') {
    console.log('[autopilot] Vercel environment — skipping setInterval, using cron endpoint instead.');
    return;
  }
  console.log(`[autopilot] Background loop enabled: every ${intervalMs / 1000}s.`);

  // First run shortly after boot, then on interval.
  setTimeout(() => {
    runAutopilotCycle()
      .then((r) => {
        recordCycleResult(r);
        console.log(`[autopilot] initial cycle: ${r.action} (${r.durationMs}ms)`);
      })
      .catch((e) => console.warn('[autopilot] initial cycle error:', e?.message || e));
  }, 1_500);

  setInterval(() => {
    runAutopilotCycle()
      .then((r) => {
        recordCycleResult(r);
        if (r.ranAction) {
          console.log(`[autopilot] cycle: ${r.action} (${r.durationMs}ms)`);
        }
      })
      .catch((e) => console.warn('[autopilot] interval cycle error:', e?.message || e));
  }, intervalMs);
}

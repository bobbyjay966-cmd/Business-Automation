/**
 * Server-side autopilot decision loop for the Rank & Rent OS.
 *
 * Previously this logic lived in `src/components/AutopilotView.tsx` as a
 * `setInterval` running in the browser. That meant closing the tab
 * stopped the entire pipeline. This module moves the same decision tree
 * to the server, where it can be driven by:
 * - a `setInterval` started in `server.ts` on boot (traditional host /
 * local dev), or
 * - an external cron ping against `POST /api/cron/autopilot` (Vercel /
 * any serverless deploy where you can't keep a process alive).
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
 * - `tryScrapeForTarget` re-scrapes stale targets every 24h and
 * deduplicates against existing prospects so lead flow is
 * continuous, not a single one-shot event.
 * - `tryProvisionTrackingLine` actually POSTs to CallRail when
 * CALLRAIL_API_KEY + OPERATOR_PHONE are set; previously the cycle
 * deadlocked on the "no line" warning.
 * - Each phase (scrape, pitch, provision, build site, trial email,
 * auto-subscribe) is a separate action so a single tick cannot
 * exceed one LLM call + at most two web-API calls (CallRail /
 * Vercel).
 * - `tryAddTarget` now grows the portfolio continuously instead of
 * capping at 8, with a 50-target ceiling to keep the DB well within
 * Upstash's 1MB single-key limit.
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
 * P1 — target with NO prospects yet (initial scrape).
 * P2 — target lastScrapedAt is > SCRAPE_COOLDOWN_MS ago AND fewer
 * than 10 prospects (continuous re-scrape for fresh leads).
 * P3 — target with fewer than 5 prospects (low yield).
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
    const validLeads = rawLeads.filter((l) => l.phone && l.email);
    const existing = prospects.filter((p) => p.targetId === target.id);
    const deduped = validLeads.filter((l) => isNewLead(l, existing));
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
 * Generate a pitch for ONE un-pitched prospect per cycle. Only pitches
 * leads that have BOTH a verified phone AND email. Capping at one LLM
 * call per tick keeps the cycle well within the function budget.
 */
async function tryPitchOne(
  log: ReturnType<typeof makeLogBuffer>,
): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.isAutoPitchOn) return false;

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
 * Provision a real CallRail tracking line for ONE prospect.
 * The tracker will forward calls directly to the prospect's real phone number.
 */
async function tryProvisionTrackingLine(
  log: ReturnType<typeof makeLogBuffer>,
): Promise<boolean> {
  if (!isCallRailEnabled()) {
    log.push(
      '📞 CallRail not configured (CALLRAIL_API_KEY not set). Skipping tracker provisioning.',
      'warn',
    );
    await notifyOncePerDay('__global__', 'callrail_not

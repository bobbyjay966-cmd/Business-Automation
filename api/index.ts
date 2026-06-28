/**
 * Vercel serverless entry point.
 *
 * Vercel invokes this file as the handler for ALL incoming requests
 * (both `/api/*` and the static `/` fallback). It uses the same
 * Express app as the long-lived deployment (server.ts), so behavior
 * is identical — the only difference is process lifecycle:
 *
 *   - Vercel spins up this function on demand, runs it for one
 *     request, and freezes it. The function instance may be reused
 *     for subsequent requests, but timers (`setInterval`) and the
 *     `app.listen()` port are NEVER used here.
 *   - The autopilot is therefore driven by `POST /api/cron/autopilot`,
 *     which is configured in `vercel.json` (Vercel Cron) or by an
 *     external service like cron-job.org hitting the endpoint.
 *   - The persistent DB lives in Upstash Redis (configured via env
 *     vars UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN), or
 *     falls back to the JSON file when the env vars are absent
 *     (useful for preview branches).
 *
 * NOTE: VERCEL=1 is set via `vercel.json` -> `env`, which Vercel
 * applies BEFORE the function code runs. server.ts evaluates
 * `const IS_VERCEL = process.env.VERCEL === '1'...` at module-load
 * time, so this is the only place the flag needs to be set.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildApp } from '../server';

// Build the app once per cold start. Vercel may keep the function
// warm between requests, so subsequent invocations reuse this same
// Express app (and any module-level cache like the Stripe client).
const app = buildApp();

export default function handler(req: VercelRequest, res: VercelResponse) {
  // Express expects Node IncomingMessage/ServerResponse; Vercel's
  // shim is API-compatible for everything we use (req.url, req.method,
  // req.headers, req.body, res.status, res.json, res.send, res.setHeader).
  return (app as any)(req, res);
}

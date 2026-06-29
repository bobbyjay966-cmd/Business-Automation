# Rank & Rent Operations Hub

An automated, AI-driven Rank & Rent pipeline that scrapes local businesses, generates personalized outreach pitches, deploys SEO-optimized landing pages, provisions tracking phone lines, and auto-bills tenants via Stripe — all running **server-side** so the operator can close the browser tab and the pipeline keeps working 24/7.

## Highlights

- **Server-side autopilot** — decision loop runs on the server (not the browser). Closing the tab does **not** stop the pipeline.
- **Three deployment modes** — local dev, long-lived Node host (Render / Railway / Fly.io / VPS), or Vercel serverless.
- **Two database backends** — local JSON file (zero setup) or Upstash Redis (works on Vercel where the file system is read-only).
- **Stripe auto-billing** — issues a $450/mo subscription + invoice when a target has both a deployed site and a tracking line. Stripe emails the customer; a copy is queued to the operator.
- **Stripe reconciliation cron** — backstops missed webhooks so the dashboard never drifts from real Stripe state.
- **CallRail + Vercel Deploy** integration for real phone numbers + live sites.

## Quick start (local dev)

```bash
npm install
cp .env.example .env   # then fill in your API keys
npm run dev            # http://localhost:3000
```

`npm run dev` starts the Express server on port 3000 with the Vite dev middleware. The autopilot loop starts automatically (default 12s tick) and uses the local `data/db.json` file as its database.

## Database choice

The app picks a backend at boot based on env vars:

| DB_TYPE | Triggered when… | Where it writes |
|---------|------------------|------------------|
| `json` (default) | `UPSTASH_REDIS_REST_URL` is unset | `data/db.json` |
| `redis` | `UPSTASH_REDIS_REST_URL` is set (or `DB_TYPE=redis` explicitly) | Upstash Redis via REST API |

To use Redis, create a free Global database at https://upstash.com, then add:

```bash
UPSTASH_REDIS_REST_URL="https://....upstash.io"
UPSTASH_REDIS_REST_TOKEN="AX..."
```

The Redis backend keeps the whole DB under a single key (default `rr:db`) since the data is small (a few KB even after months of operation).

## Autopilot behavior

The autopilot decision loop now runs on the server:

- **On long-lived hosts** (local dev, Render, Railway, Fly.io, your VPS): a `setInterval` started in `server.ts` runs one decision every `AUTOPILOT_INTERVAL_MS` (default 12s).
- **On Vercel**: serverless functions can't keep timers alive between invocations, so the loop is driven by `POST /api/cron/autopilot` instead. Vercel Cron is configured in `vercel.json` (every minute). On the Hobby tier where Vercel Cron is limited, use [cron-job.org](https://cron-job.org) or [Upstash QStash](https://upstash.com/qstash) to ping the endpoint.

A single cycle picks one of these actions based on current DB state:

1. Add a new target market (`Niche × City` pair)
2. Scrape leads for a target that has none, then auto-pitch them
3. Batch-pitch any scraped prospects that still have no pitch
4. Build a landing page for a target (after provisioning a tracking line if needed), then send trial emails
5. Auto-subscribe a tenant via Stripe when a target is ready
6. Route a simulated inbound call (pay-per-lead revenue)
7. Idle scan

Each cycle is hard-capped at `AUTOPILOT_CYCLE_TIMEOUT_MS` (default 50s) so a stuck LLM call can't blow the function budget.

The UI mirrors the server's state via `GET /api/autopilot/status` (polled every 5s) and triggers manual cycles via `POST /api/autopilot/run`.

## Deploying to Railway (recommended, free)

Railway is the **best free host** for this project because it runs a **persistent process** — the `setInterval`-based autopilot loop works natively (no cron needed). You also get persistent volume storage for the JSON database.

> **Requirements:** Railway account (free $5/mo credits). No extra services needed.

### 1. Push the repo to GitHub

### 2. Create the Railway project

1. Go to [railway.com](https://railway.com) → **New Project → Deploy from GitHub repo**
2. Railway auto-detects Node.js. Set the build command to `npm run build` and start command to `npm start`.
3. Add a **Volume** at `/app/data` (1GB is plenty — the JSON DB is ~500KB) so your database persists across restarts.

### 3. Add environment variables

In **Variables**, add:

```
NVIDIA_API_KEY             = nvapi-...
STRIPE_SECRET_KEY          = sk_live_...   (or sk_test_... for testing)
STRIPE_WEBHOOK_SECRET      = whsec_...
APP_URL                    = https://your-app.railway.app
OPERATOR_EMAIL             = halvsiebobbproductions@gmail.com
CALLRAIL_API_KEY           = ...            (optional)
VERCEL_API_KEY             = ...            (optional — for deploying tenant sites)
```

No database config needed — the default JSON file backend (`data/db.json`) works on Railway's persistent volume. No `DB_TYPE`, no Upstash, no cron secret.

### 4. Add Stripe + CallRail webhooks

Same as Vercel — point webhook URLs at `https://your-app.railway.app/api/webhooks/stripe` and `/api/webhooks/callrail`.

## Deploying to Vercel (serverless, requires Pro plan)

Vercel is **serverless** — background timers don't survive between requests. The autopilot must be driven by `POST /api/cron/autopilot` via Vercel Cron (Pro) or an external cron service. The filesystem is read-only, so you need Upstash Redis for the database.

> **Requirements:** Vercel Pro account, Upstash Redis account, external cron service (or Vercel Cron on Pro).

### 1. Push the repo to GitHub

The repo already contains `vercel.json` with the build config, serverless function entry, and cron schedule.

### 2. Create the Vercel project

In the Vercel dashboard:

1. **Add New Project → Import** your repo.
2. Vercel auto-detects the build command (`npm run build`) and output (`dist/`). Don't change them.
3. Click **Deploy** (initial deploy will fail without env vars — that's fine, we set them next).

### 3. Add environment variables

In **Settings → Environment Variables**, add (for Production, Preview, and Development):

```
UPSTASH_REDIS_REST_URL     = https://....upstash.io
UPSTASH_REDIS_REST_TOKEN   = AX...
STRIPE_SECRET_KEY          = sk_live_...   (or sk_test_... for testing)
STRIPE_WEBHOOK_SECRET      = whsec_...
APP_URL                    = https://your-app.vercel.app
OPERATOR_EMAIL             = halvsiebobbproductions@gmail.com
NVIDIA_API_KEY             = nvapi-...
CALLRAIL_API_KEY           = ...            (optional)
VERCEL_API_KEY             = ...            (optional — for deploying tenant sites)
CRON_SECRET                = <random 32+ chars>
```

`DB_TYPE` is auto-selected based on whether the Upstash vars are set, so you can leave it blank.

> **⚠️ Vercel Hobby limitation:** Function max duration is 10s (Pro: 60s). Set `AUTOPILOT_CYCLE_TIMEOUT_MS=9000` to stay under the limit. For the autopilot cron, Hobby allows only daily minimum frequency — use [cron-job.org](https://cron-job.org) (free) to ping `POST /api/cron/autopilot` every minute instead.

### 4. Add a Stripe webhook

In Stripe Dashboard → **Developers → Webhooks → Add endpoint**:

- URL: `https://your-app.vercel.app/api/webhooks/stripe`
- Events: `checkout.session.completed`, `invoice.*`, `customer.subscription.*`, `charge.refunded`

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

### 5. Add a CallRail webhook (optional)

In CallRail → **Settings → Integrations → Webhooks**:

- URL: `https://your-app.vercel.app/api/webhooks/callrail`

### 6. Add a custom domain (optional)

Vercel → **Settings → Domains**. If you use a custom domain, also add it to Firebase Auth's authorized domains (otherwise the Google Sheets panel will fail with `auth/unauthorized-domain`).

### 7. Cron + Vercel Hobby note

Vercel Cron is free on Pro, limited on Hobby. If you're on Hobby, you have two options:

1. **Use Vercel Cron anyway** — Hobby allows 2 cron jobs but enforces a daily-minimum frequency, so set the schedules in `vercel.json` to `0 0 * * *` (daily) and accept one tick per day.
2. **Use a free external cron service** — [cron-job.org](https://cron-job.org) or [Upstash QStash](https://upstash.com/qstash) can hit `POST /api/cron/autopilot` every minute from outside Vercel. The endpoint checks the `x-cron-secret` header against `CRON_SECRET` to prevent abuse.

## Deploying to a long-lived host (Render / Railway / Fly.io / VPS)

The same `npm run build` + `npm start` works everywhere:

```bash
npm install
npm run build      # bundles client + server to dist/
npm start          # node dist/server.cjs on port 3000
```

Set the same env vars as Vercel minus `UPSTASH_*` (the JSON file backend works out of the box). The `setInterval`-based autopilot loop starts automatically on boot.

## Stripe send-invoice setup

`send_invoice` subscriptions require Stripe to actually email the customer. If your account hasn't done this before:

1. Stripe Dashboard → **Settings → Branding** — set a business name, logo, support email.
2. **Settings → Emails → Customer emails** — enable "Successful payments" and "Invoice emails".

If the dashboard says "Stripe did NOT email the invoice", the operator notification feed surfaces a `⚠️ INVOICE EMAIL DISPATCH FAILED` notice with a one-click link to the Stripe dashboard toggle.

## Architecture

```
┌──────────────┐                       ┌──────────────────┐
│  Browser UI  │  poll every 5s        │  Express server  │
│  (React)     │ ←── /api/autopilot/...│  (server.ts)     │
│              │   status / toggle /    │                  │
│  no setIntv! │   run                 │  setInterval     │
└──────────────┘                       │  ↳ autopilot     │
                                       │  ↳ reconcile     │
                                       │  ↳ callrail hook │
                                       └────────┬─────────┘
                                                │
                          ┌─────────────────────┼─────────────────────┐
                          ▼                     ▼                     ▼
                  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
                  │  data/db.json│      │   Upstash    │      │   Stripe     │
                  │  (dev / VPS) │      │   Redis      │      │   API        │
                  └──────────────┘      │  (Vercel)    │      └──────────────┘
                                         └──────────────┘
```

## Environment variables

See `.env.example` for the full list. The most important ones:

| Var | Required for | Notes |
|-----|--------------|-------|
| `NVIDIA_API_KEY` | All AI features | Get free credits at build.nvidia.com |
| `NVIDIA_MODEL` | AI features (optional) | Default: `meta/llama-3.3-70b-instruct` |
| `UPSTASH_REDIS_REST_URL` | Vercel deploys | Free tier at upstash.com |
| `STRIPE_SECRET_KEY` | Live billing | `sk_test_...` or `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification | `whsec_...` from Stripe dashboard |
| `CALLRAIL_API_KEY` | Real phone numbers | callrail.com |
| `VERCEL_API_KEY` | Deploy tenant sites | Optional, for landing page auto-deploy |
| `CRON_SECRET` | Cron auth | Random 32+ char string |
| `OPERATOR_EMAIL` | Notification recipient | Defaults to `halvsiebobbproductions@gmail.com` |

## Scripts

```bash
npm run dev      # local dev with Vite middleware (port 3000)
npm run build    # vite build + esbuild server bundle
npm start        # node dist/server.cjs
npm run clean    # rm -rf dist
npm run lint     # tsc --noEmit
```

## License

Private.

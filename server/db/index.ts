/**
 * Database abstraction layer for the Rank & Rent OS.
 *
 * Selects a backend at boot based on env vars:
 *   - DB_TYPE=redis (default if UPSTASH_REDIS_REST_URL is set) → Upstash Redis over HTTP
 *   - DB_TYPE=json  (default otherwise)                       → local JSON file at data/db.json
 *
 * The Redis backend uses Upstash's REST API (works in serverless, no TCP).
 * The JSON backend is the original behavior — useful for local dev and any
 * traditional Node.js host (Render, Railway, Fly.io, your own VPS).
 *
 * The data is small enough (a few KB of prospects/sites/notifications even
 * after a year of operation) that we keep the whole DB under a single key
 * (`rr:db`). That makes read-modify-write atomic via Upstash's REST pipeline
 * semantics and avoids partial-update races when the cron tick and a webhook
 * delivery happen concurrently.
 */
import fs from 'fs';
import path from 'path';
import {
  NicheCityTarget,
  ScrapedLead,
  TrackingNumber,
  CallLog,
  GeneratedSite,
  OperatorNotification,
} from '../../src/types';

// ---------- Schema ----------

export interface AutopilotSettings {
  isAutopilotOn: boolean;
  isAutoPitchOn: boolean;
  isAutoSubscribeOn: boolean;
  updatedAt: string;
}

export interface DbSchema {
  targets: NicheCityTarget[];
  prospects: ScrapedLead[];
  numbers: TrackingNumber[];
  calls: CallLog[];
  sites: GeneratedSite[];
  notifications: OperatorNotification[];
  // Persistent settings that the client used to keep in localStorage.
  // Now stored on the server so the autopilot continues with the
  // operator's preferences after a browser tab closes.
  settings: AutopilotSettings;
}

const DEFAULT_DB: DbSchema = {
  targets: [],
  prospects: [],
  numbers: [],
  calls: [],
  sites: [],
  notifications: [],
  settings: {
    isAutopilotOn: false,
    isAutoPitchOn: true,
    isAutoSubscribeOn: true,
    updatedAt: new Date(0).toISOString(),
  },
};

// ---------- Backend interface ----------

export interface DbBackend {
  /** Returns the full DB. Returns DEFAULT_DB-shaped data on first run. */
  read(): Promise<DbSchema>;
  /** Atomically replaces the DB. */
  write(data: DbSchema): Promise<void>;
  /** Best-effort identifier for logs. */
  describe(): string;
}

// ---------- JSON backend (dev / traditional host) ----------

const DB_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DB_DIR, 'db.json');

class JsonBackend implements DbBackend {
  describe() {
    return `json:${DB_FILE}`;
  }

  private ensureFile() {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2), 'utf-8');
    }
  }

  async read(): Promise<DbSchema> {
    this.ensureFile();
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<DbSchema>;
      // Backfill any keys that were added after this file was first written.
      return {
        targets: parsed.targets ?? [],
        prospects: parsed.prospects ?? [],
        numbers: parsed.numbers ?? [],
        calls: parsed.calls ?? [],
        sites: parsed.sites ?? [],
        notifications: parsed.notifications ?? [],
        settings: { ...DEFAULT_DB.settings, ...(parsed.settings ?? {}) },
      };
    } catch (err) {
      console.error('[db:json] read failed, using default:', err);
      return { ...DEFAULT_DB, settings: { ...DEFAULT_DB.settings } };
    }
  }

  async write(data: DbSchema): Promise<void> {
    this.ensureFile();
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  }
}

// ---------- Upstash Redis backend (serverless / Vercel) ----------

class UpstashBackend implements DbBackend {
  private readonly url: string;
  private readonly token: string;
  private readonly key: string;

  constructor() {
    this.url = process.env.UPSTASH_REDIS_REST_URL || '';
    this.token = process.env.UPSTASH_REDIS_REST_TOKEN || '';
    this.key = process.env.UPSTASH_DB_KEY || 'rr:db';
    if (!this.url || !this.token) {
      throw new Error(
        'UpstashBackend requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN',
      );
    }
  }

  describe() {
    const host = (() => {
      try {
        return new URL(this.url).host;
      } catch {
        return 'unknown';
      }
    })();
    return `upstash:${host} key=${this.key}`;
  }

  private async exec<T = any>(command: string[]): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      // Upstash's REST API is fast (single-digit ms) but we leave a generous
      // ceiling for cold starts. Vercel functions cap at 10s on Hobby, so we
      // keep the SDK timeout comfortably under that.
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Upstash HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const data: any = await res.json();
    return data.result as T;
  }

  async read(): Promise<DbSchema> {
    const raw = (await this.exec(['GET', this.key])) as string | null;
    if (!raw) {
      // First run on this DB. Seed defaults.
      const seeded = { ...DEFAULT_DB, settings: { ...DEFAULT_DB.settings } };
      await this.write(seeded);
      return seeded;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DbSchema>;
      return {
        targets: parsed.targets ?? [],
        prospects: parsed.prospects ?? [],
        numbers: parsed.numbers ?? [],
        calls: parsed.calls ?? [],
        sites: parsed.sites ?? [],
        notifications: parsed.notifications ?? [],
        settings: { ...DEFAULT_DB.settings, ...(parsed.settings ?? {}) },
      };
    } catch (err) {
      console.error('[db:upstash] parse failed, using default:', err);
      return { ...DEFAULT_DB, settings: { ...DEFAULT_DB.settings } };
    }
  }

  async write(data: DbSchema): Promise<void> {
    const payload = JSON.stringify(data);
    // SET ... EX 0 = no expiration. The DB is small (< 1MB even after
    // months of operation) so a single key is fine.
    await this.exec(['SET', this.key, payload]);
  }
}

// ---------- Backend selection ----------

let _backend: DbBackend | null = null;
let _initialized = false;

export function getBackend(): DbBackend {
  if (_backend) return _backend;
  const explicit = (process.env.DB_TYPE || '').toLowerCase();
  const hasUpstash =
    !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

  const useRedis = explicit === 'redis' || (explicit === '' && hasUpstash);

  if (useRedis) {
    try {
      _backend = new UpstashBackend();
      console.log(`[db] using Upstash Redis (${_backend.describe()})`);
    } catch (err: any) {
      console.error(
        `[db] Upstash init failed (${err.message || err}); falling back to JSON.`,
      );
      _backend = new JsonBackend();
    }
  } else {
    _backend = new JsonBackend();
    console.log(`[db] using local JSON backend (${_backend.describe()})`);
  }
  _initialized = true;
  return _backend;
}

export function isBackendInitialized(): boolean {
  return _initialized;
}

// ---------- High-level helpers ----------
// These are the ONLY entry points used by the rest of the codebase.
// They guarantee a freshly-merged DB on every read, and they wrap the
// read-modify-write in a single pass so the autopilot cron and any
// concurrent webhook can never tear the data.

/**
 * Atomic read-modify-write helper. The user's function gets a freshly-
 * merged copy of the DB; whatever it returns is bubbled back to the
 * caller; the modified DB is then written back in a single SET/POST.
 *
 * Concurrency: mutate() calls are serialised through an in-memory queue
 * so two writers (e.g. the autopilot cycle saving a prospect and the
 * toggle endpoint saving settings) can never interleave their
 * read→modify→write passes and clobber each other. In serverless
 * deployments where multiple function instances may run concurrently
 * this queue only serialises within a single instance; for cross-
 * instance safety you would need a DB-level compare-and-swap (Upstash
 * Lua script) or a distributed lock.
 */
let _mutateQueue: Promise<void> = Promise.resolve();

export async function mutate<T = void>(fn: (db: DbSchema) => T | Promise<T>): Promise<T> {
  // Capture the current tail of the queue so we chain after any in-flight
  // mutate. This turns concurrent mutate() calls into a sequential chain
  // without blocking the event loop.
  let resolve: (value: T) => void;
  let reject: (reason: any) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });

  const prev = _mutateQueue;
  _mutateQueue = _mutateQueue
    .then(async () => {
      const backend = getBackend();
      const current = await backend.read();
      const result = await fn(current);
      await backend.write(current);
      return result;
    })
    .then(
      (result) => { resolve!(result as T); },
      (err) => { reject!(err); },
    );

  // Wait on prev so THIS call doesn't return until its turn completes.
  await prev;
  return promise;
}

export async function getTargets() {
  return (await getBackend().read()).targets;
}
export async function getProspects() {
  return (await getBackend().read()).prospects;
}
export async function getNumbers() {
  return (await getBackend().read()).numbers;
}
export async function getCalls() {
  return (await getBackend().read()).calls;
}
export async function getSites() {
  return (await getBackend().read()).sites;
}
export async function getNotifications() {
  const db = await getBackend().read();
  return [...db.notifications].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}
export async function getSettings(): Promise<AutopilotSettings> {
  return (await getBackend().read()).settings;
}

export async function saveTarget(target: NicheCityTarget) {
  return mutate((db) => {
    const idx = db.targets.findIndex((t) => t.id === target.id);
    if (idx >= 0) db.targets[idx] = target;
    else db.targets.push(target);
    return target;
  });
}

export async function deleteTarget(id: string) {
  return mutate((db) => {
    db.targets = db.targets.filter((t) => t.id !== id);
    db.prospects = db.prospects.filter((p) => p.targetId !== id);
    db.sites = db.sites.filter((s) => s.targetId !== id);
  });
}

export async function saveProspects(prospects: ScrapedLead[]) {
  return mutate((db) => {
    prospects.forEach((p) => {
      const idx = db.prospects.findIndex((e) => e.id === p.id);
      if (idx >= 0) db.prospects[idx] = p;
      else db.prospects.push(p);
    });
    return prospects;
  });
}

export async function saveProspect(prospect: ScrapedLead) {
  return saveProspects([prospect]);
}

export async function deleteProspect(id: string) {
  return mutate((db) => {
    db.prospects = db.prospects.filter((p) => p.id !== id);
  });
}

export async function saveNumber(num: TrackingNumber) {
  return mutate((db) => {
    const idx = db.numbers.findIndex((n) => n.id === num.id);
    if (idx >= 0) db.numbers[idx] = num;
    else db.numbers.push(num);
    return num;
  });
}

export async function deleteNumber(id: string) {
  return mutate((db) => {
    db.numbers = db.numbers.filter((n) => n.id !== id);
  });
}

export async function saveCall(call: CallLog) {
  return mutate((db) => {
    db.calls.unshift(call);
    if (db.calls.length > 500) db.calls = db.calls.slice(0, 500);
    return call;
  });
}

export async function saveSite(site: GeneratedSite) {
  return mutate((db) => {
    const idx = db.sites.findIndex((s) => s.id === site.id);
    if (idx >= 0) db.sites[idx] = site;
    else db.sites.push(site);
    return site;
  });
}

export async function deleteSite(id: string) {
  return mutate((db) => {
    db.sites = db.sites.filter((s) => s.id !== id);
  });
}

export async function saveNotification(notification: OperatorNotification) {
  return mutate((db) => {
    if (!db.notifications) db.notifications = [];
    const idx = db.notifications.findIndex((n) => n.id === notification.id);
    if (idx >= 0) db.notifications[idx] = notification;
    else db.notifications.unshift(notification);
    if (db.notifications.length > 200) {
      db.notifications = db.notifications.slice(0, 200);
    }
    return notification;
  });
}

export async function markNotificationRead(id: string) {
  return mutate((db) => {
    if (!db.notifications) db.notifications = [];
    const n = db.notifications.find((x) => x.id === id);
    if (n) n.read = true;
  });
}

export async function clearNotifications() {
  return mutate((db) => {
    db.notifications = [];
  });
}

export async function saveSettings(patch: Partial<AutopilotSettings>) {
  return mutate((db) => {
    db.settings = {
      ...db.settings,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  });
}

// Diagnostic snapshot for the status endpoint
export async function getDbSnapshot() {
  const db = await getBackend().read();
  return {
    backend: getBackend().describe(),
    counts: {
      targets: db.targets.length,
      prospects: db.prospects.length,
      numbers: db.numbers.length,
      calls: db.calls.length,
      sites: db.sites.length,
      notifications: db.notifications.length,
    },
    settings: db.settings,
  };
}

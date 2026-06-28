var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// server.ts
var server_exports = {};
__export(server_exports, {
  buildApp: () => buildApp
});
module.exports = __toCommonJS(server_exports);
var import_express = __toESM(require("express"), 1);
var import_path2 = __toESM(require("path"), 1);
var import_vite = require("vite");
var import_dotenv2 = __toESM(require("dotenv"), 1);

// server/db/index.ts
var import_fs = __toESM(require("fs"), 1);
var import_path = __toESM(require("path"), 1);
var DEFAULT_DB = {
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
    updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
  }
};
var DB_DIR = import_path.default.join(process.cwd(), "data");
var DB_FILE = import_path.default.join(DB_DIR, "db.json");
var JsonBackend = class {
  describe() {
    return `json:${DB_FILE}`;
  }
  ensureFile() {
    if (!import_fs.default.existsSync(DB_DIR)) {
      import_fs.default.mkdirSync(DB_DIR, { recursive: true });
    }
    if (!import_fs.default.existsSync(DB_FILE)) {
      import_fs.default.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2), "utf-8");
    }
  }
  async read() {
    this.ensureFile();
    try {
      const raw = import_fs.default.readFileSync(DB_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        targets: parsed.targets ?? [],
        prospects: parsed.prospects ?? [],
        numbers: parsed.numbers ?? [],
        calls: parsed.calls ?? [],
        sites: parsed.sites ?? [],
        notifications: parsed.notifications ?? [],
        settings: { ...DEFAULT_DB.settings, ...parsed.settings ?? {} }
      };
    } catch (err) {
      console.error("[db:json] read failed, using default:", err);
      return { ...DEFAULT_DB, settings: { ...DEFAULT_DB.settings } };
    }
  }
  async write(data) {
    this.ensureFile();
    import_fs.default.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf-8");
  }
};
var UpstashBackend = class {
  constructor() {
    this.url = process.env.UPSTASH_REDIS_REST_URL || "";
    this.token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
    this.key = process.env.UPSTASH_DB_KEY || "rr:db";
    if (!this.url || !this.token) {
      throw new Error(
        "UpstashBackend requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN"
      );
    }
  }
  describe() {
    const host = (() => {
      try {
        return new URL(this.url).host;
      } catch {
        return "unknown";
      }
    })();
    return `upstash:${host} key=${this.key}`;
  }
  async exec(command) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(command),
      // Upstash's REST API is fast (single-digit ms) but we leave a generous
      // ceiling for cold starts. Vercel functions cap at 10s on Hobby, so we
      // keep the SDK timeout comfortably under that.
      signal: AbortSignal.timeout(8e3)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upstash HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = await res.json();
    return data.result;
  }
  async read() {
    const raw = await this.exec(["GET", this.key]);
    if (!raw) {
      const seeded = { ...DEFAULT_DB, settings: { ...DEFAULT_DB.settings } };
      await this.write(seeded);
      return seeded;
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        targets: parsed.targets ?? [],
        prospects: parsed.prospects ?? [],
        numbers: parsed.numbers ?? [],
        calls: parsed.calls ?? [],
        sites: parsed.sites ?? [],
        notifications: parsed.notifications ?? [],
        settings: { ...DEFAULT_DB.settings, ...parsed.settings ?? {} }
      };
    } catch (err) {
      console.error("[db:upstash] parse failed, using default:", err);
      return { ...DEFAULT_DB, settings: { ...DEFAULT_DB.settings } };
    }
  }
  async write(data) {
    const payload = JSON.stringify(data);
    await this.exec(["SET", this.key, payload]);
  }
};
var _backend = null;
var _initialized = false;
function getBackend() {
  if (_backend) return _backend;
  const explicit = (process.env.DB_TYPE || "").toLowerCase();
  const hasUpstash = !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;
  const useRedis = explicit === "redis" || explicit === "" && hasUpstash;
  if (useRedis) {
    try {
      _backend = new UpstashBackend();
      console.log(`[db] using Upstash Redis (${_backend.describe()})`);
    } catch (err) {
      console.error(
        `[db] Upstash init failed (${err.message || err}); falling back to JSON.`
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
var _mutateQueue = Promise.resolve();
async function mutate(fn) {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const prev = _mutateQueue;
  _mutateQueue = _mutateQueue.then(async () => {
    const backend = getBackend();
    const current = await backend.read();
    const result = await fn(current);
    await backend.write(current);
    return result;
  }).then(
    (result) => {
      resolve(result);
    },
    (err) => {
      reject(err);
    }
  );
  await prev;
  return promise;
}
async function getTargets() {
  return (await getBackend().read()).targets;
}
async function getProspects() {
  return (await getBackend().read()).prospects;
}
async function getNumbers() {
  return (await getBackend().read()).numbers;
}
async function getCalls() {
  return (await getBackend().read()).calls;
}
async function getSites() {
  return (await getBackend().read()).sites;
}
async function getNotifications() {
  const db = await getBackend().read();
  return [...db.notifications].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}
async function getSettings() {
  return (await getBackend().read()).settings;
}
async function saveTarget(target) {
  return mutate((db) => {
    const idx = db.targets.findIndex((t) => t.id === target.id);
    if (idx >= 0) db.targets[idx] = target;
    else db.targets.push(target);
    return target;
  });
}
async function deleteTarget(id) {
  return mutate((db) => {
    db.targets = db.targets.filter((t) => t.id !== id);
    db.prospects = db.prospects.filter((p) => p.targetId !== id);
    db.sites = db.sites.filter((s) => s.targetId !== id);
  });
}
async function saveProspects(prospects) {
  return mutate((db) => {
    prospects.forEach((p) => {
      const idx = db.prospects.findIndex((e) => e.id === p.id);
      if (idx >= 0) db.prospects[idx] = p;
      else db.prospects.push(p);
    });
    return prospects;
  });
}
async function saveProspect(prospect) {
  return saveProspects([prospect]);
}
async function saveNumber(num) {
  return mutate((db) => {
    const idx = db.numbers.findIndex((n) => n.id === num.id);
    if (idx >= 0) db.numbers[idx] = num;
    else db.numbers.push(num);
    return num;
  });
}
async function deleteNumber(id) {
  return mutate((db) => {
    db.numbers = db.numbers.filter((n) => n.id !== id);
  });
}
async function saveCall(call) {
  return mutate((db) => {
    db.calls.unshift(call);
    if (db.calls.length > 500) db.calls = db.calls.slice(0, 500);
    return call;
  });
}
async function saveSite(site) {
  return mutate((db) => {
    const idx = db.sites.findIndex((s) => s.id === site.id);
    if (idx >= 0) db.sites[idx] = site;
    else db.sites.push(site);
    return site;
  });
}
async function deleteSite(id) {
  return mutate((db) => {
    db.sites = db.sites.filter((s) => s.id !== id);
  });
}
async function saveNotification(notification) {
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
async function markNotificationRead(id) {
  return mutate((db) => {
    if (!db.notifications) db.notifications = [];
    const n = db.notifications.find((x) => x.id === id);
    if (n) n.read = true;
  });
}
async function clearNotifications() {
  return mutate((db) => {
    db.notifications = [];
  });
}
async function saveSettings(patch) {
  return mutate((db) => {
    db.settings = {
      ...db.settings,
      ...patch,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  });
}
async function getDbSnapshot() {
  const db = await getBackend().read();
  return {
    backend: getBackend().describe(),
    counts: {
      targets: db.targets.length,
      prospects: db.prospects.length,
      numbers: db.numbers.length,
      calls: db.calls.length,
      sites: db.sites.length,
      notifications: db.notifications.length
    },
    settings: db.settings
  };
}

// .agent/skills/web-scraper/scripts/scraper-engine.ts
async function fetchRealSearchSnippets(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    console.log(`[Search] Crawling DuckDuckGo HTML for query: "${query}"`);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
      }
    });
    if (!res.ok) {
      throw new Error(`DuckDuckGo responded with status ${res.status}`);
    }
    const html = await res.text();
    const blocks = html.split(/<div class="result results_links results_links_deep/gi);
    const results = [];
    for (let i = 1; i < blocks.length && results.length < 8; i++) {
      const blockHtml = blocks[i];
      if (blockHtml.includes('class="badge--ad"') || blockHtml.includes("badge--ad")) {
        continue;
      }
      const titleLinkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
      const titleLinkMatch = titleLinkRegex.exec(blockHtml);
      if (!titleLinkMatch) continue;
      let rawUrl = titleLinkMatch[1];
      let title = titleLinkMatch[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      let realUrl = "";
      if (rawUrl.includes("uddg=")) {
        const uddgIndex = rawUrl.indexOf("uddg=");
        const rawUddg = rawUrl.substring(uddgIndex + 5);
        const ampIndex = rawUddg.indexOf("&");
        const encodedUrl = ampIndex !== -1 ? rawUddg.substring(0, ampIndex) : rawUddg;
        try {
          realUrl = decodeURIComponent(encodedUrl);
        } catch (e) {
          realUrl = encodedUrl;
        }
      }
      const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;
      const snippetMatch = snippetRegex.exec(blockHtml);
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() : "";
      results.push(`Result: ${title}
URL: ${realUrl || "None"}
Snippet: ${snippet}`);
    }
    if (results.length === 0) {
      console.warn("[Search] No organic search snippets parsed from DuckDuckGo HTML. Using fallback context.");
      return "No web results found. Generate realistic local businesses.";
    }
    return results.join("\n\n");
  } catch (err) {
    console.error("[Search] DuckDuckGo search failed:", err.message || err);
    return "Failed to fetch web results. Generate realistic local businesses.";
  }
}
async function scrapeContactInfoFromUrl(url) {
  try {
    console.log(`[Scraper] Visiting actual website: ${url}`);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
      },
      signal: AbortSignal.timeout(5e3)
      // Timeout after 5 seconds to prevent hanging
    });
    if (!res.ok) return { phone: null, email: null };
    const html = await res.text();
    const text = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, "").replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    const phoneRegex = /(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/i;
    const phoneMatch = phoneRegex.exec(text);
    const phone = phoneMatch ? phoneMatch[0].trim() : null;
    const emailRegex = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/gi;
    let email = null;
    let match;
    while ((match = emailRegex.exec(text)) !== null) {
      const e = match[1];
      if (!e.endsWith(".png") && !e.endsWith(".jpg") && !e.endsWith(".gif") && !e.endsWith(".webp") && !e.endsWith(".svg")) {
        email = e;
        break;
      }
    }
    return { phone, email };
  } catch (err) {
    console.warn(`[Scraper] Failed to crawl website ${url}:`, err.message || err);
    return { phone: null, email: null };
  }
}
function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i) | 0;
  }
  return Math.abs(h);
}
async function parseLeadsFromSearchContext(searchContext, targetId, niche, city) {
  console.log(`[Scraper Fallback] Parsing leads directly from search HTML snippets (LLM bypassed or failed)...`);
  const blocks = searchContext.split("\n\n");
  const leads = [];
  for (const block of blocks) {
    if (!block.trim() || !block.includes("Result: ")) continue;
    const lines = block.split("\n");
    let title = "";
    let website = "";
    let snippet = "";
    for (const line of lines) {
      if (line.startsWith("Result: ")) {
        title = line.substring(8).trim();
      } else if (line.startsWith("URL: ")) {
        website = line.substring(5).trim();
        if (website === "None") website = "";
      } else if (line.startsWith("Snippet: ")) {
        snippet = line.substring(9).trim();
      }
    }
    if (!title) continue;
    const combinedText = `${title} ${snippet}`;
    const phoneRegex = /(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/i;
    const phoneMatch = phoneRegex.exec(combinedText);
    let phone = phoneMatch ? phoneMatch[0] : null;
    if (phone && (phone.includes("555") || phone.includes("123-4567") || phone.includes("123-0099") || /555\d*/.test(phone))) {
      phone = null;
    }
    let name = title;
    const separators = [" | ", " - ", " : ", " \u2022 "];
    for (const sep of separators) {
      if (name.includes(sep)) {
        name = name.split(sep)[0].trim();
        break;
      }
    }
    name = name.replace(/#[0-9]+\s+/g, "").trim();
    const genericTitles = ["home", "contact us", "contact", "about", "about us", "services", "gallery", "pest control"];
    if (genericTitles.includes(name.toLowerCase()) && website) {
      try {
        const domain = new URL(website).hostname.replace("www.", "");
        const domainPart = domain.split(".")[0];
        name = domainPart.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      } catch (e) {
      }
    }
    if (!name || genericTitles.includes(name.toLowerCase())) {
      name = `${city} ${niche} Co.`;
    }
    const address = deterministicAddress(name, city);
    leads.push({
      id: `lead-${targetId}-${leads.length}-${Date.now()}`,
      targetId,
      niche,
      city,
      name,
      website: website || null,
      phone,
      // Nullable
      rating: deterministicRating(name),
      reviewCount: deterministicReviewCount(name),
      address,
      gmbStatus: website ? "Claimed" : "Unclaimed",
      pitchStatus: "Scraped",
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  let unclaimedCount = 0;
  for (let i = 0; i < leads.length; i++) {
    if (!leads[i].website) {
      leads[i].gmbStatus = "Unclaimed";
      unclaimedCount++;
    }
  }
  if (unclaimedCount < 2 && leads.length >= 2) {
    leads[0].website = null;
    leads[0].gmbStatus = "Unclaimed";
    leads[1].gmbStatus = "Unclaimed";
  }
  if (leads.length === 0) {
    console.warn(`[Scraper Fallback] No listings could be parsed. Generating realistic local leads for ${niche} in ${city}.`);
    return [
      {
        id: `lead-${targetId}-fb1-${Date.now()}`,
        targetId,
        niche,
        city,
        name: `Elite ${niche} of ${city}`,
        website: null,
        phone: null,
        rating: 4.1,
        reviewCount: 15,
        address: `100 Main St, ${city}`,
        gmbStatus: "Unclaimed",
        pitchStatus: "Scraped",
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      },
      {
        id: `lead-${targetId}-fb2-${Date.now()}`,
        targetId,
        niche,
        city,
        name: `${city} ${niche} Pros`,
        website: `https://www.example-${niche.toLowerCase().replace(/\s+/g, "")}-${city.toLowerCase()}.com`,
        phone: null,
        rating: 4.7,
        reviewCount: 88,
        address: `450 Maple Ave, ${city}`,
        gmbStatus: "Claimed",
        pitchStatus: "Scraped",
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      },
      {
        id: `lead-${targetId}-fb3-${Date.now()}`,
        targetId,
        niche,
        city,
        name: `${city} ${niche} & Repair Co.`,
        website: null,
        phone: null,
        rating: 3.9,
        reviewCount: 9,
        address: `720 Oak Ln, ${city}`,
        gmbStatus: "Unclaimed",
        pitchStatus: "Scraped",
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      }
    ];
  }
  console.log(`[Scraper Fallback] Crawling websites for parsed listings to verify actual phone/email...`);
  for (const lead of leads) {
    if (lead.website) {
      const contact = await scrapeContactInfoFromUrl(lead.website);
      if (contact.phone) lead.phone = contact.phone;
      if (contact.email) {
        lead.notes = `[Verified Contact Info]
Email: ${contact.email}
Phone: ${lead.phone || "Not found"}`;
      }
    }
  }
  return leads.slice(0, 5);
}
function deterministicRating(name) {
  return parseFloat((4 + strHash(name) % 90 / 100).toFixed(1));
}
function deterministicReviewCount(name) {
  return 5 + strHash(`${name}|rv`) % 200;
}
function deterministicAddress(name, city) {
  const num = 100 + strHash(name) % 900;
  const streetIndex = strHash(`${name}|st`) % STREET_NAMES.length;
  return `${num} ${STREET_NAMES[streetIndex]}, ${city}`;
}
var STREET_NAMES = [
  "Main St",
  "Maple Ave",
  "Oak Ln",
  "Cedar Blvd",
  "Pine St",
  "Elm St",
  "Park Ave",
  "Commerce Dr",
  "Industrial Pkwy",
  "Sunset Blvd"
];

// server/llm.ts
function cleanAndParseJson(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, "");
    cleaned = cleaned.replace(/\n?```$/i, "");
    cleaned = cleaned.trim();
  }
  return JSON.parse(cleaned);
}
var NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
var NVIDIA_MODEL = process.env.NVIDIA_MODEL || "meta/llama-3.3-70b-instruct";
async function callNvidiaLlm(prompt, jsonMode) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY is set but empty \u2014 check your .env file.");
  }
  const targetUrl = `${NVIDIA_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  console.log(
    `[LLM:NVIDIA] Calling ${targetUrl} (model=${NVIDIA_MODEL})`
  );
  const start = Date.now();
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: jsonMode ? [
        { role: "system", content: "You must return a valid json object." },
        { role: "user", content: prompt }
      ] : [{ role: "user", content: prompt }],
      response_format: jsonMode ? { type: "json_object" } : void 0,
      temperature: 0.2,
      top_p: 0.7,
      max_tokens: 2048
    })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      formatLlmError(
        new Error(
          `NVIDIA LLM HTTP ${response.status}: ${errorText.slice(0, 500)}`
        )
      )
    );
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (content) {
    console.log(
      `[LLM:NVIDIA] \u2713 succeeded in ${Date.now() - start}ms (${content.length} chars)`
    );
    return content;
  }
  throw new Error(
    formatLlmError(
      new Error(
        `NVIDIA LLM returned HTTP 200 but no message content: ${JSON.stringify(data).slice(0, 300)}`
      )
    )
  );
}
async function callLlm(prompt, jsonMode = true) {
  if (process.env.NVIDIA_API_KEY) {
    return callNvidiaLlm(prompt, jsonMode);
  }
  const localUrl = process.env.LOCAL_LLM_URL;
  if (!localUrl || localUrl.trim() === "") {
    throw new Error(
      `Neither NVIDIA_API_KEY nor LOCAL_LLM_URL is set. Configure one in .env:
  \u2022 NVIDIA:  NVIDIA_API_KEY=nvapi-... (cloud, recommended)
  \u2022 Ollama:  LOCAL_LLM_URL=http://localhost:11434
  \u2022 LM Studio: LOCAL_LLM_URL=http://localhost:1234/v1
Then set LOCAL_LLM_MODEL to a model you have already pulled/loaded.`
    );
  }
  const model = process.env.LOCAL_LLM_MODEL || "llama3.1";
  const targetUrl = localUrl.endsWith("/chat/completions") ? localUrl : `${localUrl.replace(/\/$/, "")}/chat/completions`;
  console.log(`[LLM] Calling local LLM at: ${targetUrl} (model=${model})`);
  const systemMessages = jsonMode ? [
    { role: "system", content: "You must return a valid json object." },
    { role: "user", content: prompt }
  ] : [{ role: "user", content: prompt }];
  const defaultStrategies = ["json_object", "json_schema", "no_response_format"];
  const rawPin = (process.env.LOCAL_LLM_RESPONSE_FORMAT || "").toLowerCase();
  const pinned = rawPin === "none" ? "no_response_format" : rawPin;
  const strategies = jsonMode ? pinned && defaultStrategies.includes(pinned) ? [pinned] : defaultStrategies : ["plain"];
  for (const attemptDescr of strategies) {
    const useJsonObject = attemptDescr === "json_object";
    const useJsonSchema = attemptDescr === "json_schema";
    const attemptStart = Date.now();
    console.log(`[LLM] Attempt: ${attemptDescr}${useJsonObject || useJsonSchema ? "" : strategies.length > 1 ? " (fallback)" : ""}`);
    let response;
    try {
      response = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: useJsonObject ? systemMessages : jsonMode ? [
            {
              role: "system",
              content: "You must return ONLY a valid JSON object \u2014 no markdown fences, no explanatory text, nothing but the raw JSON. Every response you give must be parseable by JSON.parse()."
            },
            { role: "user", content: prompt }
          ] : [{ role: "user", content: prompt }],
          response_format: useJsonObject ? { type: "json_object" } : useJsonSchema ? {
            type: "json_schema",
            json_schema: {
              name: "response",
              strict: false,
              schema: { type: "object" }
            }
          } : void 0,
          temperature: 0.7
        })
      });
    } catch (err) {
      throw new Error(formatLlmError(err));
    }
    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        console.log(
          `[LLM] \u2713 ${attemptDescr} succeeded in ${Date.now() - attemptStart}ms (${content.length} chars)`
        );
        return content;
      }
      throw new Error(
        formatLlmError(
          new Error(
            `Local LLM returned HTTP 200 but no message content: ${JSON.stringify(data).slice(0, 300)}`
          )
        )
      );
    }
    const isStructuredOutputAttempt = useJsonObject || useJsonSchema;
    const isRecoverableStatus = response.status === 400 || response.status === 422;
    if (isRecoverableStatus && isStructuredOutputAttempt) {
      const errorText2 = await response.text();
      console.log(
        `[LLM] Server rejected ${attemptDescr} (HTTP ${response.status}) \u2014 retrying with next strategy.`
      );
      continue;
    }
    const errorText = await response.text();
    throw new Error(
      formatLlmError(new Error(`Local LLM HTTP ${response.status}: ${errorText.slice(0, 500)}`))
    );
  }
  throw new Error(`Local LLM: exhausted retry attempts.`);
}
async function analyzeMarket(niche, city) {
  const searchContext = await fetchRealSearchSnippets(`${niche} competitors in ${city}`);
  const prompt = `You are performing local SEO research. Here are real-time search engine results for "${niche}" in "${city}":
---
${searchContext}
---

Perform thorough keyword and competitor SEO research for the local niche "${niche}" in the city "${city}" using the real-world search insights above.
Provide realistic metrics based on current general search trends.
You must output a JSON object containing three properties: "keywords", "competitors", and "gmbScore".

Format requirements:
- "keywords": an array of 4 objects. Each object must have:
  * "keyword": string (e.g. "Dallas Roofing Repair")
  * "searchVolume": integer (monthly search volume, e.g. 800)
  * "difficulty": integer (difficulty to rank from 0 to 100)
  * "competition": string ("Low", "Medium", or "High")
  * "cpc": number (Estimated Cost Per Click in USD, e.g. 4.50)
- "competitors": an array of 3 objects representing actual local competitors ranking for this city. Use real domain names found in the search context if possible. Each object must have:
  * "domain": string (domain name, e.g. "roofingprodallas.com")
  * "rank": integer (organic rank from 1 to 10)
  * "estimatedTraffic": integer (estimated monthly traffic)
  * "backlinksCount": integer (estimated backlink count)
- "gmbScore": integer (GMB optimization opportunity score from 0 to 100, where 100 is extreme opportunity and 0 is saturated)

Return ONLY valid JSON that matches the schema above. Do not wrap in conversational markdown text.`;
  const rawResponse = await callLlm(prompt, true);
  return cleanAndParseJson(rawResponse);
}
function cleanPhoneNumber(phone) {
  if (!phone) return null;
  const cleaned = phone.trim();
  if (cleaned.includes("555") || cleaned.includes("123-4567") || cleaned.includes("123-0099") || /555\d*/.test(cleaned)) {
    return null;
  }
  return cleaned;
}
async function scrapeLeads(niche, city, targetId) {
  let searchContext = "";
  try {
    searchContext = await fetchRealSearchSnippets(`${niche} ${city} phone website email`);
    const prompt = `Here are some real-time web search results containing local business listings for "${niche}" in "${city}":
---
${searchContext}
---

Based on these actual search results, extract details for 5 real businesses operating in "${city}".
For each business, provide:
1. "name": string (real business name)
2. "website": string or null (real website URL from search results, or null if they don't seem to have one)
3. "phone": string or null (real phone number if found, or null if none found in the search context)
4. "rating": number (Google rating from 1.0 to 5.0)
5. "reviewCount": integer (review count)
6. "address": string (physical address)
7. "gmbStatus": string ("Unclaimed", "Claimed", or "Unknown")

CRITICAL: Do NOT invent or construct fake phone numbers or emails. If the exact phone number is not present in the provided search results, you MUST set "phone" to null. Never output any phone number containing '555' or mock placeholder data.
Make sure at least 2 entries have "website": null or "gmbStatus": "Unclaimed" to serve as good sales targets.
Return ONLY a valid JSON array of 5 objects matching these fields.`;
    const rawResponse = await callLlm(prompt, true);
    const scraped = cleanAndParseJson(rawResponse);
    const leads = scraped.map((lead, idx) => ({
      id: `lead-${targetId}-${idx}-${Date.now()}`,
      targetId,
      niche,
      city,
      name: lead.name,
      website: lead.website || null,
      phone: cleanPhoneNumber(lead.phone),
      rating: Number(lead.rating) || 0,
      reviewCount: Number(lead.reviewCount) || 0,
      address: lead.address,
      gmbStatus: lead.gmbStatus || "Unknown",
      pitchStatus: "Scraped",
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    }));
    console.log(`[Scraper] Crawling websites for LLM extracted listings to verify actual phone/email...`);
    for (const lead of leads) {
      if (lead.website) {
        const contact = await scrapeContactInfoFromUrl(lead.website);
        if (contact.phone) lead.phone = cleanPhoneNumber(contact.phone);
        if (contact.email) {
          lead.email = contact.email;
          lead.notes = `[Verified Contact Info]
Email: ${contact.email}
Phone: ${lead.phone || "Not found"}`;
        }
      }
    }
    return leads;
  } catch (err) {
    console.error("Error in scrapeLeads, running fallback:", err);
    const fallbackLeads = await parseLeadsFromSearchContext(searchContext, targetId, niche, city);
    return fallbackLeads.map((l) => ({
      ...l,
      phone: cleanPhoneNumber(l.phone)
    }));
  }
}
async function generateOutreachPitch(lead) {
  const prompt = `You are Robert, a successful lead generation / Rank & Rent entrepreneur.
Generate a compelling, non-spammy, highly consultative outreach pitch to a local business owner.
Business Name: "${lead.name}"
Location: "${lead.city}"
Website: ${lead.website ? `"${lead.website}"` : "None (No website!)"}
Google Business Profile: ${lead.gmbStatus} (Rating: ${lead.rating}, Reviews: ${lead.reviewCount})

If they have no website, highlight that you have built a pre-ranked high-performing lead generation site for ${lead.niche} in ${lead.city} and want to offer them a 100% FREE 7-Day trial (or send them a few free leads) to prove the value first.
If they have a website but unclaimed GMB, emphasize how fixing GMB and routing tracking lines will increase calls.

CRITICAL: In the email pitch, you MUST explicitly instruct the recipient to reply to you directly at your active email inbox: 'halvsiebobbproductions@gmail.com'. Use 'halvsiebobbproductions@gmail.com' in the email copy or sign-off so that any replies go to this email address.

You must output a JSON object containing:
- "emailContent": string (compelling email pitch)
- "smsContent": string (short, friendly SMS outreach message)

Return ONLY valid JSON.`;
  const rawResponse = await callLlm(prompt, true);
  return cleanAndParseJson(rawResponse);
}
async function generateTrialOfferEmail(lead, siteUrl, niche, city) {
  const prompt = `You are Robert, a professional lead generation entrepreneur who builds high-ranking local service websites.
You have just built and deployed a beautiful, SEO-optimized website for a local ${niche} business in ${city}.

The live website URL is: ${siteUrl}

You are emailing the business owner at "${lead.name}" to let them know about the website you built for them.

Key points to include in the email:
1. You noticed their business and built a professional, SEO-optimized website specifically for their ${niche} services in ${city}.
2. The website is ALREADY LIVE and ranking \u2014 provide the URL: ${siteUrl}
3. You are giving them a completely FREE one-week trial of your lead generation service.
4. During the trial week, they will receive real customer calls and leads through the website at NO COST.
5. If they don't see results after the trial week, you will take down the website with zero obligation \u2014 no questions asked.
6. If they DO see results and like the service, they should reply to this email so you can discuss a fair monthly fee.
7. Emphasize that you are flexible on pricing and can work with them on the price and anything else they need.
8. Be warm, professional, and non-pushy. Make it clear this is a no-risk opportunity.

CRITICAL: The email MUST instruct the recipient to reply directly to: halvsiebobbproductions@gmail.com
Sign off the email with that email address.

You must output a JSON object containing:
- "subject": string (compelling email subject line)
- "emailContent": string (the full email body)

Return ONLY valid JSON.`;
  const rawResponse = await callLlm(prompt, true);
  return cleanAndParseJson(rawResponse);
}
async function generateLandingPage(niche, city, phone, whisper) {
  const targetId = `site-target-${Date.now()}`;
  const prompt = `You are an elite web designer and Rank & Rent SEO copywriter.
Generate a highly converting, fully responsive local landing page for "${niche}" in "${city}".
The landing page will have a prominent phone number tracking line: "${phone}".
We will route calls through this tracking line.

You must output a JSON object containing:
1. "siteTitle": SEO-optimized title (e.g. "Best ${niche} Services in ${city} | Free Quotes")
2. "metaDescription": SEO description containing phone number
3. "primaryColor": Suggested hex color theme (e.g., "#0284c7")
4. "heroHeadline": SEO-optimized hero headline
5. "heroSubheadline": Conversion-optimized subheadline
6. "services": array of at least 3 strings (services provided)
7. "htmlCode": Complete, beautiful, production-ready HTML code using Tailwind CSS for design. It should contain About Us, Services, Why Choose Us, Free Quote Form, Testimonials, and embed the phone number "${phone}" into call-to-action buttons. The form should submit with a success alert message. Do not include markdown wraps inside this string.

Return ONLY a valid JSON object matching these fields.`;
  const rawResponse = await callLlm(prompt, true);
  const data = cleanAndParseJson(rawResponse);
  return {
    id: `site-${Date.now()}`,
    targetId,
    niche,
    city,
    domainName: `${city.toLowerCase().replace(/\s+/g, "")}${niche.toLowerCase().replace(/\s+/g, "")}.com`,
    siteTitle: data.siteTitle,
    metaDescription: data.metaDescription,
    templateId: "modern-business",
    primaryColor: data.primaryColor || "#2563eb",
    heroHeadline: data.heroHeadline,
    heroSubheadline: data.heroSubheadline,
    services: data.services || [],
    htmlCode: data.htmlCode,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function formatLlmError(err) {
  if (!err) return "An unknown error occurred.";
  const rawMsg = err.message || String(err);
  const lower = rawMsg.toLowerCase();
  const localUrl = process.env.LOCAL_LLM_URL || "http://localhost:11434";
  const model = process.env.LOCAL_LLM_MODEL || "llama3.1";
  if (process.env.NVIDIA_API_KEY && (lower.includes("nvidia") || lower.includes("nvapi"))) {
    const httpMatch2 = rawMsg.match(/HTTP\s+(\d{3})/i);
    if (httpMatch2) {
      const status = httpMatch2[1];
      if (status === "401" || status === "403") {
        return `NVIDIA LLM returned HTTP ${status} (unauthorized).
Check that NVIDIA_API_KEY in your .env is valid and not expired.
Get a fresh key at https://build.nvidia.com.`;
      }
      if (status === "429") {
        return `NVIDIA LLM returned HTTP 429 (rate limited).
You've exceeded your NVIDIA API quota. Wait a few minutes or upgrade your plan.`;
      }
      if (status.startsWith("5")) {
        return `NVIDIA LLM returned HTTP ${status} (server error).
NVIDIA's API may be experiencing an outage. Check status at https://status.nvidia.com.`;
      }
      return `NVIDIA LLM returned HTTP ${status}: ${rawMsg.slice(0, 300)}`;
    }
    if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("failed to fetch") || lower.includes("fetch failed")) {
      return `Could not reach NVIDIA API at ${NVIDIA_BASE_URL}.
Check your internet connection and that the NVIDIA API is not blocked by a firewall.`;
    }
    if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
      return `NVIDIA LLM request timed out. The 70B model may be under heavy load.
Try again in a few seconds, or switch to a local LLM by removing NVIDIA_API_KEY.`;
    }
    return `NVIDIA LLM error: ${rawMsg.slice(0, 500)}`;
  }
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("eai_again") || lower.includes("ehostunreach") || lower.includes("enetunreach") || lower.includes("connection refused") || lower.includes("failed to fetch") || lower.includes("fetch failed") || lower.includes("network request failed") || lower.includes("getaddrinfo")) {
    return `Could not reach the local LLM at ${localUrl}.
Make sure your local LLM server is running:
  \u2022 Ollama:    run \`ollama serve\` (default URL: http://localhost:11434)
  \u2022 LM Studio: enable the local server in the Developer tab (default URL: http://localhost:1234/v1)
Then set LOCAL_LLM_URL in your .env to match.`;
  }
  if (lower.includes("model") && (lower.includes("not found") || lower.includes("does not exist") || lower.includes("unknown model") || lower.includes("no such model")) || lower.includes("404") && lower.includes("model")) {
    return `Local LLM could not find model "${model}".
Pull it first (Ollama: \`ollama pull ${model}\`, LM Studio: download from the Discover tab), or set LOCAL_LLM_MODEL in your .env to a model that is already installed.`;
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted") || lower.includes("abort") || lower.includes("etimedout")) {
    return `Local LLM request timed out. The model may still be loading, or the prompt is too large.
Try a smaller/faster model (e.g. \`ollama pull llama3.2:3b\`), or shorten the prompt.`;
  }
  const httpMatch = rawMsg.match(/HTTP\s+(\d{3})/i);
  if (httpMatch) {
    const status = httpMatch[1];
    if (status === "404") {
      return `Local LLM returned HTTP 404. Check that LOCAL_LLM_URL points to a valid \`/chat/completions\` endpoint and that the model in LOCAL_LLM_MODEL is installed.`;
    }
    if (status === "401" || status === "403") {
      return `Local LLM returned HTTP ${status}. The local server requires authentication \u2014 either disable auth in the local LLM settings, or include the API key in the URL (e.g. \`http://localhost:1234/v1\` with an \`Authorization: Bearer ...\` header).`;
    }
    if (status === "422") {
      return `Local LLM returned HTTP 422 (Unprocessable Entity). This usually means the prompt or the \`response_format: json_object\` flag is not supported by the model. Try a model that supports JSON mode (e.g. llama3.1, qwen2.5, mistral).`;
    }
    if (status.startsWith("5")) {
      return `Local LLM returned HTTP ${status} (server error). The model may have crashed; try a different model, or restart the local LLM server.`;
    }
    return `Local LLM returned HTTP ${status}: ${rawMsg.slice(0, 200)}`;
  }
  if (lower.includes("no message content")) {
    return `Local LLM returned a response with no message content.
This often happens when the model does not support \`response_format: json_object\`. Use a model that supports JSON mode (e.g. llama3.1, qwen2.5, mistral) or a recent Ollama version.`;
  }
  return `Local LLM error: ${rawMsg.slice(0, 500)}`;
}

// server/stripe-billing.ts
var import_stripe = __toESM(require("stripe"), 1);
var import_dotenv = __toESM(require("dotenv"), 1);
import_dotenv.default.config();
var stripe = new import_stripe.default(
  process.env.STRIPE_SECRET_KEY || "sk_test_mock_placeholder_key"
);
var STRIPE_LIVE_CONFIGURED = !!process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes("mock_placeholder") && process.env.STRIPE_SECRET_KEY !== "MY_STRIPE_SECRET_KEY";
var OPERATOR_EMAIL_DEFAULT = "halvsiebobbproductions@gmail.com";
var OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || OPERATOR_EMAIL_DEFAULT;
function isStripeLive() {
  return STRIPE_LIVE_CONFIGURED;
}
function safeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function safeStr(value, fallback) {
  return value && value.trim() !== "" ? value.trim() : fallback;
}
var AUTO_SUBSCRIBE_AMOUNT_CENTS = safeInt(
  process.env.STRIPE_AUTO_SUBSCRIBE_AMOUNT_CENTS,
  45e3
);
var AUTO_SUBSCRIBE_CURRENCY = safeStr(
  process.env.STRIPE_AUTO_SUBSCRIBE_CURRENCY,
  "usd"
);
var AUTO_SUBSCRIBE_DAYS_UNTIL_DUE = safeInt(
  process.env.STRIPE_AUTO_SUBSCRIBE_DAYS_UNTIL_DUE,
  7
);
async function findOrCreateStripeCustomer(prospect) {
  const email = prospect.email && prospect.email.trim() !== "" ? prospect.email.trim() : "";
  if (!email) {
    throw new Error(
      `Cannot create Stripe subscription for "${prospect.name}" \u2014 the prospect has no email on file. Add an email to the CRM record before auto-subscribing.`
    );
  }
  if (prospect.stripeCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(prospect.stripeCustomerId);
      if (existing && !existing.deleted) {
        return existing;
      }
    } catch (e) {
      console.warn(
        `[Stripe] Could not retrieve saved customer ${prospect.stripeCustomerId}, creating a new one.`
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
      city: prospect.city
    }
  });
}
async function createAutoSubscription(prospect, site) {
  if (prospect.stripeSubscriptionId) {
    return {
      mode: "live",
      prospectId: prospect.id,
      siteId: site?.id,
      targetId: prospect.targetId,
      customerId: prospect.stripeCustomerId || "cus_unknown",
      subscriptionId: prospect.stripeSubscriptionId,
      invoiceId: prospect.stripeInvoiceId || "in_unknown",
      invoiceNumber: prospect.stripeInvoiceNumber,
      invoiceUrl: prospect.stripeInvoiceUrl || "",
      invoiceStatus: "already_active",
      amountDue: prospect.subscriptionAmount || AUTO_SUBSCRIBE_AMOUNT_CENTS,
      currency: prospect.subscriptionCurrency || AUTO_SUBSCRIBE_CURRENCY,
      dueDate: prospect.subscriptionNextDueDate || (/* @__PURE__ */ new Date()).toISOString(),
      customerEmail: prospect.email || OPERATOR_EMAIL,
      operatorNotifiedEmail: OPERATOR_EMAIL,
      alreadyHadSubscription: true
    };
  }
  if (!STRIPE_LIVE_CONFIGURED) {
    throw new Error(
      "STRIPE_SECRET_KEY is not configured (or still set to the mock placeholder). Set a real Stripe test/live key in your .env to enable auto-subscription. See https://dashboard.stripe.com/apikeys to create one."
    );
  }
  const customer = await findOrCreateStripeCustomer(prospect);
  const productName = `Lease Subscription \u2014 ${site?.domainName || `${prospect.city} ${prospect.niche} Asset`}`;
  const productDescription = `Recurring monthly lease for the local lead-asset site in ${prospect.city} (${prospect.niche})`;
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    collection_method: "send_invoice",
    days_until_due: AUTO_SUBSCRIBE_DAYS_UNTIL_DUE,
    billing_cycle_anchor: Math.floor(Date.now() / 1e3),
    proration_behavior: "none",
    items: [
      {
        price_data: {
          currency: AUTO_SUBSCRIBE_CURRENCY,
          unit_amount: AUTO_SUBSCRIBE_AMOUNT_CENTS,
          product_data: {
            name: productName,
            description: productDescription
          },
          recurring: {
            interval: "month",
            interval_count: 1
          }
        },
        quantity: 1
      }
    ],
    metadata: {
      prospectId: prospect.id,
      targetId: prospect.targetId,
      siteId: site?.id || "",
      niche: prospect.niche,
      city: prospect.city,
      source: "rank-rent-autopilot"
    },
    expand: ["latest_invoice"]
  });
  let invoiceId = "";
  let invoiceUrl = "";
  let invoiceStatus = "";
  let invoiceNumber;
  let amountDue = AUTO_SUBSCRIBE_AMOUNT_CENTS;
  let dueDate = new Date(
    Date.now() + AUTO_SUBSCRIBE_DAYS_UNTIL_DUE * 864e5
  ).toISOString();
  let sendInvoiceFailed = false;
  let sendInvoiceError;
  const latestInvoice = subscription.latest_invoice;
  if (latestInvoice) {
    const inv = typeof latestInvoice === "string" ? await stripe.invoices.retrieve(latestInvoice) : latestInvoice;
    invoiceId = inv.id || "";
    if (inv.status === "draft") {
      try {
        await stripe.invoices.finalizeInvoice(invoiceId);
        const refreshedPostFinalize = await stripe.invoices.retrieve(invoiceId);
        Object.assign(inv, {
          status: refreshedPostFinalize.status,
          number: refreshedPostFinalize.number,
          hosted_invoice_url: refreshedPostFinalize.hosted_invoice_url,
          invoice_pdf: refreshedPostFinalize.invoice_pdf,
          due_date: refreshedPostFinalize.due_date,
          amount_due: refreshedPostFinalize.amount_due
        });
      } catch (finErr) {
        console.warn(
          `[Stripe] finalizeInvoice(${invoiceId}) failed:`,
          finErr?.message || finErr
        );
        sendInvoiceFailed = true;
        sendInvoiceError = `finalize: ${finErr?.message || finErr}`;
      }
    }
    try {
      if (inv.status === "open") {
        await stripe.invoices.sendInvoice(invoiceId);
      } else if (inv.status !== "paid") {
        sendInvoiceFailed = true;
        if (!sendInvoiceError) {
          sendInvoiceError = `unexpected invoice status "${inv.status}" \u2014 no email dispatched`;
        }
      }
    } catch (sendErr) {
      console.warn(
        `[Stripe] sendInvoice(${invoiceId}) failed:`,
        sendErr?.message || sendErr
      );
      sendInvoiceFailed = true;
      sendInvoiceError = `sendInvoice: ${sendErr?.message || sendErr}`;
    }
    const refreshed = await stripe.invoices.retrieve(invoiceId);
    invoiceUrl = refreshed.hosted_invoice_url || refreshed.invoice_pdf || inv.hosted_invoice_url || inv.invoice_pdf || "";
    invoiceStatus = refreshed.status || inv.status || "";
    invoiceNumber = refreshed.number ?? inv.number ?? void 0;
    amountDue = refreshed.amount_due ?? AUTO_SUBSCRIBE_AMOUNT_CENTS;
    if (refreshed.due_date) {
      dueDate = new Date(refreshed.due_date * 1e3).toISOString();
    }
  }
  return {
    mode: "live",
    prospectId: prospect.id,
    siteId: site?.id,
    targetId: prospect.targetId,
    customerId: customer.id,
    subscriptionId: subscription.id,
    invoiceId,
    invoiceNumber,
    invoiceUrl: invoiceUrl || "",
    invoiceStatus,
    amountDue,
    currency: AUTO_SUBSCRIBE_CURRENCY,
    dueDate,
    customerEmail: customer.email || prospect.email || OPERATOR_EMAIL,
    operatorNotifiedEmail: OPERATOR_EMAIL,
    sendInvoiceFailed,
    sendInvoiceError
  };
}

// server/callrail.ts
var import_crypto = __toESM(require("crypto"), 1);
var BASE_URL = "https://api.callrail.com/v3";
var cachedAccountId = null;
var cachedCompanyId = null;
function isCallRailEnabled() {
  return !!process.env.CALLRAIL_API_KEY;
}
async function callCallRailApi(method, params = {}, httpMethod = "GET") {
  const apiKey = process.env.CALLRAIL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "CallRail API key is not configured. Set CALLRAIL_API_KEY in your .env to enable real CallRail provisioning."
    );
  }
  let url = `${BASE_URL}${method}`;
  const options = {
    method: httpMethod,
    headers: {
      Authorization: `Token token=${apiKey}`,
      "Content-Type": "application/json"
    }
  };
  if (httpMethod === "GET") {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += `?${qs}`;
  } else {
    options.body = JSON.stringify(params);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    let errorDetail = "";
    try {
      const j = await response.json();
      errorDetail = `: ${JSON.stringify(j)}`;
    } catch {
      try {
        errorDetail = `: ${await response.text()}`;
      } catch {
      }
    }
    throw new Error(`CallRail API request failed: ${response.statusText} (${response.status})${errorDetail}`);
  }
  return response.json();
}
async function getCallRailAccountAndCompany() {
  if (cachedAccountId && cachedCompanyId) {
    return { accountId: cachedAccountId, companyId: cachedCompanyId };
  }
  const accountsRes = await callCallRailApi("/a.json", {}, "GET");
  let accounts = [];
  if (Array.isArray(accountsRes)) accounts = accountsRes;
  else if (Array.isArray(accountsRes.accounts)) accounts = accountsRes.accounts;
  else if (accountsRes.data && Array.isArray(accountsRes.data)) accounts = accountsRes.data;
  if (accounts.length === 0) throw new Error("No accounts found in your CallRail profile.");
  const accountId = accounts[0].id;
  const companiesRes = await callCallRailApi(`/a/${accountId}/companies.json`, {}, "GET");
  let companies = [];
  if (Array.isArray(companiesRes)) companies = companiesRes;
  else if (Array.isArray(companiesRes.companies)) companies = companiesRes.companies;
  else if (companiesRes.data && Array.isArray(companiesRes.data)) companies = companiesRes.data;
  if (companies.length === 0) throw new Error("No companies found in your CallRail profile.");
  const companyId = companies[0].id;
  cachedAccountId = String(accountId);
  cachedCompanyId = String(companyId);
  return { accountId: cachedAccountId, companyId: cachedCompanyId };
}
async function provisionCallRailTracker(args) {
  const { accountId, companyId } = await getCallRailAccountAndCompany();
  const cleanForwardTo = args.forwardTo.replace(/[^\d+]/g, "");
  let formattedForwardTo = cleanForwardTo;
  if (cleanForwardTo.length === 10) {
    formattedForwardTo = `+1${cleanForwardTo}`;
  } else if (cleanForwardTo.length === 11 && cleanForwardTo.startsWith("1")) {
    formattedForwardTo = `+${cleanForwardTo}`;
  } else if (!cleanForwardTo.startsWith("+")) {
    formattedForwardTo = `+${cleanForwardTo}`;
  }
  const trackerRes = await callCallRailApi(`/a/${accountId}/trackers.json`, {
    name: args.name,
    company_id: companyId,
    type: "source",
    source: { type: "offline" },
    tracking_number: { area_code: args.areaCode || "214" },
    call_flow: {
      type: "basic",
      recording_enabled: !!args.recordCalls,
      destination_number: formattedForwardTo,
      ...args.whisperMessage ? { whisper_message: args.whisperMessage } : {}
    }
  }, "POST");
  const tracker = trackerRes?.tracker ?? trackerRes;
  const phoneNumber = tracker?.phone_number || tracker?.tracking_phone_number || (Array.isArray(tracker?.tracking_numbers) ? tracker.tracking_numbers[0]?.phone_number || tracker.tracking_numbers[0] : null);
  const trackerId = String(tracker?.id || "");
  if (!phoneNumber) {
    throw new Error("CallRail did not return a tracking number in the response.");
  }
  return { phoneNumber: String(phoneNumber), trackerId };
}
async function registerCallRailWebhook(args) {
  const { accountId, companyId } = await getCallRailAccountAndCompany();
  await callCallRailApi(`/a/${accountId}/integrations.json`, {
    type: "Webhooks",
    company_id: companyId,
    config: { post_call_webhook: [args.url] }
  }, "POST");
}
function verifyCallRailSignature(rawBody, signature, signingKey) {
  const calc = import_crypto.default.createHmac("sha1", signingKey).update(rawBody).digest("base64");
  return calc === signature;
}

// server/autopilot.ts
var AUTO_NICHES = [
  "Roofing",
  "Plumbing",
  "Tree Services",
  "AC Repair",
  "Concrete Contracting",
  "Landscaping",
  "Pest Control",
  "Electrician",
  "Drywall Repair",
  "Appliance Repair"
];
var AUTO_CITIES = [
  "Dallas",
  "Houston",
  "Austin",
  "Denver",
  "Atlanta",
  "Phoenix",
  "Seattle",
  "Miami",
  "Orlando",
  "Tampa",
  "Charlotte",
  "Nashville",
  "Las Vegas",
  "San Diego"
];
var MAX_TARGETS = 50;
var SCRAPE_COOLDOWN_MS = (() => {
  const v = Number(process.env.AUTOPILOT_SCRAPE_COOLDOWN_MS);
  return Number.isFinite(v) && v > 1e3 ? v : 24 * 60 * 60 * 1e3;
})();
var CYCLE_TIMEOUT_MS = (() => {
  const v = Number(process.env.AUTOPILOT_CYCLE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 1e3 ? v : 5e4;
})();
var OPERATOR_EMAIL2 = process.env.OPERATOR_EMAIL || "halvsiebobbproductions@gmail.com";
var DEFAULT_AREA_CODE = "214";
var CITY_AREA_CODES = {
  dallas: "214",
  houston: "713",
  austin: "512",
  denver: "303",
  atlanta: "404",
  phoenix: "602",
  seattle: "206",
  miami: "305",
  orlando: "407",
  tampa: "813",
  charlotte: "704",
  nashville: "615",
  lasvegas: "702",
  sandiego: "619"
};
function areaCodeForCity(city) {
  return CITY_AREA_CODES[city.toLowerCase().replace(/\s+/g, "")] || DEFAULT_AREA_CODE;
}
var newId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
function makeLogBuffer() {
  const logs = [];
  return {
    push(message, type = "info") {
      logs.push({
        id: newId("log"),
        timestamp: (/* @__PURE__ */ new Date()).toLocaleTimeString(),
        message,
        type
      });
      if (logs.length > 100) logs.splice(0, logs.length - 100);
    },
    get logs() {
      return logs;
    }
  };
}
async function recordOperatorNotification(partial) {
  const note = {
    ...partial,
    id: newId("notif"),
    read: false,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  try {
    await saveNotification(note);
  } catch (err) {
    console.error("[autopilot] failed to save operator notification:", err);
  }
  return note;
}
function normalizeStr(s) {
  return (s ?? "").toString().toLowerCase().replace(/\s+/g, " ").trim();
}
function digitsOnly(s) {
  return (s ?? "").toString().replace(/[^\d]/g, "");
}
function isNewLead(lead, existing) {
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
async function tryAddTarget(log) {
  const targets = await getTargets();
  if (targets.length >= MAX_TARGETS) return null;
  if (targets.length > 0 && Math.random() > 0.2) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const niche = AUTO_NICHES[Math.floor(Math.random() * AUTO_NICHES.length)];
    const city = AUTO_CITIES[Math.floor(Math.random() * AUTO_CITIES.length)];
    const exists = targets.some(
      (t) => t.niche.toLowerCase() === niche.toLowerCase() && t.city.toLowerCase() === city.toLowerCase()
    );
    if (exists) continue;
    log.push(
      `\u{1F50D} AUTOPILOT TARGET INITIATED: Locating keyword demand for "${niche}" in "${city}"...`,
      "info"
    );
    try {
      const analysis = await analyzeMarket(niche, city);
      const newTarget = {
        id: `target-${Date.now()}`,
        niche,
        city,
        status: "researching",
        monthlyVolume: analysis.keywords.reduce(
          (acc, k) => acc + (k.searchVolume || 0),
          0
        ),
        avgDifficulty: Math.round(
          analysis.keywords.reduce(
            (acc, k) => acc + (k.difficulty || 0),
            0
          ) / (analysis.keywords.length || 1)
        ),
        keywords: analysis.keywords,
        competitors: analysis.competitors,
        gmbScore: analysis.gmbScore || 50,
        lastScrapedAt: void 0,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await saveTarget(newTarget);
      log.push(
        `\u2728 Target SEO Market discovered! Niche: "${niche}", City: "${city}". Portfolio: ${targets.length + 1}/${MAX_TARGETS}.`,
        "success"
      );
      return newTarget;
    } catch (err) {
      log.push(
        `\u274C Target analysis failed for "${niche}/${city}": ${err?.message || err}.`,
        "warn"
      );
    }
  }
  log.push("\u{1F50D} Demands are balanced. Proceeding to lead audits...", "info");
  return null;
}
async function tryScrapeForTarget(log) {
  const targets = await getTargets();
  if (targets.length === 0) return null;
  const prospects = await getProspects();
  const now = Date.now();
  const candidates = [];
  const initial = targets.find(
    (t) => !prospects.some((p) => p.targetId === t.id)
  );
  if (initial) candidates.push({ priority: 1, target: initial });
  for (const t of targets) {
    const targetProspects = prospects.filter((p) => p.targetId === t.id);
    const targetProspectCount = targetProspects.length;
    const isStale = !t.lastScrapedAt || now - new Date(t.lastScrapedAt).getTime() > SCRAPE_COOLDOWN_MS;
    if (isStale && targetProspectCount < 10) {
      candidates.push({ priority: 2, target: t });
    }
  }
  for (const t of targets) {
    const targetProspectCount = prospects.filter((p) => p.targetId === t.id).length;
    if (targetProspectCount < 5 && targetProspectCount > 0) {
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
    `\u{1F575}\uFE0F\u200D\u2642\uFE0F LEAD PROSPECTOR (P${topPriority}): Scraping "${target.niche} - ${target.city}"...`,
    "info"
  );
  try {
    const rawLeads = await scrapeLeads(target.niche, target.city, target.id);
    const existing = prospects.filter((p) => p.targetId === target.id);
    const deduped = rawLeads.filter((l) => isNewLead(l, existing));
    if (deduped.length > 0) {
      await saveProspects(deduped);
    }
    target.lastScrapedAt = (/* @__PURE__ */ new Date()).toISOString();
    target.status = "active_leads";
    await saveTarget(target);
    log.push(
      `\u2705 Scraped ${deduped.length} fresh leads (${rawLeads.length - deduped.length} duplicates filtered) for "${target.niche}/${target.city}".`,
      deduped.length > 0 ? "success" : "info"
    );
    return { target, newLeadCount: deduped.length };
  } catch (err) {
    log.push(`\u274C Scrape failed for "${target.niche}/${target.city}": ${err?.message || err}.`, "warn");
    target.lastScrapedAt = (/* @__PURE__ */ new Date()).toISOString();
    await saveTarget(target);
    return null;
  }
}
async function tryCreateStripeCustomerOne(log) {
  if (!isStripeLive()) return false;
  const prospects = await getProspects();
  const lead = prospects.find(
    (p) => p.phone && p.email && !p.stripeCustomerId && p.pitchStatus === "Scraped"
  );
  if (!lead) return false;
  log.push(
    `\u{1F4B3} Creating Stripe customer for "${lead.name}" (${lead.email})...`,
    "process"
  );
  try {
    const customer = await findOrCreateStripeCustomer(lead);
    lead.stripeCustomerId = customer.id;
    await saveProspect(lead);
    log.push(
      `\u2705 Stripe customer ${customer.id} created for "${lead.name}".`,
      "success"
    );
    return true;
  } catch (err) {
    const errMsg = err?.message || String(err);
    const isClientError = errMsg.includes("HTTP 400") || errMsg.includes("HTTP 402") || errMsg.includes("HTTP 404") || errMsg.includes("HTTP 422");
    if (isClientError) {
      log.push(
        `\u274C Stripe customer creation failed for "${lead.name}" (client error): ${errMsg}. Marking as failed to skip.`,
        "warn"
      );
      lead.stripeCustomerId = "failed";
    } else {
      log.push(
        `\u26A0\uFE0F Stripe customer creation failed for "${lead.name}" (transient): ${errMsg}. Will retry next cycle.`,
        "warn"
      );
    }
    await saveProspect(lead);
    return true;
  }
}
async function tryPitchOne(log) {
  const prospects = await getProspects();
  const target = prospects.find(
    (p) => p.pitchStatus === "Scraped" && !p.pitchEmailContent && p.phone && p.email
  );
  if (!target) return false;
  log.push(
    `\u{1F4DD} AI COPYWRITER: Drafting value proposition for "${target.name}" in "${target.city}"...`,
    "info"
  );
  try {
    const pitch = await generateOutreachPitch(target);
    target.pitchEmailContent = pitch.emailContent;
    target.pitchSmsContent = pitch.smsContent;
    target.pitchStatus = "Pitched";
    await saveProspect(target);
    log.push(`\u2709\uFE0F Personal Cold Outreach drafted for "${target.name}".`, "success");
    return true;
  } catch (err) {
    log.push(`\u274C Pitch failed for "${target.name}": ${err?.message || err}.`, "warn");
    return true;
  }
}
async function tryProvisionTrackingLine(log) {
  if (!isCallRailEnabled()) return false;
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
    (n) => n.friendlyName?.toLowerCase().includes(target.city.toLowerCase()) && n.friendlyName?.toLowerCase().includes(target.niche.toLowerCase())
  );
  if (hasLine) return false;
  const operatorPhone = process.env.OPERATOR_PHONE;
  if (!operatorPhone) {
    log.push(
      `\u{1F6AB} Cannot provision line for "${target.city} ${target.niche}": OPERATOR_PHONE not set in .env.`,
      "warn"
    );
    await notifyOncePerDay(target.id, "OPERATOR_PHONE_not_set", {
      type: "system",
      title: `\u{1F6AB} Cannot provision line for "${target.city} ${target.niche}"`,
      message: `OPERATOR_PHONE is not set in .env. CallRail needs a destination number (E.164 format like +12145551234) to forward calls to. Without it, the autopilot cannot build sites for this target. Add OPERATOR_PHONE to .env (your cell phone) to unblock site building and revenue.`,
      metadata: { targetId: target.id, reason: "OPERATOR_PHONE_not_set" }
    });
    return true;
  }
  log.push(
    `\u{1F4DE} Provisioning real CallRail line for "${target.city} ${target.niche}" \u2192 ${operatorPhone}...`,
    "process"
  );
  try {
    const { phoneNumber } = await provisionCallRailTracker({
      name: `${target.city} ${target.niche} Forwarder`,
      areaCode: areaCodeForCity(target.city),
      forwardTo: operatorPhone,
      whisperMessage: `Call from Rank & Rent ${target.city} ${target.niche} Leads.`,
      recordCalls: true
    });
    const newNum = {
      id: `num-${Date.now()}`,
      targetId: target.id,
      phoneNumber,
      friendlyName: `${target.city} ${target.niche} Forwarder`,
      forwardTo: operatorPhone,
      whisperMessage: `Call from Rank & Rent ${target.city} ${target.niche} Leads.`,
      recordCalls: true,
      isActive: true,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await saveNumber(newNum);
    await recordOperatorNotification({
      type: "invoice_created",
      title: `\u{1F4DE} Provisioned CallRail line for "${target.city} ${target.niche}"`,
      message: `Real tracking number: ${phoneNumber}
Forwarding to: ${operatorPhone}
Auto-provisioned by autopilot. The next cycle will build the site.`,
      metadata: { targetId: target.id, phoneNumber, forwardTo: operatorPhone, source: "autopilot" }
    });
    log.push(
      `\u{1F4DE} CallRail tracker provisioned: ${phoneNumber}. Next cycle will build site.`,
      "success"
    );
    return true;
  } catch (err) {
    log.push(
      `\u274C CallRail provisioning failed for "${target.city} ${target.niche}": ${err?.message || err}.`,
      "warn"
    );
    return true;
  }
}
async function notifyOncePerDay(targetId, key, partial) {
  const since = Date.now() - 24 * 60 * 60 * 1e3;
  const notes = await getNotifications();
  const alreadyNotified = notes.some(
    (n) => n.metadata?.targetId === targetId && n.metadata?.reason === key && new Date(n.createdAt).getTime() >= since
  );
  if (alreadyNotified) return;
  await recordOperatorNotification({
    ...partial,
    metadata: { ...partial.metadata ?? {}, targetId, reason: key }
  });
}
async function tryBuildSite(log) {
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
    (n) => n.friendlyName?.toLowerCase().includes(target.city.toLowerCase()) && n.friendlyName?.toLowerCase().includes(target.niche.toLowerCase())
  );
  if (!activeLine) return null;
  log.push(
    `\u{1F3D7}\uFE0F AI SITE BUILDER: Compiling SEO-optimized landing page for "${target.niche}" in "${target.city}"...`,
    "info"
  );
  try {
    const generated = await generateLandingPage(
      target.niche,
      target.city,
      activeLine.phoneNumber,
      activeLine.whisperMessage
    );
    generated.targetId = target.id;
    if (process.env.VERCEL_API_KEY) {
      try {
        const cleanName = `${target.city.toLowerCase()}-${target.niche.toLowerCase()}-${Date.now().toString().slice(-4)}`.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
        const vercelRes = await fetch("https://api.vercel.com/v13/deployments", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.VERCEL_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name: cleanName,
            files: [
              { file: "index.html", data: generated.htmlCode, encoding: "utf-8" }
            ],
            projectSettings: { framework: null }
          })
        });
        if (vercelRes.ok) {
          const data = await vercelRes.json();
          if (data?.url) {
            generated.domainName = data.url;
            generated.deploymentUrl = data.url;
          }
        }
      } catch (vErr) {
        log.push(`\u26A0\uFE0F Vercel deploy failed: ${vErr?.message || vErr}. Site saved without deploy URL.`, "warn");
      }
    }
    await saveSite(generated);
    target.status = "site_created";
    await saveTarget(target);
    log.push(
      `\u{1F389} Landing page generated${generated.deploymentUrl ? " and deployed to " + generated.deploymentUrl : ""}.`,
      "success"
    );
    return { target, site: generated };
  } catch (err) {
    log.push(`\u274C Site generation failed: ${err?.message || err}.`, "warn");
    return null;
  }
}
async function trySendTrialEmail(log) {
  const prospects = await getProspects();
  const sites = await getSites();
  const prospect = prospects.find(
    (p) => !p.trialEmailSent && p.pitchStatus !== "Disqualified" && sites.some((s) => s.targetId === p.targetId)
  );
  if (!prospect) return false;
  const site = sites.find((s) => s.targetId === prospect.targetId);
  if (!site) return false;
  const siteUrl = site.deploymentUrl || site.domainName || "";
  log.push(
    `\u{1F4E7} Generating trial offer email for "${prospect.name}" \u2192 ${siteUrl}...`,
    "info"
  );
  try {
    const email = await generateTrialOfferEmail(
      prospect,
      siteUrl,
      prospect.niche,
      prospect.city
    );
    prospect.trialEmailContent = email.emailContent;
    prospect.trialEmailSent = true;
    prospect.pitchStatus = "Trial";
    await saveProspect(prospect);
    log.push(`\u{1F4E7} Trial offer queued for "${prospect.name}".`, "success");
    return true;
  } catch (err) {
    log.push(`\u274C Trial email failed for "${prospect.name}": ${err?.message || err}.`, "warn");
    return true;
  }
}
async function tryAutoSubscribe(log) {
  if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.includes("mock")) {
    return false;
  }
  const targets = await getTargets();
  const prospects = await getProspects();
  const sites = await getSites();
  const numbers = await getNumbers();
  const siteByTarget = {};
  for (const s of sites) siteByTarget[s.targetId] = s;
  const numbersMatching = (t) => {
    const c = t.city.toLowerCase();
    const n = t.niche.toLowerCase();
    return numbers.filter((num) => {
      const fn = num.friendlyName?.toLowerCase() || "";
      return fn.includes(c) || fn.includes(n);
    });
  };
  const targetReady = targets.find(
    (t) => !!siteByTarget[t.id] && numbersMatching(t).length > 0
  );
  if (!targetReady) return false;
  const billable = prospects.find(
    (p) => p.targetId === targetReady.id && (p.pitchStatus === "Pitched" || p.pitchStatus === "Trial") && p.email && p.email.trim() !== "" && !p.stripeSubscriptionId
  );
  if (!billable) return false;
  const liveSite = siteByTarget[targetReady.id];
  log.push(
    `\u{1F4B3} STRIPE AUTO-SUB: "${billable.name}" is ready to lease "${liveSite?.domainName || targetReady.city + " " + targetReady.niche}". Creating subscription + invoice...`,
    "income"
  );
  try {
    const result = await createAutoSubscription(billable, liveSite || null);
    billable.stripeCustomerId = result.customerId;
    billable.stripeSubscriptionId = result.subscriptionId;
    billable.stripeInvoiceId = result.invoiceId;
    billable.stripeInvoiceUrl = result.invoiceUrl;
    billable.stripeInvoiceNumber = result.invoiceNumber;
    billable.subscriptionAmount = result.amountDue;
    billable.subscriptionCurrency = result.currency;
    billable.subscriptionNextDueDate = result.dueDate;
    billable.subscriptionStartDate = (/* @__PURE__ */ new Date()).toISOString();
    billable.subscriptionMode = result.mode;
    billable.stripeSubscriptionStatus = "active";
    if (!result.alreadyHadSubscription) {
      billable.pitchStatus = "Rented";
      const stamp = (/* @__PURE__ */ new Date()).toLocaleString();
      billable.notes = (billable.notes ? billable.notes + "\n" : "") + `${stamp} \u2014 [Stripe LIVE] $${(result.amountDue / 100).toFixed(2)} ${result.currency.toUpperCase()} subscription + invoice created.`;
    }
    await saveProspect(billable);
    if (!result.alreadyHadSubscription) {
      targetReady.status = "rented";
      await saveTarget(targetReady);
    }
    log.push(
      `\u2705 Stripe LIVE: Subscription ${result.subscriptionId} activated for "${billable.name}". Invoice ${result.invoiceId} emailed.`,
      "income"
    );
    log.push(
      `\u{1F4C8} MRR+$${(result.amountDue / 100).toFixed(2)}! "${billable.name}" is now an active RENTED tenant.`,
      "income"
    );
    return true;
  } catch (err) {
    log.push(
      `\u274C Auto-subscribe failed for "${billable.name}": ${err?.message || err}.`,
      "warn"
    );
    return true;
  }
}
async function runAutopilotCycle() {
  const start = Date.now();
  const log = makeLogBuffer();
  isCycleRunning = true;
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    log.push("\u23F1\uFE0F Cycle timeout reached \u2014 short-circuiting.", "warn");
  }, CYCLE_TIMEOUT_MS);
  try {
    const settings = await getSettings();
    if (!settings.isAutopilotOn) {
      log.push('\u{1F6D1} Autopilot is OFF. Toggle "Start AI Autopilot" in the UI to begin.', "info");
      return {
        ranAction: false,
        action: "skipped_off",
        summary: "Autopilot disabled \u2014 skipping cycle.",
        logs: log.logs,
        durationMs: Date.now() - start,
        finishedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    if (timedOut) return timeoutResult(log, start);
    log.push("\u26A1 Starting Autopilot pipeline analysis...", "process");
    const newTarget = await tryAddTarget(log);
    if (newTarget) {
      return finish(log, start, "add_target", `Added ${newTarget.niche}/${newTarget.city}.`);
    }
    if (timedOut) return timeoutResult(log, start);
    const scraped = await tryScrapeForTarget(log);
    if (scraped) {
      return finish(
        log,
        start,
        "scrape_target",
        `Scraped ${scraped.newLeadCount} fresh leads for ${scraped.target.niche}/${scraped.target.city}.`
      );
    }
    if (timedOut) return timeoutResult(log, start);
    if (await tryCreateStripeCustomerOne(log)) {
      return finish(log, start, "create_stripe_customer", "Created Stripe customer for one verified lead.");
    }
    if (timedOut) return timeoutResult(log, start);
    if (await tryPitchOne(log)) {
      return finish(log, start, "pitch_lead", "Pitched one prospect.");
    }
    if (timedOut) return timeoutResult(log, start);
    if (await tryProvisionTrackingLine(log)) {
      return finish(log, start, "provision_line", "CallRail line provisioning step ran.");
    }
    if (timedOut) return timeoutResult(log, start);
    const built = await tryBuildSite(log);
    if (built) {
      return finish(
        log,
        start,
        "build_site",
        `Built site ${built.site.domainName} for ${built.target.niche}/${built.target.city}.`
      );
    }
    if (timedOut) return timeoutResult(log, start);
    if (await trySendTrialEmail(log)) {
      return finish(log, start, "send_trial_email", "Sent one trial email.");
    }
    if (timedOut) return timeoutResult(log, start);
    if (settings.isAutoSubscribeOn && await tryAutoSubscribe(log)) {
      return finish(log, start, "auto_subscribe", "Issued a Stripe auto-subscription.");
    }
    if (timedOut) return timeoutResult(log, start);
    log.push("\u{1F9D8} Portfolio audit complete. No actionable targets this tick.", "info");
    return finish(log, start, "idle_scan", "No action \u2014 idle scan.");
  } catch (err) {
    log.push(`\u274C Autopilot cycle error: ${err?.message || err}.`, "warn");
    return {
      ranAction: false,
      action: "noop",
      summary: `Cycle error: ${err?.message || err}`,
      logs: log.logs,
      durationMs: Date.now() - start,
      finishedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  } finally {
    clearTimeout(timeoutHandle);
    isCycleRunning = false;
  }
}
function finish(log, start, action, summary) {
  return {
    ranAction: action !== "noop" && action !== "idle_scan" && action !== "skipped_off" && action !== "skipped_timeout",
    action,
    summary,
    logs: log.logs,
    durationMs: Date.now() - start,
    finishedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function timeoutResult(log, start) {
  return {
    ranAction: false,
    action: "skipped_timeout",
    summary: "Cycle timed out before completing.",
    logs: log.logs,
    durationMs: Date.now() - start,
    finishedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
var bootTime = Date.now();
var lastCycle = null;
var isCycleRunning = false;
function recordCycleResult(result) {
  lastCycle = result;
  isCycleRunning = false;
}
async function getAutopilotStatus(intervalMs) {
  const settings = await getSettings();
  const activeLastCycle = settings.isAutopilotOn && lastCycle?.action === "skipped_off" ? null : lastCycle;
  return {
    isAutopilotOn: settings.isAutopilotOn,
    isAutoPitchOn: settings.isAutoPitchOn,
    isAutoSubscribeOn: settings.isAutoSubscribeOn,
    backend: (process.env.DB_TYPE || "json").toLowerCase(),
    lastCycle: activeLastCycle,
    isCycleRunning,
    nextRunEstimateMs: activeLastCycle ? Math.max(0, activeLastCycle.finishedAt ? intervalMs - (Date.now() - new Date(activeLastCycle.finishedAt).getTime()) : 0) : null,
    uptimeMs: Date.now() - bootTime,
    startedAt: new Date(bootTime).toISOString()
  };
}
function startAutopilotLoop(intervalMs = 12e3) {
  if (process.env.VERCEL === "1" || process.env.VERCEL === "true") {
    console.log("[autopilot] Vercel environment \u2014 skipping setInterval, using cron endpoint instead.");
    return;
  }
  console.log(`[autopilot] Background loop enabled: every ${intervalMs / 1e3}s.`);
  setTimeout(() => {
    runAutopilotCycle().then((r) => {
      recordCycleResult(r);
      console.log(`[autopilot] initial cycle: ${r.action} (${r.durationMs}ms)`);
    }).catch((e) => console.warn("[autopilot] initial cycle error:", e?.message || e));
  }, 1500);
  setInterval(() => {
    runAutopilotCycle().then((r) => {
      recordCycleResult(r);
      if (r.ranAction) {
        console.log(`[autopilot] cycle: ${r.action} (${r.durationMs}ms)`);
      }
    }).catch((e) => console.warn("[autopilot] interval cycle error:", e?.message || e));
  }, intervalMs);
}

// server/stripe-webhooks.ts
async function hasRecentNotification(prospectId, type, windowMs) {
  const cutoff = Date.now() - windowMs;
  const notes = await getNotifications();
  return notes.some(
    (n) => n.metadata?.prospectId === prospectId && n.type === type && new Date(n.createdAt).getTime() >= cutoff
  );
}
function lookupProspectIdFromStripeEvent(stripeObj) {
  if (!stripeObj) return void 0;
  const candidates = [
    stripeObj?.metadata?.prospectId,
    stripeObj?.customer?.metadata?.prospectId,
    stripeObj?.subscription_details?.metadata?.prospectId,
    stripeObj?.lines?.data?.[0]?.metadata?.prospectId,
    stripeObj?.parent?.subscription_details?.metadata?.prospectId,
    stripeObj?.parent?.metadata?.prospectId,
    stripeObj?.payment?.metadata?.prospectId
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c;
  }
  return void 0;
}
function loadProspectById(prospectId) {
  if (!prospectId) return Promise.resolve(void 0);
  return getProspects().then((p) => p.find((x) => x.id === prospectId));
}
function findProspectByStripeIdsFallback(event) {
  const obj = event?.data?.object;
  if (!obj) return Promise.resolve(void 0);
  const evType = event?.type || "";
  const customerId = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
  const rawSub = obj.subscription;
  const subscriptionId = typeof rawSub === "string" ? rawSub : rawSub?.id ?? (evType.startsWith("customer.subscription.") ? obj.id : void 0);
  const invoiceId = evType.startsWith("invoice.") ? obj.id : void 0;
  return getProspects().then((all) => {
    if (customerId && subscriptionId) {
      const m = all.find(
        (p) => p.stripeCustomerId === customerId && p.stripeSubscriptionId === subscriptionId
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
    return void 0;
  });
}
async function resolveProspectForEvent(event) {
  const obj = event?.data?.object;
  const fromMeta = await loadProspectById(lookupProspectIdFromStripeEvent(obj));
  if (fromMeta) return fromMeta;
  return findProspectByStripeIdsFallback(event);
}
async function handleStripeEvent(event) {
  console.log(`[Stripe Webhook] ${event.type} (id=${event.id || "unknown"})`);
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const prospect = await resolveProspectForEvent(event);
      if (prospect) {
        prospect.pitchStatus = "Rented";
        const stamp = (/* @__PURE__ */ new Date()).toLocaleString();
        prospect.notes = (prospect.notes ? prospect.notes + "\n" : "") + `${stamp} \u2014 [Stripe] Rented subscription activated via Stripe session ${session.id}.`;
        await saveProspect(prospect);
        try {
          await saveNotification({
            id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: "subscription_activated",
            title: `\u2705 Subscription activated for ${prospect.name}`,
            message: `Stripe Checkout session ${session.id} completed.
Customer: ${prospect.email || OPERATOR_EMAIL}
A copy of this notification has been queued to ${OPERATOR_EMAIL}.`,
            metadata: { prospectId: prospect.id, stripeSessionId: session.id, source: "checkout.completed" },
            read: false,
            createdAt: (/* @__PURE__ */ new Date()).toISOString()
          });
        } catch {
        }
      }
      return;
    }
    case "invoice.created":
    case "invoice.finalized":
    case "invoice.paid":
    case "invoice.payment_failed": {
      const inv = event.data.object;
      const prospectId = lookupProspectIdFromStripeEvent(inv);
      const prospect = await loadProspectById(prospectId);
      if (!prospect || !prospectId) return;
      const previousStatus = prospect.stripeSubscriptionStatus;
      if (inv.id) prospect.stripeInvoiceId = inv.id;
      if (inv.number) prospect.stripeInvoiceNumber = inv.number;
      if (inv.hosted_invoice_url || inv.invoice_pdf) {
        prospect.stripeInvoiceUrl = inv.hosted_invoice_url || inv.invoice_pdf;
      }
      if (typeof inv.amount_due === "number") prospect.subscriptionAmount = inv.amount_due;
      if (inv.currency) prospect.subscriptionCurrency = inv.currency;
      if (inv.due_date) prospect.subscriptionNextDueDate = new Date(inv.due_date * 1e3).toISOString();
      const stamp = (/* @__PURE__ */ new Date()).toLocaleString();
      if (event.type === "invoice.paid") {
        prospect.stripeSubscriptionStatus = "active";
        prospect.subscriptionLastPaidAt = (/* @__PURE__ */ new Date()).toISOString();
        prospect.notes = (prospect.notes ? prospect.notes + "\n" : "") + `${stamp} \u2014 [Stripe] Invoice ${inv.id || inv.number} PAID by ${prospect.name}.`;
        const isFirstActivationOrRecovery = !previousStatus || previousStatus === "incomplete" || previousStatus === "incomplete_expired" || previousStatus === "past_due" || previousStatus === "unpaid";
        if (isFirstActivationOrRecovery) {
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: "subscription_activated",
              title: previousStatus === "past_due" || previousStatus === "unpaid" ? `\u2705 Recovered from past_due: Invoice paid by ${prospect.name}` : previousStatus === "incomplete" || previousStatus === "incomplete_expired" ? `\u2705 First payment received from ${prospect.name}` : `\u2705 Subscription activated for ${prospect.name}`,
              message: `Invoice ${inv.number || inv.id} marked as PAID.
Amount: $${((inv.amount_paid ?? inv.amount_due ?? 0) / 100).toFixed(2)} ${(inv.currency || "usd").toUpperCase()}
Previous status: ${previousStatus || "unknown"} \u2192 active.
Email-copy queued to ${OPERATOR_EMAIL}.`,
              metadata: { prospectId: prospect.id, stripeInvoiceId: inv.id, stripeInvoiceUrl: inv.hosted_invoice_url, previousStatus: previousStatus || null, mode: "live", outcome: "paid" },
              read: false,
              createdAt: (/* @__PURE__ */ new Date()).toISOString()
            });
          } catch {
          }
        }
      } else if (event.type === "invoice.payment_failed") {
        prospect.stripeSubscriptionStatus = "past_due";
        const failReason = inv.last_payment_error?.message || inv.failure_message || "unknown";
        prospect.notes = (prospect.notes ? prospect.notes + "\n" : "") + `${stamp} \u2014 [Stripe] Invoice ${inv.id || inv.number} PAYMENT FAILED for ${prospect.name} \u2014 ${failReason}.`;
        if (!await hasRecentNotification(prospect.id, "subscription_failed", 24 * 60 * 60 * 1e3)) {
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: "subscription_failed",
              title: `\u274C Payment failed for ${prospect.name}`,
              message: `Invoice ${inv.number || inv.id} failed to charge.
Reason: ${failReason}
Stripe will retry automatically; duplicate retries within 24h suppressed.
Email-copy queued to ${OPERATOR_EMAIL}.`,
              metadata: { prospectId: prospect.id, stripeInvoiceId: inv.id, failureReason: failReason, mode: "live", outcome: "failed" },
              read: false,
              createdAt: (/* @__PURE__ */ new Date()).toISOString()
            });
          } catch {
          }
        }
      } else if (event.type === "invoice.finalized") {
        if (inv.billing_reason === "subscription_create" && !await hasRecentNotification(prospect.id, "invoice_created", 60 * 60 * 1e3)) {
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: "invoice_created",
              title: `\u{1F4E8} First invoice finalized for ${prospect.name}`,
              message: `Invoice ${inv.number || inv.id} finalized for $${((inv.amount_due || 0) / 100).toFixed(2)} ${(inv.currency || "usd").toUpperCase()}.
Due: ${inv.due_date ? new Date(inv.due_date * 1e3).toISOString().slice(0, 10) : "\u2014"}
Stripe will email the customer; copy queued to ${OPERATOR_EMAIL}.`,
              metadata: { prospectId: prospect.id, stripeInvoiceId: inv.id, stripeInvoiceUrl: inv.hosted_invoice_url, billingReason: inv.billing_reason, mode: "live" },
              read: false,
              createdAt: (/* @__PURE__ */ new Date()).toISOString()
            });
          } catch {
          }
        }
      }
      await saveProspect(prospect);
      return;
    }
    case "invoice.deleted":
    case "charge.refunded": {
      const obj = event.data.object;
      const prospect = await resolveProspectForEvent(event);
      if (!prospect) return;
      const stamp = (/* @__PURE__ */ new Date()).toLocaleString();
      if (event.type === "charge.refunded") {
        if (obj.id) prospect.stripeChargeRefundedId = obj.id;
        prospect.notes = (prospect.notes ? prospect.notes + "\n" : "") + `${stamp} \u2014 [Stripe] Charge ${obj.id} refunded for ${prospect.name} (amount: $${((obj.amount_refunded ?? obj.amount ?? 0) / 100).toFixed(2)}).`;
        try {
          await saveNotification({
            id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: "subscription_failed",
            title: `\u21A9\uFE0F Refund issued for ${prospect.name}`,
            message: `Charge ${obj.id} refunded.
Amount: $${((obj.amount_refunded ?? obj.amount ?? 0) / 100).toFixed(2)} ${(obj.currency || "usd").toUpperCase()}
Note: refund is a charge-level event \u2014 original invoice stays "paid".
Email-copy queued to ${OPERATOR_EMAIL}.`,
            metadata: { prospectId: prospect.id, stripeChargeId: obj.id, mode: "live", outcome: "refunded" },
            read: false,
            createdAt: (/* @__PURE__ */ new Date()).toISOString()
          });
        } catch {
        }
      } else {
        prospect.stripeInvoiceStatus = "void";
        prospect.notes = (prospect.notes ? prospect.notes + "\n" : "") + `${stamp} \u2014 [Stripe] Invoice ${obj.number || obj.id} deleted for ${prospect.name}.`;
        if (!await hasRecentNotification(prospect.id, "system", 24 * 60 * 60 * 1e3)) {
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: "system",
              title: `\u{1F5D1}\uFE0F Invoice deleted for ${prospect.name}`,
              message: `Invoice ${obj.number || obj.id} was deleted.
Hosted URL will stop resolving shortly. Email-copy queued to ${OPERATOR_EMAIL}.`,
              metadata: { prospectId: prospect.id, stripeInvoiceId: obj.id, stripeInvoiceUrl: obj.hosted_invoice_url, mode: "live", outcome: "void" },
              read: false,
              createdAt: (/* @__PURE__ */ new Date()).toISOString()
            });
          } catch {
          }
        }
      }
      await saveProspect(prospect);
      return;
    }
    case "invoice.marked_uncollectible": {
      const obj = event.data.object;
      const prospect = await resolveProspectForEvent(event);
      if (!prospect) return;
      prospect.stripeInvoiceStatus = "uncollectible";
      prospect.notes = (prospect.notes ? prospect.notes + "\n" : "") + `${(/* @__PURE__ */ new Date()).toLocaleString()} \u2014 [Stripe] Invoice ${obj.number || obj.id} marked uncollectible for ${prospect.name}.`;
      if (!await hasRecentNotification(prospect.id, "system", 24 * 60 * 60 * 1e3)) {
        try {
          await saveNotification({
            id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: "system",
            title: `\u2620\uFE0F Invoice uncollectible for ${prospect.name}`,
            message: `Invoice ${obj.number || obj.id} marked uncollectible \u2014 Smart Retries exhausted.
Email-copy queued to ${OPERATOR_EMAIL}.`,
            metadata: { prospectId: prospect.id, stripeInvoiceId: obj.id, stripeInvoiceUrl: obj.hosted_invoice_url, invoiceStatus: "uncollectible", mode: "live" },
            read: false,
            createdAt: (/* @__PURE__ */ new Date()).toISOString()
          });
        } catch {
        }
      }
      await saveProspect(prospect);
      return;
    }
    case "invoice.updated": {
      const obj = event.data.object;
      const prospect = await resolveProspectForEvent(event);
      if (!prospect) return;
      if (obj.status === "void") {
        prospect.stripeInvoiceStatus = "void";
        prospect.notes = (prospect.notes ? prospect.notes + "\n" : "") + `${(/* @__PURE__ */ new Date()).toLocaleString()} \u2014 [Stripe] Invoice ${obj.number || obj.id} \u2192 void for ${prospect.name}.`;
        if (!await hasRecentNotification(prospect.id, "system", 24 * 60 * 60 * 1e3)) {
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: "system",
              title: `\u{1F5D1}\uFE0F Invoice voided for ${prospect.name}`,
              message: `Invoice ${obj.number || obj.id} was voided via Stripe dashboard.
Email-copy queued to ${OPERATOR_EMAIL}.`,
              metadata: { prospectId: prospect.id, stripeInvoiceId: obj.id, stripeInvoiceUrl: obj.hosted_invoice_url, invoiceStatus: "void", mode: "live" },
              read: false,
              createdAt: (/* @__PURE__ */ new Date()).toISOString()
            });
          } catch {
          }
        }
        await saveProspect(prospect);
      }
      return;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const prospect = await resolveProspectForEvent(event);
      if (!prospect) return;
      if (sub.id) prospect.stripeSubscriptionId = sub.id;
      if (sub.status) prospect.stripeSubscriptionStatus = sub.status;
      if (sub.customer) {
        prospect.stripeCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
      }
      if (typeof sub.current_period_end === "number") {
        prospect.subscriptionNextDueDate = new Date(sub.current_period_end * 1e3).toISOString();
      }
      const stamp = (/* @__PURE__ */ new Date()).toLocaleString();
      if (event.type === "customer.subscription.deleted") {
        prospect.stripeSubscriptionStatus = "canceled";
        prospect.notes = (prospect.notes ? prospect.notes + "\n" : "") + `${stamp} \u2014 [Stripe] Subscription ${sub.id} canceled for ${prospect.name}.`;
        if (!await hasRecentNotification(prospect.id, "subscription_failed", 24 * 60 * 60 * 1e3)) {
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: "subscription_failed",
              title: `\u{1F6AB} Subscription canceled for ${prospect.name}`,
              message: `Stripe subscription ${sub.id} canceled.
No further rent will be collected. Email-copy queued to ${OPERATOR_EMAIL}.`,
              metadata: { prospectId: prospect.id, stripeSubscriptionId: sub.id, mode: "live", outcome: "canceled" },
              read: false,
              createdAt: (/* @__PURE__ */ new Date()).toISOString()
            });
          } catch {
          }
        }
      } else {
        const ATTENTION_STATES = /* @__PURE__ */ new Set([
          "past_due",
          "unpaid",
          "incomplete",
          "incomplete_expired",
          "paused",
          "canceled"
        ]);
        if (sub.status && ATTENTION_STATES.has(sub.status)) {
          prospect.notes = (prospect.notes ? prospect.notes + "\n" : "") + `${stamp} \u2014 [Stripe] Subscription ${sub.id} status \u2192 ${sub.status} for ${prospect.name}.`;
          let title, body, outcome;
          switch (sub.status) {
            case "incomplete_expired":
              title = `\u{1FAA6} First invoice never paid for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} \u2192 "${sub.status}".
First invoice was never paid; subscription slot is now free.
Re-onboarding requires a fresh auto-subscribe. Email-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = "incomplete_expired";
              break;
            case "unpaid":
              title = `\u{1F480} All retries exhausted for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} \u2192 "${sub.status}" after ~21 days of failed retries.
Subscription will be canceled by Stripe. Email-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = "unpaid";
              break;
            case "past_due":
              title = `\u26A0\uFE0F Subscription past_due for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} status \u2192 "${sub.status}".
Latest invoice failed; Stripe is retrying. Email-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = "past_due";
              break;
            case "incomplete":
              title = `\u23F3 First invoice pending for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} status \u2192 "${sub.status}".
Waiting for first payment. Email-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = "incomplete";
              break;
            case "paused":
              title = `\u23F8\uFE0F Subscription paused for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} status \u2192 "${sub.status}".
Email-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = "paused";
              break;
            case "canceled":
              title = `\u{1F6AB} Subscription canceled for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} status \u2192 "${sub.status}".
No further rent will be collected. Email-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = "canceled";
              break;
            default:
              title = `\u2139\uFE0F Subscription status \u2192 ${sub.status} for ${prospect.name}`;
              body = `Stripe subscription ${sub.id} status changed to "${sub.status}".
Email-copy queued to ${OPERATOR_EMAIL}.`;
              outcome = sub.status;
          }
          const notifType = sub.status === "past_due" || sub.status === "unpaid" || sub.status === "canceled" || sub.status === "incomplete_expired" ? "subscription_failed" : "invoice_created";
          try {
            await saveNotification({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: notifType,
              title,
              message: body,
              metadata: { prospectId: prospect.id, stripeSubscriptionId: sub.id, status: sub.status, mode: "live", outcome },
              read: false,
              createdAt: (/* @__PURE__ */ new Date()).toISOString()
            });
          } catch {
          }
        }
      }
      await saveProspect(prospect);
      return;
    }
    default:
      return;
  }
}

// server.ts
import_dotenv2.default.config();
async function hasRecentNotification2(prospectId, type, windowMs) {
  const cutoff = Date.now() - windowMs;
  const notes = await getNotifications();
  return notes.some(
    (n) => n.metadata?.prospectId === prospectId && n.type === type && new Date(n.createdAt).getTime() >= cutoff
  );
}
function buildApp() {
  const app = (0, import_express.default)();
  app.use(import_express.default.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    }
  }));
  app.use(import_express.default.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    console.log(`[${(/* @__PURE__ */ new Date()).toISOString()}] ${req.method} ${req.url}`);
    next();
  });
  app.get("/api/targets", async (_req, res) => {
    try {
      res.json(await getTargets());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/targets", async (req, res) => {
    const { niche, city } = req.body;
    if (!niche || !city) {
      res.status(400).json({ error: "Niche and City are required fields." });
      return;
    }
    try {
      console.log(`Starting SEO analysis for Niche: "${niche}" in "${city}"...`);
      const analysis = await analyzeMarket(niche, city);
      const newTarget = {
        id: `target-${Date.now()}`,
        niche,
        city,
        status: "researching",
        monthlyVolume: analysis.keywords.reduce((acc, k) => acc + (k.searchVolume || 0), 0),
        avgDifficulty: Math.round(
          analysis.keywords.reduce((acc, k) => acc + (k.difficulty || 0), 0) / (analysis.keywords.length || 1)
        ),
        keywords: analysis.keywords,
        competitors: analysis.competitors,
        gmbScore: analysis.gmbScore || 50,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await saveTarget(newTarget);
      res.json(newTarget);
    } catch (err) {
      console.error("Error analyzing target market:", err);
      res.status(500).json({ error: formatLlmError(err) });
    }
  });
  app.delete("/api/targets/:id", async (req, res) => {
    try {
      await deleteTarget(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get("/api/prospects", async (req, res) => {
    try {
      const { targetId } = req.query;
      let prospects = await getProspects();
      if (targetId) prospects = prospects.filter((p) => p.targetId === targetId);
      res.json(prospects);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/prospects/scrape", async (req, res) => {
    const { targetId, niche, city } = req.body;
    if (!targetId || !niche || !city) {
      res.status(400).json({ error: "targetId, niche, and city are required." });
      return;
    }
    try {
      const leads = await scrapeLeads(niche, city, targetId);
      await saveProspects(leads);
      const targets = await getTargets();
      const target = targets.find((t) => t.id === targetId);
      if (target) {
        target.status = "active_leads";
        await saveTarget(target);
      }
      res.json(leads);
    } catch (err) {
      console.error("Error scraping leads:", err);
      res.status(500).json({ error: formatLlmError(err) });
    }
  });
  app.post("/api/prospects/:id/pitch", async (req, res) => {
    const prospects = await getProspects();
    const prospect = prospects.find((p) => p.id === req.params.id);
    if (!prospect) {
      res.status(404).json({ error: "Prospect not found." });
      return;
    }
    try {
      const pitch = await generateOutreachPitch(prospect);
      prospect.pitchEmailContent = pitch.emailContent;
      prospect.pitchSmsContent = pitch.smsContent;
      prospect.pitchStatus = "Pitched";
      await saveProspect(prospect);
      res.json(prospect);
    } catch (err) {
      res.status(500).json({ error: formatLlmError(err) });
    }
  });
  app.patch("/api/prospects/:id/status", async (req, res) => {
    const prospects = await getProspects();
    const prospect = prospects.find((p) => p.id === req.params.id);
    if (!prospect) {
      res.status(404).json({ error: "Prospect not found." });
      return;
    }
    try {
      prospect.pitchStatus = req.body.status;
      await saveProspect(prospect);
      res.json(prospect);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/prospects/:id/notes", async (req, res) => {
    const prospects = await getProspects();
    const prospect = prospects.find((p) => p.id === req.params.id);
    if (!prospect) {
      res.status(404).json({ error: "Prospect not found." });
      return;
    }
    try {
      prospect.notes = req.body.notes;
      await saveProspect(prospect);
      res.json(prospect);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get("/api/numbers", async (_req, res) => {
    try {
      res.json(await getNumbers());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/numbers", async (req, res) => {
    const { phoneNumber, friendlyName, forwardTo, whisperMessage, recordCalls } = req.body;
    if (!phoneNumber || !forwardTo) {
      res.status(400).json({ error: "phoneNumber and forwardTo are required." });
      return;
    }
    try {
      let finalNumber = phoneNumber;
      if (isCallRailEnabled()) {
        let areaCode = "214";
        const m = phoneNumber.replace(/\D/g, "").match(/^1?([0-9]{3})/);
        if (m) areaCode = m[1];
        const { phoneNumber: realNumber } = await provisionCallRailTracker({
          name: friendlyName || `${phoneNumber} Forwarder`,
          areaCode,
          forwardTo,
          whisperMessage,
          recordCalls: !!recordCalls
        });
        finalNumber = realNumber;
      }
      const newNum = {
        id: `num-${Date.now()}`,
        phoneNumber: finalNumber,
        friendlyName: friendlyName || `${finalNumber} Forwarder`,
        forwardTo,
        whisperMessage: whisperMessage || "Call from Rank & Rent Leads.",
        recordCalls: !!recordCalls,
        isActive: true,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await saveNumber(newNum);
      res.json(newNum);
    } catch (err) {
      console.error("Error provisioning tracking number:", err);
      res.status(500).json({ error: err.message });
    }
  });
  app.delete("/api/numbers/:id", async (req, res) => {
    try {
      await deleteNumber(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get("/api/calls", async (_req, res) => {
    try {
      res.json(await getCalls());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get("/api/sites", async (_req, res) => {
    try {
      res.json(await getSites());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/sites/generate", async (req, res) => {
    const { targetId, trackingNumberId } = req.body;
    if (!targetId || !trackingNumberId) {
      res.status(400).json({ error: "targetId and trackingNumberId are required." });
      return;
    }
    const targets = await getTargets();
    const target = targets.find((t) => t.id === targetId);
    const numbers = await getNumbers();
    const line = numbers.find((l) => l.id === trackingNumberId);
    if (!target) {
      res.status(404).json({ error: "Target market not found." });
      return;
    }
    if (!line) {
      res.status(404).json({ error: "Tracking line not found." });
      return;
    }
    try {
      const site = await generateLandingPage(target.niche, target.city, line.phoneNumber, line.whisperMessage);
      site.targetId = targetId;
      if (process.env.VERCEL_API_KEY) {
        try {
          const clean = `rank-rent-${target.city.toLowerCase()}-${target.niche.toLowerCase()}-${Date.now().toString().slice(-4)}`.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
          const vercelRes = await fetch("https://api.vercel.com/v13/deployments", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.VERCEL_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              name: clean,
              files: [{ file: "index.html", data: site.htmlCode, encoding: "utf-8" }],
              projectSettings: { framework: null }
            })
          });
          if (vercelRes.ok) {
            const data = await vercelRes.json();
            if (data?.url) {
              site.domainName = data.url;
              site.deploymentUrl = data.url;
            }
          }
        } catch (vErr) {
          console.error("Vercel deployment failed, using generated domain name:", vErr.message || vErr);
        }
      }
      await saveSite(site);
      target.status = "site_created";
      await saveTarget(target);
      res.json(site);
    } catch (err) {
      console.error("Error generating site:", err);
      res.status(500).json({ error: formatLlmError(err) });
    }
  });
  app.delete("/api/sites/:id", async (req, res) => {
    try {
      await deleteSite(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/outreach/trial-email", async (req, res) => {
    const { prospectId, siteUrl, niche, city } = req.body;
    if (!prospectId || !siteUrl) {
      res.status(400).json({ error: "prospectId and siteUrl are required." });
      return;
    }
    const prospects = await getProspects();
    const prospect = prospects.find((p) => p.id === prospectId);
    if (!prospect) {
      res.status(404).json({ error: "Prospect not found." });
      return;
    }
    try {
      const emailData = await generateTrialOfferEmail(prospect, siteUrl, niche || prospect.niche, city || prospect.city);
      prospect.trialEmailContent = emailData.emailContent;
      prospect.trialEmailSent = true;
      prospect.pitchStatus = "Trial";
      await saveProspect(prospect);
      res.json({
        success: true,
        prospectId: prospect.id,
        subject: emailData.subject,
        emailContent: emailData.emailContent,
        sentTo: prospect.email || null,
        from: "halvsiebobbproductions@gmail.com"
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/billing/checkout", async (req, res) => {
    const { siteId, prospectId } = req.body;
    if (!siteId || !prospectId) {
      res.status(400).json({ error: "siteId and prospectId are required." });
      return;
    }
    try {
      const sites = await getSites();
      const site = sites.find((s) => s.id === siteId);
      const prospects = await getProspects();
      const prospect = prospects.find((p) => p.id === prospectId);
      if (!site || !prospect) {
        res.status(404).json({ error: "Site or Prospect not found." });
        return;
      }
      if (!isStripeLive()) {
        res.status(503).json({
          error: "STRIPE_SECRET_KEY is not configured (or still set to the mock placeholder). Set a real Stripe test/live key in your .env to enable Checkout. See https://dashboard.stripe.com/apikeys to create one."
        });
        return;
      }
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: {
              name: `Lease Subscription: ${site.domainName}`,
              description: `Recurring rental fee for local lead asset: ${site.niche} in ${site.city}`
            },
            unit_amount: 45e3,
            recurring: { interval: "month" }
          },
          quantity: 1
        }],
        mode: "subscription",
        success_url: `${process.env.APP_URL || "http://localhost:3000"}/?status=success&prospectId=${prospectId}&siteId=${siteId}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.APP_URL || "http://localhost:3000"}/?status=cancel`,
        metadata: { siteId, prospectId }
      });
      res.json({ url: session.url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/billing/auto-subscribe", async (req, res) => {
    const { prospectId, siteId, targetId } = req.body;
    if (!prospectId) {
      res.status(400).json({ error: "prospectId is required" });
      return;
    }
    try {
      const prospects = await getProspects();
      const prospect = prospects.find((p) => p.id === prospectId);
      if (!prospect) {
        res.status(404).json({ error: "Prospect not found." });
        return;
      }
      const sites = await getSites();
      let site = siteId ? sites.find((s) => s.id === siteId) : sites.find((s) => s.targetId === prospect.targetId);
      if (!site && targetId) site = sites.find((s) => s.targetId === targetId);
      const numbers = await getNumbers();
      const hasLine = numbers.some(
        (n) => n.friendlyName?.toLowerCase().includes(prospect.city.toLowerCase()) || n.friendlyName?.toLowerCase().includes(prospect.niche.toLowerCase())
      ) || numbers.length > 0;
      if (!site || !hasLine) {
        res.status(412).json({
          error: `Cannot auto-subscribe: prerequisites not met. siteReady=${!!site}, hasLine=${hasLine}.`,
          needsSite: !site,
          needsLine: !hasLine
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
      prospect.subscriptionStartDate = (/* @__PURE__ */ new Date()).toISOString();
      prospect.subscriptionMode = result.mode;
      prospect.stripeSubscriptionStatus = "active";
      if (!result.alreadyHadSubscription) {
        prospect.pitchStatus = "Rented";
        const stamp = (/* @__PURE__ */ new Date()).toLocaleString();
        prospect.notes = (prospect.notes ? prospect.notes + "\n" : "") + `${stamp} \u2014 [Stripe LIVE] $${(result.amountDue / 100).toFixed(2)} ${result.currency.toUpperCase()} subscription + invoice created.`;
      }
      await saveProspect(prospect);
      if (!result.alreadyHadSubscription) {
        const targets = await getTargets();
        const target = targets.find((t) => t.id === prospect.targetId);
        if (target) {
          target.status = "rented";
          await saveTarget(target);
        }
      }
      const dispatchFailed = !!result.sendInvoiceFailed;
      const note = {
        id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: dispatchFailed ? "subscription_failed" : result.alreadyHadSubscription ? "invoice_created" : "subscription_activated",
        title: dispatchFailed ? `\u26A0\uFE0F Invoice NOT emailed to ${prospect.name}` : result.alreadyHadSubscription ? `Existing subscription confirmed for ${prospect.name}` : `\u2705 Stripe subscription created for ${prospect.name}`,
        message: `Customer: ${result.customerEmail}
Subscription: ${result.subscriptionId}
Invoice: ${result.invoiceId}
Amount: $${(result.amountDue / 100).toFixed(2)} ${result.currency.toUpperCase()}
Due: ${result.dueDate.slice(0, 10)}
` + (result.invoiceUrl ? `Hosted: ${result.invoiceUrl}
` : "") + `Operator copy queued to ${OPERATOR_EMAIL}.`,
        metadata: {
          prospectId: prospect.id,
          targetId: prospect.targetId,
          siteId: site.id,
          stripeCustomerId: result.customerId,
          stripeSubscriptionId: result.subscriptionId,
          stripeInvoiceId: result.invoiceId,
          stripeInvoiceUrl: result.invoiceUrl,
          mode: result.mode,
          amount: result.amountDue,
          currency: result.currency,
          dueDate: result.dueDate
        },
        read: false,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await saveNotification(note);
      res.json({ success: true, ...result, notification: note, prospect });
    } catch (err) {
      console.error("Auto-subscribe error:", err);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
  app.get("/api/notifications", async (_req, res) => {
    try {
      const notes = await getNotifications();
      res.json({ notifications: notes, operatorEmail: OPERATOR_EMAIL, unreadCount: notes.filter((n) => !n.read).length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/notifications/:id/read", async (req, res) => {
    try {
      await markNotificationRead(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.delete("/api/notifications", async (_req, res) => {
    try {
      await clearNotifications();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  const AUTOPILOT_INTERVAL_MS = (() => {
    const v = Number(process.env.AUTOPILOT_INTERVAL_MS);
    return Number.isFinite(v) && v > 0 ? v : 12e3;
  })();
  app.get("/api/autopilot/status", async (_req, res) => {
    try {
      const status = await getAutopilotStatus(AUTOPILOT_INTERVAL_MS);
      res.json({ ...status, intervalMs: AUTOPILOT_INTERVAL_MS });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/autopilot/toggle", async (req, res) => {
    const allowedKeys = ["isAutopilotOn", "isAutoPitchOn", "isAutoSubscribeOn"];
    const patch = {};
    for (const k of allowedKeys) {
      if (typeof req.body?.[k] === "boolean") patch[k] = req.body[k];
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Provide at least one of isAutopilotOn, isAutoPitchOn, isAutoSubscribeOn." });
      return;
    }
    try {
      await saveSettings(patch);
      const current = await getSettings();
      res.json({ success: true, settings: current });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/autopilot/run", async (_req, res) => {
    try {
      const result = await runAutopilotCycle();
      recordCycleResult(result);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
  app.post("/api/cron/autopilot", async (req, res) => {
    const expected = process.env.CRON_SECRET;
    if (expected) {
      const got = req.headers["x-cron-secret"] || req.headers["authorization"];
      if (got !== expected && got !== `Bearer ${expected}`) {
        res.status(401).json({ error: "Unauthorized cron ping." });
        return;
      }
    }
    try {
      const result = await runAutopilotCycle();
      recordCycleResult(result);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(200).json({ success: false, error: err?.message || String(err) });
    }
  });
  app.get("/api/health", async (_req, res) => {
    try {
      const snapshot = await getDbSnapshot();
      res.json({ status: "ok", timestamp: (/* @__PURE__ */ new Date()).toISOString(), ...snapshot });
    } catch (err) {
      res.status(500).json({ status: "error", error: err.message });
    }
  });
  app.post("/api/webhooks/stripe", import_express.default.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (webhookSecret && sig) {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } else {
        event = JSON.parse(req.body.toString());
      }
    } catch (err) {
      res.status(400).send(`Webhook Error: ${sig ? err.message : "Missing signature or webhook secret"}`);
      return;
    }
    try {
      await handleStripeEvent(event);
    } catch (e) {
      console.error("[Stripe Webhook] handler error:", e?.message || e);
    }
    res.json({ received: true });
  });
  app.post("/api/webhooks/callrail", async (req, res) => {
    const { customer_number, tracking_phone_number, duration, answered, recording_url, start_time, customer_city, customer_state } = req.body;
    const signature = req.headers["x-callrail-signature"];
    const signingKey = process.env.CALLRAIL_SIGNING_KEY;
    if (signingKey) {
      const raw = req.rawBody;
      if (!raw) {
        res.status(400).json({ error: "Raw body missing for signature verification." });
        return;
      }
      if (!signature || !verifyCallRailSignature(raw.toString(), signature, signingKey)) {
        res.status(401).json({ error: "Invalid signature." });
        return;
      }
    }
    const numbers = await getNumbers();
    const cleanCallRailNum = (tracking_phone_number || "").replace(/[^\d+]/g, "");
    const line = numbers.find((n) => n.phoneNumber.replace(/[^\d+]/g, "") === cleanCallRailNum);
    if (line) {
      const durationSeconds = duration ? Number(duration) : 0;
      const status = answered === true || answered === "true" ? "completed" : "no-answer";
      await saveCall({
        id: `call-${Date.now()}`,
        trackingNumberId: line.id,
        trackingNumber: line.phoneNumber,
        callerNumber: customer_number || "+1 (unknown)",
        callerLocation: customer_city && customer_state ? `${customer_city}, ${customer_state}` : "United States",
        forwardTo: line.forwardTo,
        durationSeconds,
        status,
        recordingUrl: recording_url || void 0,
        dateCreated: start_time ? new Date(start_time).toISOString() : (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    res.json({ success: true });
  });
  let isReconciling = false;
  let lastReconcileStats = null;
  const STRIPE_RECONCILE_INTERVAL_MS = (() => {
    const v = Number(process.env.STRIPE_RECONCILE_INTERVAL_MS);
    return Number.isFinite(v) && v > 0 ? v : 30 * 60 * 1e3;
  })();
  async function reconcileStripeSubscriptionStates() {
    if (isReconciling) {
      lastReconcileStats = {
        lastRunAt: (/* @__PURE__ */ new Date()).toISOString(),
        lastCheckedCount: 0,
        lastDriftedCount: 0,
        lastErrorsCount: 0,
        lastResult: "skipped",
        intervalMs: STRIPE_RECONCILE_INTERVAL_MS
      };
      return { checked: 0, drifted: 0, errors: 0, skipped: true };
    }
    isReconciling = true;
    try {
      if (!isStripeLive()) {
        lastReconcileStats = {
          lastRunAt: (/* @__PURE__ */ new Date()).toISOString(),
          lastCheckedCount: 0,
          lastDriftedCount: 0,
          lastErrorsCount: 0,
          lastResult: "noop_live_disabled",
          intervalMs: STRIPE_RECONCILE_INTERVAL_MS
        };
        return { checked: 0, drifted: 0, errors: 0 };
      }
      const now = Date.now();
      const DAY_MS = 24 * 60 * 60 * 1e3;
      const prospects = await getProspects();
      const candidates = prospects.filter((p) => {
        if (!p.stripeSubscriptionId) return false;
        if (p.stripeSubscriptionStatus !== "active") return false;
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
          lastRunAt: (/* @__PURE__ */ new Date()).toISOString(),
          lastCheckedCount: 0,
          lastDriftedCount: 0,
          lastErrorsCount: 0,
          lastResult: "noop_no_candidates",
          intervalMs: STRIPE_RECONCILE_INTERVAL_MS
        };
        return { checked: 0, drifted: 0, errors: 0 };
      }
      let drifted = 0, errors = 0;
      const stamp = (/* @__PURE__ */ new Date()).toLocaleString();
      for (const prospect of candidates) {
        try {
          const sub = await stripe.subscriptions.retrieve(prospect.stripeSubscriptionId);
          if (sub.status && sub.status !== prospect.stripeSubscriptionStatus) {
            const oldStatus = prospect.stripeSubscriptionStatus;
            prospect.stripeSubscriptionStatus = sub.status;
            prospect.notes = (prospect.notes ? prospect.notes + "\n" : "") + `${stamp} \u2014 [Reconcile] Subscription status drifted "${oldStatus || "unknown"}" \u2192 "${sub.status}".`;
            const isRecovering = sub.status === "active" || sub.status === "trialing";
            const notifType = isRecovering ? "subscription_activated" : "subscription_failed";
            const notifTitle = sub.status === "past_due" ? `\u26A0\uFE0F Reconciled: ${prospect.name} is past_due` : sub.status === "unpaid" ? `\u{1F480} Reconciled: ${prospect.name} is unpaid` : sub.status === "canceled" ? `\u{1F6AB} Reconciled: ${prospect.name} canceled` : sub.status === "incomplete_expired" ? `\u{1FAA6} Reconciled: ${prospect.name} expired` : sub.status === "active" || sub.status === "trialing" ? `\u2705 Reconciled: ${prospect.name} renewed` : `\u{1F504} Reconciled: ${prospect.name} status \u2192 ${sub.status}`;
            if (!await hasRecentNotification2(prospect.id, notifType, 24 * 60 * 60 * 1e3)) {
              await saveNotification({
                id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                type: notifType,
                title: notifTitle,
                message: `Reconciliation drift detected.
Old: ${oldStatus || "unknown"}
New: ${sub.status}
Email-copy queued to ${OPERATOR_EMAIL}.`,
                metadata: { prospectId: prospect.id, stripeSubscriptionId: sub.id, previousStatus: oldStatus || null, currentStatus: sub.status, mode: "live", outcome: sub.status, source: "cron" },
                read: false,
                createdAt: (/* @__PURE__ */ new Date()).toISOString()
              });
            }
            drifted++;
          }
          if (typeof sub.current_period_end === "number") {
            const newNext = new Date(sub.current_period_end * 1e3).toISOString();
            if (prospect.subscriptionNextDueDate !== newNext) prospect.subscriptionNextDueDate = newNext;
          }
          const latest = sub.latest_invoice;
          const latestId = typeof latest === "string" ? latest : latest?.id;
          if (latestId && latestId !== prospect.stripeInvoiceId) {
            try {
              const inv = await stripe.invoices.retrieve(latestId);
              if (inv.id) prospect.stripeInvoiceId = inv.id;
              if (inv.number) prospect.stripeInvoiceNumber = inv.number;
              if (inv.hosted_invoice_url || inv.invoice_pdf) {
                prospect.stripeInvoiceUrl = inv.hosted_invoice_url || inv.invoice_pdf;
              }
              if (typeof inv.amount_paid === "number" || typeof inv.amount_due === "number") {
                prospect.subscriptionAmount = typeof inv.amount_paid === "number" && inv.amount_paid > 0 ? inv.amount_paid : inv.amount_due ?? prospect.subscriptionAmount;
              }
              if (inv.currency) prospect.subscriptionCurrency = inv.currency;
              if (inv.status) prospect.stripeInvoiceStatus = inv.status;
              if (inv.status === "paid" && !prospect.subscriptionLastPaidAt) {
                prospect.subscriptionLastPaidAt = (/* @__PURE__ */ new Date()).toISOString();
              }
            } catch (invErr) {
              console.warn(`[Stripe Reconcile] invoice ${latestId} fetch failed:`, invErr?.message || invErr);
            }
          }
          await saveProspect(prospect);
        } catch (err) {
          errors++;
          console.warn(`[Stripe Reconcile] subscription ${prospect.stripeSubscriptionId} fetch failed:`, err?.message || err);
        }
      }
      lastReconcileStats = {
        lastRunAt: (/* @__PURE__ */ new Date()).toISOString(),
        lastCheckedCount: candidates.length,
        lastDriftedCount: drifted,
        lastErrorsCount: errors,
        lastResult: "completed",
        intervalMs: STRIPE_RECONCILE_INTERVAL_MS
      };
      return { checked: candidates.length, drifted, errors };
    } finally {
      isReconciling = false;
    }
  }
  app.post("/api/billing/reconcile", async (_req, res) => {
    try {
      const result = await reconcileStripeSubscriptionStates();
      if (result.skipped) {
        res.status(409).json({ success: false, message: "Reconciliation already in progress.", ...result });
        return;
      }
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
  app.get("/api/admin/stripe-reconcile-status", (_req, res) => {
    const last = lastReconcileStats;
    const lastRunAt = last?.lastRunAt ?? null;
    let nextExpectedRunAt = null;
    let isStale = true;
    let ageMs = null;
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
      ageMs,
      nextExpectedRunAt,
      isStale
    });
  });
  if (process.env.NODE_ENV !== "production") {
    (async () => {
      const vite = await (0, import_vite.createServer)({
        server: { middlewareMode: true },
        appType: "spa"
      });
      app.use(vite.middlewares);
    })();
  } else {
    const distPath = import_path2.default.join(process.cwd(), "dist");
    app.use(import_express.default.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(import_path2.default.join(distPath, "index.html"));
    });
  }
  app.__reconcileStripe = reconcileStripeSubscriptionStates;
  return app;
}
var IS_VERCEL = process.env.VERCEL === "1" || process.env.VERCEL === "true";
async function startServer() {
  const app = buildApp();
  const PORT = Number(process.env.PORT) || 3e3;
  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Rank & Rent Hub Backend listening on port ${PORT}`);
    startAutopilotLoop(12e3);
    if (isStripeLive()) {
      console.log(`[Stripe Reconcile] Background poller enabled: every ${Number(process.env.STRIPE_RECONCILE_INTERVAL_MS) || 30 * 60 * 1e3}ms (first run in 10s).`);
      setTimeout(() => {
        app.__reconcileStripe().catch(
          (e) => console.warn("[Stripe Reconcile] initial run error:", e?.message || e)
        );
      }, 1e4);
      setInterval(() => {
        app.__reconcileStripe().catch(
          (e) => console.warn("[Stripe Reconcile] interval run error:", e?.message || e)
        );
      }, Number(process.env.STRIPE_RECONCILE_INTERVAL_MS) || 30 * 60 * 1e3);
    }
    if (isCallRailEnabled()) {
      const webhookUrl = `${process.env.APP_URL || "http://localhost:3000"}/api/webhooks/callrail`;
      console.log(`[CallRail] Registering webhook URL: ${webhookUrl}`);
      try {
        await registerCallRailWebhook({ url: webhookUrl });
        console.log(`[CallRail] Webhook URL registered.`);
      } catch (err) {
        console.warn(`[CallRail] Webhook registration failed (usually already registered):`, err.message || err);
      }
    }
  });
}
if (!IS_VERCEL) {
  startServer();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildApp
});
//# sourceMappingURL=server.cjs.map

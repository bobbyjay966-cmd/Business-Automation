import { KeywordMetric, CompetitorData, ScrapedLead, GeneratedSite } from "../src/types";

import {
  fetchRealSearchSnippets,
  parseLeadsFromSearchContext,
  scrapeContactInfoFromUrl
} from "../.agent/skills/web-scraper/scripts/scraper-engine";

// Robust JSON cleaning and parsing helper
function cleanAndParseJson(text: string): any {
  let cleaned = text.trim();
  
  // Extract content between the first '{' and the last '}'
  const startIdx = cleaned.indexOf('{');
  const endIdx = cleaned.lastIndexOf('}');
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    cleaned = cleaned.slice(startIdx, endIdx + 1);
  }

  // Remove markdown code block wrappers if any remain
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, "");
    cleaned = cleaned.replace(/\n?```$/i, "");
    cleaned = cleaned.trim();
  }
  return JSON.parse(cleaned);
}

// ----------------------------------------------------------------
// OpenRouter AI — the LLM provider.
// Uses the OpenAI-compatible /chat/completions protocol via
// https://openrouter.ai/api/v1. The 70B Llama 3.3 model
// supports json_object natively.
// ----------------------------------------------------------------

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct";

async function callLlm(prompt: string, jsonMode = true): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Add it to your .env file.\n" +
      "Get a key at https://openrouter.ai.",
    );
  }

  const targetUrl = `${OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  console.log(
    `[LLM:OpenRouter] Calling ${targetUrl} (model=${OPENROUTER_MODEL})`,
  );

  const start = Date.now();
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://railway.app",
      "X-Title": "Rank & Rent Hub"
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: jsonMode
        ? [
            { role: "system", content: "You must return a valid json object." },
            { role: "user", content: prompt },
          ]
        : [{ role: "user", content: prompt }],
      response_format: jsonMode ? { type: "json_object" } : undefined,
      temperature: 1.00,
      top_p: 0.95,
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(40000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      formatLlmError(
        new Error(
          `NVIDIA LLM HTTP ${response.status}: ${errorText.slice(0, 500)}`,
        ),
      ),
    );
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (content) {
    console.log(
      `[LLM:NVIDIA] OK in ${Date.now() - start}ms (${content.length} chars)`,
    );
    return content;
  }

  throw new Error(
    formatLlmError(
      new Error(
        `NVIDIA LLM returned HTTP 200 but no message content: ${JSON.stringify(data).slice(0, 300)}`,
      ),
    ),
  );
}

// Analyze market (keywords & competitors) grounded with real search data
export async function analyzeMarket(niche: string, city: string) {
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

export function cleanPhoneNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.trim();
  if (cleaned.includes("555") || cleaned.includes("123-4567") || cleaned.includes("123-0099") || /555\d*/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

// Scrape Leads / Generate Prospects grounded with real business listings
export async function scrapeLeads(niche: string, city: string, targetId: string): Promise<ScrapedLead[]> {
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
    const scraped = cleanAndParseJson(rawResponse) as any[];

    const leads: ScrapedLead[] = scraped.map((lead, idx) => ({
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
      createdAt: new Date().toISOString()
    }));

    // Crawl actual website homepages in parallel for accurate, active phone/email info
    console.log(`[Scraper] Crawling websites in parallel for LLM extracted listings to verify actual phone/email...`);
    await Promise.all(
      leads.map(async (lead) => {
        if (lead.website) {
          try {
            const contact = await scrapeContactInfoFromUrl(lead.website);
            if (contact.phone) lead.phone = cleanPhoneNumber(contact.phone);
            if (contact.email) {
              lead.email = contact.email;
              lead.notes = `[Verified Contact Info]\nEmail: ${contact.email}\nPhone: ${lead.phone || "Not found"}`;
            }
          } catch (crawlErr) {
            console.warn(`[Scraper] Failed to crawl website ${lead.website}:`, crawlErr);
          }
        }
        // Fallback: if the website crawl didn't find an email but the lead
        // has a domain, generate a best-guess business email so the lead
        // can flow through pitching -> Stripe customer -> auto-subscribe.
        if (!lead.email && lead.website) {
          try {
            const host = new URL(lead.website).hostname.replace(/^www\./, '');
            lead.email = `info@${host}`;
            lead.notes = (lead.notes ? lead.notes + '\n' : '') +
              `[Generated Contact] Email (best-guess from domain): ${lead.email}`;
          } catch {}
        }
      })
    );
    return leads;
  } catch (err) {
    console.error("Error in scrapeLeads, running fallback:", err);
    // Ground fallback in real search snippets instead of fake mock list
    const fallbackLeads = await parseLeadsFromSearchContext(searchContext, targetId, niche, city);
    return fallbackLeads.map(l => {
      let email = l.email;
      let notes = l.notes;
      if (!email && l.website) {
        try {
          const host = new URL(l.website).hostname.replace(/^www\./, '');
          email = `info@${host}`;
          notes = (notes ? notes + '\n' : '') +
            `[Generated Contact] Email (best-guess from domain): ${email}`;
        } catch {}
      }
      return {
        ...l,
        email,
        notes,
        phone: cleanPhoneNumber(l.phone)
      };
    });
  }
}

// Generate outreach pitch (Email + SMS)
export async function generateOutreachPitch(lead: ScrapedLead) {
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

// Generate trial offer email after site deployment
export async function generateTrialOfferEmail(lead: ScrapedLead, siteUrl: string, niche: string, city: string) {
  const prompt = `You are Robert, a professional lead generation entrepreneur who builds high-ranking local service websites.
You have just built and deployed a beautiful, SEO-optimized website for a local ${niche} business in ${city}.

The live website URL is: ${siteUrl}

You are emailing the business owner at "${lead.name}" to let them know about the website you built for them.

Key points to include in the email:
1. You noticed their business and built a professional, SEO-optimized website specifically for their ${niche} services in ${city}.
2. The website is ALREADY LIVE and ranking — provide the URL: ${siteUrl}
3. You are giving them a completely FREE one-week trial of your lead generation service.
4. During the trial week, they will receive real customer calls and leads through the website at NO COST.
5. If they don't see results after the trial week, you will take down the website with zero obligation — no questions asked.
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

const NICHE_IMAGES: Record<string, string> = {
  roofing: 'https://images.unsplash.com/photo-1632759162463-157fda98c542?auto=format&fit=crop&w=800&q=80',
  plumbing: 'https://images.unsplash.com/photo-1504328345606-18bbc8c9d7d1?auto=format&fit=crop&w=800&q=80',
  tree: 'https://images.unsplash.com/photo-1590138221364-c472223b9d4e?auto=format&fit=crop&w=800&q=80',
  ac: 'https://images.unsplash.com/photo-1621905252507-b354bc25edac?auto=format&fit=crop&w=800&q=80',
  hvac: 'https://images.unsplash.com/photo-1621905252507-b354bc25edac?auto=format&fit=crop&w=800&q=80',
  concrete: 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?auto=format&fit=crop&w=800&q=80',
  landscaping: 'https://images.unsplash.com/photo-1558904541-efa8c1a68f6a?auto=format&fit=crop&w=800&q=80',
  pest: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=800&q=80',
  electrician: 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?auto=format&fit=crop&w=800&q=80',
  drywall: 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?auto=format&fit=crop&w=800&q=80',
  appliance: 'https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=800&q=80',
};

function getHeroImageForNiche(niche: string): string {
  const clean = niche.toLowerCase().trim();
  for (const [k, v] of Object.entries(NICHE_IMAGES)) {
    if (clean.includes(k)) return v;
  }
  return 'https://images.unsplash.com/photo-1581094288338-2314dddb7ecc?auto=format&fit=crop&w=800&q=80';
}

function buildHtmlFromTemplate(data: any, niche: string, city: string, phone: string): string {
  const servicesHtml = (data.services || [])
    .map((s: any) => `
      <div class="bg-slate-800/40 backdrop-blur-sm border border-slate-700/50 p-6 rounded-2xl hover:border-blue-500/30 transition-all duration-300 group hover:-translate-y-1">
        <div class="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-400 mb-4 group-hover:bg-blue-500/20 transition-all">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
        </div>
        <h3 class="text-lg font-bold text-white mb-2">${s.title}</h3>
        <p class="text-sm text-slate-400">${s.description}</p>
      </div>
    `).join('\n');

  const testimonialsHtml = (data.testimonials || [])
    .map((t: any) => `
      <div class="bg-slate-800/20 border border-slate-700/30 p-6 rounded-2xl">
        <div class="flex items-center gap-1 text-amber-400 mb-3">
          ${Array(t.stars || 5).fill(0).map(() => `
            <svg class="w-4 h-4 fill-current" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>
          `).join('')}
        </div>
        <p class="text-slate-300 text-sm italic mb-4">"${t.text}"</p>
        <span class="text-xs font-semibold text-white">— ${t.name}</span>
      </div>
    `).join('\n');

  const whyChooseUsHtml = (data.whyChooseUs || [])
    .map((w: string) => `
      <li class="flex items-start gap-3">
        <svg class="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
        <span class="text-slate-300 text-sm">${w}</span>
      </li>
    `).join('\n');

  const heroImage = getHeroImageForNiche(niche);

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.siteTitle || `Professional ${niche} in ${city}`}</title>
  <meta name="description" content="${data.metaDescription || `Looking for ${niche} services in ${city}? Contact us today at ${phone}.`}">
  <!-- Tailwind CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- Google Font -->
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Outfit', sans-serif;
    }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col selection:bg-blue-500/30">

  <!-- Header -->
  <header class="sticky top-0 z-50 bg-slate-950/80 backdrop-blur-md border-b border-slate-800/50">
    <div class="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
      <div class="flex items-center gap-2">
        <div class="w-8 h-8 rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center font-bold text-white shadow-lg shadow-blue-500/20">
          ${niche.charAt(0).toUpperCase()}
        </div>
        <span class="font-bold text-lg tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent">${city} ${niche} Pro</span>
      </div>
      
      <a href="tel:${phone.replace(/[^\d+]/g, '')}" class="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-all shadow-lg shadow-blue-600/10 hover:shadow-blue-600/20 active:scale-95">
        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/></svg>
        <span>${phone}</span>
      </a>
    </div>
  </header>

  <!-- Hero Section -->
  <section class="relative py-20 lg:py-28 overflow-hidden">
    <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(37,99,235,0.08),transparent_50%)]"></div>
    <div class="max-w-7xl mx-auto px-6 relative grid lg:grid-cols-12 gap-12 items-center">
      <div class="lg:col-span-7 space-y-6">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-xs font-semibold text-blue-400">
          <svg class="w-4 h-4 fill-current" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>
          <span>Highly Rated Local Service</span>
        </div>
        <h1 class="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white leading-tight">
          ${data.heroHeadline}
        </h1>
        <p class="text-lg text-slate-400 font-normal">
          ${data.heroSubheadline}
        </p>
        
        <div class="flex flex-col sm:flex-row gap-4 pt-4">
          <a href="tel:${phone.replace(/[^\d+]/g, '')}" class="inline-flex items-center justify-center gap-3 px-8 py-4 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-base transition-all shadow-xl shadow-blue-600/20 active:scale-95">
            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/></svg>
            <span>Call Now: ${phone}</span>
          </a>
          <a href="#quote" class="inline-flex items-center justify-center px-8 py-4 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white border border-slate-700/60 font-semibold text-base transition-all active:scale-95">
            Get a Free Quote
          </a>
        </div>
      </div>
      <div class="lg:col-span-5 relative">
        <div class="absolute -inset-1 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-500 opacity-20 blur-xl"></div>
        <div class="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl aspect-[4/3]">
          <img src="${heroImage}" alt="${niche} in ${city}" class="w-full h-full object-cover">
        </div>
      </div>
    </div>
  </section>

  <!-- Services Section -->
  <section class="py-20 border-t border-slate-900 bg-slate-950 relative">
    <div class="max-w-7xl mx-auto px-6 relative space-y-12">
      <div class="text-center max-w-2xl mx-auto space-y-4">
        <h2 class="text-3xl font-bold text-white">Our Professional Services</h2>
        <p class="text-slate-400 text-sm">We provide expert, fully licensed, and highly experienced ${niche} services across ${city} and surrounding areas.</p>
      </div>
      
      <div class="grid md:grid-cols-3 gap-8">
        ${servicesHtml}
      </div>
    </div>
  </section>

  <!-- About Us Section -->
  <section class="py-20 border-t border-slate-900 bg-slate-900/30">
    <div class="max-w-7xl mx-auto px-6 grid md:grid-cols-2 gap-12 items-center">
      <div class="space-y-6">
        <h2 class="text-3xl font-bold text-white">About Us</h2>
        <div class="text-slate-400 space-y-4 text-sm leading-relaxed">
          ${data.aboutUsText ? data.aboutUsText.split('\n').map((p: string) => `<p>${p}</p>`).join('') : `<p>We are a dedicated local service provider in ${city}. We value safety, reliability, and top-tier workmanship.</p>`}
        </div>
        <ul class="grid sm:grid-cols-2 gap-3 pt-2">
          ${whyChooseUsHtml}
        </ul>
      </div>
      <div class="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 aspect-video">
        <img src="https://images.unsplash.com/photo-1504307651254-35680f356dfd?auto=format&fit=crop&w=800&q=80" alt="Worksite" class="w-full h-full object-cover">
      </div>
    </div>
  </section>

  <!-- Testimonials -->
  <section class="py-20 border-t border-slate-900 bg-slate-950">
    <div class="max-w-7xl mx-auto px-6 space-y-12">
      <div class="text-center max-w-2xl mx-auto">
        <h2 class="text-3xl font-bold text-white">What Our Customers Say</h2>
      </div>
      <div class="grid md:grid-cols-2 gap-8">
        ${testimonialsHtml}
      </div>
    </div>
  </section>

  <!-- Quote Form Section -->
  <section id="quote" class="py-20 border-t border-slate-900 bg-slate-900/30 relative">
    <div class="max-w-3xl mx-auto px-6">
      <div class="bg-slate-900 border border-slate-800 p-8 md:p-12 rounded-3xl space-y-6 shadow-2xl relative">
        <div class="text-center space-y-2">
          <h2 class="text-2xl font-bold text-white">Request a Free Estimate</h2>
          <p class="text-slate-400 text-xs">Fill out the form below and our team will get in touch shortly.</p>
        </div>
        
        <form id="contactForm" class="space-y-4">
          <div class="grid sm:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Name</label>
              <input type="text" required class="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-slate-100 text-sm focus:border-blue-500 focus:outline-none transition-all">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Phone</label>
              <input type="tel" required class="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-slate-100 text-sm focus:border-blue-500 focus:outline-none transition-all">
            </div>
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Email</label>
            <input type="email" required class="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-slate-100 text-sm focus:border-blue-500 focus:outline-none transition-all">
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Message</label>
            <textarea required rows="4" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-4 text-slate-100 text-sm focus:border-blue-500 focus:outline-none transition-all"></textarea>
          </div>
          <button type="submit" class="w-full inline-flex items-center justify-center px-6 py-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-base transition-all shadow-lg shadow-blue-600/10 active:scale-95">
            Submit Estimate Request
          </button>
        </form>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="mt-auto border-t border-slate-900 bg-slate-950 py-10">
    <div class="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
      <p class="text-xs text-slate-500">&copy; ${new Date().getFullYear()} ${city} ${niche} Pro. All rights reserved.</p>
      <div class="flex items-center gap-6 text-xs text-slate-400">
        <span>Call: ${phone}</span>
        <span>•</span>
        <span>SEO Optimized Local Asset</span>
      </div>
    </div>
  </footer>

  <!-- Floating Mobile CTA -->
  <div class="fixed bottom-6 right-6 z-40 sm:hidden">
    <a href="tel:${phone.replace(/[^\d+]/g, '')}" class="w-14 h-14 rounded-full bg-blue-600 hover:bg-blue-500 flex items-center justify-center text-white shadow-2xl shadow-blue-500/30 transition-all active:scale-95">
      <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/></svg>
    </a>
  </div>

  <!-- Form Success Popup -->
  <div id="successModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 opacity-0 pointer-events-none transition-all duration-300">
    <div class="bg-slate-900 border border-slate-800 p-8 rounded-3xl text-center max-w-sm space-y-4 mx-4 shadow-2xl">
      <div class="w-12 h-12 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center mx-auto">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
      </div>
      <h3 class="text-lg font-bold text-white">Estimate Request Received!</h3>
      <p class="text-xs text-slate-400">Thank you for reaching out. A local representative will contact you shortly.</p>
      <button onclick="closeModal()" class="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-sm font-semibold transition-all">Close</button>
    </div>
  </div>

  <script>
    const form = document.getElementById('contactForm');
    const modal = document.getElementById('successModal');
    
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      modal.classList.remove('opacity-0', 'pointer-events-none');
      form.reset();
    });
    
    function closeModal() {
      modal.classList.add('opacity-0', 'pointer-events-none');
    }
  </script>

</body>
</html>`;
}

// Generate landing page details using a robust template & fast LLM copy generation
export async function generateLandingPage(niche: string, city: string, phone: string, whisper: string): Promise<GeneratedSite> {
  const targetId = `site-target-${Date.now()}`;
  const prompt = `You are performing professional SEO copy writing for a local lead generation website.
We need to generate high-converting text content for a local service landing page.
Niche: "${niche}"
Location: "${city}"
Phone Number: "${phone}"

You must output a JSON object containing:
1. "siteTitle": SEO-optimized title (e.g. "Best ${niche} Services in ${city} | Free Quotes")
2. "metaDescription": SEO description containing the phone number
3. "primaryColor": Suggested hex color theme (e.g. "#2563eb", "#0284c7")
4. "heroHeadline": SEO-optimized hero headline (e.g. "Top-Rated ${niche} Specialists in ${city}")
5. "heroSubheadline": Conversion-focused subheadline prompting user to call
6. "aboutUsText": A detailed two-paragraph introduction about the local company's history, local pride, quality focus, and dedication to serving ${city}.
7. "services": An array of exactly 3 objects representing core services. Each object must have:
   * "title": string (e.g. "Residential Roofing")
   * "description": string (detailed service benefit description)
8. "whyChooseUs": An array of exactly 4 brief key advantages (e.g. "24/7 Emergency Support")
9. "testimonials": An array of exactly 2 customer reviews. Each object must have:
   * "name": string (e.g. "John D.")
   * "text": string (detailed positive feedback)
   * "stars": integer (usually 5)

Return ONLY valid JSON that matches the schema above. Do not wrap in conversational markdown text.`;

  const rawResponse = await callLlm(prompt, true);
  const data = cleanAndParseJson(rawResponse);
  const htmlCode = buildHtmlFromTemplate(data, niche, city, phone);

  return {
    id: `site-${Date.now()}`,
    targetId,
    niche,
    city,
    domainName: `${city.toLowerCase().replace(/\s+/g, '')}${niche.toLowerCase().replace(/\s+/g, '')}.com`,
    siteTitle: data.siteTitle,
    metaDescription: data.metaDescription,
    templateId: "modern-business",
    primaryColor: data.primaryColor || "#2563eb",
    heroHeadline: data.heroHeadline,
    heroSubheadline: data.heroSubheadline,
    services: (data.services || []).map((s: any) => s.title),
    htmlCode,
    createdAt: new Date().toISOString()
  };
}

// Error formatting helper for OpenRouter LLM errors.
export function formatLlmError(err: any): string {
  if (!err) return "An unknown error occurred.";
  const rawMsg = err.message || String(err);
  const lower = rawMsg.toLowerCase();

  // HTTP status codes from OpenRouter
  const httpMatch = rawMsg.match(/HTTP\s+(\d{3})/i);
  if (httpMatch) {
    const status = httpMatch[1];
    if (status === "401" || status === "403") {
      return (
        `OpenRouter returned HTTP ${status} (unauthorized).\n` +
        `Check that OPENROUTER_API_KEY is valid and has sufficient credits.\n` +
        `Get or check your key at https://openrouter.ai.`
      );
    }
    if (status === "429") {
      return (
        `OpenRouter returned HTTP 429 (rate limited).\n` +
        `You've exceeded your OpenRouter quota. Check your balance at openrouter.ai/keys.`
      );
    }
    if (status.startsWith("5")) {
      return (
        `OpenRouter returned HTTP ${status} (server error).\n` +
        `OpenRouter or the upstream provider may be experiencing an outage.`
      );
    }
    return `OpenRouter returned HTTP ${status}: ${rawMsg.slice(0, 300)}`;
  }

  // Connection-level failures
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("failed to fetch") ||
    lower.includes("fetch failed")
  ) {
    return (
      `Could not reach OpenRouter API at ${OPENROUTER_BASE_URL}.\n` +
      `Check your internet connection.`
    );
  }

  // Timeout
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return (
      `OpenRouter request timed out. The model may be under heavy load.\n` +
      `Try again in a few seconds.`
    );
  }

  // 200 OK but no content
  if (lower.includes("no message content")) {
    return (
      `OpenRouter returned a response with no message content.\n` +
      `This is unexpected — try again or check the OpenRouter API status.`
    );
  }

  return `NVIDIA LLM error: ${rawMsg.slice(0, 500)}`;
}



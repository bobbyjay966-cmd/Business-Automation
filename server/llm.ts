import { KeywordMetric, CompetitorData, ScrapedLead, GeneratedSite } from "../src/types";

import {
  fetchRealSearchSnippets,
  parseLeadsFromSearchContext,
  scrapeContactInfoFromUrl
} from "../.agent/skills/web-scraper/scripts/scraper-engine";

// Robust JSON cleaning and parsing helper
function cleanAndParseJson(text: string): any {
  let cleaned = text.trim();
  // Remove markdown code block wrappers if the model returned them
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, "");
    cleaned = cleaned.replace(/\n?```$/i, "");
    cleaned = cleaned.trim();
  }
  return JSON.parse(cleaned);
}

// ----------------------------------------------------------------
// NVIDIA AI — the ONLY LLM provider.
// Uses the OpenAI-compatible /chat/completions protocol via
// https://integrate.api.nvidia.com/v1. The 70B Llama 3.3 model
// supports json_object natively so no retry ladder is needed.
// ----------------------------------------------------------------

const NVIDIA_BASE_URL =
  process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
const NVIDIA_MODEL =
  process.env.NVIDIA_MODEL || "meta/llama-3.3-70b-instruct";

async function callLlm(prompt: string, jsonMode = true): Promise<string> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error(
      "NVIDIA_API_KEY is not set. Add it to your .env file.\n" +
      "Get a free key with credits at https://build.nvidia.com.",
    );
  }

  const targetUrl = `${NVIDIA_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  console.log(
    `[LLM:NVIDIA] Calling ${targetUrl} (model=${NVIDIA_MODEL})`,
  );

  const start = Date.now();
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: jsonMode
        ? [
            { role: "system", content: "You must return a valid json object." },
            { role: "user", content: prompt },
          ]
        : [{ role: "user", content: prompt }],
      response_format: jsonMode ? { type: "json_object" } : undefined,
      temperature: 0.2,
      top_p: 0.7,
      max_tokens: 2048,
    }),
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

    // Crawl actual website homepages for accurate, active phone/email info
    console.log(`[Scraper] Crawling websites for LLM extracted listings to verify actual phone/email...`);
    for (const lead of leads) {
      if (lead.website) {
        const contact = await scrapeContactInfoFromUrl(lead.website);
        if (contact.phone) lead.phone = cleanPhoneNumber(contact.phone);
        if (contact.email) {
          lead.email = contact.email;
          lead.notes = `[Verified Contact Info]\nEmail: ${contact.email}\nPhone: ${lead.phone || "Not found"}`;
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
    }
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

// Generate landing page details (HTML/Tailwind)
export async function generateLandingPage(niche: string, city: string, phone: string, whisper: string): Promise<GeneratedSite> {
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
    domainName: `${city.toLowerCase().replace(/\s+/g, '')}${niche.toLowerCase().replace(/\s+/g, '')}.com`,
    siteTitle: data.siteTitle,
    metaDescription: data.metaDescription,
    templateId: "modern-business",
    primaryColor: data.primaryColor || "#2563eb",
    heroHeadline: data.heroHeadline,
    heroSubheadline: data.heroSubheadline,
    services: data.services || [],
    htmlCode: data.htmlCode,
    createdAt: new Date().toISOString()
  };
}

// Error formatting helper for NVIDIA LLM errors.
export function formatLlmError(err: any): string {
  if (!err) return "An unknown error occurred.";
  const rawMsg = err.message || String(err);
  const lower = rawMsg.toLowerCase();

  // HTTP status codes from NVIDIA
  const httpMatch = rawMsg.match(/HTTP\s+(\d{3})/i);
  if (httpMatch) {
    const status = httpMatch[1];
    if (status === "401" || status === "403") {
      return (
        `NVIDIA LLM returned HTTP ${status} (unauthorized).\n` +
        `Check that NVIDIA_API_KEY is valid and not expired.\n` +
        `Get a fresh key at https://build.nvidia.com.`
      );
    }
    if (status === "429") {
      return (
        `NVIDIA LLM returned HTTP 429 (rate limited).\n` +
        `You've exceeded your NVIDIA API quota. Wait a few minutes or upgrade your plan.`
      );
    }
    if (status.startsWith("5")) {
      return (
        `NVIDIA LLM returned HTTP ${status} (server error).\n` +
        `NVIDIA's API may be experiencing an outage.`
      );
    }
    return `NVIDIA LLM returned HTTP ${status}: ${rawMsg.slice(0, 300)}`;
  }

  // Connection-level failures
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("failed to fetch") ||
    lower.includes("fetch failed")
  ) {
    return (
      `Could not reach NVIDIA API at ${NVIDIA_BASE_URL}.\n` +
      `Check your internet connection.`
    );
  }

  // Timeout
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return (
      `NVIDIA LLM request timed out. The 70B model may be under heavy load.\n` +
      `Try again in a few seconds.`
    );
  }

  // 200 OK but no content
  if (lower.includes("no message content")) {
    return (
      `NVIDIA LLM returned a response with no message content.\n` +
      `This is unexpected — try again or check the NVIDIA API status.`
    );
  }

  return `NVIDIA LLM error: ${rawMsg.slice(0, 500)}`;
}



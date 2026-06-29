name: local-lead-scraper-and-scoring-engine
description: Automated local business scraper optimized for extracting contact channels and algorithmically rating B2B lead viability for call-forwarding and automation services.
​Local Lead Scraper & Scoring Engine
​This skill extracts targeted local business listings across defined geographic regions, harvests direct communication channels, and applies a multi-factor viability heuristic to score leads specifically for automated call-forwarding and lead-routing solutions.
​Use this skill when:
​Hunting high-intent local service niches (e.g., HVAC, plumbing, roofing, towing, locksmiths) for targeted B2B client acquisition.
​Aggregating clean, non-duplicative phone numbers and email addresses directly from live organic footprints.
​Algorithmically qualifying prospects based on missed-revenue vulnerability (raw landlines, high-velocity local intent, lack of automated call infrastructure).
​Instructions:
​1. Targeted Search Phase
​Execute fetchRealSearchSnippets using hyper-localized queries: "[Niche] in [City, State]".
​Prioritize high-turnover, immediate-need industries where a missed call equals instant lost revenue for the business owner.
​Isolate the top organic search domains. Filter out major online directories (e.g., Yelp, YellowPages, Angi, Houzz) at the regex level during snippet parsing to ensure processing cycles are spent exclusively on direct business assets.
​2. Deep Extraction & Crawl Phase
​Asynchronously query the filtered target domains concurrently.
​Implement a rigid 5-second connection timeout and mirror a modern enterprise-grade User-Agent string to circumvent basic script-blocking and anti-scraping firewalls.
​Parse the raw HTML payload:
​Phone Numbers: Extract using the primary US format match: /(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/
​Emails: Extract clean strings using: /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/. Programmatically discard standard asset matches disguised as emails (e.g., strings ending in .jpg, .png, .webp, .gif).
​3. Lead Viability Heuristic (Call-Forwarding Scoring Engine)
​Evaluate each parsed business record on a scale of 0 to 100 based on operational vulnerability indicators:
​Phone Presence (Mandatory - Baseline Rule): The system must verify an active phone number asset. If no direct phone number is extracted, immediately drop the score to 0 and terminate processing for that record.
​High-Intent Niche Factor (+40 points): Assign maximum weight to emergency-response and high-ticket local service sectors (e.g., 24/7 Towing, Emergency Plumbing, Roof Repair) where booking success is entirely dictated by rapid phone availability.
​Automation Deficit Detection (+40 points): Analyze the page source code for the absence of call tracking, interactive voice response (IVR) platforms, or unified communication scripts (e.g., missing Twilio, RingCentral, or specialized software snippets). If the site relies on a raw, un-tracked static tel: link, award maximum points for automation deficit.
​Lead Capture Gap (+20 points): Check for the total absence of interactive digital booking widgets, modern CRM forms, or live chat modules. High points here indicate the business is completely dependent on raw incoming voice calls to secure revenue, making them ideal clients for a bulletproof forwarding engine.
​4. Direct Action Output Formatting
​Construct the final structural JSON array containing 100% verified, live data. No placeholder metrics, mock fields, or empty dummy values are permitted. Every object must output exactly:

[
  {
    "business_name": "Cleaned Business Name String",
    "city_location": "Target Market City, State",
    "phone_number": "Verified Direct Dial Number",
    "email_address": "Extracted Communication Channel or null",
    "viability_score": 85,
    "pitch_trigger": "High-intent emergency niche operating on un-tracked static landline channel with zero digital lead capture alternatives."
  }
]

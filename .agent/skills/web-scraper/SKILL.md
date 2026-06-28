---
name: web-scraper
description: Real-world business lookup, search result parsing, and homepage contact information crawler (emails and phone numbers).
---

# Web Scraper Skill

This skill performs accurate, real-world local business lookup and crawls their official website homepages to extract verified contact information (phone numbers and emails).

## Use this skill when:
- Gathering real local business listings for lead generation.
- Qualify leads based on GMB status, review counts, and website existence.
- Crawling business websites for emails, addresses, and phone numbers.
- Replacing simulated/mock data with actual live web content.

## Instructions:
1. **Search Phase**: Use `fetchRealSearchSnippets` to query DuckDuckGo for the city/niche keywords and obtain organic search titles and decoded target domains.
2. **Parsing Phase**: Extract listing blocks. Clean the title to get the actual business name. Parse target domain URLs.
3. **Crawl Phase (Direct Site Scrape)**: For every domain found, make an asynchronous GET request to the homepage. Set a realistic `User-Agent` and a 5-second connection timeout.
4. **Extraction Phase**:
   - Strip scripts, styles, and tags to get clean visible text.
   - Run a strict US phone number regex: `/(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/`
   - Run a strict email regex: `/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/` (filter out static assets like image extensions).
5. **Formatting Phase**: Merge the parsed details, fallback to templates if search is completely down, and ensure no fake placeholder phone numbers are ever returned.

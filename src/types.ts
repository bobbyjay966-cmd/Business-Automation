export interface KeywordMetric {
  keyword: string;
  searchVolume: number;
  difficulty: number; // 0-100
  competition: 'Low' | 'Medium' | 'High';
  cpc: number;
}

export interface CompetitorData {
  domain: string;
  rank: number;
  estimatedTraffic: number;
  backlinksCount: number;
}

export interface NicheCityTarget {
  id: string;
  niche: string;
  city: string;
  status: 'researching' | 'site_created' | 'active_leads' | 'rented';
  monthlyVolume: number;
  avgDifficulty: number;
  competitors: CompetitorData[];
  keywords: KeywordMetric[];
  gmbScore: number; // Google Business Profile score (0-100)
  /** ISO timestamp of the most recent successful scrape. Drives the
   *  autopilot's 24h re-scrape priority queue (P2). Optional for backward
   *  compat with DB rows written before this field was added. */
  lastScrapedAt?: string;
  createdAt: string;
}

export interface ScrapedLead {
  id: string;
  targetId: string;
  niche: string;
  city: string;
  name: string;
  website: string | null;
  phone: string | null;
  rating: number;
  reviewCount: number;
  address: string;
  gmbStatus: 'Unclaimed' | 'Claimed' | 'Unknown';
  pitchStatus: 'Scraped' | 'Pitched' | 'Trial' | 'Rented' | 'Disqualified';
  pitchEmailContent?: string;
  pitchSmsContent?: string;
  trialEmailContent?: string;
  trialEmailSent?: boolean;
  email?: string;
  notes?: string;
  trackingNumber?: string;
  siteUrl?: string;
  // Stripe auto-subscription fields
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeSubscriptionStatus?: 'active' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid' | 'paused' | string;
  stripeInvoiceId?: string;
  stripeInvoiceUrl?: string;
  stripeInvoiceNumber?: string;
  // Lifecycle of the invoice itself, separate from the subscription status.
  // Tracks: 'draft' → 'open' → 'paid' | 'void' | 'uncollectible' | 'refunded'.
  stripeInvoiceStatus?: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible' | 'refunded' | string;
  // Last charge refunded (full or partial) — recorded so the UI/feed can
  // link back to Stripe's refund record without an extra fetch.
  stripeChargeRefundedId?: string;
  subscriptionAmount?: number; // Amount in cents (default 45000 = $450.00)
  subscriptionCurrency?: string; // 'usd' by default
  subscriptionNextDueDate?: string; // ISO date when next invoice is due
  subscriptionStartDate?: string; // ISO date of first invoice creation
  subscriptionLastPaidAt?: string; // ISO timestamp of most recent successful payment
  subscriptionMode?: 'live'; // Always live — the app no longer supports mock Stripe mode.
  createdAt: string;
}

export interface OperatorNotification {
  id: string;
  type: 'invoice_created' | 'subscription_activated' | 'subscription_failed' | 'firebase_domain_warning' | 'system';
  title: string;
  message: string;
  metadata?: Record<string, any>;
  read?: boolean;
  createdAt: string;
}

export interface TrackingNumber {
  id: string;
  targetId?: string; // Optional links to target market
  phoneNumber: string;
  friendlyName: string;
  forwardTo: string; // The real local business owner's number
  whisperMessage: string; // Text spoken to owner before connecting
  recordCalls: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface CallLog {
  id: string;
  trackingNumberId: string;
  trackingNumber: string;
  callerNumber: string;
  callerLocation: string;
  forwardTo: string;
  durationSeconds: number;
  status: 'completed' | 'no-answer' | 'busy' | 'failed';
  recordingUrl?: string;
  dateCreated: string;
}

export interface GeneratedSite {
  id: string;
  targetId: string;
  niche: string;
  city: string;
  domainName: string;
  siteTitle: string;
  metaDescription: string;
  templateId: 'modern-business' | 'bold-builder' | 'clean-clinic';
  primaryColor: string;
  heroHeadline: string;
  heroSubheadline: string;
  services: string[];
  htmlCode: string;
  deploymentUrl?: string;
  createdAt: string;
}

/**
 * CallRail API client — shared between `server.ts` (manual `/api/numbers`
 * endpoint + webhook registration on boot) and `server/autopilot.ts`
 * (auto-provisioning from the decision loop).
 *
 * Pure production paths. No fabricated phone numbers, no mock APIs.
 * Every helper here issues a real HTTP call against
 * https://api.callrail.com/v3 using `CALLRAIL_API_KEY` from the env.
 */
import crypto from 'crypto';

const BASE_URL = 'https://api.callrail.com/v3';

// Module-level cache so repeated tick calls don't re-fetch the
// account / company tree on every invocation.
let cachedAccountId: string | null = null;
let cachedCompanyId: string | null = null;

export function isCallRailEnabled(): boolean {
  return !!process.env.CALLRAIL_API_KEY;
}

async function callCallRailApi(
  method: string,
  params: Record<string, any> = {},
  httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
): Promise<any> {
  const apiKey = process.env.CALLRAIL_API_KEY;
  if (!apiKey) {
    throw new Error(
      'CallRail API key is not configured. Set CALLRAIL_API_KEY in your .env to enable real CallRail provisioning.',
    );
  }
  let url = `${BASE_URL}${method}`;
  const options: RequestInit = {
    method: httpMethod,
    headers: {
      Authorization: `Token token=${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
  if (httpMethod === 'GET') {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += `?${qs}`;
  } else {
    options.body = JSON.stringify(params);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    let errorDetail = '';
    try {
      const j = await response.json();
      errorDetail = `: ${JSON.stringify(j)}`;
    } catch {
      try {
        errorDetail = `: ${await response.text()}`;
      } catch {
        // ignore
      }
    }
    throw new Error(`CallRail API request failed: ${response.statusText} (${response.status})${errorDetail}`);
  }
  return response.json();
}

export async function getCallRailAccountAndCompany(): Promise<{ accountId: string; companyId: string }> {
  if (cachedAccountId && cachedCompanyId) {
    return { accountId: cachedAccountId, companyId: cachedCompanyId };
  }
  const accountsRes = await callCallRailApi('/a.json', {}, 'GET');
  let accounts: any[] = [];
  if (Array.isArray(accountsRes)) accounts = accountsRes;
  else if (Array.isArray(accountsRes.accounts)) accounts = accountsRes.accounts;
  else if (accountsRes.data && Array.isArray(accountsRes.data)) accounts = accountsRes.data;
  if (accounts.length === 0) throw new Error('No accounts found in your CallRail profile.');
  const accountId = accounts[0].id;

  const companiesRes = await callCallRailApi(`/a/${accountId}/companies.json`, {}, 'GET');
  let companies: any[] = [];
  if (Array.isArray(companiesRes)) companies = companiesRes;
  else if (Array.isArray(companiesRes.companies)) companies = companiesRes.companies;
  else if (companiesRes.data && Array.isArray(companiesRes.data)) companies = companiesRes.data;
  if (companies.length === 0) throw new Error('No companies found in your CallRail profile.');
  const companyId = companies[0].id;

  cachedAccountId = String(accountId);
  cachedCompanyId = String(companyId);
  return { accountId: cachedAccountId, companyId: cachedCompanyId };
}

// Resets the cached account / company IDs. Test-only.
export function _resetCallRailCache(): void {
  cachedAccountId = null;
  cachedCompanyId = null;
}

export interface ProvisionTrackerArgs {
  /** Display name shown in the CallRail UI, e.g. "Dallas Roofing Forwarder". */
  name: string;
  /** 3-digit area code for the new tracking number (default 214 = Dallas). */
  areaCode?: string;
  /** E.164-formatted destination number (e.g. "+12145551234"). */
  forwardTo: string;
  /** Whisper message spoken to the recipient before connecting. */
  whisperMessage?: string;
  /** Whether to record the bridged calls. */
  recordCalls?: boolean;
}

export interface ProvisionTrackerResult {
  phoneNumber: string;
  trackerId: string;
}

/**
 * Provision a real CallRail source tracker with a fresh tracking number
 * in the requested area code, forwarding calls to `forwardTo`. Persists
 * nothing — the caller is responsible for writing the returned values
 * to the DB. Throws on API error or missing required fields.
 */
export async function provisionCallRailTracker(args: ProvisionTrackerArgs): Promise<ProvisionTrackerResult> {
  const { accountId, companyId } = await getCallRailAccountAndCompany();

  // Normalize the destination into E.164 so CallRail doesn't reject it.
  const cleanForwardTo = args.forwardTo.replace(/[^\d+]/g, '');
  let formattedForwardTo = cleanForwardTo;
  if (cleanForwardTo.length === 10) {
    formattedForwardTo = `+1${cleanForwardTo}`;
  } else if (cleanForwardTo.length === 11 && cleanForwardTo.startsWith('1')) {
    formattedForwardTo = `+${cleanForwardTo}`;
  } else if (!cleanForwardTo.startsWith('+')) {
    formattedForwardTo = `+${cleanForwardTo}`;
  }

  const trackerRes = await callCallRailApi(`/a/${accountId}/trackers.json`, {
    name: args.name,
    company_id: companyId,
    type: 'source',
    source: { type: 'offline' },
    tracking_number: { area_code: args.areaCode || '214' },
    call_flow: {
      type: 'basic',
      recording_enabled: !!args.recordCalls,
      destination_number: formattedForwardTo,
      ...(args.whisperMessage ? { whisper_message: args.whisperMessage } : {}),
    },
  }, 'POST');

  const tracker = trackerRes?.tracker ?? trackerRes;
  const phoneNumber =
    tracker?.phone_number
    || tracker?.tracking_phone_number
    || (Array.isArray(tracker?.tracking_numbers) ? tracker.tracking_numbers[0]?.phone_number || tracker.tracking_numbers[0] : null);
  const trackerId = String(tracker?.id || '');
  if (!phoneNumber) {
    throw new Error('CallRail did not return a tracking number in the response.');
  }
  return { phoneNumber: String(phoneNumber), trackerId };
}

/**
 * Register the post-call webhook URL against the configured CallRail
 * account. Idempotent — if the URL is already registered this still
 * returns 200 from CallRail.
 */
export async function registerCallRailWebhook(args: { url: string }): Promise<void> {
  const { accountId, companyId } = await getCallRailAccountAndCompany();
  await callCallRailApi(`/a/${accountId}/integrations.json`, {
    type: 'Webhooks',
    company_id: companyId,
    config: { post_call_webhook: [args.url] },
  }, 'POST');
}

/**
 * Verify the HMAC-SHA1 signature CallRail attaches to every webhook body.
 * Returns true when the signature matches; false otherwise.
 */
export function verifyCallRailSignature(rawBody: string, signature: string, signingKey: string): boolean {
  const calc = crypto.createHmac('sha1', signingKey).update(rawBody).digest('base64');
  return calc === signature;
}

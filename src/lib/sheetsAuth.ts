import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { ScrapedLead } from '../types';

// Reuse initialized app or initialize new one safely
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();
// Add all Google Sheets & Drive scopes requested
provider.addScope('https://www.googleapis.com/auth/drive.file');
provider.addScope('https://www.googleapis.com/auth/spreadsheets');

let isSigningIn = false;
let cachedAccessToken: string | null = null;

// Initialize auth state listener
export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      // In a real app, if cachedAccessToken is lost (e.g. page reload), 
      // the user might need to re-click sign-in to refresh the access token,
      // or we can read it from a session/cookie if available.
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else {
        // If we don't have the cached token but the user is signed in, we can ask them to sign in again to get the token.
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

// Start Google sign-in with pop-up
export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to retrieve OAuth access token from Google.');
    }

    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Google Sheets sign-in error:', error);
    // Re-throw with a friendly, actionable message for the specific
    // Firebase auth/unauthorized-domain error which the user reported.
    if (
      typeof error?.code === 'string' &&
      error.code === 'auth/unauthorized-domain'
    ) {
      const friendly = new Error(
        `Firebase: Error (auth/unauthorized-domain) — The current host ` +
        `'${window?.location?.hostname || 'this app'}' is not whitelisted in your Firebase project ` +
        `'${(firebaseConfig as any)?.projectId || 'firebase project'}'. To fix:\n\n` +
        `  1. Open https://console.firebase.google.com/project/${(firebaseConfig as any)?.projectId || ''}/authentication/settings\n` +
        `  2. Scroll to "Authorized domains"\n` +
        `  3. Click "Add domain" and add '${window?.location?.hostname || 'your-deploy-domain'}' (and any other host you deploy to)\n\n` +
        `  Localhost is normally allowed by default; if it's missing, add it too.`
      );
      // Preserve original error code for detection in the UI
      (friendly as any).code = error.code;
      (friendly as any).hostname = window?.location?.hostname;
      (friendly as any).projectId = (firebaseConfig as any)?.projectId;
      throw friendly;
    }
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = (): string | null => {
  return cachedAccessToken;
};

export const logout = async () => {
  await auth.signOut();
  cachedAccessToken = null;
};

/**
 * Creates a new Google Spreadsheet and initializes headers.
 */
export async function createSpreadsheet(accessToken: string, title: string): Promise<string> {
  const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        title: title,
      },
      sheets: [
        {
          properties: {
            title: 'Contacted Leads',
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || 'Failed to create Google Spreadsheet.');
  }

  const data = await response.json();
  const spreadsheetId = data.spreadsheetId;

  // Add the header row immediately
  await appendValuesToSpreadsheet(accessToken, spreadsheetId, 'Contacted Leads!A1', [
    [
      'Business Name',
      'Niche',
      'City',
      'Phone',
      'Website',
      'Rating',
      'Reviews',
      'Address',
      'GMB Status',
      'CRM Status',
      'Notes',
      'Date Generated',
    ],
  ]);

  return spreadsheetId;
}

/**
 * Appends raw rows of values to a specific range in a Google Sheet.
 */
export async function appendValuesToSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  values: any[][]
): Promise<any> {
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
      range
    )}:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        range,
        majorDimension: 'ROWS',
        values,
      }),
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || 'Failed to append data to Google Sheet.');
  }

  return response.json();
}

/**
 * Format and append lead details to Google Sheets.
 */
export async function appendLeadsToSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
  leads: ScrapedLead[]
): Promise<void> {
  if (leads.length === 0) return;

  const rows = leads.map((lead) => [
    lead.name,
    lead.niche,
    lead.city,
    lead.phone || 'N/A',
    lead.website || 'N/A',
    lead.rating,
    lead.reviewCount,
    lead.address,
    lead.gmbStatus,
    lead.pitchStatus,
    lead.notes || '',
    lead.createdAt,
  ]);

  await appendValuesToSpreadsheet(accessToken, spreadsheetId, 'Contacted Leads!A1', rows);
}

import "server-only";

import { SignJWT, importPKCS8 } from "jose";
import type { SheetRow } from "./types";

// Minimal Google Sheets client. Avoids the `googleapis` dependency:
// - Sign a JWT with the service account private key (RS256)
// - Trade it for a short-lived OAuth access token
// - Call sheets.googleapis.com directly with fetch
// Token is cached in module scope until ~1 minute before expiry.

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch seconds
}

let cached: CachedToken | null = null;

function parseServiceAccount(raw: string): ServiceAccountKey {
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as ServiceAccountKey).client_email !== "string" ||
    typeof (parsed as ServiceAccountKey).private_key !== "string"
  ) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key",
    );
  }
  return parsed as ServiceAccountKey;
}

async function fetchAccessToken(serviceAccountJson: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - 60 > now) {
    return cached.accessToken;
  }

  const sa = parseServiceAccount(serviceAccountJson);
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const privateKey = await importPKCS8(sa.private_key, "RS256");

  const assertion = await new SignJWT({
    scope: "https://www.googleapis.com/auth/spreadsheets",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setAudience(tokenUri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cached = {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in,
  };
  return data.access_token;
}

export interface AppendRowsArgs {
  serviceAccountJson: string;
  sheetId: string;
  tabName: string;
  rows: SheetRow[];
}

export interface AppendRowsResult {
  updatedRange: string | null;
  appendedRows: number;
}

// Appends rows to the bottom of the named tab. Uses USER_ENTERED so currency
// formatting renders the way the accountant expects (₱-prefixed, formulas
// evaluated). INSERT_ROWS keeps the appended rows separate from any tracked
// table on the tab.
export async function appendRowsToTab({
  serviceAccountJson,
  sheetId,
  tabName,
  rows,
}: AppendRowsArgs): Promise<AppendRowsResult> {
  if (rows.length === 0) {
    return { updatedRange: null, appendedRows: 0 };
  }

  const accessToken = await fetchAccessToken(serviceAccountJson);
  const range = encodeURIComponent(`${tabName}!A1`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ values: rows }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Google Sheets append failed (${res.status}) for tab "${tabName}": ${text}`,
    );
  }

  const data = (await res.json()) as {
    updates?: { updatedRange?: string; updatedRows?: number };
  };

  return {
    updatedRange: data.updates?.updatedRange ?? null,
    appendedRows: data.updates?.updatedRows ?? rows.length,
  };
}

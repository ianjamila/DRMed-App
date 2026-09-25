import { SignJWT, importPKCS8 } from "jose";

// Shared Google service-account OAuth token exchange. Not `server-only`: the
// sheet-sync CLI (a plain node script) imports it directly. It holds no
// secret of its own — the caller passes the service-account JSON and the
// scope it wants a token for.
//
// - Sign a JWT with the service account private key (RS256)
// - Trade it for a short-lived OAuth access token
// - Call the token endpoint directly with fetch (no `googleapis` dependency)
//
// Tokens are cached in module scope, keyed by `${client_email}|${scope}`,
// until ~1 minute before expiry.

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch seconds
}

const cache = new Map<string, CachedToken>();

export function __resetTokenCacheForTests(): void {
  cache.clear();
}

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

/**
 * Exchanges a Google service-account key for a short-lived OAuth access
 * token scoped to `scope`, caching per `client_email|scope` until ~1 minute
 * before expiry.
 */
export async function getServiceAccountToken(
  serviceAccountJson: string,
  scope: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const sa = parseServiceAccount(serviceAccountJson);
  const cacheKey = `${sa.client_email}|${scope}`;
  const now = Math.floor(Date.now() / 1000);
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt - 60 > now) {
    return hit.accessToken;
  }

  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const privateKey = await importPKCS8(sa.private_key, "RS256");

  const assertion = await new SignJWT({ scope })
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

  const res = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("Google token exchange returned no access token");
  }
  cache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: now + Number(data.expires_in),
  });
  return data.access_token;
}

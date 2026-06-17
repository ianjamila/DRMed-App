import "server-only";
import { SITE } from "@/lib/marketing/site";
import { reportError } from "@/lib/observability/report-error";
import { audit } from "@/lib/audit/log";
import {
  INDEXNOW_ENDPOINT,
  buildIndexNowPayload,
  buildPingAuditMetadata,
  indexNowEnabled,
} from "./indexnow-core";
import { buildSitemapEntries } from "./sitemap-entries";

export interface IndexNowResult {
  ok: boolean;
  submitted: number;
  skipped?: "disabled" | "no-urls";
}

export interface IndexNowActor {
  id: string;
  ip: string | null;
  ua: string | null;
}

/**
 * Best-effort IndexNow submission. Never throws; failures go to reportError.
 * MUST be awaited by callers — Vercel can freeze the function before a
 * fire-and-forget request completes.
 *
 * After any real POST attempt (success OR failure) writes one
 * `seo.indexnow.ping` audit row so auto-pings are verifiable in-app. The
 * disabled (non-production) path writes nothing — no ping actually fires.
 */
export async function submitToIndexNow(
  urls: string[],
  opts: { trigger: string; actor?: IndexNowActor },
): Promise<IndexNowResult> {
  if (!indexNowEnabled(process.env as { VERCEL_ENV?: string; INDEXNOW_KEY?: string })) {
    return { ok: true, submitted: 0, skipped: "disabled" };
  }

  const base = SITE.url.replace(/\/$/, "");
  let host: string;
  try {
    host = new URL(base).host;
  } catch (error) {
    await reportError({ scope: "seo/indexnow", error, metadata: { trigger: opts.trigger, base } });
    return { ok: false, submitted: 0 };
  }

  // Non-null: indexNowEnabled() guarantees a non-empty key.
  const key = process.env.INDEXNOW_KEY as string;
  const keyLocation = `${base}/indexnow-key.txt`;
  const payload = buildIndexNowPayload({ urls, key, host, keyLocation });
  if (!payload) return { ok: true, submitted: 0, skipped: "no-urls" };

  const recordPing = async (result: IndexNowResult): Promise<void> => {
    await audit({
      actor_id: opts.actor?.id ?? null,
      actor_type: opts.actor ? "staff" : "system",
      action: "seo.indexnow.ping",
      resource_type: "seo",
      metadata: buildPingAuditMetadata(result, {
        trigger: opts.trigger,
        payloadUrls: payload.urlList,
      }),
      ip_address: opts.actor?.ip ?? null,
      user_agent: opts.actor?.ua ?? null,
    });
  };

  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      await reportError({
        scope: "seo/indexnow",
        error: new Error(`IndexNow responded ${res.status}`),
        metadata: { trigger: opts.trigger, count: payload.urlList.length, status: res.status },
      });
      const result: IndexNowResult = { ok: false, submitted: 0 };
      await recordPing(result);
      return result;
    }
    const result: IndexNowResult = { ok: true, submitted: payload.urlList.length };
    await recordPing(result);
    return result;
  } catch (error) {
    await reportError({
      scope: "seo/indexnow",
      error,
      metadata: { trigger: opts.trigger, count: payload.urlList.length },
    });
    const result: IndexNowResult = { ok: false, submitted: 0 };
    await recordPing(result);
    return result;
  }
}

/** Every public URL in the sitemap — for the manual full-submit. */
export async function allSiteUrls(): Promise<string[]> {
  const entries = await buildSitemapEntries();
  return entries.map((e) => e.url);
}

import "server-only";
import { SITE } from "@/lib/marketing/site";
import { reportError } from "@/lib/observability/report-error";
import {
  INDEXNOW_ENDPOINT,
  buildIndexNowPayload,
  indexNowEnabled,
} from "./indexnow-core";
import { buildSitemapEntries } from "./sitemap-entries";

export interface IndexNowResult {
  ok: boolean;
  submitted: number;
  skipped?: "disabled" | "no-urls";
}

/**
 * Best-effort IndexNow submission. Never throws; failures go to reportError.
 * MUST be awaited by callers — Vercel can freeze the function before a
 * fire-and-forget request completes.
 */
export async function submitToIndexNow(
  urls: string[],
  opts: { trigger: string },
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
      return { ok: false, submitted: 0 };
    }
    return { ok: true, submitted: payload.urlList.length };
  } catch (error) {
    await reportError({
      scope: "seo/indexnow",
      error,
      metadata: { trigger: opts.trigger, count: payload.urlList.length },
    });
    return { ok: false, submitted: 0 };
  }
}

/** Every public URL in the sitemap — for the manual full-submit. */
export async function allSiteUrls(): Promise<string[]> {
  const entries = await buildSitemapEntries();
  return entries.map((e) => e.url);
}

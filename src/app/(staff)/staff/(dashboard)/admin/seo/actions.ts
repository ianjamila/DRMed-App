"use server";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { reportError } from "@/lib/observability/report-error";
import { allSiteUrls, submitToIndexNow } from "@/lib/seo/indexnow";

export type ResubmitResult =
  | { ok: true; data: { submitted: number; total: number; skipped: string | null } }
  | { ok: false; error: string };

export async function resubmitAllToIndexNowAction(): Promise<ResubmitResult> {
  const session = await requireAdminStaff();

  let urls: string[];
  try {
    urls = await allSiteUrls();
  } catch (error) {
    await reportError({ scope: "seo/indexnow", error, metadata: { trigger: "manual.full" } });
    return { ok: false, error: "Could not build the page list. Check the server logs." };
  }

  // submitToIndexNow writes the `seo.indexnow.ping` audit row itself (trigger
  // "manual.full"), so no separate audit() call is needed here.
  const { ip, ua } = await ipAndAgent();
  const res = await submitToIndexNow(urls, {
    trigger: "manual.full",
    actor: { id: session.user_id, ip, ua },
  });

  if (!res.ok) {
    return { ok: false, error: "IndexNow submission failed. Check the server logs." };
  }
  return {
    ok: true,
    data: { submitted: res.submitted, total: urls.length, skipped: res.skipped ?? null },
  };
}

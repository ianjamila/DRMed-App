"use server";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
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
  const res = await submitToIndexNow(urls, { trigger: "manual.full" });

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "seo.indexnow.full_submit",
    resource_type: "seo",
    metadata: {
      count: urls.length,
      submitted: res.submitted,
      ok: res.ok,
      skipped: res.skipped ?? null,
    },
    ip_address: ip,
    user_agent: ua,
  });

  if (!res.ok) {
    return { ok: false, error: "IndexNow submission failed. Check the server logs." };
  }
  return {
    ok: true,
    data: { submitted: res.submitted, total: urls.length, skipped: res.skipped ?? null },
  };
}

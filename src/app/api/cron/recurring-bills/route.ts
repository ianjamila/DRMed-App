import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { todayManilaISODate } from "@/lib/dates/manila";
import { audit } from "@/lib/audit/log";

export const dynamic = "force-dynamic";

const MAX_ITERATIONS_PER_TEMPLATE = 12;

type RpcResult = {
  bill_id?: string;
  next_run_date?: string;
  skipped?: boolean;
  reason?: string;
};

function asRpcObject(v: unknown): RpcResult {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as RpcResult;
  return {};
}

// Vercel Cron sends GET by default.
export async function GET(request: Request) {
  // 1. Authenticate via shared CRON_SECRET.
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const today = todayManilaISODate();
  const admin = createAdminClient();

  // 2. Query templates whose next_run_date is on or before today.
  const { data: templates, error } = await admin
    .from("recurring_bill_templates")
    .select("id")
    .eq("is_active", true)
    .lte("next_run_date", today);

  if (error) {
    await reportError({ scope: "cron/recurring-bills:query", error });
    return Response.json({ error: "query failed" }, { status: 500 });
  }

  let processed = 0;
  let draftsCreated = 0;
  const failures: Array<{ template_id: string; error: string }> = [];

  // 3. Loop per template, with isolation: a failing template must not stop the others.
  for (const t of templates ?? []) {
    processed += 1;
    try {
      let iters = 0;
      while (iters < MAX_ITERATIONS_PER_TEMPLATE) {
        const { data, error: rpcErr } = await admin.rpc("ap_post_recurring_template", {
          p_template_id: t.id,
        });
        if (rpcErr) throw new Error(rpcErr.message);
        const result = asRpcObject(data);
        if (result.skipped) break;
        if (!result.bill_id) break;
        draftsCreated += 1;
        iters += 1;
      }
      if (iters >= MAX_ITERATIONS_PER_TEMPLATE) {
        throw new Error(
          `Iteration limit reached (${MAX_ITERATIONS_PER_TEMPLATE}); next_run_date may be stuck`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reportError({
        scope: "cron/recurring-bills:template",
        error: err,
        metadata: { template_id: t.id },
      });
      await audit({
        actor_id: null,
        actor_type: "system",
        action: "recurring_template.fire_failed",
        resource_type: "recurring_bill_template",
        resource_id: t.id,
        metadata: { error: msg, run_date: today },
      });
      failures.push({ template_id: t.id, error: msg });
    }
  }

  return Response.json({ processed, drafts_created: draftsCreated, failures });
}

import { notFound, redirect } from "next/navigation";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";

import { PreviewClient } from "./preview-client";

export const metadata = { title: "HMO history import — preview" };
export const dynamic = "force-dynamic";

export default async function PreviewPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  await requireAdminStaff();
  const { runId } = await params;
  const supabase = createAdminClient();

  const { data: run } = await supabase
    .from("hmo_import_runs")
    .select("*")
    .eq("id", runId)
    .single();
  if (!run) notFound();
  if (run.committed_at) {
    redirect(`/staff/admin/accounting/hmo-history/${runId}/committed`);
  }

  // Validation re-runs on every mount of the preview client (useEffect →
  // validateRunAction). The server load below pulls staging rows so we can
  // render the errors table + skipped count immediately, without waiting on
  // the validate round-trip.
  const { data: staging } = await supabase
    .from("hmo_history_staging")
    .select(
      "provider_name_raw, service_name_raw, source_tab, status, validation_errors, source_date, source_row_no, billed_amount",
    )
    .eq("run_id", runId)
    .limit(50_000);

  // Provider + service dropdown options for the alias-mapping panels.
  const [providersR, servicesR] = await Promise.all([
    supabase
      .from("hmo_providers")
      .select("id, name")
      .eq("is_active", true)
      .order("name", { ascending: true }),
    supabase
      .from("services")
      .select("id, name, kind")
      .eq("is_active", true)
      .order("name", { ascending: true }),
  ]);

  // Reconciliation seed from the run summary (stashed by validateRunAction).
  // Loose-typed: summary is `Json` in the DB type so we narrow with a cast.
  const reconciliation =
    (run.summary as { reconciliation_computed?: unknown[] } | null)
      ?.reconciliation_computed ?? [];

  // `staging.validation_errors` is `Json` in the DB type; the parent
  // PreviewClient narrows it to the validated shape. Same for reconciliation:
  // `run.summary` is `Json` so we cast at the boundary.
  return (
    <PreviewClient
      run={run}
      staging={(staging ?? []) as unknown as Parameters<typeof PreviewClient>[0]["staging"]}
      reconciliation={
        reconciliation as unknown as Parameters<typeof PreviewClient>[0]["reconciliation"]
      }
      providers={providersR.data ?? []}
      services={servicesR.data ?? []}
    />
  );
}

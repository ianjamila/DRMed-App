"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { validateRunAction, discardRunAction } from "../actions";

import { CountsPanel } from "./sections/counts-panel";
import { UnmappedProvidersPanel } from "./sections/unmapped-providers-panel";
import { UnmappedServicesPanel } from "./sections/unmapped-services-panel";
import { ReconciliationPanel } from "./sections/reconciliation-panel";
import { ErrorsTable } from "./sections/errors-table";
import { CommitFooter } from "./sections/commit-footer";

// Staging row shape is loosely typed because the page server-loads with
// `select("provider_name_raw, …")` — Supabase types collapse to `unknown` on
// dynamic projections. Same for `run.summary` (Json) and reconciliation rows.
// We cast with `as` at the boundary; downstream components are properly typed.
interface PreviewRun {
  id: string;
  file_name: string;
  cutover_date: string;
  started_at: string;
  staging_count: number;
  summary: unknown;
}

interface StagingRowLite {
  status: string;
  source_tab: string;
  source_row_no: number;
  validation_errors: { severity: "error" | "warning" | "info"; code: string; message: string }[] | null;
}

interface ReconciliationRow {
  provider_id: string;
  provider_name: string;
  wb_ending_php: number | null;
  staged_ar_php: number;
  variance_pct: number | null;
  severity: "green" | "yellow" | "red" | "no_reference";
}

interface Provider {
  id: string;
  name: string;
}

interface Service {
  id: string;
  name: string;
  kind: string;
}

interface Props {
  run: PreviewRun;
  staging: StagingRowLite[];
  reconciliation: ReconciliationRow[];
  providers: Provider[];
  services: Service[];
}

type ValidationData = {
  error_count: number;
  warning_count: number;
  unmapped_providers: { alias: string; row_count: number }[];
  unmapped_services: {
    alias: string;
    kind: "lab_test" | "doctor_consultation";
    row_count: number;
  }[];
  reconciliation: ReconciliationRow[];
};

export function PreviewClient({ run, staging, reconciliation, providers, services }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [validationData, setValidationData] = useState<ValidationData | null>(null);

  useEffect(() => {
    startTransition(async () => {
      const res = await validateRunAction({ run_id: run.id });
      if (res.ok) setValidationData(res.data);
    });
  }, [run.id]);

  const skipPostCutover = staging.filter((r) => r.status === "skipped_post_cutover").length;
  const errors = staging
    .flatMap((r) =>
      (r.validation_errors ?? []).map((e) => ({
        severity: e.severity,
        source_tab: r.source_tab,
        source_row_no: r.source_row_no,
        code: e.code,
        message: e.message,
      })),
    )
    .sort((a, b) => a.source_row_no - b.source_row_no);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-8 pb-40">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">
          Run <span className="font-mono text-base">{run.id.slice(0, 8)}…</span>
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          File: <strong>{run.file_name}</strong> · cutover{" "}
          <strong>{run.cutover_date}</strong> · uploaded{" "}
          {new Date(run.started_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}
        </p>
      </header>

      <CountsPanel
        parsed={run.staging_count}
        skippedPostCutover={skipPostCutover}
        errors={validationData?.error_count ?? 0}
        warnings={validationData?.warning_count ?? 0}
        unmappedProviders={validationData?.unmapped_providers.length ?? 0}
        unmappedServices={validationData?.unmapped_services.length ?? 0}
        pending={isPending}
      />

      <UnmappedProvidersPanel
        runId={run.id}
        unmapped={validationData?.unmapped_providers ?? []}
        onResolved={() => router.refresh()}
        providers={providers}
      />

      <UnmappedServicesPanel
        runId={run.id}
        unmapped={validationData?.unmapped_services ?? []}
        onResolved={() => router.refresh()}
        services={services}
      />

      <ReconciliationPanel rows={validationData?.reconciliation ?? reconciliation} />

      <ErrorsTable errors={errors} />

      <CommitFooter
        run={run}
        blockers={{
          errors: validationData?.error_count ?? 0,
          unmappedProviders: validationData?.unmapped_providers.length ?? 0,
          unmappedServices: validationData?.unmapped_services.length ?? 0,
          variancesOver5pct: (validationData?.reconciliation ?? []).filter(
            (r) => r.severity === "red",
          ).length,
        }}
        onDiscarded={async () => {
          await discardRunAction({ run_id: run.id });
          router.push("/staff/admin/accounting/hmo-history");
        }}
        onCommitted={() =>
          router.push(`/staff/admin/accounting/hmo-history/${run.id}/committed`)
        }
      />
    </div>
  );
}

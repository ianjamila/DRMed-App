import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import {
  buildHmoArMatrix,
  summarizeAging,
  type HmoArRow,
  type AgingRow,
} from "@/lib/operations/hmo-ar-report";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { Card } from "@/components/ui/card";
import { OperationsTabs } from "../_components/operations-tabs";
import { DateControls } from "../_components/date-controls";
import { HmoSummaryCards } from "./_components/hmo-summary-cards";
import { HmoArMatrixTable } from "./_components/hmo-ar-matrix";
import { HmoAgingPanel } from "./_components/hmo-aging-panel";

const BASE = "/staff/admin/operations/hmo";

interface SearchParams {
  from?: string;
  to?: string;
}

export default async function HmoReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdminStaff();
  const params = await searchParams;

  const today = todayManilaISODate();
  const from = params.from ?? `${today.slice(0, 4)}-01-01`;
  const to = params.to ?? today;

  const admin = createAdminClient();
  // N14: `v_ops_daily_hmo_provider_ar` paged the same way as hmo.csv (same
  // ceiling, same `fetchAllRows`, same order key) so this screen's running
  // balance can't disagree with the export's. `v_hmo_ar_aging` is pre-grouped
  // by provider/bucket/kind at the view level (at most a few dozen rows —
  // see 0082_v_hmo_views_kind.sql) so it can't hit the 1000-row cap; it
  // stays a plain select. `historic_hmo_claims` is a raw per-claim select
  // with no export counterpart, but it is equally exposed to the cap, so it
  // gets the same paged treatment as the AR view.
  let arResult: { rows: HmoArRow[]; truncated: boolean };
  let consultResult: { rows: { final_amount_php: number | string | null }[]; truncated: boolean };
  let agingRes: { data: AgingRow[] | null; error: { message: string } | null };
  try {
    [arResult, consultResult, agingRes] = await Promise.all([
      fetchAllRows<HmoArRow>(
        (rFrom, rTo) =>
          admin
            .from("v_ops_daily_hmo_provider_ar")
            .select("*")
            .lte("business_date", to) // NO lower bound — cumulative opening balance
            .order("business_date", { ascending: true })
            .order("provider_name", { ascending: true })
            .order("source", { ascending: true })
            .order("billed_in_php", { ascending: true })
            .order("paid_out_php", { ascending: true })
            .range(rFrom, rTo)
            .returns<HmoArRow[]>(),
        REPORT_EXPORT_MAX_ROWS,
      ),
      fetchAllRows<{ final_amount_php: number | string | null }>(
        (rFrom, rTo) =>
          admin
            .from("historic_hmo_claims")
            .select("final_amount_php, id")
            .eq("source_tab", "DOCTOR CONSULTATION")
            .in("status", ["pending", "overdue"])
            .order("claim_date", { ascending: true })
            .order("id", { ascending: true })
            .range(rFrom, rTo),
        REPORT_EXPORT_MAX_ROWS,
      ),
      admin.from("v_hmo_ar_aging").select("*"),
    ]);
  } catch {
    return (
      <div className="p-4">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <OperationsTabs />
        <Card className="mt-6 px-4 text-sm text-destructive">
          Could not load the HMO receivables report. Please try again.
        </Card>
      </div>
    );
  }

  if (agingRes.error) {
    return (
      <div className="p-4">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <OperationsTabs />
        <Card className="mt-6 px-4 text-sm text-destructive">
          Could not load the HMO receivables report. Please try again.
        </Card>
      </div>
    );
  }

  const truncated = arResult.truncated || consultResult.truncated;

  const matrix = buildHmoArMatrix(arResult.rows, { from, to });
  const aging = summarizeAging(agingRes.data ?? []);
  const consultAr = consultResult.rows.reduce(
    (sum, r) => sum + Number(r.final_amount_php ?? 0),
    0,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[#0b2a4a]">HMO receivables</h1>
        <p className="text-sm text-muted-foreground">
          Per-provider lab-HMO AR roll-forward — billed in, paid out, running balance.
        </p>
      </div>
      <OperationsTabs />
      <DateControls key={`${from}_${to}`} from={from} to={to} today={today} basePath={BASE} />
      {truncated ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Showing the first {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} rows of at least one
          section — narrow the date range to see the rest.
        </p>
      ) : null}
      <HmoSummaryCards matrix={matrix} />
      <Card className="p-0 overflow-hidden">
        <HmoArMatrixTable matrix={matrix} from={from} to={to} />
      </Card>
      <HmoAgingPanel aging={aging} labTotal={matrix.total.endingBalance} consultAr={consultAr} />
      <a
        href={`/api/admin/operations/hmo.csv?from=${from}&to=${to}`}
        className="inline-block text-sm text-[#0b6bb3] underline"
      >
        Download CSV (sheet shape)
      </a>
    </div>
  );
}

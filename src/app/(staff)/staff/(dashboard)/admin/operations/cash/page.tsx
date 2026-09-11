import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import {
  buildCollectionsMatrix,
  buildCreditCardPanel,
  buildCashReconRows,
  type CollectionRow,
  type HmoReceivedRow,
  type EodCloseRow,
} from "@/lib/operations/cash-report";
import { enumerateDays } from "@/lib/operations/daily-report";
import { buildDenominationTrend } from "@/lib/accounting/denomination-trends";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import { Card } from "@/components/ui/card";
import { OperationsTabs } from "../_components/operations-tabs";
import { DateControls } from "../_components/date-controls";
import { CashSummaryCards } from "./_components/cash-summary-cards";
import { CollectionsMatrix } from "./_components/collections-matrix";
import { CreditCardPanel } from "./_components/credit-card-panel";
import { CashReconPanel } from "./_components/cash-recon-panel";
import { DenominationTrendPanel } from "./_components/denomination-trend-panel";

const BASE = "/staff/admin/operations/cash";

interface SearchParams {
  from?: string;
  to?: string;
}

export default async function CashCollectedPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdminStaff();
  const params = await searchParams;

  const today = todayManilaISODate();
  // Default to the current year — the matrix collapses columns by month.
  const from = params.from ?? `${today.slice(0, 4)}-01-01`;
  const to = params.to ?? today;

  const admin = createAdminClient();
  // N14: same paged reads as cash.csv (same ceiling, same `fetchAllRows`) so
  // this screen can't show narrower channel/method figures than the export.
  let collectionsResult: { rows: CollectionRow[]; truncated: boolean };
  let hmoResult: { rows: HmoReceivedRow[]; truncated: boolean };
  let eodResult: { rows: EodCloseRow[]; truncated: boolean };
  try {
    [collectionsResult, hmoResult, eodResult] = await Promise.all([
      fetchAllRows<CollectionRow>(
        (rFrom, rTo) =>
          admin
            .from("v_ops_daily_collections")
            .select("*")
            .gte("business_date", from)
            .lte("business_date", to)
            .order("business_date", { ascending: true })
            .order("section", { ascending: true })
            .order("method", { ascending: true })
            .range(rFrom, rTo)
            .returns<CollectionRow[]>(),
        REPORT_EXPORT_MAX_ROWS,
      ),
      fetchAllRows<HmoReceivedRow>(
        (rFrom, rTo) =>
          admin
            .from("v_ops_daily_hmo_received")
            .select("*")
            .gte("received_date", from)
            .lte("received_date", to)
            .order("received_date", { ascending: true })
            .order("source", { ascending: true })
            .range(rFrom, rTo)
            .returns<HmoReceivedRow[]>(),
        REPORT_EXPORT_MAX_ROWS,
      ),
      fetchAllRows<EodCloseRow>(
        (rFrom, rTo) =>
          admin
            .from("eod_close_records")
            .select("id,business_date,expected_cash_php,counted_cash_php,variance_php,counted_denominations")
            .eq("status", "closed")
            .gte("business_date", from)
            .lte("business_date", to)
            .order("business_date", { ascending: true })
            .range(rFrom, rTo)
            .returns<EodCloseRow[]>(),
        REPORT_EXPORT_MAX_ROWS,
      ),
    ]);
  } catch {
    return (
      <div className="p-4">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <OperationsTabs />
        <Card className="mt-6 px-4 text-sm text-destructive">
          Could not load the cash &amp; cards report. Please try again.
        </Card>
      </div>
    );
  }

  const truncated = collectionsResult.truncated || hmoResult.truncated || eodResult.truncated;

  const days = enumerateDays(from, to);
  const matrix = buildCollectionsMatrix(collectionsResult.rows, days, hmoResult.rows);
  const creditCard = buildCreditCardPanel(collectionsResult.rows, days);
  const reconRows = buildCashReconRows(eodResult.rows, days);
  // Trends run off the reconciled days only — a day with no close has no count
  // to trend, and counting it as "balanced" would flatter the numbers.
  const trend = buildDenominationTrend(
    reconRows
      .filter((r) => r.reconciled)
      .map((r) => ({ day: r.day, variance: r.variance, denominations: r.denominations })),
  );

  const csvHref = `/api/admin/operations/cash.csv?from=${from}&to=${to}`;

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <ExportCsvLink href={csvHref} />
      </div>
      <OperationsTabs />

      {/* key on the range so the custom From/To inputs re-init after a pill/year
          navigation (useState would otherwise keep its stale initial value). */}
      <DateControls key={`${from}_${to}`} from={from} to={to} today={today} basePath={BASE} />

      {truncated ? (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Showing the first {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} rows of at least one
          section — narrow the date range to see the rest.
        </p>
      ) : null}

      <CashSummaryCards matrix={matrix} reconRows={reconRows} />
      <CollectionsMatrix matrix={matrix} />
      <CreditCardPanel panel={creditCard} days={days} />
      <CashReconPanel rows={reconRows} />
      <DenominationTrendPanel trend={trend} />
    </div>
  );
}

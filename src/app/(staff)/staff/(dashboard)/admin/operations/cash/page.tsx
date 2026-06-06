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
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { OperationsTabs } from "../_components/operations-tabs";
import { DateControls } from "../_components/date-controls";
import { CashSummaryCards } from "./_components/cash-summary-cards";
import { CollectionsMatrix } from "./_components/collections-matrix";
import { CreditCardPanel } from "./_components/credit-card-panel";
import { CashReconPanel } from "./_components/cash-recon-panel";

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
  const [collectionsRes, hmoRes, eodRes] = await Promise.all([
    admin
      .from("v_ops_daily_collections")
      .select("*")
      .gte("business_date", from)
      .lte("business_date", to),
    admin
      .from("v_ops_daily_hmo_received")
      .select("*")
      .gte("received_date", from)
      .lte("received_date", to),
    admin
      .from("eod_close_records")
      .select("business_date,expected_cash_php,counted_cash_php,variance_php")
      .eq("status", "closed")
      .gte("business_date", from)
      .lte("business_date", to),
  ]);

  if (collectionsRes.error || hmoRes.error || eodRes.error) {
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

  const days = enumerateDays(from, to);
  const matrix = buildCollectionsMatrix(
    (collectionsRes.data ?? []) as CollectionRow[],
    days,
    (hmoRes.data ?? []) as HmoReceivedRow[],
  );
  const creditCard = buildCreditCardPanel(
    (collectionsRes.data ?? []) as CollectionRow[],
    days,
  );
  const reconRows = buildCashReconRows(
    (eodRes.data ?? []) as EodCloseRow[],
    days,
  );

  const csvHref = `/api/admin/operations/cash.csv?from=${from}&to=${to}`;

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">Operations</h1>
        <a href={csvHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Export CSV
        </a>
      </div>
      <OperationsTabs />

      {/* key on the range so the custom From/To inputs re-init after a pill/year
          navigation (useState would otherwise keep its stale initial value). */}
      <DateControls key={`${from}_${to}`} from={from} to={to} today={today} basePath={BASE} />

      <CashSummaryCards matrix={matrix} reconRows={reconRows} />
      <CollectionsMatrix matrix={matrix} />
      <CreditCardPanel panel={creditCard} days={days} />
      <CashReconPanel rows={reconRows} />
    </div>
  );
}

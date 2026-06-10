import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import {
  buildHmoArMatrix,
  summarizeAging,
  type HmoArRow,
  type AgingRow,
} from "@/lib/operations/hmo-ar-report";
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
  const [arRes, agingRes, consultRes] = await Promise.all([
    admin
      .from("v_ops_daily_hmo_provider_ar")
      .select("*")
      .lte("business_date", to), // NO lower bound — cumulative opening balance
    admin.from("v_hmo_ar_aging").select("*"),
    admin
      .from("historic_hmo_claims")
      .select("final_amount_php")
      .eq("source_tab", "DOCTOR CONSULTATION")
      .in("status", ["pending", "overdue"]),
  ]);

  const matrix = buildHmoArMatrix((arRes.data ?? []) as HmoArRow[], { from, to });
  const aging = summarizeAging((agingRes.data ?? []) as AgingRow[]);
  const consultAr = (consultRes.data ?? []).reduce(
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
      <DateControls from={from} to={to} today={today} basePath={BASE} />
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

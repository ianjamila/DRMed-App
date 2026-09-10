import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { HmoClaimsClient } from "./hmo-claims-client";
import type { Database } from "@/types/database";

type UnbilledRow = Database["public"]["Views"]["v_hmo_unbilled"]["Row"];
type StuckRow = Database["public"]["Views"]["v_hmo_stuck"]["Row"];

export const metadata = { title: "HMO claims — staff" };
export const dynamic = "force-dynamic";

export default async function HmoClaimsIndexPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  // The two detail views are the only ones here that grow with visit volume,
  // and they had outgrown PostgREST's silent 1000-row cap: the page was
  // showing — and the "All unbilled" CSV was exporting — the first 1000 of
  // 2031 rows, with a footer total to match, while the provider cards read the
  // pre-aggregated summary view and showed the true (much larger) figure. Walk
  // them with the house pager instead. Both orders carry a uuid tie-break;
  // without a TOTAL order, pages can repeat or drop rows.
  // v_hmo_ar_aging and v_hmo_provider_summary are aggregates bounded by
  // provider x bucket x kind, so they stay single-shot.
  const [summary, unbilled, stuck, aging, staff, paymentMethods] = await Promise.all([
    admin
      .from("v_hmo_provider_summary")
      .select("*")
      .order("total_unresolved_ar_php", { ascending: false, nullsFirst: false }),
    fetchAllRows<UnbilledRow>(
      (from, to) =>
        admin
          .from("v_hmo_unbilled")
          .select("*")
          .order("days_since_release", { ascending: false })
          .order("test_request_id", { ascending: true })
          .range(from, to),
      REPORT_EXPORT_MAX_ROWS,
    ),
    fetchAllRows<StuckRow>(
      (from, to) =>
        admin
          .from("v_hmo_stuck")
          .select("*")
          .order("days_since_submission", { ascending: false })
          .order("item_id", { ascending: true })
          .range(from, to),
      REPORT_EXPORT_MAX_ROWS,
    ),
    admin.from("v_hmo_ar_aging").select("*"),
    admin
      .from("staff_profiles")
      .select("id, full_name")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("full_name"),
    admin
      .from("chart_of_accounts")
      .select("code, name")
      .eq("is_active", true)
      .eq("is_settlement_destination", true)
      .order("code"),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.3 · Admin
        </p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          HMO claims
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Per-provider HMO accounts receivable with unbilled / aging
          detection. Drill into a provider to manage their claim batches.
        </p>
      </header>
      <HmoClaimsClient
        summary={summary.data ?? []}
        unbilled={unbilled.rows}
        unbilledTruncated={unbilled.truncated}
        stuck={stuck.rows}
        stuckTruncated={stuck.truncated}
        aging={aging.data ?? []}
        staff={staff.data ?? []}
        paymentMethods={paymentMethods.data ?? []}
      />
    </div>
  );
}

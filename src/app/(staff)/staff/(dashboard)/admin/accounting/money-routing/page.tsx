import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { fetchCompleteRows } from "@/lib/reports/paging";
import { PageHeader } from "@/components/staff/page-header";
import { ROUTE_NAME } from "@/lib/staff/route-names";
import { MoneyRoutingClient, type LastChange } from "./money-routing-client";

export const metadata = { title: "Money Routing" };
export const dynamic = "force-dynamic";

const ROUTE = "/staff/admin/accounting/money-routing";
const CHANGE_ACTIONS = [
  "payment_method_map.updated",
  "cash_routing.updated",
  "accounting_settings.updated",
] as const;

type ChangeRow = {
  id: number;
  action: string;
  actor_id: string | null;
  resource_id: string | null;
  metadata: unknown;
  created_at: string;
};

/** Which row an audit entry belongs to: `payment:<map id>`, `cash:<kind>` or `fund`. */
function changeKey(row: ChangeRow): string | null {
  const meta = (row.metadata ?? {}) as { kind?: unknown; key?: unknown };
  if (row.action === "payment_method_map.updated") return row.resource_id ? `payment:${row.resource_id}` : null;
  if (row.action === "cash_routing.updated") return typeof meta.kind === "string" ? `cash:${meta.kind}` : null;
  return meta.key === "default_change_fund_php" ? "fund" : null;
}

export default async function MoneyRoutingPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const [payments, cash, accounts, fund, drawerUse, changes] = await Promise.all([
    admin
      .from("payment_method_account_map")
      .select("id, payment_method, account_id, notes")
      .order("payment_method"),
    admin
      .from("cash_adjustment_account_map")
      .select("id, kind, account_id, requires_user_choice, notes")
      .order("kind"),
    admin
      .from("chart_of_accounts")
      .select("id, code, name, type")
      .eq("is_active", true)
      .order("code"),
    admin
      .from("accounting_settings")
      .select("value_php")
      .eq("key", "default_change_fund_php")
      .maybeSingle(),
    // Has reception ever recorded a cash-drawer entry? Until then the cash
    // rules below have never been applied, so they start folded away.
    admin.from("eod_cash_adjustments").select("id", { count: "exact", head: true }),
    // Every change ever made here, newest first — rare, so the whole set is
    // small, and reading it all keeps "last changed" exact for every row.
    fetchCompleteRows<ChangeRow, { message: string }>((from, to) =>
      admin
        .from("audit_log")
        .select("id, action, actor_id, resource_id, metadata, created_at")
        .in("action", [...CHANGE_ACTIONS])
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);
  for (const r of [payments, cash, accounts, fund]) if (r.error) throw new Error(r.error.message);
  if (changes.error) throw new Error(changes.error.message);

  const latest = new Map<string, ChangeRow>();
  for (const row of changes.data ?? []) {
    const key = changeKey(row);
    if (key && !latest.has(key)) latest.set(key, row);
  }
  const actorIds = [...new Set([...latest.values()].map((r) => r.actor_id).filter((id): id is string => !!id))];
  const { data: actors } = actorIds.length
    ? await admin.from("staff_profiles").select("id, full_name").in("id", actorIds)
    : { data: [] as { id: string; full_name: string }[] };
  const nameOf = new Map((actors ?? []).map((a) => [a.id, a.full_name]));
  const lastChanges: Record<string, LastChange> = {};
  for (const [key, row] of latest) {
    lastChanges[key] = { by: (row.actor_id && nameOf.get(row.actor_id)) || "Unknown staff", at: row.created_at };
  }

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title={ROUTE_NAME[ROUTE]}
        subtitle="Where each patient payment and cash-drawer entry is recorded in the books. Changes apply to new entries only — past entries stay as they are. Most clinics rarely need to change these."
      />
      <MoneyRoutingClient
        payments={payments.data ?? []}
        cash={cash.data ?? []}
        accounts={accounts.data ?? []}
        defaultChangeFund={Number(fund.data?.value_php ?? 0)}
        // A failed count must not hide rules that may be in use.
        cashDrawerInUse={!!drawerUse.error || (drawerUse.count ?? 0) > 0}
        lastChanges={lastChanges}
      />
    </div>
  );
}

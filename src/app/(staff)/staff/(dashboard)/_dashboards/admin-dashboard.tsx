import type { StaffSession } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { DashboardHeader } from "./_components/dashboard-header";
import { SectionHeading } from "./_components/section-heading";
import { StatCard } from "./_components/stat-card";
import { QuickLinks } from "./_components/quick-links";
import { ActivityStrip, type ActivityItem } from "./_components/activity-strip";
import { PlannedCard } from "./_components/planned-card";
import { formatPeso, relativeAge } from "./_components/format";

const QUICK_LINKS = [
  { href: "/staff/admin/reports/daily-revenue", label: "Daily revenue" },
  { href: "/staff/admin/accounting/ap", label: "AP dashboard" },
  { href: "/staff/admin/accounting/hmo-claims", label: "HMO claims" },
  { href: "/staff/admin/payroll/runs", label: "Pay runs" },
  { href: "/staff/admin/accounting/periods", label: "Periods" },
  { href: "/staff/admin/accounting/chart-of-accounts", label: "Chart of accounts" },
  { href: "/staff/audit", label: "Audit log" },
  { href: "/staff/users", label: "Staff users" },
];

type BillRow = { outstanding_amount: number | null; due_date: string; status: string };
type PatientArRow = { total_php: number | null; paid_php: number | null };
type UnbilledRow = { released_at: string; days_since_release: number; billed_amount_php: number | null };
type AdvanceRow = { outstanding_balance_php: number | null };
type PfRow = { pf_php: number };
type AuditRow = {
  id: string;
  action: string;
  actor_type: string;
  created_at: string;
};
type DraftJeRow = { id: string; entry_number: string; posting_date: string; created_at: string };
type PaymentRow = { amount_php: number };

async function loadAdminStats() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const today = todayManilaISODate();
  const startOfTodayUtc = new Date(`${today}T00:00:00+08:00`).toISOString();
  const startOfTomorrowUtc = new Date(`${today}T24:00:00+08:00`).toISOString();
  const sevenDaysAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();

  const [
    visitsToday,
    queueTotal,
    releasedToday,
    revenueToday,
    openPeriods,
    draftJeCount,
    bills,
    patientAr,
    unbilled,
    advances,
    pfPending,
    activeEmployees,
    payrollRunsInProgress,
    recentAudit,
    staleDrafts,
  ] = await Promise.all([
    supabase
      .from("visits")
      .select("id", { count: "exact", head: true })
      .eq("visit_date", today),
    supabase
      .from("test_requests")
      .select("id", { count: "exact", head: true })
      .in("status", ["requested", "in_progress"]),
    supabase
      .from("test_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "released")
      .gte("released_at", startOfTodayUtc)
      .lt("released_at", startOfTomorrowUtc),
    admin
      .from("payments")
      .select("amount_php")
      .gte("received_at", startOfTodayUtc)
      .lt("received_at", startOfTomorrowUtc)
      .is("voided_at", null)
      .returns<PaymentRow[]>(),
    admin
      .from("accounting_periods")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")
      .lte("period_end", today),
    admin
      .from("journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("status", "draft"),
    admin
      .from("bills")
      .select("outstanding_amount, due_date, status")
      .gt("outstanding_amount", 0)
      .neq("status", "voided")
      .returns<BillRow[]>(),
    admin
      .from("visits")
      .select("total_php, paid_php")
      .in("payment_status", ["unpaid", "partial"])
      .is("hmo_provider_id", null)
      .returns<PatientArRow[]>(),
    admin
      .from("v_hmo_unbilled")
      .select("released_at, days_since_release, billed_amount_php")
      .returns<UnbilledRow[]>(),
    admin
      .from("staff_advances")
      .select("outstanding_balance_php")
      .eq("status", "outstanding")
      .returns<AdvanceRow[]>(),
    admin
      .from("doctor_pf_entries")
      .select("pf_php")
      .eq("recognition_basis", "hmo_at_settlement")
      .is("recognized_at", null)
      .is("voided_at", null)
      .returns<PfRow[]>(),
    admin
      .from("employees")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .is("termination_date", null),
    admin
      .from("payroll_runs")
      .select("id", { count: "exact", head: true })
      .in("status", ["draft", "computed"]),
    admin
      .from("audit_log")
      .select("id, action, actor_type, created_at")
      .or(
        "action.ilike.%void%,action.ilike.%reverse%,action.ilike.%rejected%,action.ilike.%failed%",
      )
      .order("created_at", { ascending: false })
      .limit(5)
      .returns<AuditRow[]>(),
    admin
      .from("journal_entries")
      .select("id, entry_number, posting_date, created_at")
      .eq("status", "draft")
      .lt("created_at", sevenDaysAgoIso)
      .order("created_at", { ascending: true })
      .limit(5)
      .returns<DraftJeRow[]>(),
  ]);

  const revenueTotal = (revenueToday.data ?? []).reduce(
    (s, p) => s + Number(p.amount_php ?? 0),
    0,
  );

  const billRows = bills.data ?? [];
  const apOutstanding = billRows.reduce(
    (s, b) => s + Number(b.outstanding_amount ?? 0),
    0,
  );
  const apOverdue = billRows.filter((b) => b.due_date < today).length;

  const patientArRows = patientAr.data ?? [];
  const patientArTotal = patientArRows.reduce(
    (s, v) => s + (Number(v.total_php ?? 0) - Number(v.paid_php ?? 0)),
    0,
  );
  const patientArCount = patientArRows.length;

  const unbilledRows = unbilled.data ?? [];
  const unbilledAgedTotal = unbilledRows
    .filter((u) => Number(u.days_since_release ?? 0) >= 90)
    .reduce((s, u) => s + Number(u.billed_amount_php ?? 0), 0);
  const unbilledAgedCount = unbilledRows.filter(
    (u) => Number(u.days_since_release ?? 0) >= 90,
  ).length;

  const advancesTotal = (advances.data ?? []).reduce(
    (s, a) => s + Number(a.outstanding_balance_php ?? 0),
    0,
  );

  const pfPendingTotal = (pfPending.data ?? []).reduce(
    (s, p) => s + Number(p.pf_php ?? 0),
    0,
  );

  return {
    visitsToday: visitsToday.count ?? 0,
    queueTotal: queueTotal.count ?? 0,
    releasedToday: releasedToday.count ?? 0,
    revenueTotal,
    openPeriods: openPeriods.count ?? 0,
    draftJeCount: draftJeCount.count ?? 0,
    apOutstanding,
    apOverdue,
    patientArTotal,
    patientArCount,
    unbilledAgedTotal,
    unbilledAgedCount,
    advancesTotal,
    pfPendingTotal,
    activeEmployees: activeEmployees.count ?? 0,
    payrollRunsInProgress: payrollRunsInProgress.count ?? 0,
    recentAudit: recentAudit.data ?? [],
    staleDrafts: staleDrafts.data ?? [],
  };
}

export async function AdminDashboard({ session }: { session: StaffSession }) {
  const stats = await loadAdminStats();

  const auditItems: ActivityItem[] = stats.recentAudit.map((a) => ({
    primary: a.action,
    secondary: a.actor_type,
    meta: relativeAge(a.created_at),
    href: `/staff/audit?action=${encodeURIComponent(a.action.split(".")[0])}`,
  }));

  const draftItems: ActivityItem[] = stats.staleDrafts.map((d) => ({
    primary: d.entry_number,
    secondary: `Posting date ${d.posting_date}`,
    meta: relativeAge(d.created_at),
    href: `/staff/admin/accounting/journal/${d.id}`,
  }));

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <DashboardHeader
        firstName={session.full_name.split(" ")[0]}
        roleLabel="Admin"
        title="Clinic command centre"
      />

      <SectionHeading title="Operations" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Revenue today"
          value={formatPeso(stats.revenueTotal)}
          hint="Collected payments, today"
          href="/staff/admin/reports/daily-revenue"
          accent="good"
        />
        <StatCard
          label="Visits today"
          value={stats.visitsToday}
          hint="Registered today"
          href="/staff/visits"
        />
        <StatCard
          label="Queue"
          value={stats.queueTotal}
          hint="Requested + in progress"
          href="/staff/queue"
        />
        <StatCard
          label="Released today"
          value={stats.releasedToday}
          hint="Results released to patients"
          href="/staff/queue?filter=released_today"
        />
      </div>

      <SectionHeading title="Money" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Past-due open periods"
          value={stats.openPeriods}
          hint="Months ended but still open"
          href="/staff/admin/accounting/periods"
          accent={stats.openPeriods > 0 ? "warn" : "default"}
        />
        <StatCard
          label="Draft journal entries"
          value={stats.draftJeCount}
          hint="Awaiting posting"
          href="/staff/admin/accounting/periods"
          accent={stats.draftJeCount > 0 ? "warn" : "default"}
        />
        <StatCard
          label="AP outstanding"
          value={formatPeso(stats.apOutstanding)}
          hint="Total bills payable"
          href="/staff/admin/accounting/ap/bills"
        />
        <StatCard
          label="AP bills overdue"
          value={stats.apOverdue}
          hint="Past due date"
          href="/staff/admin/accounting/ap/bills"
          accent={stats.apOverdue > 0 ? "warn" : "default"}
        />
        <StatCard
          label="HMO unbilled aged 90+"
          value={formatPeso(stats.unbilledAgedTotal)}
          hint={`${stats.unbilledAgedCount} test${stats.unbilledAgedCount === 1 ? "" : "s"} ≥ 90d unbilled`}
          href="/staff/admin/accounting/hmo-claims"
          accent={stats.unbilledAgedCount > 0 ? "warn" : "default"}
        />
        <StatCard
          label="Patient AR outstanding"
          value={formatPeso(stats.patientArTotal)}
          hint={`${stats.patientArCount} non-HMO visit${stats.patientArCount === 1 ? "" : "s"} unpaid / partial`}
          href="/staff/admin/accounting/patient-ar"
          accent={stats.patientArCount > 0 ? "warn" : "default"}
        />
        <StatCard
          label="Staff advances outstanding"
          value={formatPeso(stats.advancesTotal)}
          hint="Receivable from payroll deductions"
          href="/staff/admin/reports/staff-advances"
        />
        <StatCard
          label="Doctor PF pending"
          value={formatPeso(stats.pfPendingTotal)}
          hint="Awaiting HMO settlement"
          href="/staff/admin/accounting/pf-payouts"
        />
      </div>

      <SectionHeading title="People" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active employees"
          value={stats.activeEmployees}
          hint="On the roster today"
          href="/staff/admin/payroll/employees"
        />
        <StatCard
          label="Payroll runs in progress"
          value={stats.payrollRunsInProgress}
          hint="Draft or computed, awaiting finalise"
          href="/staff/admin/payroll/runs"
          accent={stats.payrollRunsInProgress > 0 ? "warn" : "default"}
        />
      </div>

      <SectionHeading title="Quicklinks" />
      <QuickLinks items={QUICK_LINKS} />

      <SectionHeading title="What needs attention" />
      <div className="grid gap-4 lg:grid-cols-2">
        <ActivityStrip
          title="Recent audit anomalies"
          items={auditItems}
          emptyMessage="No void / reversal / rejection events recently."
          viewAllHref="/staff/audit"
        />
        <ActivityStrip
          title="Stale draft journals (7d+)"
          items={draftItems}
          emptyMessage="No drafts older than a week."
          viewAllHref="/staff/admin/accounting/periods"
        />
      </div>

      <SectionHeading
        title="Coming soon"
        subtitle="Roadmap modules — not yet live"
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <PlannedCard
          label="Inventory"
          teaser="Reagent stock, expiry alerts, reorder thresholds"
          module="inventory"
        />
        <PlannedCard
          label="Financial statements"
          teaser="P&L, balance sheet, and cash flow from your COA"
          module="financial-statements"
        />
        <PlannedCard
          label="Budget vs actual"
          teaser="Set budgets and track variance by department"
          module="variance-analysis"
        />
        <PlannedCard
          label="Bank reconciliation"
          teaser="Match bank statements to GL with variance tracking"
          module="bank-reconciliation"
        />
        <PlannedCard
          label="Month-end close tracker"
          teaser="Interactive close checklist with audit trail"
          module="close-tracker"
        />
        <PlannedCard
          label="Doctor PF YTD summary"
          teaser="Per-physician YTD accrued vs disbursed"
          module="pf-ytd-summary"
        />
        <PlannedCard
          label="Send-out vendor performance"
          teaser="TAT, cost, SLA, rejection rate per external lab"
          module="send-out-performance"
        />
      </div>
    </div>
  );
}

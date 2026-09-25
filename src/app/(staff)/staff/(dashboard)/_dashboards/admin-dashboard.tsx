import { incomeStatementTotals, loadIncomeStatementLines } from "@/lib/accounting/income-statement";
import { quickLinksFor } from "@/components/staff/staff-nav-config";
import type { StaffSession } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOCTOR_KINDS_PG_LIST } from "@/lib/visits/classification";
import { LAB_QUEUE_GATE_VISITS_OR } from "@/lib/visits/lab-gate";
import { PAYABLE_BILL_STATUSES } from "@/lib/accounting/payable-bills";
import { todayManilaISODate } from "@/lib/dates/manila";
import { loadHiddenCardIds } from "@/lib/dashboards/card-prefs";
import { loadCandidatePairsWithStatus } from "@/lib/patients/find-duplicates";
import {
  fetchAllRows,
  REPORT_EXPORT_MAX_ROWS,
  type PageFetcher,
} from "@/lib/reports/paging";
import { reportError } from "@/lib/observability/report-error";
import { RealtimeRefresher, type Subscription } from "@/components/staff/realtime-refresher";
import {
  HMO_UNBILLED_AGE_BANDS,
  matchesHmoUnbilledAgeBand,
  type HmoUnbilledAgeBand,
} from "@/lib/reports/hmo-unbilled-bands";
import { HmoUnbilledCard } from "./_admin-components/hmo-unbilled-card";
import { DashboardHeader } from "./_components/dashboard-header";
import { EodReminderBanner } from "./_components/eod-reminder-banner";
import { SectionHeading } from "./_components/section-heading";
import { StatCard } from "./_components/stat-card";
import { QuickLinks } from "./_components/quick-links";
import { ActivityStrip, type ActivityItem } from "./_components/activity-strip";
import { formatPeso, relativeAge } from "./_components/format";

const NO_SUBSCRIPTIONS: readonly Subscription[] = [];

// Owner shortcuts; metric cards above keep their own descriptive labels and IDs.
const QUICK_LINKS = quickLinksFor("admin", "admin");

const SKIP_COUNT = Promise.resolve({ count: 0, data: null, error: null });
const SKIP_DATA = Promise.resolve({ data: null, error: null });
// H1/M9: the paged equivalent of SKIP_COUNT/SKIP_DATA, for cards walked with
// `fetchAllRows` instead of a bare `.select()`. `error` sits alongside
// `rows`/`truncated` so a failing pager marks its own card instead of
// throwing the whole dashboard to an error page (see `pagedRows` below).
const SKIP_ROWS: Promise<{ rows: never[]; truncated: boolean; error: unknown }> =
  Promise.resolve({ rows: [], truncated: false, error: null });

type BillRow = { id: string; outstanding_amount: number | null; due_date: string; status: string };
type PatientArRow = { id: string; total_php: number | null; paid_php: number | null };
type UnbilledRow = {
  test_request_id: string;
  released_at: string;
  days_since_release: number;
  billed_amount_php: number | null;
  past_threshold: boolean | null;
};
type AdvanceRow = { id: string; outstanding_balance_php: number | null };
type PfRow = { id: string; pf_php: number };
type PfToPayRow = { id: string; pf_php: number; physician_id: string };
type PaymentRow = { id: string; amount_php: number };
type AuditRow = {
  id: string;
  action: string;
  actor_type: string;
  created_at: string;
};
type DraftJeRow = { id: string; entry_number: string; posting_date: string; created_at: string };
type ReleasedByRow = { id: string; assigned_to: string | null };

// Runs `fetchAllRows` but never throws — a failing pager reports to Sentry
// and marks its own card via `error`, instead of blowing up the whole
// server render the way a bare `fetchAllRows` await would (it throws on a
// page error by design, which is right for a report page but wrong for one
// tile among many on a dashboard).
async function pagedRows<T>(
  fetchPage: PageFetcher<T>,
  maxRows: number,
): Promise<{ rows: T[]; truncated: boolean; error: unknown }> {
  try {
    const { rows, truncated } = await fetchAllRows<T>(fetchPage, maxRows);
    return { rows, truncated, error: null };
  } catch (error) {
    return { rows: [], truncated: false, error };
  }
}

function truncatedHint(truncated: boolean, fallback: string): string {
  return truncated
    ? `Capped at ${REPORT_EXPORT_MAX_ROWS.toLocaleString()} rows, true total is higher`
    : fallback;
}

function doctorsToPayHint(s: {
  doctorsToPayCount: number;
  doctorsToPayTruncated: boolean;
  pfPendingTotal: number;
  pfPendingTruncated: boolean;
  pfPendingError: boolean;
}): string {
  if (s.doctorsToPayTruncated) {
    return `Capped at ${REPORT_EXPORT_MAX_ROWS.toLocaleString()} rows, true total is higher`;
  }
  const base =
    s.doctorsToPayCount === 0
      ? "No doctor payments due"
      : `${s.doctorsToPayCount} doctor${s.doctorsToPayCount === 1 ? "" : "s"} ready to pay`;
  // N9: PF pending is folded into this card's hint rather than its own tile
  // — nothing is payable until the HMO settles, so it isn't a standing card.
  if (s.pfPendingError) return `${base} · PF pending: unknown (reload)`;
  if (s.pfPendingTruncated) return `${base} · PF pending capped at ${REPORT_EXPORT_MAX_ROWS.toLocaleString()} rows`;
  if (s.pfPendingTotal > 0) return `${base} · ${formatPeso(s.pfPendingTotal)} pending HMO settlement`;
  return base;
}

async function loadAdminStats(show: (id: string) => boolean) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const today = todayManilaISODate();
  const currentFiscalYear = Number(today.slice(0, 4));
  const monthStart = `${today.slice(0, 7)}-01`;
  const startOfTodayUtc = new Date(`${today}T00:00:00+08:00`).toISOString();
  const startOfTomorrowUtc = new Date(`${today}T24:00:00+08:00`).toISOString();
  const sevenDaysAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();

  const [
    visitsToday,
    queueTotal,
    releasedToday,
    releasedByStaff,
    revenueToday,
    openPeriods,
    draftJeCount,
    bills,
    patientAr,
    unbilled,
    advances,
    pfPending,
    doctorsToPay,
    activeEmployees,
    payrollRunsInProgress,
    recentAudit,
    staleDrafts,
    grossProfitRows,
    booksLines,
    newMessagesCount,
  ] = await Promise.all([
    // The audit wanted all three of these cut as "throughput decoration".
    // The owner deferred Visits today and Queue to a LATER re-review, so
    // they stay on screen and were corrected in place instead: Visits today
    // now carries the date into its link, and Queue applies the money gate
    // and the package-header exclusion so it finally counts the same work
    // /staff/queue shows (it used to count unpaid lines the queue withholds).
    // Only Released today is retired, and reversibly — `defaultHidden: true`
    // in cards.ts rather than a deleted render, so Dashboard settings can
    // genuinely bring it back. Deleting the JSX would have made the toggle
    // a no-op.
    show("admin.visits_today")
      ? supabase
          .from("visits")
          .select("id", { count: "exact", head: true })
          .eq("visit_date", today)
          .is("deleted_at", null)
      : SKIP_COUNT,
    show("admin.queue_total")
      ? supabase
          .from("test_requests")
          .select("id, services!inner ( id ), visits!inner ( id )", {
            count: "exact",
            head: true,
          })
          .in("status", ["requested", "in_progress"])
          .eq("is_package_header", false)
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
          // The destination withholds work whose visit hasn't settled, so
          // counting it here made the card read higher than the queue it
          // opens. Same predicate, same numbers.
          .or(LAB_QUEUE_GATE_VISITS_OR, { foreignTable: "visits" })
      : SKIP_COUNT,
    show("admin.released_today")
      ? supabase
          .from("test_requests")
          .select("id, services!inner ( id ), visits!inner ( id )", {
            count: "exact",
            head: true,
          })
          .eq("status", "released")
          .eq("is_package_header", false)
          .gte("released_at", startOfTodayUtc)
          .lt("released_at", startOfTomorrowUtc)
          .is("deleted_at", null)
          .is("visits.deleted_at", null)
          .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
      : SKIP_COUNT,
    // "Released today by staff" replaces the bare released-today count with
    // something the owner can act on: who cleared what today. Attributed by
    // `assigned_to` only — `released_by` is not shown anywhere on the queue
    // this links to, so attributing by it would name someone the destination
    // never mentions. Unassigned releases (a package promoted by the 0109
    // trigger, say) get their own bucket rather than being dropped. Paged
    // because the worst historical day's volume is unknown, and it carries the
    // queue's own predicates so the numbers match the screen it opens.
    show("admin.strip_released_by_staff")
      ? pagedRows<ReleasedByRow>(
          (from, to) =>
            admin
              .from("test_requests")
              .select("id, assigned_to, services!inner ( id ), visits!inner ( id )")
              .eq("status", "released")
              .eq("is_package_header", false)
              .gte("released_at", startOfTodayUtc)
              .lt("released_at", startOfTomorrowUtc)
              .is("deleted_at", null)
              .is("visits.deleted_at", null)
              .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
              .order("id", { ascending: true })
              .range(from, to)
              .returns<ReleasedByRow[]>(),
          REPORT_EXPORT_MAX_ROWS,
        )
      : SKIP_ROWS,
    // H2: was a bare, unpaged `.select()` (silently capped at 1000 payment
    // rows) labelled "Revenue today" and linked to /staff/admin/reports/
    // daily-revenue, which sums RELEASED SERVICE REVENUE and defaults to
    // month-to-date — a different figure entirely from money collected at
    // the counter today. Relabelled "Payments collected today", kept the
    // collections definition, paged it, and pointed it at the actual
    // collections destination (/staff/admin/operations/cash) with explicit
    // today bounds instead.
    show("admin.revenue_today")
      ? pagedRows<PaymentRow>(
          (from, to) =>
            admin
              .from("payments")
              .select("id, amount_php")
              .gte("received_at", startOfTodayUtc)
              .lt("received_at", startOfTomorrowUtc)
              .is("voided_at", null)
              .order("id", { ascending: true })
              .range(from, to)
              .returns<PaymentRow[]>(),
          REPORT_EXPORT_MAX_ROWS,
        )
      : SKIP_ROWS,
    // H10: `.lte` flagged the current month as past-due on its own final
    // morning, hours before it actually ends; also counted every fiscal
    // year, while /staff/admin/accounting/periods defaults to the current
    // one (`.eq("fiscal_year", year)`). Both fixed to match.
    show("admin.past_due_periods")
      ? admin
          .from("accounting_periods")
          .select("id", { count: "exact", head: true })
          .eq("status", "open")
          .lt("period_end", today)
          .eq("fiscal_year", currentFiscalYear)
      : SKIP_COUNT,
    show("admin.draft_jes")
      ? admin
          .from("journal_entries")
          .select("id", { count: "exact", head: true })
          .eq("status", "draft")
      : SKIP_COUNT,
    // H4: bills merges "AP outstanding" + "AP bills overdue" into one card
    // below. `.neq("status", "voided")` used to also count DRAFT bills —
    // a draft computes an outstanding_amount but can't receive a payment
    // allocation until it's posted (see actions/accounting/bills.ts,
    // "Only draft bills can be posted"), so it isn't actually payable.
    // Restricted to the two statuses the AP subledger's own CHECK
    // constraint (0048_ap_subledger_schema.sql) says can carry a real
    // balance: 'posted' and 'partially_paid'.
    show("admin.ap_outstanding") || show("admin.ap_overdue")
      ? pagedRows<BillRow>(
          (from, to) =>
            admin
              .from("bills")
              .select("id, outstanding_amount, due_date, status")
              .gt("outstanding_amount", 0)
              // Same constant the bills list filters on for ?payable=1, so
              // the card and the screen it opens cannot drift apart.
              .in("status", PAYABLE_BILL_STATUSES as readonly string[])
              .order("id", { ascending: true })
              .range(from, to)
              .returns<BillRow[]>(),
          REPORT_EXPORT_MAX_ROWS,
        )
      : SKIP_ROWS,
    show("admin.patient_ar")
      ? pagedRows<PatientArRow>(
          (from, to) =>
            admin
              .from("visits")
              .select("id, total_php, paid_php")
              .in("payment_status", ["unpaid", "partial"])
              .is("hmo_provider_id", null)
              .is("deleted_at", null)
              .order("id", { ascending: true })
              .range(from, to)
              .returns<PatientArRow[]>(),
          REPORT_EXPORT_MAX_ROWS,
        )
      : SKIP_ROWS,
    // H5: `past_threshold` is the view's own per-provider comparison
    // (days_since_release > hmo_providers.unbilled_threshold_days,
    // default 14) — selected alongside the fixed-90-day column so both
    // bands (plus "all") can be computed client-side from one fetch. See
    // src/lib/reports/hmo-unbilled-bands.ts for the shared definition.
    show("admin.hmo_unbilled_aged")
      ? pagedRows<UnbilledRow>(
          (from, to) =>
            admin
              .from("v_hmo_unbilled")
              .select(
                "test_request_id, released_at, days_since_release, billed_amount_php, past_threshold",
              )
              .order("days_since_release", { ascending: false })
              .order("test_request_id", { ascending: true })
              .range(from, to)
              .returns<UnbilledRow[]>(),
          REPORT_EXPORT_MAX_ROWS,
        )
      : SKIP_ROWS,
    show("admin.advances_outstanding")
      ? pagedRows<AdvanceRow>(
          (from, to) =>
            admin
              .from("staff_advances")
              .select("id, outstanding_balance_php")
              .eq("status", "outstanding")
              .order("id", { ascending: true })
              .range(from, to)
              .returns<AdvanceRow[]>(),
          REPORT_EXPORT_MAX_ROWS,
        )
      : SKIP_ROWS,
    show("admin.pf_pending")
      ? pagedRows<PfRow>(
          (from, to) =>
            admin
              .from("doctor_pf_entries")
              .select("id, pf_php")
              .eq("recognition_basis", "hmo_at_settlement")
              .is("recognized_at", null)
              .is("voided_at", null)
              .order("id", { ascending: true })
              .range(from, to)
              .returns<PfRow[]>(),
          REPORT_EXPORT_MAX_ROWS,
        )
      : SKIP_ROWS,
    // H3: joined `physicians!inner` and required `is_active` so this
    // matches the payout screen's own predicate exactly
    // (pf-payouts-client.tsx OpenTab: `g.isActive && g.total > 0`) — an
    // inactive doctor with a balance was counted here but unpayable there.
    // `!inner` is required for the `.eq("physicians.is_active", …)` filter
    // to actually apply — the same embed against a left join silently
    // ignores the filter and returns every row (see CLAUDE.md).
    show("admin.pf_to_pay")
      ? pagedRows<PfToPayRow>(
          (from, to) =>
            admin
              .from("doctor_pf_entries")
              .select("id, pf_php, physician_id, physicians!inner(is_active)")
              .is("disbursement_id", null)
              .not("recognized_at", "is", null)
              .is("voided_at", null)
              .eq("physicians.is_active", true)
              .order("id", { ascending: true })
              .range(from, to)
              .returns<PfToPayRow[]>(),
          REPORT_EXPORT_MAX_ROWS,
        )
      : SKIP_ROWS,
    show("admin.active_employees")
      ? admin
          .from("employees")
          .select("id", { count: "exact", head: true })
          .eq("is_active", true)
          .is("termination_date", null)
      : SKIP_COUNT,
    // H11: scoped to the current fiscal year (the destination's own
    // default) and rendered only when nonzero below. PostgREST does not
    // honour a filter against an ALIASED embedded resource
    // (`payroll_periods.period_start`) — the payroll/runs page's own
    // comment confirms this is silently dropped — so the period ids for
    // the year are resolved first, exactly like that page does.
    show("admin.payroll_runs")
      ? (async () => {
          const { data: periodRows, error: periodErr } = await admin
            .from("payroll_periods")
            .select("id")
            .gte("period_start", `${currentFiscalYear}-01-01`)
            .lt("period_start", `${currentFiscalYear + 1}-01-01`);
          if (periodErr) return { count: 0, data: null, error: periodErr };
          const ids = (periodRows ?? []).map((p) => p.id);
          if (ids.length === 0) return { count: 0, data: null, error: null };
          return admin
            .from("payroll_runs")
            .select("id", { count: "exact", head: true })
            .in("period_id", ids)
            .in("status", ["draft", "computed"]);
        })()
      : SKIP_COUNT,
    // N14: added the 7-day recency window the strip never had — without
    // one, an old setup/void event sits here indefinitely. Mirrors
    // `sevenDaysAgoIso`, already used by the stale-drafts strip below.
    show("admin.strip_audit")
      ? admin
          .from("audit_log")
          .select("id, action, actor_type, created_at")
          .or(
            "action.ilike.%void%,action.ilike.%reverse%,action.ilike.%rejected%,action.ilike.%failed%",
          )
          .gte("created_at", sevenDaysAgoIso)
          .order("created_at", { ascending: false })
          .limit(5)
          .returns<AuditRow[]>()
      : SKIP_DATA,
    show("admin.strip_stale_drafts")
      ? admin
          .from("journal_entries")
          .select("id, entry_number, posting_date, created_at")
          .eq("status", "draft")
          .lt("created_at", sevenDaysAgoIso)
          .order("created_at", { ascending: true })
          .limit(5)
          .returns<DraftJeRow[]>()
      : SKIP_DATA,
    // Operations gross profit is v_ops_daily_totals.net, before expenses.
    // At most two rows per Manila day (lab and consult).
    show("admin.net_income_mtd")
      ? admin
          .from("v_ops_daily_totals")
          .select("net")
          .gte("business_date", monthStart)
          .lte("business_date", today)
          .returns<{ net: number | string }[]>()
      : SKIP_DATA,
    show("admin.net_income_books_mtd")
      ? loadIncomeStatementLines(admin, monthStart, today).then(
          (data) => ({ data, error: null }),
          (error: unknown) => ({ data: null, error }),
        )
      : SKIP_DATA,
    show("admin.new_messages")
      ? supabase
          .from("contact_messages")
          .select("id", { count: "exact", head: true })
          .eq("status", "new")
      : SKIP_COUNT,
  ]);

  // "Unclaimed": lab lines nobody holds yet, on the same money gate as the
  // Queue card — exactly the rows /staff/queue?filter=unclaimed lists. X-ray
  // is split out because an admin can no longer claim one (X-ray technician
  // only), so those wait on the technician, not on whoever is free.
  const unclaimedQuery = (xrayOnly: boolean) => {
    let q = supabase
      .from("test_requests")
      .select("id, services!inner ( id, section ), visits!inner ( id )", {
        count: "exact",
        head: true,
      })
      .in("status", ["requested", "in_progress"])
      .is("assigned_to", null)
      .eq("is_package_header", false)
      .is("deleted_at", null)
      .is("visits.deleted_at", null)
      .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
      .or(LAB_QUEUE_GATE_VISITS_OR, { foreignTable: "visits" });
    if (xrayOnly) q = q.eq("services.section", "imaging_xray");
    return q;
  };
  const [queueUnclaimed, queueUnclaimedXray] = show("admin.queue_unclaimed")
    ? await Promise.all([unclaimedQuery(false), unclaimedQuery(true)])
    : [
        { count: 0, error: null },
        { count: 0, error: null },
      ];

  // N19: this file used to read no `.error` at all — a failed query and a
  // genuinely empty one both rendered as a reassuring zero. Collect every
  // scope's error, report the failing ones, and keep a per-widget boolean
  // below so StatCard/ActivityStrip can say "Couldn't load" instead.
  const namedResults: { scope: string; error: unknown }[] = [
    { scope: "revenue_today", error: revenueToday.error },
    { scope: "past_due_periods", error: openPeriods.error },
    { scope: "draft_jes", error: draftJeCount.error },
    { scope: "ap_bills", error: bills.error },
    { scope: "patient_ar", error: patientAr.error },
    { scope: "hmo_unbilled", error: unbilled.error },
    { scope: "advances_outstanding", error: advances.error },
    { scope: "pf_pending", error: pfPending.error },
    { scope: "pf_to_pay", error: doctorsToPay.error },
    { scope: "active_employees", error: activeEmployees.error },
    { scope: "payroll_runs", error: payrollRunsInProgress.error },
    { scope: "strip_audit", error: recentAudit.error },
    { scope: "strip_stale_drafts", error: staleDrafts.error },
    { scope: "gross_profit_ops", error: grossProfitRows.error },
    { scope: "net_income_books", error: booksLines.error },
    { scope: "new_messages", error: newMessagesCount.error },
    { scope: "queue_unclaimed", error: queueUnclaimed.error ?? queueUnclaimedXray.error },
  ];
  await Promise.all(
    namedResults
      .filter((r) => r.error)
      .map((r) => reportError({ scope: `admin-dashboard.${r.scope}`, error: r.error })),
  );

  const revenueRows = revenueToday.rows;
  const revenueTotal = revenueRows.reduce((s, p) => s + Number(p.amount_php ?? 0), 0);
  const revenueTruncated = revenueToday.truncated;
  const revenueError = Boolean(revenueToday.error);

  const billRows = bills.rows;
  const apOutstanding = billRows.reduce((s, b) => s + Number(b.outstanding_amount ?? 0), 0);
  const apOverdueCount = billRows.filter((b) => b.due_date < today).length;
  const apTruncated = bills.truncated;
  const apError = Boolean(bills.error);

  // H7: only POSITIVE balances count and display — the destination page
  // only buckets `outstanding > 0` (patient-ar/page.tsx), so a zero-balance
  // unpaid/partial visit was inflating this card's count against what the
  // page itself shows.
  // Known edge (not fixed here): resolving an HMO claim as "Bill patient"
  // never clears visits.hmo_provider_id, so those visits stay invisible to
  // this card (which filters `.is("hmo_provider_id", null)`) — reachable
  // only via patient-ar's own `?scope=hmo|all` tabs.
  const patientArPositive = patientAr.rows.filter(
    (v) => Number(v.total_php ?? 0) - Number(v.paid_php ?? 0) > 0,
  );
  const patientArTotal = patientArPositive.reduce(
    (s, v) => s + (Number(v.total_php ?? 0) - Number(v.paid_php ?? 0)),
    0,
  );
  const patientArCount = patientArPositive.length;
  const patientArTruncated = patientAr.truncated;
  const patientArError = Boolean(patientAr.error);

  // H5: one fetch, three precomputed totals — see hmo-unbilled-bands.ts.
  const unbilledBandStats = Object.fromEntries(
    HMO_UNBILLED_AGE_BANDS.map((band) => {
      const rows = unbilled.rows.filter((u) => matchesHmoUnbilledAgeBand(u, band));
      return [
        band,
        {
          count: rows.length,
          total: rows.reduce((s, u) => s + Number(u.billed_amount_php ?? 0), 0),
        },
      ];
    }),
  ) as Record<HmoUnbilledAgeBand, { count: number; total: number }>;
  const unbilledTruncated = unbilled.truncated;
  const unbilledError = Boolean(unbilled.error);

  const advancesTotal = advances.rows.reduce(
    (s, a) => s + Number(a.outstanding_balance_php ?? 0),
    0,
  );
  const advancesTruncated = advances.truncated;
  const advancesError = Boolean(advances.error);

  const pfPendingTotal = pfPending.rows.reduce((s, p) => s + Number(p.pf_php ?? 0), 0);
  const pfPendingTruncated = pfPending.truncated;
  const pfPendingError = Boolean(pfPending.error);

  // "Ready to pay" PF, grouped per doctor: total owed + how many doctors have
  // a positive balance (matches the Pay doctors page's Ready-to-pay tab).
  // The query above already restricts to active physicians, matching that
  // page's `g.isActive` half of the predicate; `> 0` below matches its
  // `g.total > 0` half.
  const toPayByDoctor = new Map<string, number>();
  for (const r of doctorsToPay.rows) {
    toPayByDoctor.set(
      r.physician_id,
      (toPayByDoctor.get(r.physician_id) ?? 0) + Number(r.pf_php ?? 0),
    );
  }
  const positiveDoctorTotals = Array.from(toPayByDoctor.values()).filter((v) => v > 0);
  const doctorsToPayCount = positiveDoctorTotals.length;
  const doctorsToPayTotal = positiveDoctorTotals.reduce((s, v) => s + v, 0);
  const doctorsToPayTruncated = doctorsToPay.truncated;
  const doctorsToPayError = Boolean(doctorsToPay.error);

  const grossProfitMtd =
    ((grossProfitRows.data ?? []) as { net: number | string }[]).reduce(
      (sum, row) => sum + Number(row.net ?? 0), 0,
    );
  const grossProfitError = Boolean(grossProfitRows.error);
  const booksNetIncomeMtd = incomeStatementTotals(booksLines.data ?? []).netIncome;
  const booksNetIncomeError = Boolean(booksLines.error);

  // Released-today, grouped by who the test was assigned to. Names come from
  // staff_profiles in one follow-up read; an id we can't resolve keeps its
  // bucket and reads "Unknown staff" rather than vanishing from the total.
  const releasedByCounts = new Map<string, number>();
  for (const r of releasedByStaff.rows) {
    const key = r.assigned_to ?? "unassigned";
    releasedByCounts.set(key, (releasedByCounts.get(key) ?? 0) + 1);
  }
  const releasedStaffIds = [...releasedByCounts.keys()].filter(
    (k) => k !== "unassigned",
  );
  const releasedNames = new Map<string, string>();
  if (releasedStaffIds.length > 0) {
    const { data: profs } = await admin
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", releasedStaffIds);
    for (const prof of profs ?? []) releasedNames.set(prof.id, prof.full_name);
  }
  const releasedByStaffRows = [...releasedByCounts.entries()]
    .map(([key, count]) => ({
      key,
      name:
        key === "unassigned"
          ? "Unassigned"
          : (releasedNames.get(key) ?? "Unknown staff"),
      count,
    }))
    // Busiest first, with a stable tie-break so equal counts don't reorder
    // between renders.
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const releasedByStaffTotal = releasedByStaff.rows.length;

  // Possible-duplicate pairs (scored in TS, so not part of the count batch
  // above). H12: now paged (was a bare `.select("*")`, silently capped at
  // 1000 pairs) and distinguishes a failed read from a genuinely clean pass.
  const dup = show("admin.dup_candidates")
    ? await loadCandidatePairsWithStatus(admin, { minTier: "probable" })
    : { pairs: [], truncated: false, error: false };
  const dupCandidates = dup.pairs.length;
  const dupTruncated = dup.truncated;
  const dupError = dup.error;

  return {
    // Visits today and Queue render below; Released today ships hidden via
    // cards.ts but keeps its render so the toggle works.
    visitsToday: visitsToday.count ?? 0,
    visitsTodayError: Boolean(visitsToday.error),
    queueTotal: queueTotal.count ?? 0,
    queueTotalError: Boolean(queueTotal.error),
    queueUnclaimed: queueUnclaimed.count ?? 0,
    queueUnclaimedXray: queueUnclaimedXray.count ?? 0,
    queueUnclaimedError: Boolean(queueUnclaimed.error || queueUnclaimedXray.error),
    releasedToday: releasedToday.count ?? 0,
    releasedTodayError: Boolean(releasedToday.error),
    releasedByStaffRows,
    releasedByStaffTotal,
    releasedByStaffTruncated: releasedByStaff.truncated,
    releasedByStaffError: Boolean(releasedByStaff.error),
    revenueTotal,
    revenueTruncated,
    revenueError,
    openPeriods: openPeriods.count ?? 0,
    openPeriodsError: Boolean(openPeriods.error),
    draftJeCount: draftJeCount.count ?? 0,
    draftJeError: Boolean(draftJeCount.error),
    apOutstanding,
    apOverdueCount,
    apTruncated,
    apError,
    patientArTotal,
    patientArCount,
    patientArTruncated,
    patientArError,
    unbilledBandStats,
    unbilledTruncated,
    unbilledError,
    advancesTotal,
    advancesTruncated,
    advancesError,
    pfPendingTotal,
    pfPendingTruncated,
    pfPendingError,
    doctorsToPayTotal,
    doctorsToPayCount,
    doctorsToPayTruncated,
    doctorsToPayError,
    grossProfitMtd,
    grossProfitError,
    booksNetIncomeMtd,
    booksNetIncomeError,
    activeEmployees: activeEmployees.count ?? 0,
    activeEmployeesError: Boolean(activeEmployees.error),
    payrollRunsInProgress: payrollRunsInProgress.count ?? 0,
    payrollRunsError: Boolean(payrollRunsInProgress.error),
    recentAudit: (recentAudit.data ?? []) as AuditRow[],
    auditStripError: Boolean(recentAudit.error),
    staleDrafts: (staleDrafts.data ?? []) as DraftJeRow[],
    staleDraftsError: Boolean(staleDrafts.error),
    dupCandidates,
    dupTruncated,
    dupError,
    newMessages: newMessagesCount.count ?? 0,
    newMessagesError: Boolean(newMessagesCount.error),
    currentFiscalYear,
    today,
    monthStart,
  };
}

export async function AdminDashboard({ session }: { session: StaffSession }) {
  const hidden = await loadHiddenCardIds("admin");
  const show = (id: string) => !hidden.has(id);
  const stats = await loadAdminStats(show);

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

  // N18: SectionHeading's own `if (!children)` fallback can never fire when
  // the caller always hands it a (truthy) <div> — which is what every
  // section here did. Compute "does this section have anything to show"
  // at the call site instead, and skip the whole section when it doesn't;
  // this is only live now because N13's cuts + the nonzero-only gates below
  // can genuinely empty a section.
  const showDupCard = show("admin.dup_candidates") && (stats.dupError || stats.dupCandidates > 0);
  const showOperations =
    show("admin.revenue_today") ||
    show("admin.visits_today") ||
    show("admin.queue_total") ||
    show("admin.queue_unclaimed") ||
    show("admin.released_today") ||
    showDupCard ||
    show("admin.new_messages");

  const showMoney =
    show("admin.net_income_mtd") ||
    show("admin.net_income_books_mtd") ||
    show("admin.past_due_periods") ||
    show("admin.draft_jes") ||
    show("admin.ap_outstanding") ||
    show("admin.ap_overdue") ||
    show("admin.hmo_unbilled_aged") ||
    show("admin.patient_ar") ||
    show("admin.advances_outstanding") ||
    show("admin.pf_to_pay");

  const showPayrollRunsCard =
    show("admin.payroll_runs") && (stats.payrollRunsError || stats.payrollRunsInProgress > 0);
  const showPeople = show("admin.active_employees") || showPayrollRunsCard;

  const releasedByStaffItems: ActivityItem[] = stats.releasedByStaffRows.map(
    (r) => ({
      primary: r.name,
      secondary: `${r.count} test${r.count === 1 ? "" : "s"} released`,
      href: "/staff/queue?filter=released_today",
    }),
  );
  const showReleasedByStaffStrip =
    show("admin.strip_released_by_staff") &&
    (stats.releasedByStaffError || stats.releasedByStaffTotal > 0);

  const showStaleDraftsStrip =
    show("admin.strip_stale_drafts") && (stats.staleDraftsError || stats.staleDrafts.length > 0);
  const showAttention =
    show("admin.strip_audit") || showStaleDraftsStrip || showReleasedByStaffStrip;

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <RealtimeRefresher
        channelName="admin-dashboard"
        subscriptions={NO_SUBSCRIPTIONS}
        intervalMs={60000}
      />
      <DashboardHeader
        firstName={session.full_name.split(" ")[0]}
        roleLabel="Admin"
        title="Clinic command centre"
        updatedAt={new Date()}
      />

      <EodReminderBanner />

      {showOperations && (
        <SectionHeading title="Operations">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {show("admin.revenue_today") && (
              <StatCard
                label="Payments collected today"
                value={formatPeso(stats.revenueTotal)}
                hint={truncatedHint(stats.revenueTruncated, "Collected payments, today")}
                href={`/staff/admin/operations/cash?from=${stats.today}&to=${stats.today}`}
                accent="good"
                error={stats.revenueError}
              />
            )}
            {show("admin.visits_today") && (
              <StatCard
                label="Visits today"
                value={stats.visitsToday}
                hint="Visits opened today"
                href={`/staff/visits?start=${stats.today}&end=${stats.today}`}
                error={stats.visitsTodayError}
              />
            )}
            {show("admin.queue_total") && (
              <StatCard
                label="Queue"
                value={stats.queueTotal}
                hint="All dates — lab & imaging lines awaiting a result"
                href="/staff/queue"
                error={stats.queueTotalError}
              />
            )}
            {show("admin.queue_unclaimed") && (
              <StatCard
                label="Unclaimed"
                value={stats.queueUnclaimed}
                hint={
                  stats.queueUnclaimedXray > 0
                    ? `All dates — waiting for someone to pick up · ${stats.queueUnclaimedXray} x-ray for the X-ray technician`
                    : "All dates — paid lab & imaging lines nobody has picked up"
                }
                href="/staff/queue?filter=unclaimed"
                error={stats.queueUnclaimedError}
              />
            )}
            {show("admin.released_today") && (
              <StatCard
                label="Released today (plain count)"
                value={stats.releasedToday}
                hint="Lab & imaging results released today"
                href="/staff/queue?filter=released_today"
                error={stats.releasedTodayError}
              />
            )}
            {showDupCard && (
              <StatCard
                label="Possible duplicates"
                value={stats.dupCandidates}
                hint={truncatedHint(stats.dupTruncated, "Patient records to review & merge")}
                href="/staff/admin/patient-merge/candidates"
                accent={stats.dupCandidates > 0 ? "warn" : "default"}
                error={stats.dupError}
              />
            )}
            {show("admin.new_messages") && (
              <StatCard
                label="Website messages"
                value={stats.newMessages}
                hint="Waiting for a reply"
                href="/staff/messages"
                accent={stats.newMessages > 0 ? "warn" : "default"}
                error={stats.newMessagesError}
              />
            )}
          </div>
        </SectionHeading>
      )}

      {showMoney && (
        <SectionHeading title="Money">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {show("admin.net_income_books_mtd") && (
              <StatCard
                label="Net Income (Books)"
                value={formatPeso(stats.booksNetIncomeMtd)}
                hint="This month · posted revenue less contra revenue and expenses"
                href={`/staff/admin/accounting/financial-statements?start=${stats.monthStart}&end=${stats.today}`}
                accent={stats.booksNetIncomeMtd >= 0 ? "good" : "warn"}
                error={stats.booksNetIncomeError}
              />
            )}
            {show("admin.net_income_mtd") && (
              <StatCard
                label="Gross Profit (Ops)"
                value={formatPeso(stats.grossProfitMtd)}
                hint="This month · released lab + consult revenue after discounts, before expenses"
                href={`/staff/admin/operations/expenses?from=${stats.monthStart}&to=${stats.today}`}
                accent={stats.grossProfitMtd >= 0 ? "good" : "warn"}
                error={stats.grossProfitError}
              />
            )}
            {show("admin.past_due_periods") && (
              <StatCard
                label="Past-due open periods"
                value={stats.openPeriods}
                hint={`Ended, still open — FY ${stats.currentFiscalYear}`}
                href={`/staff/admin/accounting/periods?year=${stats.currentFiscalYear}`}
                accent={stats.openPeriods > 0 ? "warn" : "default"}
                error={stats.openPeriodsError}
              />
            )}
            {show("admin.draft_jes") && (
              <StatCard
                label="Draft journal entries"
                value={stats.draftJeCount}
                hint="Awaiting posting"
                href="/staff/admin/accounting/journal?status=draft"
                accent={stats.draftJeCount > 0 ? "warn" : "default"}
                error={stats.draftJeError}
              />
            )}
            {show("admin.ap_outstanding") ? (
              <StatCard
                label="AP outstanding"
                value={formatPeso(stats.apOutstanding)}
                hint={truncatedHint(
                  stats.apTruncated,
                  show("admin.ap_overdue")
                    ? `${stats.apOverdueCount} overdue`
                    : "Posted / partially paid",
                )}
                href="/staff/admin/accounting/ap/bills?payable=1"
                accent={stats.apOverdueCount > 0 ? "warn" : "default"}
                error={stats.apError}
              />
            ) : (
              show("admin.ap_overdue") && (
                <StatCard
                  label="AP bills overdue"
                  value={stats.apOverdueCount}
                  hint={truncatedHint(stats.apTruncated, "Past due date")}
                  href="/staff/admin/accounting/ap/bills?payable=1&overdue=1"
                  accent={stats.apOverdueCount > 0 ? "warn" : "default"}
                  error={stats.apError}
                />
              )
            )}
            {show("admin.hmo_unbilled_aged") && (
              <HmoUnbilledCard
                stats={stats.unbilledBandStats}
                truncated={stats.unbilledTruncated}
                error={stats.unbilledError}
              />
            )}
            {show("admin.patient_ar") && (
              <StatCard
                label="Patient AR outstanding"
                value={formatPeso(stats.patientArTotal)}
                hint={truncatedHint(
                  stats.patientArTruncated,
                  `${stats.patientArCount} non-HMO visit${stats.patientArCount === 1 ? "" : "s"} with an outstanding balance`,
                )}
                href="/staff/admin/accounting/patient-ar"
                accent={stats.patientArCount > 0 ? "warn" : "default"}
                error={stats.patientArError}
              />
            )}
            {show("admin.advances_outstanding") && (
              <StatCard
                label="Staff advances outstanding"
                value={formatPeso(stats.advancesTotal)}
                hint={truncatedHint(stats.advancesTruncated, "Receivable from payroll deductions")}
                href="/staff/admin/reports/staff-advances"
                error={stats.advancesError}
              />
            )}
            {show("admin.pf_to_pay") && (
              <StatCard
                label="Doctors to pay"
                value={stats.doctorsToPayCount === 0 ? "—" : formatPeso(stats.doctorsToPayTotal)}
                hint={doctorsToPayHint(stats)}
                href="/staff/admin/accounting/pf-payouts?tab=open"
                accent={stats.doctorsToPayCount > 0 ? "warn" : "default"}
                error={stats.doctorsToPayError}
              />
            )}
          </div>
        </SectionHeading>
      )}

      {showPeople && (
        <SectionHeading title="People">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {show("admin.active_employees") && (
              <StatCard
                label="Active employees"
                value={stats.activeEmployees}
                hint="On the roster today"
                href="/staff/admin/payroll/employees"
                error={stats.activeEmployeesError}
              />
            )}
            {showPayrollRunsCard && (
              <StatCard
                label="Payroll runs in progress"
                value={stats.payrollRunsInProgress}
                hint={`Draft or computed — FY ${stats.currentFiscalYear}`}
                href={`/staff/admin/payroll/runs?year=${stats.currentFiscalYear}`}
                accent="warn"
                error={stats.payrollRunsError}
              />
            )}
          </div>
        </SectionHeading>
      )}

      <SectionHeading title="Quicklinks">
        <QuickLinks items={QUICK_LINKS} />
      </SectionHeading>

      {showAttention && (
        <SectionHeading title="What needs attention">
          <div className="grid gap-4 lg:grid-cols-2">
            {show("admin.strip_audit") && (
              <ActivityStrip
                title="Recent audit anomalies (7d)"
                items={auditItems}
                emptyMessage="No void / reversal / rejection events in the last 7 days."
                viewAllHref="/staff/audit"
                error={stats.auditStripError}
              />
            )}
            {showReleasedByStaffStrip && (
              <ActivityStrip
                title={
                  stats.releasedByStaffTruncated
                    ? `Released today by staff (${stats.releasedByStaffTotal}+)`
                    : `Released today by staff (${stats.releasedByStaffTotal})`
                }
                items={releasedByStaffItems}
                emptyMessage="Nothing released yet today."
                viewAllHref="/staff/queue?filter=released_today"
                error={stats.releasedByStaffError}
              />
            )}
            {showStaleDraftsStrip && (
              <ActivityStrip
                title="Stale draft journals (7d+)"
                items={draftItems}
                emptyMessage="No drafts older than a week."
                viewAllHref="/staff/admin/accounting/journal?status=draft"
                error={stats.staleDraftsError}
              />
            )}
          </div>
        </SectionHeading>
      )}
    </div>
  );
}

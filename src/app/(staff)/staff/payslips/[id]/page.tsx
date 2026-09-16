import { ROUTE_NAME } from "@/lib/staff/route-names";
import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import { pluckOne } from "@/lib/reports/format";
import { manilaDate } from "@/lib/dates/manila";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadPayslipData } from "@/lib/payroll/payslip-pdf";
import { payslipVisibleToStaff } from "@/lib/payroll/payslip-visibility";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import { hasRecentAudit } from "@/lib/server/action-helpers";
import { PayslipDetailClient } from "./payslip-detail-client";

const loadPayslipHeader = cache(async (employeeRunId: string) => {
  const session = await requireActiveStaff();
  // RLS trap: `payroll_runs` has exactly one policy (admin-only), so a
  // non-admin staff user cannot SELECT it directly or through an embed.
  // Keep the admin client here — swapping in the RLS-scoped server client
  // would make the `payroll_runs!inner(...)` embed below return zero rows
  // for every non-admin and break this page outright, not merely leak less.
  const admin = createAdminClient();

  // 1. Authorize. Own payslip OR admin. Anything else → notFound() so we
  // don't leak existence to unauthorized viewers.
  const { data: er, error: erErr } = await admin
    .from("payroll_employee_runs")
    .select(
      "id, employee_id, payslip_file_path, run_id, employees!inner(staff_profile_id), payroll_runs!inner(status, payroll_periods!inner(period_start, period_end))",
    )
    .eq("id", employeeRunId)
    .maybeSingle();
  if (erErr || !er) {
    notFound();
  }

  const employeeJoin = er.employees as { staff_profile_id: string };
  const isOwn = employeeJoin.staff_profile_id === session.user_id;
  const isAdmin = session.role === "admin";
  if (!isOwn && !isAdmin) {
    notFound();
  }

  // A payslip is visible to staff only once its run is finalised or paid
  // (see payslip-visibility.ts). Admin is exempt — they may legitimately
  // need to inspect a draft/computed run's in-progress numbers (debugging a
  // wrong figure before finalise). A non-admin hitting this route for their
  // own not-yet-finalised run gets the same notFound() as one they don't
  // own at all, so we don't leak "this payslip exists but isn't ready".
  const runStatus = (er.payroll_runs as { status: string }).status;
  if (!isAdmin && !payslipVisibleToStaff(runStatus)) {
    notFound();
  }

  return { session, admin, er, isOwn, isAdmin };
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  await requireActiveStaff();
  const { id } = await params;
  return detailMetadata(ROUTE_NAME["/staff/payslips/[id]"], async () => {
    const { er } = await loadPayslipHeader(id);
    const period = pluckOne(pluckOne(er.payroll_runs)?.payroll_periods ?? null);
    return period ? `${manilaDate(period.period_start)} – ${manilaDate(period.period_end)}` : null;
  });
}
export const dynamic = "force-dynamic";

export default async function PayslipDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireActiveStaff();
  const { id: employeeRunId } = await params;
  const { admin, er, isOwn, isAdmin } = await loadPayslipHeader(employeeRunId);

  // 2. Load full detail data via the shared loader (same shape as the PDF).
  // Admin may be inspecting a draft/computed run (see gate above), so pass
  // allowNonFinalisedRun for admin viewers — the loader's own default is to
  // require a finalised run, matching the non-admin path we already gated.
  let data;
  try {
    data = await loadPayslipData(admin, employeeRunId, {
      allowNonFinalisedRun: isAdmin,
    });
  } catch (err) {
    // Malformed/missing joins — treat as not found rather than crash. Report
    // to Sentry so production 500s don't silently become 404s.
    await reportError({
      scope: "payroll.payslip_detail_load",
      error: err,
      metadata: { employee_run_id: employeeRunId },
    });
    notFound();
  }

  // 3. Audit the view. Distinct from `.downloaded` (raised by
  // getPayslipUrlAction) — `.viewed` covers opening the detail page even if
  // the PDF is never fetched. Mirrors the result.viewed / result.downloaded
  // split used by the lab-result portal.
  //
  // Dedupe at write time: `dynamic = 'force-dynamic'` re-emits a viewed row
  // on every navigation (back button, tab switch). Suppress if the same
  // viewer audited this resource in the last 5 minutes — that window covers
  // session-like browsing while still catching genuine re-opens.
  const recentlyViewed = await hasRecentAudit(
    admin,
    {
      actor_id: session.user_id,
      action: "payroll_payslip.viewed",
      resource_id: employeeRunId,
    },
    5,
  );

  if (!recentlyViewed) {
    const h = await headers();
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "payroll_payslip.viewed",
      resource_type: "payroll_employee_run",
      resource_id: employeeRunId,
      metadata: {
        employee_id: er.employee_id,
        payroll_run_id: er.run_id,
        viewer_role: session.role,
        cross_employee: !isOwn,
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }

  return (
    <PayslipDetailClient
      data={data}
      employeeRunId={employeeRunId}
      hasFile={!!er.payslip_file_path}
      viewingAsAdmin={!isOwn && isAdmin}
    />
  );
}

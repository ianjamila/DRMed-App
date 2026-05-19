import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadPayslipData } from "@/lib/payroll/payslip-pdf";
import { audit } from "@/lib/audit/log";
import { PayslipDetailClient } from "./payslip-detail-client";

export const metadata = { title: "Payslip" };
export const dynamic = "force-dynamic";

export default async function PayslipDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireActiveStaff();
  const { id: employeeRunId } = await params;
  const admin = createAdminClient();

  // 1. Authorize. Own payslip OR admin. Anything else → notFound() so we
  // don't leak existence to unauthorized viewers.
  const { data: er, error: erErr } = await admin
    .from("payroll_employee_runs")
    .select(
      "id, employee_id, payslip_file_path, run_id, employees!inner(staff_profile_id)",
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

  // 2. Load full detail data via the shared loader (same shape as the PDF).
  let data;
  try {
    data = await loadPayslipData(admin, employeeRunId);
  } catch {
    // Malformed/missing joins — treat as not found rather than crash. The
    // shared loader already logs the underlying error.
    notFound();
  }

  // 3. Audit the view. Distinct from `.downloaded` (raised by
  // getPayslipUrlAction) — `.viewed` covers opening the detail page even if
  // the PDF is never fetched. Mirrors the result.viewed / result.downloaded
  // split used by the lab-result portal.
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

  return (
    <PayslipDetailClient
      data={data}
      employeeRunId={employeeRunId}
      hasFile={!!er.payslip_file_path}
    />
  );
}

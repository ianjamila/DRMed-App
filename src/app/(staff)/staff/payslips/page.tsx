import { requireActiveStaff } from "@/lib/auth/require-staff";
import {
  listMyPayslipsAction,
  getMyYtdTotalsAction,
  listEmployeesForPayslipAdminAction,
  type PayslipListItem,
  type YtdTotals,
  type EmployeePayslipAdminOption,
} from "./actions";
import { PayslipsClient } from "./payslips-client";

export const metadata = { title: "My payslips" };
export const dynamic = "force-dynamic";

export default async function PayslipsPage({
  searchParams,
}: {
  searchParams: Promise<{ employee_id?: string; year?: string }>;
}) {
  const session = await requireActiveStaff();
  const params = await searchParams;

  const isAdmin = session.role === "admin";
  const currentYear = new Date().getFullYear();
  const parsedYear = params.year ? Number.parseInt(params.year, 10) : NaN;
  const selectedYear = Number.isFinite(parsedYear) ? parsedYear : currentYear;
  const targetEmployeeId = isAdmin ? params.employee_id : undefined;

  // We deliberately request the FULL list (no year filter at the action level)
  // so the client can switch year tabs without a round-trip — the action
  // returns at most 200 records, well within memory.
  const [listRes, ytdRes, adminEmployeesRes] = await Promise.all([
    listMyPayslipsAction({ employee_id: targetEmployeeId }),
    getMyYtdTotalsAction({ employee_id: targetEmployeeId, year: selectedYear }),
    isAdmin
      ? listEmployeesForPayslipAdminAction()
      : Promise.resolve({ ok: true as const, data: { employees: [] } }),
  ]);

  const payslips: PayslipListItem[] = listRes.ok ? listRes.data.payslips : [];
  const ytd: YtdTotals = ytdRes.ok
    ? ytdRes.data.ytd
    : {
        gross_pay_php: 0,
        total_deductions_php: 0,
        net_pay_php: 0,
        payslip_count: 0,
      };
  const adminEmployees: EmployeePayslipAdminOption[] = adminEmployeesRes.ok
    ? adminEmployeesRes.data.employees
    : [];

  const errorMsg = !listRes.ok
    ? listRes.error
    : !ytdRes.ok
      ? ytdRes.error
      : null;

  // Detect "no employee row" — listMyPayslipsAction returns ok=true with empty
  // payslips both when the user has no employees row AND when the user simply
  // has no payslips yet. To distinguish, we check for the existence of an
  // employees row when the list is empty. We don't need it when admin is
  // viewing another employee.
  const hasOwnEmployeeRecord = await (async () => {
    if (targetEmployeeId) return true;
    if (payslips.length > 0) return true;
    // Lazy import to avoid a top-level admin client in the page module.
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const { data } = await admin
      .from("employees")
      .select("id")
      .eq("staff_profile_id", session.user_id)
      .maybeSingle();
    return !!data;
  })();

  return (
    <PayslipsClient
      payslips={payslips}
      ytd={ytd}
      selectedYear={selectedYear}
      currentYear={currentYear}
      isAdmin={isAdmin}
      selectedEmployeeId={targetEmployeeId ?? null}
      adminEmployees={adminEmployees}
      hasEmployeeRecord={hasOwnEmployeeRecord}
      errorMessage={errorMsg}
      viewerFullName={session.full_name}
    />
  );
}

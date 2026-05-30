import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  EmployeesClient,
  type EmployeeListRow,
  type EligibleStaffOption,
} from "./employees-client";

export const metadata = { title: "Employees — payroll admin" };
export const dynamic = "force-dynamic";

export default async function PayrollEmployeesPage() {
  await requireAdminStaff();

  // Service-role client: we need to join across employees → staff_profiles
  // for every row regardless of the caller's RLS filter, and we want to
  // resolve eligible staff who don't yet have an employee row.
  const admin = createAdminClient();

  const [employeesRes, staffRes, employeeStaffIdsRes] = await Promise.all([
    admin
      .from("employees")
      .select(
        "id, employee_number, hire_date, regularization_date, termination_date, basic_daily_rate_php, schedule_kind, payment_method, is_active, staff_profile_id, staff_profiles:staff_profile_id(full_name, role)",
      ),
    admin
      .from("staff_profiles")
      .select("id, full_name, role")
      .eq("is_active", true)
      .order("full_name", { ascending: true }),
    admin.from("employees").select("staff_profile_id"),
  ]);

  // Narrow into the typed row shape we render.
  const employees: EmployeeListRow[] = (employeesRes.data ?? [])
    .map((row) => {
      // PostgREST embeds the related row as an object for to-one FKs but the
      // generated type can sometimes widen to an array. Normalise here.
      const profile = Array.isArray(row.staff_profiles)
        ? row.staff_profiles[0]
        : row.staff_profiles;
      return {
        id: row.id,
        employee_number: row.employee_number,
        hire_date: row.hire_date,
        regularization_date: row.regularization_date,
        termination_date: row.termination_date,
        basic_daily_rate_php: Number(row.basic_daily_rate_php),
        schedule_kind: row.schedule_kind,
        payment_method: row.payment_method,
        is_active: row.is_active,
        full_name: profile?.full_name ?? "Unknown",
        role: profile?.role ?? null,
      };
    })
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  const takenStaffIds = new Set(
    (employeeStaffIdsRes.data ?? [])
      .map((r) => r.staff_profile_id)
      .filter((v): v is string => Boolean(v)),
  );
  const eligibleStaff: EligibleStaffOption[] = (staffRes.data ?? [])
    .filter((s) => !takenStaffIds.has(s.id))
    .map((s) => ({ id: s.id, full_name: s.full_name, role: s.role }));

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Employees
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Payroll employee roster — click an employee to manage allowances,
          loans, and leaves.
        </p>
      </header>

      <EmployeesClient employees={employees} eligibleStaff={eligibleStaff} />
    </div>
  );
}

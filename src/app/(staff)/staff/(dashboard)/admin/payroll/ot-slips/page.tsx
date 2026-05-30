import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import {
  OtSlipsClient,
  type EmployeeOption,
  type OtSlipRow,
  type StatusFilter,
} from "./ot-slips-client";

export const metadata = { title: "OT slips — payroll admin" };
export const dynamic = "force-dynamic";

const STATUS_FILTERS: ReadonlySet<StatusFilter> = new Set<StatusFilter>([
  "all",
  "pending",
  "approved",
  "rejected",
  "voided",
]);

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

/**
 * Shift a YYYY-MM-DD wall-clock string by `days`. Positive `days` moves
 * forward, negative moves back. Uses UTC arithmetic on the date components,
 * which is safe for date-only strings (no DST artefacts).
 */
function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((v) => Number.parseInt(v, 10));
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export default async function OtSlipsPage({ searchParams }: PageProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const today = todayManilaISODate();
  const defaultFrom = shiftIsoDate(today, -30);
  const defaultTo = shiftIsoDate(today, 7);

  const statusParam = sp.status ?? "all";
  const status: StatusFilter = STATUS_FILTERS.has(statusParam as StatusFilter)
    ? (statusParam as StatusFilter)
    : "all";
  // Reject any non-UUID employee value before it reaches Postgres — otherwise
  // .eq("employee_id", "garbage") raises 22P02.
  const uuidRe =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const employeeParam =
    sp.employee && sp.employee !== "all" && uuidRe.test(sp.employee)
      ? sp.employee
      : "";
  // Loose validation: must be 10-char YYYY-MM-DD. Anything else falls back to
  // the default, so a malformed query string can't blow up the page.
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  const dateFrom = sp.date_from && isoRe.test(sp.date_from) ? sp.date_from : defaultFrom;
  const dateTo = sp.date_to && isoRe.test(sp.date_to) ? sp.date_to : defaultTo;

  const admin = createAdminClient();

  // -- Active employees for filter + create form. Sorted by name.
  type RawEmployee = {
    id: string;
    employee_number: string | null;
    staff_profile:
      | { full_name: string | null }
      | { full_name: string | null }[]
      | null;
  };
  const { data: empRows, error: empErr } = await admin
    .from("employees")
    .select(
      "id, employee_number, staff_profile:staff_profiles!inner(full_name)",
    )
    .eq("is_active", true)
    .returns<RawEmployee[]>();
  if (empErr) {
    console.error("[payroll/ot-slips] employees query failed:", empErr);
  }
  const employees: EmployeeOption[] = (empRows ?? [])
    .map((e) => {
      const profile = Array.isArray(e.staff_profile)
        ? e.staff_profile[0]
        : e.staff_profile;
      return {
        id: e.id,
        full_name: profile?.full_name ?? "(unknown)",
        employee_number: e.employee_number,
      };
    })
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  // -- OT slips with embedded employee + uploader/decider profiles. Filter
  // by work_date window so the table is bounded.
  type RawSlip = {
    id: string;
    employee_id: string;
    work_date: string;
    hours_requested: number;
    reason: string | null;
    status: string;
    requested_at: string;
    decided_at: string | null;
    decision_notes: string | null;
    decided_by: string | null;
    employee:
      | {
          id: string;
          employee_number: string | null;
          staff_profile:
            | { full_name: string | null }
            | { full_name: string | null }[]
            | null;
        }
      | {
          id: string;
          employee_number: string | null;
          staff_profile:
            | { full_name: string | null }
            | { full_name: string | null }[]
            | null;
        }[]
      | null;
    decider:
      | { full_name: string | null }
      | { full_name: string | null }[]
      | null;
  };

  let slipsQuery = admin
    .from("payroll_ot_slips")
    .select(
      `id, employee_id, work_date, hours_requested, reason, status,
       requested_at, decided_at, decision_notes, decided_by,
       employee:employees!inner(
         id, employee_number,
         staff_profile:staff_profiles!inner(full_name)
       ),
       decider:staff_profiles!payroll_ot_slips_decided_by_fkey(full_name)`,
    )
    .gte("work_date", dateFrom)
    .lte("work_date", dateTo)
    .order("work_date", { ascending: false });

  if (status !== "all") {
    slipsQuery = slipsQuery.eq("status", status);
  }
  if (employeeParam) {
    slipsQuery = slipsQuery.eq("employee_id", employeeParam);
  }

  const { data: rawSlips, error: slipsErr } = await slipsQuery.returns<
    RawSlip[]
  >();
  if (slipsErr) {
    console.error("[payroll/ot-slips] slips query failed:", slipsErr);
  }

  const slips: OtSlipRow[] = (rawSlips ?? []).map((row) => {
    const emp = Array.isArray(row.employee) ? row.employee[0] : row.employee;
    const profile = emp
      ? Array.isArray(emp.staff_profile)
        ? emp.staff_profile[0]
        : emp.staff_profile
      : null;
    const decider = Array.isArray(row.decider) ? row.decider[0] : row.decider;
    return {
      id: row.id,
      employee_id: row.employee_id,
      employee_name: profile?.full_name ?? "(unknown)",
      employee_number: emp?.employee_number ?? null,
      work_date: row.work_date,
      hours_requested: Number(row.hours_requested),
      reason: row.reason,
      status: row.status,
      requested_at: row.requested_at,
      decided_at: row.decided_at,
      decision_notes: row.decision_notes,
      decided_by_name: decider?.full_name ?? null,
    };
  });

  const dbError = slipsErr || empErr ? "Failed to load OT slips." : null;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          OT slips
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Overtime requests. Pending slips block the run until approved or
          rejected.
        </p>
      </header>

      <OtSlipsClient
        slips={slips}
        employees={employees}
        currentStatus={status}
        currentEmployee={employeeParam}
        dateFrom={dateFrom}
        dateTo={dateTo}
        defaultWorkDate={today}
        error={dbError}
      />
    </div>
  );
}

// M2 milestone tinker smoke for the 12.6 payroll compute engine.
//
// Seeds the prerequisite auth.users + staff_profile + employee + allowance +
// period + run + DTR rows against the LOCAL Supabase stack (NOT the remote!),
// runs computePayrollRun, asserts the headline numbers (basic 5×₱660,
// allowance 5×₱30, gross 3450), then voids the run and cleans up.
//
// Run via:
//   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
//   SUPABASE_SERVICE_ROLE_KEY=sb_secret_… \
//   npx tsx scripts/smoke-12.6-actions.ts
//
// We do NOT load .env.local — that file points at REMOTE Supabase where
// migration 0044 hasn't been pushed yet. Env vars must be set inline.

import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { computePayrollRun } from "../src/lib/payroll/compute";

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function main() {
  const admin = createAdminClient();
  const stamp = Date.now();

  // ---- seed: auth.users -----------------------------------------------------
  const email = `smoke-12.6-${stamp}@drmed.local`;
  const { data: userData, error: userErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password: "smoke-test-only-not-secret",
  });
  if (userErr || !userData?.user) {
    throw new Error(`createUser failed: ${userErr?.message ?? "no user"}`);
  }
  const userId = userData.user.id;
  console.log("seeded auth.user:", userId);

  // Track everything we create so the finally-block can tear it down even
  // if a later step throws.
  let staffSeeded = false;
  let employeeId: string | null = null;
  let allowanceId: string | null = null;
  let periodId: string | null = null;
  let runId: string | null = null;
  let importId: string | null = null;

  try {
    // ---- seed: staff_profiles (no auto-create trigger on auth.users) -------
    const { error: spErr } = await admin.from("staff_profiles").insert({
      id: userId,
      full_name: "M2 Smoke Tester",
      role: "admin",
      is_active: true,
    });
    if (spErr) throw new Error(`staff_profiles insert: ${spErr.message}`);
    staffSeeded = true;

    // ---- seed: employees ---------------------------------------------------
    const { data: emp, error: empErr } = await admin
      .from("employees")
      .insert({
        staff_profile_id: userId,
        hire_date: "2024-04-10",
        regularization_date: "2024-10-10",
        basic_daily_rate_php: 660,
        monthly_salary_credit_php: 17160,
        schedule_kind: "fixed_6day_mon_sat",
        payment_method: "cash",
        tax_status: "standard",
      })
      .select("id")
      .single();
    if (empErr || !emp) throw new Error(`employees insert: ${empErr?.message}`);
    employeeId = emp.id;

    // ---- seed: employee_allowances ----------------------------------------
    const { data: allow, error: allowErr } = await admin
      .from("employee_allowances")
      .insert({
        employee_id: employeeId,
        name: "transpo",
        daily_amount_php: 30,
        is_taxable: true,
        effective_from: "2026-01-01",
      })
      .select("id")
      .single();
    if (allowErr || !allow)
      throw new Error(`employee_allowances insert: ${allowErr?.message}`);
    allowanceId = allow.id;

    // ---- seed: payroll_periods --------------------------------------------
    const { data: period, error: periodErr } = await admin
      .from("payroll_periods")
      .insert({
        period_start: "2026-05-01",
        period_end: "2026-05-15",
        pay_date: "2026-05-20",
      })
      .select("id")
      .single();
    if (periodErr || !period)
      throw new Error(`payroll_periods insert: ${periodErr?.message}`);
    periodId = period.id;

    // ---- seed: payroll_runs -----------------------------------------------
    const { data: run, error: runErr } = await admin
      .from("payroll_runs")
      .insert({ period_id: periodId })
      .select("id")
      .single();
    if (runErr || !run) throw new Error(`payroll_runs insert: ${runErr?.message}`);
    runId = run.id;

    // ---- seed: payroll_employee_runs --------------------------------------
    const { error: erErr } = await admin
      .from("payroll_employee_runs")
      .insert({
        run_id: runId,
        employee_id: employeeId,
        scheduled_days: 13,
      });
    if (erErr) throw new Error(`payroll_employee_runs insert: ${erErr.message}`);

    // ---- seed: payroll_dtr_imports ----------------------------------------
    const { data: imp, error: impErr } = await admin
      .from("payroll_dtr_imports")
      .insert({
        period_id: periodId,
        uploaded_by: userId,
        raw_csv_text: "test",
        parsed_rows_count: 5,
      })
      .select("id")
      .single();
    if (impErr || !imp)
      throw new Error(`payroll_dtr_imports insert: ${impErr?.message}`);
    importId = imp.id;

    // ---- seed: 5 DTR rows (2026-05-01 .. 2026-05-05) ----------------------
    const dtrRows = [1, 2, 3, 4, 5].map((d) => ({
      import_id: importId!,
      employee_id: employeeId!,
      external_id_raw: "0",
      work_date: `2026-05-0${d}`,
      time_in: `2026-05-0${d}T08:00:00+08:00`,
      time_out: `2026-05-0${d}T17:00:00+08:00`,
      total_hours: 8,
      status: "parsed" as const,
      source_row: {},
    }));
    const { error: dtrErr } = await admin
      .from("payroll_dtr_rows")
      .insert(dtrRows);
    if (dtrErr) throw new Error(`payroll_dtr_rows insert: ${dtrErr.message}`);

    // ---- compute ----------------------------------------------------------
    const result = await computePayrollRun(admin, runId);
    console.log("compute result:", result);
    if (!result.ok) {
      throw new Error(`computePayrollRun failed: ${result.error}`);
    }

    // ---- read back --------------------------------------------------------
    const { data: er, error: readErr } = await admin
      .from("payroll_employee_runs")
      .select(
        "days_present, days_regular_holiday_worked, basic_pay_php, allowances_total_php, holiday_pay_php, gross_pay_php, net_pay_php, sss_ee_php, philhealth_ee_php, pagibig_ee_php, wt_compensation_php",
      )
      .eq("run_id", runId)
      .single();
    if (readErr || !er)
      throw new Error(`read employee_run: ${readErr?.message}`);
    console.log("employee_run:", er);

    // ---- assertions -------------------------------------------------------
    // Note: 2026-05-01 is Labor Day (regular holiday, seeded in migration
    // 0044). The DTR row for that day is `present_regular_holiday`, which
    //   - still counts toward days_present (5 worked days), and
    //   - adds 1 × daily_rate × (holiday_pay_regular_worked - 1) = 660 to
    //     holiday_pay_php (premium over basic, since basic already covers it).
    // Hence gross = basic 3300 + allowances 150 + holiday 660 = 4110.
    const checks: Array<[string, number, number]> = [
      ["days_present", Number(er.days_present), 5],
      ["days_regular_holiday_worked", Number(er.days_regular_holiday_worked), 1],
      ["basic_pay_php", Number(er.basic_pay_php), 3300],
      ["allowances_total_php", Number(er.allowances_total_php), 150],
      ["holiday_pay_php", Number(er.holiday_pay_php), 660],
      ["gross_pay_php", Number(er.gross_pay_php), 4110],
    ];
    for (const [field, actual, expected] of checks) {
      if (Math.abs(actual - expected) > 0.001) {
        throw new Error(
          `assertion failed: ${field} expected ${expected}, got ${actual}`,
        );
      }
    }
    const net = Number(er.net_pay_php);
    if (!(net >= 0)) {
      throw new Error(`assertion failed: net_pay_php expected >= 0, got ${net}`);
    }

    console.log("✅ M2 smoke PASS");
  } finally {
    // Cleanup runs even on failure. Catch and log per step so a single bad
    // step doesn't prevent the rest of the teardown.
    const tryStep = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        console.warn(
          `cleanup ${label} failed:`,
          e instanceof Error ? e.message : e,
        );
      }
    };

    if (runId) {
      await tryStep("void run", async () => {
        const { error } = await admin
          .from("payroll_runs")
          .update({
            status: "voided",
            voided_at: new Date().toISOString(),
            voided_by: userId,
            void_reason: "smoke cleanup",
          })
          .eq("id", runId!);
        if (error) throw error;
      });
    }
    if (importId) {
      await tryStep("delete dtr_rows", async () => {
        const { error } = await admin
          .from("payroll_dtr_rows")
          .delete()
          .eq("import_id", importId!);
        if (error) throw error;
      });
      await tryStep("delete dtr_imports", async () => {
        const { error } = await admin
          .from("payroll_dtr_imports")
          .delete()
          .eq("id", importId!);
        if (error) throw error;
      });
    }
    if (runId) {
      await tryStep("delete run (cascades employee_runs)", async () => {
        const { error } = await admin
          .from("payroll_runs")
          .delete()
          .eq("id", runId!);
        if (error) throw error;
      });
    }
    if (periodId) {
      await tryStep("delete period", async () => {
        const { error } = await admin
          .from("payroll_periods")
          .delete()
          .eq("id", periodId!);
        if (error) throw error;
      });
    }
    if (allowanceId) {
      await tryStep("delete allowance", async () => {
        const { error } = await admin
          .from("employee_allowances")
          .delete()
          .eq("id", allowanceId!);
        if (error) throw error;
      });
    }
    if (employeeId) {
      await tryStep("delete employee", async () => {
        const { error } = await admin
          .from("employees")
          .delete()
          .eq("id", employeeId!);
        if (error) throw error;
      });
    }
    if (staffSeeded) {
      // The staff_profile is FK ON DELETE CASCADE from auth.users, so
      // deleting the user will drop it. Doing it here just to be explicit.
      await tryStep("delete staff_profile", async () => {
        const { error } = await admin
          .from("staff_profiles")
          .delete()
          .eq("id", userId);
        if (error) throw error;
      });
    }
    await tryStep("delete auth.user", async () => {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error;
    });
    console.log("cleanup complete");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

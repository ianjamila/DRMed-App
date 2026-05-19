import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from "pdf-lib";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatManilaDate, formatPeriodRange } from "./format";

// Read the letterhead logo once at module load. T73 will batch generatePayslipPdf
// across 20-50 employees per run; per-call fs reads of the same file would be
// wasteful. Matches the precedent in src/lib/results/pdf-document.tsx.
// If public/logo.png is missing in production, this throws at server boot —
// loud and early, which is what we want.
const LOGO_BYTES = readFileSync(join(process.cwd(), "public/logo.png"));

// ---------------------------------------------------------------------------
// Brand + page constants
// ---------------------------------------------------------------------------
//
// T70 introduces only the values used by the letterhead and the
// employee/period block. T71-T73 will extend the palette (accent green for
// net pay, table row stripes, etc.) as needed.

const NAVY: RGB = rgb(0x28 / 255, 0x45 / 255, 0x70 / 255);
const GRAY: RGB = rgb(0x6b / 255, 0x72 / 255, 0x80 / 255);
const INK: RGB = rgb(0x11 / 255, 0x18 / 255, 0x27 / 255);

const PAGE_W = 595; // A4 portrait, points
const PAGE_H = 842;
const MARGIN = 30;

// Hardcoded for now. Once `payroll_settings` (or equivalent) grows
// `company_name` / `company_address` keys, swap these for a settings lookup
// inside loadPayslipData().
const COMPANY_NAME = "DRM Medical Diagnostics & Wellness Center";
const COMPANY_TAGLINE = "drmed.ph";
const COMPANY_ADDRESS = "Mandaluyong City, Metro Manila, Philippines";

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

type EmployeeInfo = {
  id: string;
  full_name: string;
  employee_number: string | null;
  basic_daily_rate_php: number;
  tin: string | null;
  sss_number: string | null;
  philhealth_number: string | null;
  pagibig_number: string | null;
  payment_method: string;
  bank_name: string | null;
  bank_account_number: string | null;
};

type PeriodInfo = {
  period_start: string;
  period_end: string;
  pay_date: string;
};

type RunInfo = {
  id: string;
  // Earnings
  basic_pay_php: number;
  allowances_total_php: number;
  ot_pay_php: number;
  night_diff_pay_php: number;
  holiday_pay_php: number;
  incentives_total_php: number;
  perfect_attendance_bonus_php: number;
  thirteenth_month_payout_php: number;
  gross_pay_php: number;
  // Deductions
  sss_ee_php: number;
  philhealth_ee_php: number;
  pagibig_ee_php: number;
  wt_compensation_php: number;
  tardiness_deduction_php: number;
  staff_advance_settlement_php: number;
  other_deductions_total_php: number;
  // Final
  net_pay_php: number;
  // Attendance summary
  scheduled_days: number;
  days_present: number;
  days_unpaid_absent: number;
  days_vl_used: number;
  days_sl_used: number;
  // Payout
  payment_method_used: string | null;
  paid_at: string | null;
};

type EarningLine = {
  kind: string;
  label: string;
  amount_php: number;
  quantity: number | null;
  rate_php: number | null;
};

type DeductionLine = {
  kind: string;
  label: string;
  amount_php: number;
};

type YtdTotals = {
  basic_pay_php: number;
  allowances_total_php: number;
  ot_pay_php: number;
  night_diff_pay_php: number;
  holiday_pay_php: number;
  incentives_total_php: number;
  perfect_attendance_bonus_php: number;
  thirteenth_month_payout_php: number;
  gross_pay_php: number;
  sss_ee_php: number;
  philhealth_ee_php: number;
  pagibig_ee_php: number;
  wt_compensation_php: number;
  net_pay_php: number;
};

type LeaveBalances = {
  vl_balance: number;
  sl_balance: number;
};

export type PayslipData = {
  employee: EmployeeInfo;
  period: PeriodInfo;
  run: RunInfo;
  earningLines: EarningLine[];
  deductionLines: DeductionLine[];
  ytd: YtdTotals;
  leave: LeaveBalances;
};

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
//
// formatManilaDate + formatPeriodRange come from ./format. The payslip-
// specific peso formatter (fixed .00, unlike the marketing formatPhp's
// minimumFractionDigits: 0) lives with the table-drawing code that uses it,
// reintroduced in T71.

const PESO_FMT = new Intl.NumberFormat("en-PH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Payslip-specific peso formatter — fixed .00 decimals always, unlike the
// marketing formatPhp which uses minimumFractionDigits: 0.
function formatPeso(amount: number): string {
  return `₱${PESO_FMT.format(amount)}`;
}

// ---------------------------------------------------------------------------
// Data loader
// ---------------------------------------------------------------------------

type AdminClient = ReturnType<typeof createAdminClient>;

async function loadPayslipData(
  admin: AdminClient,
  employee_run_id: string,
): Promise<PayslipData> {
  // 1. Load the employee_run + joined run + period + employee + staff_profile.
  const runRes = await admin
    .from("payroll_employee_runs")
    .select(
      `id,
       basic_pay_php, allowances_total_php, ot_pay_php, night_diff_pay_php,
       holiday_pay_php, incentives_total_php, perfect_attendance_bonus_php,
       thirteenth_month_payout_php, gross_pay_php,
       sss_ee_php, philhealth_ee_php, pagibig_ee_php, wt_compensation_php,
       tardiness_deduction_php, staff_advance_settlement_php,
       other_deductions_total_php, net_pay_php,
       scheduled_days, days_present, days_unpaid_absent, days_vl_used, days_sl_used,
       payment_method_used, paid_at,
       employee_id,
       employees:employee_id(
         id, employee_number, basic_daily_rate_php, tin,
         sss_number, philhealth_number, pagibig_number,
         payment_method, bank_name, bank_account_number,
         staff_profiles:staff_profile_id(full_name)
       ),
       payroll_runs:run_id(
         id,
         payroll_periods:period_id(period_start, period_end, pay_date)
       )`,
    )
    .eq("id", employee_run_id)
    .maybeSingle();

  if (runRes.error) {
    throw new Error(
      `[payslip-pdf] failed to load employee_run: ${runRes.error.message}`,
    );
  }
  if (!runRes.data) {
    throw new Error(`[payslip-pdf] employee_run not found: ${employee_run_id}`);
  }

  const row = runRes.data;

  // Supabase's relational select returns single-row foreign rows as a single
  // object when the FK column is `unique not null`, but the generated types
  // model nested joins as arrays. Normalise here.
  const employeeJoin = Array.isArray(row.employees)
    ? row.employees[0]
    : row.employees;
  if (!employeeJoin) {
    throw new Error(
      `[payslip-pdf] employee join missing for employee_run ${employee_run_id}`,
    );
  }
  const profileJoin = Array.isArray(employeeJoin.staff_profiles)
    ? employeeJoin.staff_profiles[0]
    : employeeJoin.staff_profiles;

  const runJoin = Array.isArray(row.payroll_runs)
    ? row.payroll_runs[0]
    : row.payroll_runs;
  if (!runJoin) {
    throw new Error(
      `[payslip-pdf] payroll_runs join missing for employee_run ${employee_run_id}`,
    );
  }
  const periodJoin = Array.isArray(runJoin.payroll_periods)
    ? runJoin.payroll_periods[0]
    : runJoin.payroll_periods;
  if (!periodJoin) {
    throw new Error(
      `[payslip-pdf] payroll_periods join missing for employee_run ${employee_run_id}`,
    );
  }

  const employee: EmployeeInfo = {
    id: employeeJoin.id,
    full_name: profileJoin?.full_name ?? "Unknown employee",
    employee_number: employeeJoin.employee_number,
    basic_daily_rate_php: Number(employeeJoin.basic_daily_rate_php),
    tin: employeeJoin.tin,
    sss_number: employeeJoin.sss_number,
    philhealth_number: employeeJoin.philhealth_number,
    pagibig_number: employeeJoin.pagibig_number,
    payment_method: employeeJoin.payment_method,
    bank_name: employeeJoin.bank_name,
    bank_account_number: employeeJoin.bank_account_number,
  };

  const period: PeriodInfo = {
    period_start: periodJoin.period_start,
    period_end: periodJoin.period_end,
    pay_date: periodJoin.pay_date,
  };

  const run: RunInfo = {
    id: row.id,
    basic_pay_php: Number(row.basic_pay_php),
    allowances_total_php: Number(row.allowances_total_php),
    ot_pay_php: Number(row.ot_pay_php),
    night_diff_pay_php: Number(row.night_diff_pay_php),
    holiday_pay_php: Number(row.holiday_pay_php),
    incentives_total_php: Number(row.incentives_total_php),
    perfect_attendance_bonus_php: Number(row.perfect_attendance_bonus_php),
    thirteenth_month_payout_php: Number(row.thirteenth_month_payout_php),
    gross_pay_php: Number(row.gross_pay_php),
    sss_ee_php: Number(row.sss_ee_php),
    philhealth_ee_php: Number(row.philhealth_ee_php),
    pagibig_ee_php: Number(row.pagibig_ee_php),
    wt_compensation_php: Number(row.wt_compensation_php),
    tardiness_deduction_php: Number(row.tardiness_deduction_php),
    staff_advance_settlement_php: Number(row.staff_advance_settlement_php),
    other_deductions_total_php: Number(row.other_deductions_total_php),
    net_pay_php: Number(row.net_pay_php),
    scheduled_days: row.scheduled_days,
    days_present: row.days_present,
    days_unpaid_absent: row.days_unpaid_absent,
    days_vl_used: row.days_vl_used,
    days_sl_used: row.days_sl_used,
    payment_method_used: row.payment_method_used,
    paid_at: row.paid_at,
  };

  // 2. Earning + deduction lines, and YTD source rows, and leave balances —
  // all independent of one another.
  // YTD includes the current run (standard payslip convention — YTD-through-
  // this-period, not YTD-before-this-period).
  const yearStart = `${period.pay_date.slice(0, 4)}-01-01`;
  const yearEnd = `${period.pay_date.slice(0, 4)}-12-31`;

  const [earningRes, deductionRes, ytdRes, vlRes, slRes] = await Promise.all([
    admin
      .from("payroll_earning_lines")
      .select("kind, label, amount_php, quantity, rate_php")
      .eq("employee_run_id", employee_run_id)
      .order("created_at", { ascending: true }),
    admin
      .from("payroll_deduction_lines")
      .select("kind, label, amount_php")
      .eq("employee_run_id", employee_run_id)
      .order("created_at", { ascending: true }),
    admin
      .from("payroll_employee_runs")
      .select(
        `basic_pay_php, allowances_total_php, ot_pay_php, night_diff_pay_php,
         holiday_pay_php, incentives_total_php, perfect_attendance_bonus_php,
         thirteenth_month_payout_php, gross_pay_php,
         sss_ee_php, philhealth_ee_php, pagibig_ee_php, wt_compensation_php,
         net_pay_php,
         payroll_runs:run_id!inner(
           payroll_periods:period_id!inner(pay_date)
         )`,
      )
      .eq("employee_id", employee.id)
      .gte("payroll_runs.payroll_periods.pay_date", yearStart)
      .lte("payroll_runs.payroll_periods.pay_date", yearEnd),
    admin.rpc("employee_leave_balance", {
      p_employee_id: employee.id,
      p_kind: "VL",
      p_as_of_date: period.period_end,
    }),
    admin.rpc("employee_leave_balance", {
      p_employee_id: employee.id,
      p_kind: "SL",
      p_as_of_date: period.period_end,
    }),
  ]);

  if (earningRes.error) {
    throw new Error(
      `[payslip-pdf] failed to load earning lines: ${earningRes.error.message}`,
    );
  }
  if (deductionRes.error) {
    throw new Error(
      `[payslip-pdf] failed to load deduction lines: ${deductionRes.error.message}`,
    );
  }
  if (ytdRes.error) {
    throw new Error(
      `[payslip-pdf] failed to load YTD totals: ${ytdRes.error.message}`,
    );
  }
  if (vlRes.error) {
    throw new Error(
      `[payslip-pdf] failed to load VL balance: ${vlRes.error.message}`,
    );
  }
  if (slRes.error) {
    throw new Error(
      `[payslip-pdf] failed to load SL balance: ${slRes.error.message}`,
    );
  }

  const earningLines: EarningLine[] = (earningRes.data ?? []).map((l) => ({
    kind: l.kind,
    label: l.label,
    amount_php: Number(l.amount_php),
    quantity: l.quantity === null ? null : Number(l.quantity),
    rate_php: l.rate_php === null ? null : Number(l.rate_php),
  }));

  const deductionLines: DeductionLine[] = (deductionRes.data ?? []).map(
    (l) => ({
      kind: l.kind,
      label: l.label,
      amount_php: Number(l.amount_php),
    }),
  );

  const ytd: YtdTotals = {
    basic_pay_php: 0,
    allowances_total_php: 0,
    ot_pay_php: 0,
    night_diff_pay_php: 0,
    holiday_pay_php: 0,
    incentives_total_php: 0,
    perfect_attendance_bonus_php: 0,
    thirteenth_month_payout_php: 0,
    gross_pay_php: 0,
    sss_ee_php: 0,
    philhealth_ee_php: 0,
    pagibig_ee_php: 0,
    wt_compensation_php: 0,
    net_pay_php: 0,
  };
  for (const r of ytdRes.data ?? []) {
    ytd.basic_pay_php += Number(r.basic_pay_php);
    ytd.allowances_total_php += Number(r.allowances_total_php);
    ytd.ot_pay_php += Number(r.ot_pay_php);
    ytd.night_diff_pay_php += Number(r.night_diff_pay_php);
    ytd.holiday_pay_php += Number(r.holiday_pay_php);
    ytd.incentives_total_php += Number(r.incentives_total_php);
    ytd.perfect_attendance_bonus_php += Number(r.perfect_attendance_bonus_php);
    ytd.thirteenth_month_payout_php += Number(r.thirteenth_month_payout_php);
    ytd.gross_pay_php += Number(r.gross_pay_php);
    ytd.sss_ee_php += Number(r.sss_ee_php);
    ytd.philhealth_ee_php += Number(r.philhealth_ee_php);
    ytd.pagibig_ee_php += Number(r.pagibig_ee_php);
    ytd.wt_compensation_php += Number(r.wt_compensation_php);
    ytd.net_pay_php += Number(r.net_pay_php);
  }

  const leave: LeaveBalances = {
    vl_balance: Number(vlRes.data ?? 0),
    sl_balance: Number(slRes.data ?? 0),
  };

  return { employee, period, run, earningLines, deductionLines, ytd, leave };
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------
//
// Each helper takes the page + the fonts + a starting Y and returns the next
// available Y cursor (measured from the bottom in pdf-lib, but each helper
// internally treats Y as "where to start drawing from", consistent with the
// `y - lineHeight` pattern). T71 will chain off `drawEmployeePeriodBlock`'s
// return value.

type DrawCtx = {
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
};

function drawText(
  ctx: DrawCtx,
  text: string,
  x: number,
  y: number,
  options: { size?: number; color?: RGB; bold?: boolean } = {},
) {
  const { size = 9, color = INK, bold = false } = options;
  ctx.page.drawText(text, {
    x,
    y,
    size,
    font: bold ? ctx.fontBold : ctx.font,
    color,
  });
}

function drawLetterhead(
  ctx: DrawCtx,
  logoImg: PDFImage,
): number /* next Y */ {
  const topY = PAGE_H - MARGIN;

  // Logo — scale to a 60pt-tall band, preserving aspect ratio.
  const logoTargetH = 60;
  const logoScale = logoTargetH / logoImg.height;
  const logoW = logoImg.width * logoScale;
  ctx.page.drawImage(logoImg, {
    x: MARGIN,
    y: topY - logoTargetH,
    width: logoW,
    height: logoTargetH,
  });

  // Company text block, to the right of the logo.
  const textX = MARGIN + logoW + 14;
  drawText(ctx, COMPANY_NAME, textX, topY - 16, {
    size: 12,
    color: NAVY,
    bold: true,
  });
  drawText(ctx, COMPANY_TAGLINE, textX, topY - 30, {
    size: 9,
    color: GRAY,
  });
  drawText(ctx, COMPANY_ADDRESS, textX, topY - 42, {
    size: 8,
    color: GRAY,
  });

  // "PAYSLIP" title — right-aligned to the page margin.
  const title = "PAYSLIP";
  const titleSize = 16;
  const titleWidth = ctx.fontBold.widthOfTextAtSize(title, titleSize);
  drawText(ctx, title, PAGE_W - MARGIN - titleWidth, topY - 16, {
    size: titleSize,
    color: NAVY,
    bold: true,
  });

  // Divider rule.
  const dividerY = topY - logoTargetH - 10;
  ctx.page.drawLine({
    start: { x: MARGIN, y: dividerY },
    end: { x: PAGE_W - MARGIN, y: dividerY },
    thickness: 0.75,
    color: NAVY,
  });

  return dividerY - 14;
}

function drawEmployeePeriodBlock(
  ctx: DrawCtx,
  data: PayslipData,
  startY: number,
): number /* next Y */ {
  // Two-column layout: employee on the left, period+payment on the right.
  const leftX = MARGIN;
  const rightX = PAGE_W / 2 + 10;
  const labelSize = 8;
  const valueSize = 9.5;
  const lineH = 13;

  let leftY = startY;
  let rightY = startY;

  // Section header.
  drawText(ctx, "EMPLOYEE", leftX, leftY, {
    size: labelSize,
    color: GRAY,
    bold: true,
  });
  drawText(ctx, "PAY PERIOD", rightX, rightY, {
    size: labelSize,
    color: GRAY,
    bold: true,
  });
  leftY -= lineH;
  rightY -= lineH;

  // Employee name + number.
  drawText(ctx, data.employee.full_name, leftX, leftY, {
    size: valueSize + 1,
    color: INK,
    bold: true,
  });
  leftY -= lineH;
  if (data.employee.employee_number) {
    drawText(ctx, `Employee #: ${data.employee.employee_number}`, leftX, leftY, {
      size: valueSize,
      color: INK,
    });
    leftY -= lineH;
  }

  // Government IDs — render only the populated ones, one per line.
  const govIds: Array<[string, string | null]> = [
    ["TIN", data.employee.tin],
    ["SSS", data.employee.sss_number],
    ["PhilHealth", data.employee.philhealth_number],
    ["Pag-IBIG", data.employee.pagibig_number],
  ];
  for (const [label, value] of govIds) {
    if (!value) continue;
    drawText(ctx, `${label}: ${value}`, leftX, leftY, {
      size: valueSize,
      color: INK,
    });
    leftY -= lineH;
  }

  // Period block on the right.
  drawText(
    ctx,
    formatPeriodRange(data.period.period_start, data.period.period_end),
    rightX,
    rightY,
    { size: valueSize + 1, color: INK, bold: true },
  );
  rightY -= lineH;
  drawText(
    ctx,
    `Pay date: ${formatManilaDate(data.period.pay_date)}`,
    rightX,
    rightY,
    { size: valueSize, color: INK },
  );
  rightY -= lineH;

  // Payment method block — show what was *used* if paid out, else what's
  // configured on the employee.
  const methodUsed = data.run.payment_method_used ?? data.employee.payment_method;
  const methodLabel = methodUsed === "bank" ? "Bank transfer" : "Cash";
  drawText(ctx, `Payment: ${methodLabel}`, rightX, rightY, {
    size: valueSize,
    color: INK,
  });
  rightY -= lineH;

  if (methodUsed === "bank" && data.employee.bank_account_number) {
    const bankLine = data.employee.bank_name
      ? `${data.employee.bank_name} · ${data.employee.bank_account_number}`
      : data.employee.bank_account_number;
    drawText(ctx, bankLine, rightX, rightY, {
      size: valueSize,
      color: INK,
    });
    rightY -= lineH;
  }

  if (data.run.paid_at) {
    drawText(
      ctx,
      `Paid: ${formatManilaDate(data.run.paid_at.slice(0, 10))}`,
      rightX,
      rightY,
      { size: valueSize, color: GRAY },
    );
    rightY -= lineH;
  }

  return Math.min(leftY, rightY) - 4;
}

// ---------------------------------------------------------------------------
// Earnings + deductions tables (T71)
// ---------------------------------------------------------------------------
//
// Two-column layout: earnings on the left, deductions on the right.
// Page width 595 with 30pt margins and a 20pt gutter gives ~257.5pt per
// column. Labels are GRAY, values are right-aligned in INK.

const COL_GAP = 20;
const COL_W = (PAGE_W - 2 * MARGIN - COL_GAP) / 2;
const LEFT_X = MARGIN;
const RIGHT_X = MARGIN + COL_W + COL_GAP;

const SECTION_HEADER_SIZE = 11;
const ROW_LABEL_SIZE = 9;
const ROW_VALUE_SIZE = 9;
const SUBSECTION_HEADER_SIZE = 8;
const ROW_LINE_H = 13;
const SUBSECTION_LINE_H = 11;

function drawRow(
  ctx: DrawCtx,
  label: string,
  amount: number,
  x: number,
  y: number,
  options: { bold?: boolean; indent?: number } = {},
): number /* next Y */ {
  const { bold = false, indent = 0 } = options;
  drawText(ctx, label, x + indent, y, {
    size: ROW_LABEL_SIZE,
    color: bold ? INK : GRAY,
    bold,
  });
  const value = formatPeso(amount);
  const valueFont = bold ? ctx.fontBold : ctx.font;
  const valueWidth = valueFont.widthOfTextAtSize(value, ROW_VALUE_SIZE);
  drawText(ctx, value, x + COL_W - valueWidth, y, {
    size: ROW_VALUE_SIZE,
    color: INK,
    bold,
  });
  return y - ROW_LINE_H;
}

function drawEarnings(
  ctx: DrawCtx,
  data: PayslipData,
  startY: number,
): number /* next Y */ {
  let y = startY;

  // Section header.
  drawText(ctx, "EARNINGS", LEFT_X, y, {
    size: SECTION_HEADER_SIZE,
    color: NAVY,
    bold: true,
  });
  y -= ROW_LINE_H + 2;

  // Always-shown rows.
  y = drawRow(ctx, "Basic pay", data.run.basic_pay_php, LEFT_X, y);
  y = drawRow(ctx, "Allowances", data.run.allowances_total_php, LEFT_X, y);
  y = drawRow(ctx, "Overtime", data.run.ot_pay_php, LEFT_X, y);
  y = drawRow(
    ctx,
    "Night differential",
    data.run.night_diff_pay_php,
    LEFT_X,
    y,
  );
  y = drawRow(ctx, "Holiday pay", data.run.holiday_pay_php, LEFT_X, y);
  y = drawRow(ctx, "Incentives", data.run.incentives_total_php, LEFT_X, y);
  y = drawRow(
    ctx,
    "Perfect attendance",
    data.run.perfect_attendance_bonus_php,
    LEFT_X,
    y,
  );

  // 13th-month payout — only if > 0 (typically December).
  if (data.run.thirteenth_month_payout_php > 0) {
    y = drawRow(
      ctx,
      "13th-month payout",
      data.run.thirteenth_month_payout_php,
      LEFT_X,
      y,
    );
  }

  return y;
}

function drawDeductions(
  ctx: DrawCtx,
  data: PayslipData,
  startY: number,
): number /* next Y */ {
  let y = startY;

  // Section header.
  drawText(ctx, "DEDUCTIONS", RIGHT_X, y, {
    size: SECTION_HEADER_SIZE,
    color: NAVY,
    bold: true,
  });
  y -= ROW_LINE_H + 2;

  // Statutory + standard deductions.
  y = drawRow(ctx, "SSS contribution", data.run.sss_ee_php, RIGHT_X, y);
  y = drawRow(
    ctx,
    "PhilHealth contribution",
    data.run.philhealth_ee_php,
    RIGHT_X,
    y,
  );
  y = drawRow(
    ctx,
    "Pag-IBIG contribution",
    data.run.pagibig_ee_php,
    RIGHT_X,
    y,
  );
  y = drawRow(
    ctx,
    "Withholding tax",
    data.run.wt_compensation_php,
    RIGHT_X,
    y,
  );

  // Conditional rows.
  if (data.run.tardiness_deduction_php > 0) {
    y = drawRow(
      ctx,
      "Tardiness",
      data.run.tardiness_deduction_php,
      RIGHT_X,
      y,
    );
  }
  if (data.run.staff_advance_settlement_php > 0) {
    y = drawRow(
      ctx,
      "Staff advance settlement",
      data.run.staff_advance_settlement_php,
      RIGHT_X,
      y,
    );
  }

  // Loan amortizations subsection.
  const loanLines = data.deductionLines.filter(
    (l) => l.kind === "loan_amortization",
  );
  if (loanLines.length > 0) {
    drawText(ctx, "Loan amortizations", RIGHT_X, y, {
      size: SUBSECTION_HEADER_SIZE,
      color: GRAY,
      bold: true,
    });
    y -= SUBSECTION_LINE_H;
    for (const line of loanLines) {
      y = drawRow(ctx, line.label, line.amount_php, RIGHT_X, y, { indent: 8 });
    }
  }

  // Manual deductions subsection — manual_adjustment + other.
  const manualLines = data.deductionLines.filter(
    (l) => l.kind === "manual_adjustment" || l.kind === "other",
  );
  if (manualLines.length > 0) {
    drawText(ctx, "Manual deductions", RIGHT_X, y, {
      size: SUBSECTION_HEADER_SIZE,
      color: GRAY,
      bold: true,
    });
    y -= SUBSECTION_LINE_H;
    for (const line of manualLines) {
      y = drawRow(ctx, line.label, line.amount_php, RIGHT_X, y, { indent: 8 });
    }
  }

  // Total deductions — sum of statutory + standard + all deduction lines.
  // (Per the schema CHECK, deduction line `kind` is limited to
  // loan_amortization / manual_adjustment / other — so iterating all lines
  // equals iterating the subsection-shown ones.)
  const linesTotal = data.deductionLines.reduce(
    (acc, l) => acc + l.amount_php,
    0,
  );
  const totalDeductions =
    data.run.sss_ee_php +
    data.run.philhealth_ee_php +
    data.run.pagibig_ee_php +
    data.run.wt_compensation_php +
    data.run.tardiness_deduction_php +
    data.run.staff_advance_settlement_php +
    linesTotal;

  // Thin divider above total.
  const dividerY = y + ROW_LINE_H - 3;
  ctx.page.drawLine({
    start: { x: RIGHT_X, y: dividerY },
    end: { x: RIGHT_X + COL_W, y: dividerY },
    thickness: 0.5,
    color: GRAY,
  });
  y -= 2;
  y = drawRow(ctx, "Total deductions", totalDeductions, RIGHT_X, y, {
    bold: true,
  });

  return y;
}

function drawEarningsAndDeductions(
  ctx: DrawCtx,
  data: PayslipData,
  startY: number,
): number /* next Y */ {
  // 18pt gap between the employee/period block and the section headers.
  const tablesStartY = startY - 18;
  const leftAfterY = drawEarnings(ctx, data, tablesStartY);
  const rightAfterY = drawDeductions(ctx, data, tablesStartY);
  return Math.min(leftAfterY, rightAfterY) - 6;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build a payslip PDF for a single payroll_employee_runs row. Returns the
 * rendered bytes as a Node Buffer. Caller (Server Action) is responsible for
 * uploading to storage + audit-logging the access.
 *
 * T70 ships the base: letterhead + employee/period block. T71-T73 will append
 * earnings/deductions tables, the net-pay block, YTD + leave block, and
 * pagination measurement.
 */
export async function generatePayslipPdf(
  employee_run_id: string,
): Promise<Buffer> {
  const admin = createAdminClient();
  const data = await loadPayslipData(admin, employee_run_id);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Payslip — ${data.employee.full_name}`);
  pdfDoc.setAuthor(COMPANY_NAME);
  pdfDoc.setCreator(COMPANY_NAME);
  pdfDoc.setProducer("drmed.ph payroll");
  pdfDoc.setCreationDate(new Date());

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Logo bytes are read once at module load (see LOGO_BYTES above) — just
  // embed into this document.
  const logoImg = await pdfDoc.embedPng(LOGO_BYTES);

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const ctx: DrawCtx = { page, font, fontBold };

  const afterLetterheadY = drawLetterhead(ctx, logoImg);
  const afterEmployeeY = drawEmployeePeriodBlock(ctx, data, afterLetterheadY);
  drawEarningsAndDeductions(ctx, data, afterEmployeeY);

  // T72 will chain off drawEarningsAndDeductions' return value (afterTablesY)
  // and append: drawNetPay + drawYtd + drawLeave + drawSignatures.
  // T73 will measure section heights and break pages when cursorY < MARGIN.

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

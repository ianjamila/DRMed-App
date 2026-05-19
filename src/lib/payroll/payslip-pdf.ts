import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PDFDocument,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatManilaDate, formatPeriodRange } from "./format";

// Read the letterhead logo once at module load. T73 will batch generatePayslipPdf
// across 20-50 employees per run; per-call fs reads of the same file would be
// wasteful. Matches the precedent in src/lib/results/pdf-document.tsx.
// If public/logo.png is missing in production, this throws at server boot —
// loud and early, which is what we want.
const LOGO_BYTES = readFileSync(join(process.cwd(), "public/logo.png"));

// Inter Regular + Bold static TTFs — bundled in public/font/. We use these
// instead of pdf-lib's StandardFonts (Helvetica/HelveticaBold) because
// StandardFonts only support WinAnsi encoding, which has no glyph for the
// Peso symbol (₱, U+20B1) or the true minus sign (−, U+2212). Inter (OFL
// license) ships the full Unicode range including ₱, −, –, ·, etc.
//
// Static-instance TTFs (not variable) so pdf-lib's subset:true can prune
// down to just the glyphs each PDF actually uses — keeps generated PDFs
// small (~10-20KB of font data per payslip instead of ~880KB).
const FONT_REGULAR_BYTES = readFileSync(join(process.cwd(), "public/font/Inter-Regular.ttf"));
const FONT_BOLD_BYTES = readFileSync(join(process.cwd(), "public/font/Inter-Bold.ttf"));

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

// Two-column body geometry — shared by the earnings/deductions tables (T71)
// and the YTD/Leave block (T72). Hoisted to module scope so both sections
// line up visually on the same column grid.
const COL_GAP = 20;
const COL_W = (PAGE_W - 2 * MARGIN - COL_GAP) / 2;
const LEFT_X = MARGIN;
const RIGHT_X = MARGIN + COL_W + COL_GAP;

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

// Exported so the T76 detail page (/staff/payslips/[id]) can reuse the same
// join shape we render in the PDF — keeps the HTML view and the PDF view in
// lockstep on every schema change.
export async function loadPayslipData(
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
  options: { compact?: boolean } = {},
): number /* next Y */ {
  const { compact = false } = options;
  const topY = PAGE_H - MARGIN;

  // Logo — scale to a 60pt band on page 1, 42pt on continuation pages.
  const logoTargetH = compact ? 42 : 60;
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
  const nameSize = compact ? 10 : 12;
  const taglineSize = compact ? 8 : 9;
  drawText(ctx, COMPANY_NAME, textX, topY - (compact ? 12 : 16), {
    size: nameSize,
    color: NAVY,
    bold: true,
  });
  drawText(ctx, COMPANY_TAGLINE, textX, topY - (compact ? 24 : 30), {
    size: taglineSize,
    color: GRAY,
  });
  if (!compact) {
    drawText(ctx, COMPANY_ADDRESS, textX, topY - 42, {
      size: 8,
      color: GRAY,
    });
  }

  // Title — right-aligned to the page margin. Continuation pages get
  // "PAYSLIP cont'd" at a slightly smaller size.
  const title = compact ? "PAYSLIP cont'd" : "PAYSLIP";
  const titleSize = compact ? 13 : 16;
  const titleWidth = ctx.fontBold.widthOfTextAtSize(title, titleSize);
  drawText(ctx, title, PAGE_W - MARGIN - titleWidth, topY - (compact ? 12 : 16), {
    size: titleSize,
    color: NAVY,
    bold: true,
  });

  // Divider rule.
  const dividerY = topY - logoTargetH - (compact ? 6 : 10);
  ctx.page.drawLine({
    start: { x: MARGIN, y: dividerY },
    end: { x: PAGE_W - MARGIN, y: dividerY },
    thickness: 0.75,
    color: NAVY,
  });

  return dividerY - (compact ? 10 : 14);
}

// "Continued from page 1 · Gross pay carried: ₱X,XXX.XX" notice, drawn at
// the top of page 2 immediately below the compact letterhead. Single navy
// line, small text.
function drawContinuedNotice(
  ctx: DrawCtx,
  data: PayslipData,
  startY: number,
): number /* next Y */ {
  const employeeLabel = data.employee.employee_number
    ? `${data.employee.full_name} (#${data.employee.employee_number})`
    : data.employee.full_name;
  const line = `Continued from page 1 · ${employeeLabel} · Gross pay carried: ${formatPeso(data.run.gross_pay_php)}`;
  drawText(ctx, line, MARGIN, startY, {
    size: 9,
    color: NAVY,
    bold: true,
  });
  return startY - 18;
}

// Small "Page X of Y" marker, top-right of every page. Drawn AFTER all
// sections are laid out so the totalPages count is known.
function drawPageMarker(
  page: PDFPage,
  font: PDFFont,
  pageIndex: number,
  totalPages: number,
): void {
  const label = `Page ${pageIndex + 1} of ${totalPages}`;
  const size = 8;
  const width = font.widthOfTextAtSize(label, size);
  page.drawText(label, {
    x: PAGE_W - MARGIN - width,
    y: PAGE_H - 14,
    size,
    font,
    color: GRAY,
  });
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
// column. Labels are GRAY, values are right-aligned in INK. The column
// geometry constants (COL_GAP, COL_W, LEFT_X, RIGHT_X) live at module
// scope so T72's YTD/Leave block shares the same grid.

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

  // Gross pay subtotal — mirrors the "Total deductions" treatment on the
  // right column and matches the HTML detail view's earnings card.
  const dividerY = y + ROW_LINE_H - 3;
  ctx.page.drawLine({
    start: { x: LEFT_X, y: dividerY },
    end: { x: LEFT_X + COL_W, y: dividerY },
    thickness: 0.5,
    color: GRAY,
  });
  y -= 2;
  y = drawRow(ctx, "Gross pay", data.run.gross_pay_php, LEFT_X, y, {
    bold: true,
  });

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
// Net-pay band (T72)
// ---------------------------------------------------------------------------
//
// Full-width horizontal band drawn as a simulated navy→cyan gradient (pdf-lib
// has no native gradient primitive — we approximate via thin vertical
// rectangles with interpolated colors). White text on top: a "NET PAY" caption
// and the prominent net-pay value on the left, contextual pay-date + payment
// method + gross/deductions helper on the right.

const NETPAY_BAND_H = 58;
const NETPAY_GAP_BELOW = 18;
const NETPAY_GRADIENT_STEPS = 60;
// Start: NAVY (#284570). End: Tailwind cyan-500-ish (#06B6D4).
const NETPAY_GRADIENT_START = { r: 0x28, g: 0x45, b: 0x70 } as const;
const NETPAY_GRADIENT_END = { r: 0x06, g: 0xb6, b: 0xd4 } as const;

function drawNetPayBlock(
  ctx: DrawCtx,
  data: PayslipData,
  startY: number,
): number /* next Y */ {
  // Add a small gap above the band so it doesn't kiss the deductions total.
  const bandTopY = startY - 10;
  const bandBottomY = bandTopY - NETPAY_BAND_H;
  const bandX = MARGIN;
  const bandW = PAGE_W - 2 * MARGIN;
  const stepW = bandW / NETPAY_GRADIENT_STEPS;

  for (let i = 0; i < NETPAY_GRADIENT_STEPS; i++) {
    const t = i / (NETPAY_GRADIENT_STEPS - 1);
    const r = Math.round(
      NETPAY_GRADIENT_START.r +
        (NETPAY_GRADIENT_END.r - NETPAY_GRADIENT_START.r) * t,
    );
    const g = Math.round(
      NETPAY_GRADIENT_START.g +
        (NETPAY_GRADIENT_END.g - NETPAY_GRADIENT_START.g) * t,
    );
    const b = Math.round(
      NETPAY_GRADIENT_START.b +
        (NETPAY_GRADIENT_END.b - NETPAY_GRADIENT_START.b) * t,
    );
    ctx.page.drawRectangle({
      x: bandX + i * stepW,
      y: bandBottomY,
      // Small overlap to hide hairline seams between steps.
      width: stepW + 0.5,
      height: NETPAY_BAND_H,
      color: rgb(r / 255, g / 255, b / 255),
    });
  }

  const white = rgb(1, 1, 1);
  const innerPad = 16;

  // Left side: small caption + big value.
  drawText(ctx, "NET PAY", bandX + innerPad, bandTopY - 18, {
    size: 9,
    color: white,
    bold: true,
  });
  const netStr = formatPeso(data.run.net_pay_php);
  drawText(ctx, netStr, bandX + innerPad, bandTopY - 46, {
    size: 24,
    color: white,
    bold: true,
  });

  // Right side: pay date + payment method + small gross/deductions helper.
  // All right-aligned to the band's inner edge.
  const rightEdge = bandX + bandW - innerPad;
  const payDateLine = `Pay date: ${formatManilaDate(data.period.pay_date)}`;
  const payDateSize = 9;
  const payDateW = ctx.fontBold.widthOfTextAtSize(payDateLine, payDateSize);
  drawText(ctx, payDateLine, rightEdge - payDateW, bandTopY - 18, {
    size: payDateSize,
    color: white,
    bold: true,
  });

  const methodLine =
    (data.run.payment_method_used ?? "pending").toUpperCase();
  const methodSize = 11;
  const methodW = ctx.fontBold.widthOfTextAtSize(methodLine, methodSize);
  drawText(ctx, methodLine, rightEdge - methodW, bandTopY - 34, {
    size: methodSize,
    color: white,
    bold: true,
  });

  // Helper: "Gross ₱X − Deductions ₱Y". Compute deductions as gross − net so
  // it always reconciles, regardless of how individual deduction rows landed.
  const totalDeductions = data.run.gross_pay_php - data.run.net_pay_php;
  const helper = `Gross ${formatPeso(data.run.gross_pay_php)} − Deductions ${formatPeso(totalDeductions)}`;
  const helperSize = 8;
  const helperW = ctx.font.widthOfTextAtSize(helper, helperSize);
  drawText(ctx, helper, rightEdge - helperW, bandTopY - 48, {
    size: helperSize,
    color: white,
  });

  return bandBottomY - NETPAY_GAP_BELOW;
}

// ---------------------------------------------------------------------------
// YTD + Leave block (T72)
// ---------------------------------------------------------------------------
//
// Two-column block sharing the same column grid as the earnings/deductions
// tables above. Left = year-to-date totals through this period. Right = leave
// balances as of period_end + a small attendance-this-period sub-block.

function drawYtd(
  ctx: DrawCtx,
  data: PayslipData,
  startY: number,
): number /* next Y */ {
  let y = startY;

  drawText(ctx, "YEAR-TO-DATE TOTALS", LEFT_X, y, {
    size: SECTION_HEADER_SIZE,
    color: NAVY,
    bold: true,
  });
  y -= ROW_LINE_H + 2;

  y = drawRow(ctx, "YTD Gross pay", data.ytd.gross_pay_php, LEFT_X, y);
  y = drawRow(ctx, "YTD Basic pay", data.ytd.basic_pay_php, LEFT_X, y);
  y = drawRow(
    ctx,
    "YTD Overtime + night diff",
    data.ytd.ot_pay_php + data.ytd.night_diff_pay_php,
    LEFT_X,
    y,
  );
  y = drawRow(ctx, "YTD Holiday pay", data.ytd.holiday_pay_php, LEFT_X, y);
  y = drawRow(ctx, "YTD Incentives", data.ytd.incentives_total_php, LEFT_X, y);

  // 13th-month YTD — only show when there's been a payout this year.
  if (data.ytd.thirteenth_month_payout_php > 0) {
    y = drawRow(
      ctx,
      "YTD 13th-month",
      data.ytd.thirteenth_month_payout_php,
      LEFT_X,
      y,
    );
  }

  y = drawRow(
    ctx,
    "YTD SSS + PhilHealth + Pag-IBIG",
    data.ytd.sss_ee_php + data.ytd.philhealth_ee_php + data.ytd.pagibig_ee_php,
    LEFT_X,
    y,
  );
  y = drawRow(
    ctx,
    "YTD Withholding tax",
    data.ytd.wt_compensation_php,
    LEFT_X,
    y,
  );

  // Thin divider above the YTD net-pay row.
  const dividerY = y + ROW_LINE_H - 3;
  ctx.page.drawLine({
    start: { x: LEFT_X, y: dividerY },
    end: { x: LEFT_X + COL_W, y: dividerY },
    thickness: 0.5,
    color: GRAY,
  });
  y -= 2;
  y = drawRow(ctx, "YTD Net pay", data.ytd.net_pay_php, LEFT_X, y, {
    bold: true,
  });

  return y;
}

function drawLeaveAndAttendance(
  ctx: DrawCtx,
  data: PayslipData,
  startY: number,
): number /* next Y */ {
  let y = startY;

  // Header — includes the as-of date so the reader knows the snapshot point.
  drawText(
    ctx,
    `LEAVE BALANCES (as of ${formatManilaDate(data.period.period_end)})`,
    RIGHT_X,
    y,
    { size: SECTION_HEADER_SIZE, color: NAVY, bold: true },
  );
  y -= ROW_LINE_H + 2;

  // Leave balances are days, not pesos — reuse drawRow's two-column layout
  // but format the right value as days manually rather than peso.
  const drawDaysRow = (label: string, days: number, bold = false): number => {
    drawText(ctx, label, RIGHT_X, y, {
      size: ROW_LABEL_SIZE,
      color: bold ? INK : GRAY,
      bold,
    });
    const value = `${days.toFixed(2)} days`;
    const valueFont = bold ? ctx.fontBold : ctx.font;
    const valueW = valueFont.widthOfTextAtSize(value, ROW_VALUE_SIZE);
    drawText(ctx, value, RIGHT_X + COL_W - valueW, y, {
      size: ROW_VALUE_SIZE,
      color: INK,
      bold,
    });
    return y - ROW_LINE_H;
  };

  y = drawDaysRow("Vacation leave", data.leave.vl_balance);
  y = drawDaysRow("Sick leave", data.leave.sl_balance);

  // Attendance-this-period sub-block. Separated by a small gap and an italic-
  // ish small-caps label so it reads as supporting context, not the headline.
  y -= 6;
  drawText(ctx, "ATTENDANCE THIS PERIOD", RIGHT_X, y, {
    size: SUBSECTION_HEADER_SIZE,
    color: GRAY,
    bold: true,
  });
  y -= SUBSECTION_LINE_H;

  const drawTextRow = (label: string, value: string): number => {
    drawText(ctx, label, RIGHT_X, y, {
      size: ROW_LABEL_SIZE,
      color: GRAY,
    });
    const valueW = ctx.font.widthOfTextAtSize(value, ROW_VALUE_SIZE);
    drawText(ctx, value, RIGHT_X + COL_W - valueW, y, {
      size: ROW_VALUE_SIZE,
      color: INK,
    });
    return y - ROW_LINE_H;
  };

  y = drawTextRow(
    "Days worked",
    `${data.run.days_present} of ${data.run.scheduled_days}`,
  );
  y = drawTextRow("Unpaid absence", `${data.run.days_unpaid_absent} d`);
  y = drawTextRow(
    "VL used / SL used",
    `${data.run.days_vl_used} d / ${data.run.days_sl_used} d`,
  );

  return y;
}

function drawYtdAndLeave(
  ctx: DrawCtx,
  data: PayslipData,
  startY: number,
): number /* next Y */ {
  const blockStartY = startY;
  const leftAfterY = drawYtd(ctx, data, blockStartY);
  const rightAfterY = drawLeaveAndAttendance(ctx, data, blockStartY);
  return Math.min(leftAfterY, rightAfterY) - 6;
}

// ---------------------------------------------------------------------------
// Signature block (T72)
// ---------------------------------------------------------------------------
//
// Two horizontal signature lines side by side, pinned near the bottom of the
// page so the printed payslip has a fixed signing footer. T73 added the
// pagination logic in generatePayslipPdf() that decides whether to draw the
// signatures on page 1 or push them (and the preceding net-pay + YTD blocks)
// to page 2 — but the signature drawer itself remains anchored to a fixed
// bottom Y on whichever page is "current".

const SIGNATURE_BOTTOM_Y = MARGIN + 70;
const SIGNATURE_LINE_W = 220;
const SIGNATURE_LINE_THICKNESS = 0.5;

function drawSignatures(
  ctx: DrawCtx,
  data: PayslipData,
): number /* next Y */ {
  // Two columns, evenly spaced across the page body.
  const lineY = SIGNATURE_BOTTOM_Y + 28;
  const leftLineX = MARGIN + 10;
  const rightLineX = PAGE_W - MARGIN - 10 - SIGNATURE_LINE_W;

  // Draw the two signature rules.
  ctx.page.drawLine({
    start: { x: leftLineX, y: lineY },
    end: { x: leftLineX + SIGNATURE_LINE_W, y: lineY },
    thickness: SIGNATURE_LINE_THICKNESS,
    color: INK,
  });
  ctx.page.drawLine({
    start: { x: rightLineX, y: lineY },
    end: { x: rightLineX + SIGNATURE_LINE_W, y: lineY },
    thickness: SIGNATURE_LINE_THICKNESS,
    color: INK,
  });

  // Captions below each line.
  drawText(ctx, "Employee signature", leftLineX, lineY - 12, {
    size: 8,
    color: GRAY,
    bold: true,
  });
  drawText(ctx, data.employee.full_name, leftLineX, lineY - 24, {
    size: 9,
    color: INK,
  });
  drawText(
    ctx,
    `Date: ${formatManilaDate(data.period.pay_date)}`,
    leftLineX,
    lineY - 36,
    { size: 9, color: GRAY },
  );

  drawText(ctx, "Approved by — Cashier / Admin", rightLineX, lineY - 12, {
    size: 8,
    color: GRAY,
    bold: true,
  });
  // Blank printed-name line — staff sign physically and write their name.
  drawText(ctx, "Name & signature:", rightLineX, lineY - 24, {
    size: 9,
    color: INK,
  });
  drawText(
    ctx,
    `Date: ${formatManilaDate(data.period.pay_date)}`,
    rightLineX,
    lineY - 36,
    { size: 9, color: GRAY },
  );

  return SIGNATURE_BOTTOM_Y;
}

// ---------------------------------------------------------------------------
// Pagination — section-height estimation (T73)
// ---------------------------------------------------------------------------
//
// We don't draw twice. Instead, we estimate the height of each post-tables
// section ahead of time using fixed line-counts (plus the dynamic deduction-
// line count for the tables block), then decide upfront whether to break to
// a continuation page. Signatures always live on the LAST page.
//
// The pagination model: page 1 always carries the letterhead, employee/period
// block, and the earnings/deductions tables. If the net-pay band, YTD/leave
// block, AND signature footer all fit on the remaining space, everything
// stays on one page. Otherwise we break BEFORE the net-pay band — net pay,
// YTD/leave, and signatures move to page 2 with a compact letterhead and a
// "continued" notice.
//
// Estimated heights are intentionally pessimistic — better to break to page 2
// when 95% would still fit than to overlap the signature footer.

// Signature footer occupies fixed Y range, anchored to MARGIN + 70 (see
// SIGNATURE_BOTTOM_Y). The signature lines are 28pt above that, and we draw
// captions 36pt below the line. Reserve from MARGIN + 70 - 12 up to about
// SIGNATURE_BOTTOM_Y + 40 to be safe.
const SIGNATURE_RESERVE_Y = SIGNATURE_BOTTOM_Y + 50; // y at or above this is "in the signature zone"
// Net-pay band height plus the gap below.
const NETPAY_TOTAL_H = NETPAY_BAND_H + NETPAY_GAP_BELOW + 10; /* +10 for the gap above the band */
// YTD + Leave block: ~9 YTD rows × 13pt + section header + divider + bottom
// padding, plus on the right ~5 leave/attendance rows + subsection header.
// Worst case ≈ 165pt; pad to 180pt.
const YTD_LEAVE_TOTAL_H = 180;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build a payslip PDF for a single payroll_employee_runs row. Returns the
 * rendered bytes as a Node Buffer. Caller (Server Action) is responsible for
 * uploading to storage + audit-logging the access.
 *
 * T73 implements section-atom pagination: if the net-pay band + YTD/Leave +
 * signature footer would overlap below the tables on page 1, we break to a
 * continuation page with a compact letterhead and a "continued from page 1"
 * notice. Signatures always live on the LAST page.
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

  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(FONT_REGULAR_BYTES, { subset: true });
  const fontBold = await pdfDoc.embedFont(FONT_BOLD_BYTES, { subset: true });

  // Logo bytes are read once at module load (see LOGO_BYTES above) — just
  // embed into this document.
  const logoImg = await pdfDoc.embedPng(LOGO_BYTES);

  // ----- Page 1: letterhead → employee block → tables ---------------------
  const page1 = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const ctx1: DrawCtx = { page: page1, font, fontBold };

  const afterLetterheadY = drawLetterhead(ctx1, logoImg);
  const afterEmployeeY = drawEmployeePeriodBlock(ctx1, data, afterLetterheadY);
  const afterTablesY = drawEarningsAndDeductions(ctx1, data, afterEmployeeY);

  // Decide whether everything still fits on page 1. We need:
  //   afterTablesY - NETPAY_TOTAL_H - YTD_LEAVE_TOTAL_H >= SIGNATURE_RESERVE_Y
  // If false, the trailing sections move to page 2.
  const needsPage2 =
    afterTablesY - NETPAY_TOTAL_H - YTD_LEAVE_TOTAL_H < SIGNATURE_RESERVE_Y;

  if (!needsPage2) {
    // Single-page layout — original flow.
    const afterNetPayY = drawNetPayBlock(ctx1, data, afterTablesY);
    drawYtdAndLeave(ctx1, data, afterNetPayY);
    drawSignatures(ctx1, data);
  } else {
    // Two-page layout — net pay onward moves to page 2.
    const page2 = pdfDoc.addPage([PAGE_W, PAGE_H]);
    const ctx2: DrawCtx = { page: page2, font, fontBold };

    const afterCompactLetterheadY = drawLetterhead(ctx2, logoImg, {
      compact: true,
    });
    const afterNoticeY = drawContinuedNotice(
      ctx2,
      data,
      afterCompactLetterheadY,
    );
    const afterNetPayY = drawNetPayBlock(ctx2, data, afterNoticeY);
    drawYtdAndLeave(ctx2, data, afterNetPayY);
    drawSignatures(ctx2, data);
  }

  // Page markers: drawn last so we know the total count.
  const pages = pdfDoc.getPages();
  for (let i = 0; i < pages.length; i++) {
    drawPageMarker(pages[i], font, i, pages.length);
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

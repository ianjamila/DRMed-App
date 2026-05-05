import "server-only";

import type { SheetRow } from "./types";

// =============================================================================
// Pure functions: DB row → spreadsheet row array.
//
// Column orders mirror reception's existing sheets. They're a best-effort match
// from the IMPLEMENTATION_PLAN spec; the first cron run should be diffed
// against the live sheet and adjusted if anything is off-by-one. Keep these
// pure so the admin UI can preview a row without hitting Sheets.
// =============================================================================

// ---- Lab Services ----------------------------------------------------------
// One row per released test_request line. Spec column order:
// Date | Control No | Patient Name | HMO? | Provider | Approval Date |
// Service | Base Price | Senior/PWD 20% | Discount 10% | Discount 5% |
// Actual Discount | Final Price | Payment Method | Paid Ref |
// Preferred Medium | Date Released | Receptionist Remarks
// =============================================================================

export interface LabRowSource {
  visit_date: string; // 'YYYY-MM-DD'
  visit_number: string;
  patient_full_name: string;
  hmo_provider_name: string | null;
  hmo_approval_date: string | null;
  service_name: string;
  base_price_php: number | null;
  discount_kind: string | null;
  discount_amount_php: number;
  final_price_php: number | null;
  payment_methods: string; // e.g. "cash; gcash" — joined when multiple payments
  payment_references: string; // joined refs
  release_medium: string | null;
  released_at: string | null; // ISO timestamp
  receptionist_remarks: string | null;
}

export function mapLabRow(s: LabRowSource): SheetRow {
  const isSeniorPwd = s.discount_kind === "senior_pwd_20";
  const is10 = s.discount_kind === "pct_10";
  const is5 = s.discount_kind === "pct_5";
  return [
    s.visit_date,
    s.visit_number,
    s.patient_full_name,
    s.hmo_provider_name ? "Yes" : "No",
    s.hmo_provider_name ?? "",
    s.hmo_approval_date ?? "",
    s.service_name,
    moneyOrBlank(s.base_price_php),
    isSeniorPwd ? moneyOrBlank(s.discount_amount_php) : "",
    is10 ? moneyOrBlank(s.discount_amount_php) : "",
    is5 ? moneyOrBlank(s.discount_amount_php) : "",
    moneyOrBlank(s.discount_amount_php),
    moneyOrBlank(s.final_price_php),
    formatPaymentMethods(s.payment_methods),
    s.payment_references,
    formatReleaseMedium(s.release_medium),
    s.released_at ? toManilaDate(s.released_at) : "",
    s.receptionist_remarks ?? "",
  ];
}

// ---- Doctor Consultations --------------------------------------------------
// One row per consultation (test_request with services.kind='doctor_consultation').
// Spec column order:
// Control No | Test No | Patient Name | HMO? | HMO Provider | HMO Approval Date |
// Doctor Consultant | Base Price | Senior/PWD 20% | Other Discounts 20% |
// Final Price | Clinic Fee | Paid? | Reference | Remarks
// =============================================================================

export interface ConsultRowSource {
  visit_number: string;
  test_number: number | null;
  patient_full_name: string;
  hmo_provider_name: string | null;
  hmo_approval_date: string | null;
  doctor_consultant: string | null; // not yet captured; left blank pending Phase 9
  base_price_php: number | null;
  discount_kind: string | null;
  discount_amount_php: number;
  final_price_php: number | null;
  clinic_fee_php: number | null;
  payment_status: string | null; // visits.payment_status
  payment_references: string;
  receptionist_remarks: string | null;
}

export function mapConsultRow(s: ConsultRowSource): SheetRow {
  const isSeniorPwd = s.discount_kind === "senior_pwd_20";
  const isOther20 = s.discount_kind === "other_pct_20";
  return [
    s.visit_number,
    s.test_number ?? "",
    s.patient_full_name,
    s.hmo_provider_name ? "Yes" : "No",
    s.hmo_provider_name ?? "",
    s.hmo_approval_date ?? "",
    s.doctor_consultant ?? "",
    moneyOrBlank(s.base_price_php),
    isSeniorPwd ? moneyOrBlank(s.discount_amount_php) : "",
    isOther20 ? moneyOrBlank(s.discount_amount_php) : "",
    moneyOrBlank(s.final_price_php),
    moneyOrBlank(s.clinic_fee_php),
    s.payment_status === "paid" ? "Yes" : "No",
    s.payment_references,
    s.receptionist_remarks ?? "",
  ];
}

// ---- Doctor Procedures HMO -------------------------------------------------
// One row per procedure (test_request with services.kind='doctor_procedure').
// Spec column order:
// Date | Patient Name | HMO Provider | Approval Date | Service Description |
// Doctor Consultant | Approved Amount
// =============================================================================

export interface ProcedureRowSource {
  visit_date: string;
  patient_full_name: string;
  hmo_provider_name: string | null;
  hmo_approval_date: string | null;
  procedure_description: string | null;
  doctor_consultant: string | null; // not yet captured; left blank pending Phase 9
  hmo_approved_amount_php: number | null;
}

export function mapProcedureRow(s: ProcedureRowSource): SheetRow {
  return [
    s.visit_date,
    s.patient_full_name,
    s.hmo_provider_name ?? "",
    s.hmo_approval_date ?? "",
    s.procedure_description ?? "",
    s.doctor_consultant ?? "",
    moneyOrBlank(s.hmo_approved_amount_php),
  ];
}

// ---- Helpers ---------------------------------------------------------------

function moneyOrBlank(value: number | null | undefined): number | string {
  return value == null ? "" : Number(value);
}

function formatPaymentMethods(joined: string): string {
  // Reception's sheet uses upper-cased labels (CASH, GCASH, HMO, BPI, …).
  // The DB stores snake_case enum values; map for display while keeping the
  // `; ` separator the existing exports use.
  return joined
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map(prettyMethod)
    .join("; ");
}

function prettyMethod(method: string): string {
  switch (method) {
    case "bank_transfer":
      return "BANK TRANSFER";
    default:
      return method.toUpperCase();
  }
}

function formatReleaseMedium(value: string | null): string {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Renders an ISO timestamp as a Manila-local date string (YYYY-MM-DD).
// The accountant cares about the date the result was released, not the time.
function toManilaDate(iso: string): string {
  const d = new Date(iso);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(d);
}

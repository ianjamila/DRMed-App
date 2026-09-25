/** Payment Changes (0161) — every deleted, edited or moved payment. Shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { isISODate, manilaRangeUtc, shiftISODate, todayManilaISODate } from "@/lib/dates/manila";
import { formatPatientName } from "@/lib/patients/format-name";
import { formatPhp } from "@/lib/marketing/format";
import type { SortSpec } from "@/lib/ui/table-params";
import {
  linkPayments,
  paymentMethodLabel,
  PAYMENT_FATE_LABEL,
  type HistoryPayment,
} from "@/lib/visits/payment-history";
import { chunk, fetchAllRows, IN_CHUNK, unique } from "./paging";
import { csvManilaStamp, pluckOne } from "./format";

type AnyClient = SupabaseClient<Database>;

export const PAYMENT_CHANGE_KINDS = ["all", "deleted", "edited", "moved"] as const;
export type PaymentChangeKind = (typeof PAYMENT_CHANGE_KINDS)[number];

export interface PaymentChangesParams {
  start: string;
  end: string;
  kind: PaymentChangeKind;
}

/** A correction is rare — default to a wide 90-day window, like Undone Releases. */
export function parsePaymentChangesParams(
  sp: { start?: string; end?: string; kind?: string },
  today: string = todayManilaISODate(),
): PaymentChangesParams {
  return {
    start: isISODate(sp.start) ? sp.start : shiftISODate(today, -90),
    end: isISODate(sp.end) ? sp.end : today,
    kind: (PAYMENT_CHANGE_KINDS as readonly string[]).includes(sp.kind ?? "")
      ? (sp.kind as PaymentChangeKind)
      : "all",
  };
}

interface PatientEmbed {
  first_name: string;
  last_name: string;
  drm_id: string;
}

interface VisitEmbed {
  visit_number: string;
  patients: PatientEmbed | PatientEmbed[] | null;
}

export interface VoidedPaymentRow extends HistoryPayment {
  reference_number: string | null;
  received_at: string;
  voided_by: string | null;
  visits: VisitEmbed | VisitEmbed[] | null;
}

export interface PaymentChange {
  id: string;
  voidedAt: string;
  receivedAt: string;
  amountPhp: number;
  method: string | null;
  reference: string | null;
  fate: Exclude<PaymentChangeKind, "all">;
  visitId: string;
  visitNumber: string | null;
  patient: PatientEmbed | null;
  replacement: {
    amountPhp: number;
    method: string | null;
    visitId: string;
    visitNumber: string | null;
    patientName: string | null;
    /** The replacement has itself been changed since. */
    changedSince: boolean;
  } | null;
  byName: string | null;
  reason: string | null;
}

export interface PaymentChangesSummary {
  total: number;
  deleted: number;
  deletedPhp: number;
  edited: number;
  moved: number;
  /** Who made the most changes in the window — an oversight signal, not blame. */
  topActor: { name: string; count: number } | null;
}

export interface PaymentChangesReport {
  entries: PaymentChange[];
  summary: PaymentChangesSummary;
  truncated: boolean;
}

// A gift-code redemption that fails halfway voids its own payment with this
// reason (payments/new/actions.ts). Nobody typed it, so say what it was.
const SYSTEM_REASONS: Record<string, string> = {
  redemption_rollback: "Automatic: gift code redemption rolled back",
};

export function derivePaymentChanges(
  voided: readonly VoidedPaymentRow[],
  replacements: readonly VoidedPaymentRow[],
  staffNameById: ReadonlyMap<string, string>,
): PaymentChange[] {
  const links = linkPayments<VoidedPaymentRow>([...voided, ...replacements]);
  return voided.map((p) => {
    const visit = pluckOne(p.visits);
    const rep = links.replacementOf(p);
    const repVisit = rep ? pluckOne(rep.visits) : null;
    const repPatient = repVisit ? pluckOne(repVisit.patients) : null;
    const fate = links.fate(p);
    const reason = links.reason(p);
    return {
      id: p.id,
      voidedAt: p.voided_at ?? "",
      receivedAt: p.received_at,
      amountPhp: Number(p.amount_php),
      method: p.method,
      reference: p.reference_number,
      fate: fate === "active" ? "deleted" : fate,
      visitId: p.visit_id,
      visitNumber: visit?.visit_number ?? null,
      patient: pluckOne(visit?.patients ?? null),
      replacement: rep
        ? {
            amountPhp: Number(rep.amount_php),
            method: rep.method,
            visitId: rep.visit_id,
            visitNumber: repVisit?.visit_number ?? null,
            patientName: repPatient ? formatPatientName(repPatient) : null,
            changedSince: rep.voided_at != null,
          }
        : null,
      byName: p.voided_by ? (staffNameById.get(p.voided_by) ?? null) : null,
      reason: reason ? (SYSTEM_REASONS[reason] ?? reason) : null,
    };
  });
}

export function summarisePaymentChanges(entries: readonly PaymentChange[]): PaymentChangesSummary {
  const deleted = entries.filter((e) => e.fate === "deleted");
  const byActor = new Map<string, number>();
  for (const e of entries) if (e.byName) byActor.set(e.byName, (byActor.get(e.byName) ?? 0) + 1);
  let topActor: PaymentChangesSummary["topActor"] = null;
  for (const [name, count] of byActor) {
    if (!topActor || count > topActor.count || (count === topActor.count && name < topActor.name)) {
      topActor = { name, count };
    }
  }
  return {
    total: entries.length,
    deleted: deleted.length,
    deletedPhp: deleted.reduce((s, e) => s + Math.round(e.amountPhp * 100), 0) / 100,
    edited: entries.filter((e) => e.fate === "edited").length,
    moved: entries.filter((e) => e.fate === "moved").length,
    topActor,
  };
}

const VOIDED_SELECT =
  "id, visit_id, amount_php, method, reference_number, received_at, voided_at, voided_by, void_reason, corrects_payment_id, visits ( visit_number, patients ( first_name, last_name, drm_id ) )";

/**
 * Loads the whole window (the summary tiles need it all) and applies the kind
 * filter in memory — the tiles always describe the window, the table the
 * chosen kind.
 */
export async function loadPaymentChanges(
  client: AnyClient,
  params: PaymentChangesParams,
  maxRows: number,
): Promise<PaymentChangesReport> {
  const { fromIso, toIso } = manilaRangeUtc(params.start, params.end);
  const { rows, truncated } = await fetchAllRows<VoidedPaymentRow>(
    (from, to) =>
      client
        .from("payments")
        .select(VOIDED_SELECT)
        .not("voided_at", "is", null)
        .gte("voided_at", fromIso!)
        .lt("voided_at", toIso!)
        .order("voided_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<VoidedPaymentRow[]>(),
    maxRows,
  );

  const replacements: VoidedPaymentRow[] = [];
  for (const ids of chunk(rows.map((r) => r.id), IN_CHUNK)) {
    const { data } = await client
      .from("payments")
      .select(VOIDED_SELECT)
      .in("corrects_payment_id", ids)
      .returns<VoidedPaymentRow[]>();
    replacements.push(...(data ?? []));
  }

  const staffNameById = new Map<string, string>();
  for (const ids of chunk(unique(rows.map((r) => r.voided_by)), IN_CHUNK)) {
    const { data } = await client.from("staff_profiles").select("id, full_name").in("id", ids);
    for (const s of data ?? []) staffNameById.set(s.id, s.full_name);
  }

  const all = derivePaymentChanges(rows, replacements, staffNameById);
  const entries = params.kind === "all" ? all : all.filter((e) => e.fate === params.kind);
  return { entries, summary: summarisePaymentChanges(all), truncated };
}

export function paymentChangeOutcome(e: PaymentChange): string {
  if (e.fate === "deleted") return "Deleted";
  if (!e.replacement) return e.fate === "moved" ? "Moved" : "Edited";
  const money = `${formatPhp(e.replacement.amountPhp)} ${paymentMethodLabel(e.replacement.method)}`;
  const tail = e.replacement.changedSince ? " (since changed again)" : "";
  if (e.fate === "moved") {
    return `Moved to #${e.replacement.visitNumber ?? "?"}${
      e.replacement.patientName ? ` · ${e.replacement.patientName}` : ""
    }${tail}`;
  }
  return `Now ${money}${tail}`;
}

export const PAYMENT_CHANGES_SORTABLE_COLUMNS = ["when", "patient", "amount", "change", "by"] as const;
export type PaymentChangesSortColumn = (typeof PAYMENT_CHANGES_SORTABLE_COLUMNS)[number];

/** An oversight log: the change someone is asking about is the newest one. */
export const PAYMENT_CHANGES_DEFAULT_SORT: SortSpec<PaymentChangesSortColumn> = {
  key: "when",
  dir: "desc",
};

export function comparePaymentChanges(
  a: PaymentChange,
  b: PaymentChange,
  sort: SortSpec<PaymentChangesSortColumn>,
): number {
  const dirMul = sort.dir === "asc" ? 1 : -1;
  let cmp = 0;
  switch (sort.key) {
    case "when":
      cmp = dirMul * a.voidedAt.localeCompare(b.voidedAt);
      break;
    case "amount":
      cmp = dirMul * (a.amountPhp - b.amountPhp);
      break;
    case "change":
      cmp = dirMul * PAYMENT_FATE_LABEL[a.fate].localeCompare(PAYMENT_FATE_LABEL[b.fate]);
      break;
    case "patient":
    case "by": {
      // Unresolved patient / staff is missing data: last in either direction.
      const av = sort.key === "patient" ? (a.patient ? formatPatientName(a.patient) : null) : a.byName;
      const bv = sort.key === "patient" ? (b.patient ? formatPatientName(b.patient) : null) : b.byName;
      if (av === null && bv === null) cmp = 0;
      else if (av === null) return 1;
      else if (bv === null) return -1;
      else cmp = dirMul * av.localeCompare(bv);
      break;
    }
  }
  return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
}

export const PAYMENT_CHANGES_CSV_HEADER = [
  "Changed (Manila)",
  "Change",
  "Patient",
  "DRM-ID",
  "Visit #",
  "Amount",
  "Method",
  "Reference",
  "Received (Manila)",
  "Outcome",
  "New visit #",
  "Changed by",
  "Reason",
] as const;

export function paymentChangesCsvRows(entries: readonly PaymentChange[]): unknown[][] {
  return [
    [...PAYMENT_CHANGES_CSV_HEADER],
    ...entries.map((e) => [
      csvManilaStamp(e.voidedAt),
      PAYMENT_FATE_LABEL[e.fate],
      e.patient ? `${e.patient.last_name}, ${e.patient.first_name}` : "",
      e.patient?.drm_id ?? "",
      e.visitNumber ?? "",
      e.amountPhp.toFixed(2),
      paymentMethodLabel(e.method),
      e.reference ?? "",
      csvManilaStamp(e.receivedAt),
      paymentChangeOutcome(e),
      e.fate === "moved" ? (e.replacement?.visitNumber ?? "") : "",
      e.byName ?? "",
      e.reason ?? "",
    ]),
  ];
}

export function paymentChangesCsvHref(p: PaymentChangesParams): string {
  const q: Record<string, string> = { start: p.start, end: p.end };
  if (p.kind !== "all") q.kind = p.kind;
  return `/api/admin/reports/payment-changes.csv?${new URLSearchParams(q)}`;
}

export function paymentChangesCsvFilename(p: PaymentChangesParams): string {
  return `payment-changes-${p.kind === "all" ? "" : `${p.kind}-`}${p.start}_${p.end}.csv`;
}

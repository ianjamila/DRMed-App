import { z } from "zod";

// Patient delete/restore rules shared by the dialog, the server actions and
// the Deleted Patients page (0167). The SQL is the authority: this module
// validates input before it reaches delete_patient() and parses what comes
// back. deletion.test.ts pins the reasons and blocker kinds to 0167.

export const DELETE_REASONS = ["duplicate", "test_record", "patient_request", "other"] as const;
export type DeleteReason = (typeof DELETE_REASONS)[number];

export const DELETE_REASON_LABEL: Record<DeleteReason, string> = {
  duplicate: "Duplicate record",
  test_record: "Test record",
  patient_request: "Requested by the patient",
  other: "Other",
};

export function deleteReasonLabel(reason: string | null | undefined): string {
  return (DELETE_REASON_LABEL as Record<string, string>)[reason ?? ""] ?? "Unknown reason";
}

export const DELETE_NOTE_MAX = 500;

export const DeletePatientSchema = z
  .object({
    patientId: z.string().uuid("We couldn't find that patient."),
    reason: z.enum(DELETE_REASONS, { message: "Choose a reason." }),
    note: z
      .string()
      .trim()
      .max(DELETE_NOTE_MAX, `The note can be at most ${DELETE_NOTE_MAX} characters.`)
      .optional()
      .transform((v) => (v ? v : undefined)),
  })
  .superRefine((d, ctx) => {
    if (d.reason === "other" && !d.note) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "Add a note when the reason is Other." });
    }
  });
export type DeletePatientInput = z.input<typeof DeletePatientSchema>;

// Blocker kinds `patient_delete_blockers` (0167) can emit — pinned against
// the migration's `blockers as ( … )` CTE by deletion.test.ts.
export const BLOCKER_KINDS = [
  "appointment",
  "clinical",
  "empty_visit",
  "balance",
  "hmo_patient_share",
  "hmo_reconciliation",
  "hmo_claim",
  "hmo_unbilled",
] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

export const BLOCKER_GROUP_LABEL: Record<BlockerKind, string> = {
  appointment: "Open appointments",
  clinical: "Unfinished tests and consultations",
  empty_visit: "Visits with nothing on them",
  balance: "Unpaid balances",
  hmo_patient_share: "Unpaid patient share (HMO)",
  hmo_reconciliation: "HMO records to reconcile first",
  hmo_claim: "HMO claims not yet settled",
  hmo_unbilled: "HMO coverage not yet claimed",
};

export interface DeleteBlocker {
  kind: string;
  resource_id: string;
  visit_id: string | null;
  label: string;
  amount_php: number | null;
  href: string | null;
}

const BlockerRow = z.object({
  kind: z.string(),
  resource_id: z.string(),
  visit_id: z.string().nullable(),
  label: z.string(),
  amount_php: z.union([z.number(), z.string(), z.null()]),
  href: z.string().nullable(),
});

export function parseBlockers(raw: unknown): DeleteBlocker[] {
  const parsed = z.array(BlockerRow).safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.map((b) => ({
    ...b,
    amount_php: b.amount_php === null ? null : Number(b.amount_php),
  }));
}

/** P0059 carries the blocker list as JSON in the error DETAIL. */
export function parseBlockerDetail(details: string | null | undefined): DeleteBlocker[] {
  if (!details) return [];
  try {
    return parseBlockers(JSON.parse(details));
  } catch {
    return [];
  }
}

export interface BlockerGroup {
  kind: string;
  title: string;
  items: DeleteBlocker[];
}

/** Group for display, keeping the SQL's order (first-seen kind first). */
export function groupBlockers(blockers: readonly DeleteBlocker[]): BlockerGroup[] {
  const groups = new Map<string, BlockerGroup>();
  for (const b of blockers) {
    let g = groups.get(b.kind);
    if (!g) {
      g = {
        kind: b.kind,
        title: (BLOCKER_GROUP_LABEL as Record<string, string>)[b.kind] ?? "Other open items",
        items: [],
      };
      groups.set(b.kind, g);
    }
    g.items.push(b);
  }
  return [...groups.values()];
}

export interface KeptCounts {
  visits: number;
  payments: number;
  appointments: number;
  consents: number;
}

export function parseKeptCounts(raw: unknown): KeptCounts {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
  return { visits: n(r.visits), payments: n(r.payments), appointments: n(r.appointments), consents: n(r.consents) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function keptSummary(k: KeptCounts): string {
  return [
    plural(k.visits, "visit", "visits"),
    plural(k.payments, "payment", "payments"),
    plural(k.appointments, "appointment", "appointments"),
    plural(k.consents, "consent record", "consent records"),
  ].join(", ");
}

/** delete_patient / restore_patient return {patient_id, drm_id, kept}. */
export function parseLifecycleResult(raw: unknown): { patientId: string; drmId: string } | null {
  const r = raw as { patient_id?: unknown; drm_id?: unknown } | null;
  if (!r || typeof r.patient_id !== "string" || typeof r.drm_id !== "string") return null;
  return { patientId: r.patient_id, drmId: r.drm_id };
}

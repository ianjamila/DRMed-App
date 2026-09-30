"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { activePatients } from "@/lib/patients/active";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { MERGE_UNDO_WINDOW_DAYS, RECENT_MERGES_PAGE_SIZE } from "@/lib/patients/merge-fields";
import {
  parseMergeRpcResult,
  parseUndoRpcResult,
  undoableState,
  undoReportLines,
  type MovedCounts,
} from "@/lib/patients/merge-result";
import { sendEmail } from "@/lib/notifications/email";
import { checkPatientRecipient } from "@/lib/notifications/active-patient-recipient";
import { auditSkippedInactiveRecipient } from "@/lib/notifications/inactive-recipient-audit";
import {
  renderEmailShell,
  emailParagraph,
  emailHighlight,
  escapeHtml,
} from "@/lib/notifications/branded-email";

export type LookupResult =
  | {
      ok: true;
      patient: PatientPreview;
    }
  | { ok: false; error: string };

export interface PatientPreview {
  id: string;
  drm_id: string;
  first_name: string;
  last_name: string;
  middle_name: string | null;
  birthdate: string | null;
  sex: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  visit_count: number;
  appointment_count: number;
  merged_into_id: string | null;
}

const LookupSchema = z.object({
  drm_id: z
    .string()
    .trim()
    .regex(/^DRM-\d{4,}$/i, "DRM-ID looks like DRM-0001."),
});

async function previewByDrmId(drmId: string): Promise<PatientPreview | null> {
  const admin = createAdminClient();
  const { data: row } = await activePatients(
    admin
      .from("patients")
      .select(
        "id, drm_id, first_name, last_name, middle_name, birthdate, sex, phone, email, address, merged_into_id",
      ),
  )
    .eq("drm_id", drmId.toUpperCase())
    .maybeSingle();
  if (!row) return null;

  const [{ count: visits }, { count: appts }] = await Promise.all([
    admin
      .from("visits")
      .select("id", { count: "exact", head: true })
      .eq("patient_id", row.id)
      // Preview count is for identifying the right patient (0125) — count live visits only.
      .is("deleted_at", null),
    admin
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("patient_id", row.id),
  ]);

  return {
    id: row.id,
    drm_id: row.drm_id,
    first_name: row.first_name,
    last_name: row.last_name,
    middle_name: row.middle_name,
    birthdate: row.birthdate,
    sex: row.sex,
    phone: row.phone,
    email: row.email,
    address: row.address,
    merged_into_id: row.merged_into_id,
    visit_count: visits ?? 0,
    appointment_count: appts ?? 0,
  };
}

export async function lookupPatientForMergeAction(
  _prev: LookupResult | null,
  formData: FormData,
): Promise<LookupResult> {
  await requireAdminStaff();
  const parsed = LookupSchema.safeParse({ drm_id: formData.get("drm_id") });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }
  const preview = await previewByDrmId(parsed.data.drm_id);
  if (!preview) {
    return { ok: false, error: `No patient with DRM-ID ${parsed.data.drm_id.toUpperCase()}.` };
  }
  return { ok: true, patient: preview };
}

export type MergeResult =
  | {
      ok: true;
      merge_id: string;
      kept_drm_id: string;
      merged_drm_id: string;
      moved: MovedCounts;
      filled: string[];
      rechained: number;
    }
  | { ok: false; error: string };

const MergeSchema = z.object({
  keep_id: z.string().uuid(),
  source_id: z.string().uuid(),
  confirm: z.literal("MERGE", { message: "Type MERGE to confirm." }),
});

// The whole merge — every move, the fill, chain flattening, the tombstone,
// the undo ledger and the patient.merged audit row — is ONE transaction in
// merge_patients_guarded (0196). Nothing to roll back here: a refusal or a
// failure changed nothing. A lock race (P0072/40P01/40001) rolled back whole,
// so one retry is safe (withLifecycleRetry).
export async function mergePatientsAction(
  _prev: MergeResult | null,
  formData: FormData,
): Promise<MergeResult> {
  const session = await requireAdminStaff();
  const parsed = MergeSchema.safeParse({
    keep_id: formData.get("keep_id"),
    source_id: formData.get("source_id"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const { keep_id, source_id } = parsed.data;
  if (keep_id === source_id) return { ok: false, error: "Pick two different patients." };
  const origin = formData.get("origin") === "candidates" ? "candidates" : "admin";

  const { ip, ua } = await ipAndAgent();
  const admin = createAdminClient();
  const { data, error } = await withLifecycleRetry(() =>
    admin.rpc("merge_patients_guarded", {
      p_keep: keep_id,
      p_source: source_id,
      p_actor: session.user_id,
      p_context: { ip, user_agent: ua, source: origin },
    }),
  );
  if (error) return { ok: false, error: translatePgError(error) };
  const merged = parseMergeRpcResult(data);
  if (!merged) {
    await reportError({ scope: "mergePatientsAction:result", error: new Error("unparseable merge result"), metadata: { keep_id, source_id } });
    return { ok: false, error: "The records were merged, but the result could not be read. Refresh the page." };
  }

  await notifyKeptPatient(admin, merged.mergeId, keep_id, merged.keptDrmId, session.user_id, ip, ua);

  revalidatePath("/staff/admin/patient-merge");
  revalidatePath("/staff/admin/patient-merge/candidates");
  revalidatePath("/staff/patients");
  return {
    ok: true,
    merge_id: merged.mergeId,
    kept_drm_id: merged.keptDrmId,
    merged_drm_id: merged.mergedDrmId,
    moved: merged.moved,
    filled: merged.filled,
    rechained: merged.rechained,
  };
}

// M2: tell the kept patient their records were combined. Runs AFTER the merge
// committed, so its outcome gets its own audit row (the patient.merged row
// was written inside the transaction, before any email existed). Fresh
// recipient check (0167): the kept record must still be active, and its
// on-file email — already carrying any merge fill — is the address of record.
async function notifyKeptPatient(
  admin: ReturnType<typeof createAdminClient>,
  mergeId: string,
  keepId: string,
  keptDrmId: string,
  actorId: string,
  ip: string | null,
  ua: string | null,
): Promise<void> {
  const recipient = await checkPatientRecipient(admin, keepId);
  if (recipient.kind === "inactive") {
    await auditSkippedInactiveRecipient({
      sender: "patient-merge",
      patientId: keepId,
      reason: recipient.reason,
      resourceType: "patient",
      resourceId: keepId,
    });
  }
  const to = recipient.kind === "active" ? (recipient.patient.email ?? null) : null;
  let firstName = "there";
  if (to) {
    // History read (never filtered): the name on the record we just merged
    // into. deleted_at/merged_into_id ride along, unused, only so this mixed
    // file's per-chain check can see it declares its own state (same pattern
    // as loadRecentMerges' pts read below).
    const { data: row } = await admin
      .from("patients")
      .select("first_name, deleted_at, merged_into_id")
      .eq("id", keepId)
      .maybeSingle();
    if (row?.first_name) firstName = row.first_name;
  }
  const email = to
    ? await sendEmail({
        to,
        subject: "Your DRMed records were combined",
        text: `Hi ${firstName},\n\nWe combined two DRMed records that belonged to you into one. From now on, use this DRM-ID: ${keptDrmId}, together with the Secure PIN printed on your most recent receipt, to view your results online.\n\n— DRMed Clinic and Laboratory`,
        html: renderEmailShell({
          heading: "Your DRMed patient ID",
          contentHtml:
            emailParagraph(`Hi <b>${escapeHtml(firstName)}</b>,`) +
            emailParagraph("We combined two DRMed records that belonged to you into one. From now on, use this patient ID:") +
            emailHighlight("Your DRM-ID", keptDrmId) +
            emailParagraph("Sign in with the Secure PIN printed on your most recent receipt to view your results online."),
        }),
      })
    : null;

  await audit({
    actor_id: actorId,
    actor_type: "staff",
    patient_id: keepId,
    action: "patient.merge.notified",
    resource_type: "patient",
    resource_id: keepId,
    metadata: {
      merge_id: mergeId,
      recipient: recipient.kind,
      email: !email
        ? { ok: false, skipped: true, reason: "no on-file email" }
        : email.ok
          ? { ok: true, id: email.id, to }
          : email.kind === "skipped"
            ? { ok: false, skipped: true, reason: email.reason }
            : { ok: false, error: email.error, to },
    },
    ip_address: ip,
    user_agent: ua,
  });
}

export interface RecentMerge {
  id: string;
  keep_id: string;
  source_id: string;
  keep_drm_id: string | null;
  source_drm_id: string | null;
  keep_deleted_at: string | null;
  keep_merged_into_id: string | null;
  merged_at: string;
  legacy: boolean;
  undoable: boolean;
  interrupted: boolean;
  blocked_reason: string | null;
}

// Every live merge inside the undo window, paged with a total order
// (merged_at desc, id desc) — a dedup CLI batch can exceed any fixed cap.
// A live LEGACY row (snapshot_version is null) is included at any age too
// (F1): it can only be an interrupted old-app undo, which is undoable at any
// age — undoableState below decides "undoable" vs. "past the window".
export async function loadRecentMerges(page = 1): Promise<{ rows: RecentMerge[]; total: number; page: number }> {
  await requireAdminStaff();
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - MERGE_UNDO_WINDOW_DAYS * 86_400_000).toISOString();
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const from = (safePage - 1) * RECENT_MERGES_PAGE_SIZE;
  const { data, count } = await admin
    .from("patient_merges")
    .select("id, keep_id, source_id, merged_at, snapshot_version", { count: "exact" })
    .is("undone_at", null)
    .or(`merged_at.gte.${cutoff},snapshot_version.is.null`)
    .order("merged_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + RECENT_MERGES_PAGE_SIZE - 1);
  if (!data) return { rows: [], total: 0, page: safePage };
  const ids = Array.from(new Set(data.flatMap((m) => [m.keep_id, m.source_id])));
  // History (never filtered): a merge stays listed even if a record has since
  // been deleted or merged again — the row explains why Undo is unavailable.
  const { data: pts } = await admin
    .from("patients")
    .select("id, drm_id, deleted_at, merged_into_id")
    .in("id", ids);
  const byId = new Map((pts ?? []).map((p) => [p.id, p]));
  const now = Date.now();
  const rows = data.map((m) => {
    const keep = byId.get(m.keep_id) ?? null;
    const source = byId.get(m.source_id) ?? null;
    const legacy = m.snapshot_version === null;
    const state = undoableState({ keepId: m.keep_id, legacy, mergedAt: m.merged_at, keep, source }, now);
    return {
      id: m.id,
      keep_id: m.keep_id,
      source_id: m.source_id,
      keep_drm_id: keep?.drm_id ?? null,
      source_drm_id: source?.drm_id ?? null,
      keep_deleted_at: keep?.deleted_at ?? null,
      keep_merged_into_id: keep?.merged_into_id ?? null,
      merged_at: m.merged_at,
      legacy,
      undoable: state.undoable,
      interrupted: state.interrupted,
      blocked_reason: state.reason,
    };
  });
  return { rows, total: count ?? rows.length, page: safePage };
}

export type UndoResult = { ok: true; lines: string[] } | { ok: false; error: string };

// One transaction in undo_patient_merge_guarded (0196): it refuses (P0079,
// in words for an admin) rather than half-undoing, keeps fields edited since
// the merge, moves back only what is still on the kept record, and completes
// an undo the pre-3b app left half-done.
export async function undoMergeAction(
  _prev: UndoResult | null,
  formData: FormData,
): Promise<UndoResult> {
  const session = await requireAdminStaff();
  const mergeId = z.string().uuid().safeParse(formData.get("merge_id"));
  if (!mergeId.success) return { ok: false, error: "Invalid merge id." };

  const { ip, ua } = await ipAndAgent();
  const admin = createAdminClient();
  const { data, error } = await withLifecycleRetry(() =>
    admin.rpc("undo_patient_merge_guarded", {
      p_merge_id: mergeId.data,
      p_actor: session.user_id,
      p_context: { ip, user_agent: ua },
    }),
  );
  if (error) return { ok: false, error: translatePgError(error) };
  const report = parseUndoRpcResult(data);
  if (!report) {
    await reportError({ scope: "undoMergeAction:result", error: new Error("unparseable undo report"), metadata: { merge_id: mergeId.data } });
    return { ok: false, error: "The merge was undone, but the report could not be read. Refresh the page." };
  }

  revalidatePath("/staff/admin/patient-merge");
  revalidatePath("/staff/admin/patient-merge/candidates");
  revalidatePath("/staff/patients");
  return { ok: true, lines: undoReportLines(report) };
}

// One-click merge from the candidates report (ids already known + admin-confirmed
// in the UI). keep_id is the OLDER record by default.
export async function mergeCandidateAction(
  _prev: MergeResult | null,
  formData: FormData,
): Promise<MergeResult> {
  const fd = new FormData();
  fd.set("keep_id", String(formData.get("keep_id") ?? ""));
  fd.set("source_id", String(formData.get("source_id") ?? ""));
  fd.set("confirm", "MERGE");
  fd.set("origin", "candidates");
  return mergePatientsAction(null, fd);
}

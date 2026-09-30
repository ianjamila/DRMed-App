"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { activePatients } from "@/lib/patients/active";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { runUndoSteps, undoMergeSteps } from "@/lib/patients/undo-merge-steps";
import {
  mergeMoveSteps,
  runMergeMoveSteps,
  rollbackMergeMoves,
  MERGE_MOVE_TABLES,
  type MergeMoveStep,
  type MergeMoveTable,
  type MergeRollbackFailure,
} from "@/lib/patients/merge-steps";
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";
import { chunkIds } from "@/lib/patients/require-active-core";
import { fetchCompleteRows } from "@/lib/reports/paging";
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

export type MergeResult =
  | {
      ok: true;
      kept_drm_id: string;
      merged_drm_id: string;
      moved: {
        visits: number;
        appointments: number;
        audit_log: number;
        critical_alerts: number;
        patient_consents: number;
        appointment_attachments: number;
      };
    }
  | { ok: false; error: string };

const LookupSchema = z.object({
  drm_id: z
    .string()
    .trim()
    .regex(/^DRM-\d{4,}$/i, "DRM-ID looks like DRM-0001."),
});

const MergeSchema = z.object({
  keep_id: z.string().uuid(),
  source_id: z.string().uuid(),
  confirm: z.literal("MERGE", { message: "Type MERGE to confirm." }),
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

// Ids per rollback chunk — same figure as require-active.ts's own CHUNK (a
// plain `.in()` with hundreds of values is both a PostgREST/Postgres risk
// and rides the GET query string uncapped). A single merge's row counts are
// ordinarily tiny, but this keeps the rollback safe if they aren't.
const MERGE_ROLLBACK_CHUNK = 200;

// Claws exact ids back from keep_id to source_id for one completed move
// step, called by runMergeMoveSteps only when a LATER step failed. Chunked,
// each chunk retried once on a lock race, with a fresh builder per attempt
// (same Prefer-header trap as the forward move). `.eq("patient_id", keepId)`
// is a safety predicate: only claw back rows still on the kept patient,
// never a row some unrelated concurrent write already moved elsewhere.
// audit_log.id is bigserial (number), not uuid — cast before `.in()`, same
// as undoMergeAction's own move-back case.
async function rollbackMergeMoveStep(
  admin: ReturnType<typeof createAdminClient>,
  step: MergeMoveStep,
  ids: unknown[],
  keepId: string,
  sourceId: string,
): Promise<{ error: { message: string } | null }> {
  const failures: string[] = [];
  // audit_log.id is bigserial (number), not uuid (string) like the other
  // five tables — normalise to string for chunking, same as the other
  // moves' ids, then cast back to Number for THIS table's `.in()`, same as
  // undoMergeAction's own move-back case.
  const idStrings = ids.map((id) => String(id));
  for (const idsChunk of chunkIds(idStrings, MERGE_ROLLBACK_CHUNK)) {
    const queryIds = step.table === "audit_log" ? idsChunk.map(Number) : idsChunk;
    const { error } = await withLifecycleRetry(() =>
      admin
        .from(step.table)
        .update({ patient_id: sourceId })
        .in("id", queryIds)
        .eq("patient_id", keepId),
    );
    if (error) failures.push(error.message);
  }
  return failures.length > 0 ? { error: { message: failures.join("; ") } } : { error: null };
}

// Reads every id currently on source_id for one FK table, BEFORE any move
// (0184 review follow-up, unknown-outcome case). Paged/complete — a batch
// could exceed PostgREST's 1000-row cap — with a total order (`id`) so
// `.range()` can't drop or repeat rows.
async function snapshotSourceIds(
  admin: ReturnType<typeof createAdminClient>,
  table: MergeMoveTable,
  sourceId: string,
): Promise<{ ids: unknown[]; error: string | null }> {
  const { data, error } = await fetchCompleteRows<{ id: unknown }, { message: string }>((from, to) =>
    admin
      .from(table)
      .select("id")
      .eq("patient_id", sourceId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) return { ids: [], error: error.message };
  return { ids: (data ?? []).map((r) => r.id), error: null };
}

// Reports a merge that stopped after the moves already succeeded (the fill
// or tombstone write failed) or during them (a move failed), and rolls back
// accordingly. `rolledBack`/`rollbackFailures` are the outcome of a
// rollbackMergeMoves call the caller already made (or, for a move failure,
// the one runMergeMoveSteps made internally) — this only turns that outcome
// into the audit trail + user-facing message, which is the same either way:
// full rollback success reads as "nothing changed, try again"; a rollback
// failure reports exactly which ids are stranded and refuses a re-run.
async function reportMergeStopped(
  rolledBack: boolean,
  rollbackFailures: MergeRollbackFailure[],
  scope: string,
  originalError: string,
  extraMetadata: Record<string, unknown>,
): Promise<MergeResult> {
  if (rolledBack) {
    await reportError({
      scope,
      error: new Error(originalError),
      metadata: { ...extraMetadata, rolled_back: true },
    });
    return {
      ok: false,
      error:
        "The merge couldn't finish because another change was being saved at the same moment. Nothing was changed — please try again.",
    };
  }
  // The rollback itself couldn't fully complete — some rows may now be on
  // the wrong patient. Report exactly which ones so this can be fixed by
  // hand, and refuse a re-run rather than risk compounding the mess.
  await reportError({
    scope: `${scope}:rollback`,
    error: new Error(originalError),
    metadata: {
      ...extraMetadata,
      rollback_failures: rollbackFailures.map((f) => ({ table: f.table, error: f.error })),
      stranded_ids: Object.fromEntries(rollbackFailures.map((f) => [f.table, f.ids])),
    },
  });
  return {
    ok: false,
    error:
      "The merge stopped part-way and some records could not be put back automatically. Don't run it again — the error has been reported for a manual fix.",
  };
}

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
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }
  const { keep_id, source_id } = parsed.data;
  if (keep_id === source_id) {
    return { ok: false, error: "Pick two different patients." };
  }

  const admin = createAdminClient();

  // Both rows must exist and not already be merged or deleted.
  const { data: rows } = await admin
    .from("patients")
    .select(
      "id, drm_id, first_name, last_name, middle_name, sex, phone, email, address, merged_into_id, deleted_at",
    )
    .in("id", [keep_id, source_id]);
  const keep = rows?.find((r) => r.id === keep_id);
  const source = rows?.find((r) => r.id === source_id);
  if (!keep || !source) {
    return { ok: false, error: "One of the patients was not found." };
  }
  if (keep.merged_into_id || source.merged_into_id) {
    return {
      ok: false,
      error: "One of the patients has already been merged. Refresh and try again.",
    };
  }
  if (keep.deleted_at || source.deleted_at) {
    return {
      ok: false,
      error: "One of the patients is deleted. Restore it from Admin Tools › Deleted Patients before merging.",
    };
  }

  // Snapshot every FK table's rows currently on source_id, BEFORE any move
  // (0184 review follow-up, unknown-outcome case): if a move's HTTP response
  // is lost after the UPDATE actually committed, PostgREST reports it as an
  // error with data: null — the row IS on keep_id, but a rollback keyed only
  // on the acknowledged `moved` ids would never learn that and would leave
  // it stranded. The snapshot gives the rollback something to fall back on:
  // union(snapshot, acknowledged ids), filtered to rows still on keep_id, is
  // exact either way and a no-op for anything that never moved.
  const snapshot = {} as Record<MergeMoveTable, unknown[]>;
  for (const table of MERGE_MOVE_TABLES) {
    const snap = await snapshotSourceIds(admin, table, source_id);
    if (snap.error) {
      return { ok: false, error: "Could not prepare the merge. Try again." };
    }
    snapshot[table] = snap.ids;
  }

  // Reassign FK rows source→keep (merge-steps.ts). Since 0184 every write to
  // a patient-owned table takes the patient lifecycle lock, so a move can
  // fail with 40P01 (a concurrent payment path can take the visit's shared
  // lock first), P0072 (the record moved mid-save) or 23514 (a critical
  // alert's patient must match its test's patient — it can only move back
  // once its visit already has). The runner stops at the FIRST move that
  // still fails; each move is retried once on a lock race, with a fresh
  // builder per attempt (re-awaiting one PostgREST builder with `.select()`
  // would re-append its Prefer header and send the mutation twice). Nothing
  // below this — filling fields, tombstoning the source, writing the undo
  // ledger — runs unless every move actually landed (0184 review finding
  // P1): a merge that stopped part-way used to tombstone the source anyway
  // and strand the rows that didn't move on a now-inactive patient.
  //
  // On a stop, the runner also rolls back every step it attempted — using
  // the snapshot above, not just the acknowledged `moved` ids (see
  // snapshotSourceIds' comment) — to source_id (0184 review follow-up): a
  // re-run is only a full recovery for rows that never moved at all —
  // patient_merges.moved is never written on a failed merge, so Undo has
  // nothing to restore, and without a rollback any row a completed step DID
  // move would be stranded on keep_id, invisible to Undo, and silently
  // under-reverted. Both patients are still active at this point, so the
  // guard allows moving rows back. If the rollback itself fully succeeds,
  // both records end up exactly as they were and the admin can just try
  // again. If the rollback can't complete either, some rows are left in an
  // inconsistent state and this needs a human to look at it — never
  // silently re-attempted.
  const moveOutcome = await runMergeMoveSteps(
    mergeMoveSteps(),
    snapshot,
    (step) =>
      withLifecycleRetry(() =>
        admin.from(step.table).update({ patient_id: keep_id }).eq("patient_id", source_id).select("id"),
      ),
    (step, ids) => rollbackMergeMoveStep(admin, step, ids, keep_id, source_id),
  );
  if (!moveOutcome.ok) {
    return reportMergeStopped(
      moveOutcome.rolledBack,
      moveOutcome.rollbackFailures,
      "mergePatientsAction:move",
      moveOutcome.error,
      { keep_id, source_id, failed_table: moveOutcome.failedAt.table, completed_moves: moveOutcome.completed },
    );
  }
  const {
    visits,
    appointments: appts,
    audit_log: auditRows,
    critical_alerts: criticalAlerts,
    patient_consents: consents,
    appointment_attachments: attachments,
  } = moveOutcome.moved;

  // Fill missing fields on the kept row from the source row — never
  // overwrite a non-null value. Checked the same way as a move above: on
  // failure, stop before tombstoning the source.
  const fill: {
    middle_name?: string;
    sex?: string;
    phone?: string;
    email?: string;
    address?: string;
  } = {};
  if (!keep.middle_name && source.middle_name) fill.middle_name = source.middle_name;
  if (!keep.sex && source.sex) fill.sex = source.sex;
  if (!keep.phone && source.phone) fill.phone = source.phone;
  if (!keep.email && source.email) fill.email = source.email;
  if (!keep.address && source.address) fill.address = source.address;
  if (Object.keys(fill).length > 0) {
    const { error: fillErr } = await withLifecycleRetry(() =>
      admin.from("patients").update(fill).eq("id", keep_id),
    );
    if (fillErr) {
      // The six moves already landed — a bare "run the merge again" would
      // write an EMPTY ledger on the re-run (the moves are no-ops the second
      // time, since the rows are already on keep_id) and Undo would then
      // have nothing to restore. Roll the six moves back first, same as a
      // move failure (0184 review follow-up).
      const { rolledBack, rollbackFailures } = await rollbackMergeMoves(
        mergeMoveSteps(),
        moveOutcome.moved,
        snapshot,
        (step, ids) => rollbackMergeMoveStep(admin, step, ids, keep_id, source_id),
      );
      return reportMergeStopped(rolledBack, rollbackFailures, "mergePatientsAction:fill", fillErr.message, {
        keep_id,
        source_id,
      });
    }
  }

  // Tombstone the source row.
  const mergedAt = new Date().toISOString();
  const { error: tombErr } = await admin
    .from("patients")
    .update({ merged_into_id: keep_id, merged_at: mergedAt })
    .eq("id", source_id);
  if (tombErr) {
    // Same reasoning as the fill-failure branch above: the six moves already
    // landed, so a bare retry would write an empty ledger. Roll them back
    // first (0184 review follow-up). This does NOT undo the `fill` update
    // above (if it ran) — that only copies previously-NULL fields from
    // source onto keep and is harmless to leave in place; the fields it
    // touched are re-derived the same way on any later merge attempt.
    const { rolledBack, rollbackFailures } = await rollbackMergeMoves(
      mergeMoveSteps(),
      moveOutcome.moved,
      snapshot,
      (step, ids) => rollbackMergeMoveStep(admin, step, ids, keep_id, source_id),
    );
    return reportMergeStopped(rolledBack, rollbackFailures, "mergePatientsAction:tombstone", tombErr.message, {
      keep_id,
      source_id,
    });
  }

  // Record the merge for reversibility (exact moved IDs + filled fields).
  const movedIds = {
    visits: (visits ?? []).map((r) => r.id),
    appointments: (appts ?? []).map((r) => r.id),
    audit_log: (auditRows ?? []).map((r) => r.id),
    critical_alerts: (criticalAlerts ?? []).map((r) => r.id),
    patient_consents: (consents ?? []).map((r) => r.id),
    appointment_attachments: (attachments ?? []).map((r) => r.id),
  };
  const { error: ledgerErr } = await admin.from("patient_merges").insert({
    keep_id,
    source_id,
    merged_by: session.user_id,
    moved: movedIds,
    filled_from_source: Object.keys(fill),
  });
  if (ledgerErr) {
    // The merge itself succeeded (rows moved + source tombstoned) — unlike
    // the fill/tombstone failure branches above, there is nothing left to
    // roll back here; the tombstone already committed, so this IS the
    // completed merge. If the undo ledger row failed to write, the merge is
    // NOT reversible — surface it to Sentry rather than silently presenting
    // it as undoable (0184 review follow-up: pre-existing, unchanged).
    await reportError({
      scope: "mergePatientsAction:ledger",
      error: ledgerErr,
      metadata: { keep_id, source_id },
    });
  }

  // M2: let the kept patient know their records were combined, so they use the
  // right DRM-ID going forward. The email uses the kept row's address (either
  // its own or the one just filled in from the source). It never mentions the
  // retired DRM-ID or any PIN — the current PIN lives on the patient's most
  // recent receipt.
  // Fresh read (0167): the kept record must still be active right before the
  // send, and its on-file email (already carrying whatever `fill` copied over
  // above) is the address of record — never the earlier `keep`/`fill` values.
  const recipient = await checkPatientRecipient(admin, keep_id);
  if (recipient.kind === "inactive") {
    await auditSkippedInactiveRecipient({
      sender: "patient-merge",
      patientId: keep_id,
      reason: recipient.reason,
      resourceType: "patient",
      resourceId: keep_id,
    });
  }
  const keptEmail = recipient.kind === "active" ? (recipient.patient.email ?? fill.email ?? null) : null;
  const mergeEmail = keptEmail
    ? await sendEmail({
        to: keptEmail,
        subject: "Your DRMed records were combined",
        text: `Hi ${keep.first_name},\n\nWe combined two DRMed records that belonged to you into one. From now on, use this DRM-ID: ${keep.drm_id}, together with the Secure PIN printed on your most recent receipt, to view your results online.\n\n— DRMed Clinic and Laboratory`,
        html: renderEmailShell({
          heading: "Your DRMed patient ID",
          contentHtml:
            emailParagraph(`Hi <b>${escapeHtml(keep.first_name)}</b>,`) +
            emailParagraph(
              "We combined two DRMed records that belonged to you into one. From now on, use this patient ID:",
            ) +
            emailHighlight("Your DRM-ID", keep.drm_id) +
            emailParagraph(
              "Sign in with the Secure PIN printed on your most recent receipt to view your results online.",
            ),
        }),
      })
    : null;

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: keep_id,
    action: "patient.merged",
    resource_type: "patient",
    resource_id: keep_id,
    metadata: {
      kept_drm_id: keep.drm_id,
      merged_drm_id: source.drm_id,
      merged_patient_id: source_id,
      moved: {
        visits: visits?.length ?? 0,
        appointments: appts?.length ?? 0,
        audit_log: auditRows?.length ?? 0,
        critical_alerts: criticalAlerts?.length ?? 0,
        patient_consents: consents?.length ?? 0,
        appointment_attachments: attachments?.length ?? 0,
      },
      filled_from_source: Object.keys(fill),
      notification: {
        recipient: recipient.kind,
        email: !mergeEmail
          ? { ok: false, skipped: true, reason: "no on-file email" }
          : mergeEmail.ok
            ? { ok: true, id: mergeEmail.id, to: keptEmail }
            : mergeEmail.kind === "skipped"
              ? { ok: false, skipped: true, reason: mergeEmail.reason }
              : { ok: false, error: mergeEmail.error, to: keptEmail },
      },
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/patient-merge");
  revalidatePath("/staff/patients");

  return {
    ok: true,
    kept_drm_id: keep.drm_id,
    merged_drm_id: source.drm_id,
    moved: {
      visits: visits?.length ?? 0,
      appointments: appts?.length ?? 0,
      audit_log: auditRows?.length ?? 0,
      critical_alerts: criticalAlerts?.length ?? 0,
      patient_consents: consents?.length ?? 0,
      appointment_attachments: attachments?.length ?? 0,
    },
  };
}

const MERGE_UNDO_WINDOW_DAYS = 30;

export interface RecentMerge {
  id: string;
  keep_id: string;
  source_id: string;
  keep_drm_id: string | null;
  source_drm_id: string | null;
  // Set when the kept record has since been deleted (Task 26 shows the badge).
  keep_deleted_at: string | null;
  merged_at: string;
  undoable: boolean;
}

export async function loadRecentMerges(): Promise<RecentMerge[]> {
  await requireAdminStaff();
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - MERGE_UNDO_WINDOW_DAYS * 86400_000).toISOString();
  const { data } = await admin
    .from("patient_merges")
    .select("id, keep_id, source_id, merged_at, undone_at")
    .is("undone_at", null)
    .gte("merged_at", cutoff)
    .order("merged_at", { ascending: false })
    .limit(50);
  if (!data) return [];
  const ids = Array.from(new Set(data.flatMap((m) => [m.keep_id, m.source_id])));
  // History (never filtered): a merge stays listed even if the kept record has
  // since been deleted. deleted_at/merged_into_id ride along so the list can
  // show an InactivePatientBadge next to it.
  const { data: pts } = await admin
    .from("patients")
    .select("id, drm_id, deleted_at, merged_into_id")
    .in("id", ids);
  const byId = new Map((pts ?? []).map((p) => [p.id, p]));
  return data.map((m) => {
    const keep = byId.get(m.keep_id);
    const source = byId.get(m.source_id);
    return {
      id: m.id,
      keep_id: m.keep_id,
      source_id: m.source_id,
      keep_drm_id: keep?.drm_id ?? null,
      source_drm_id: source?.drm_id ?? null,
      keep_deleted_at: keep?.deleted_at ?? null,
      merged_at: m.merged_at,
      undoable: true,
    };
  });
}

export type UndoResult = { ok: true } | { ok: false; error: string };

export async function undoMergeAction(
  _prev: UndoResult | null,
  formData: FormData,
): Promise<UndoResult> {
  const session = await requireAdminStaff();
  const mergeId = z.string().uuid().safeParse(formData.get("merge_id"));
  if (!mergeId.success) return { ok: false, error: "Invalid merge id." };

  const admin = createAdminClient();
  const { data: m } = await admin
    .from("patient_merges")
    .select("id, keep_id, source_id, merged_at, moved, filled_from_source, undone_at")
    .eq("id", mergeId.data)
    .maybeSingle();
  if (!m) return { ok: false, error: "Merge record not found." };
  if (m.undone_at) return { ok: false, error: "This merge was already undone." };

  const ageDays = (Date.now() - new Date(m.merged_at).getTime()) / 86400_000;
  if (ageDays > MERGE_UNDO_WINDOW_DAYS) {
    return { ok: false, error: `Merges can only be undone within ${MERGE_UNDO_WINDOW_DAYS} days.` };
  }

  // Guard against a cascaded merge: if the kept record has itself since been
  // merged into a third patient, re-pointing rows back to the source would
  // leave them attached to a now-tombstoned record. Refuse rather than corrupt.
  const { data: keepRow } = await admin
    .from("patients")
    .select("merged_into_id, deleted_at")
    .eq("id", m.keep_id)
    .maybeSingle();
  if (keepRow?.merged_into_id) {
    return {
      ok: false,
      error: "Can't undo: the kept patient has since been merged into another record. Resolve that merge first.",
    };
  }
  if (keepRow?.deleted_at) {
    return { ok: false, error: "Can't undo: the kept patient has since been deleted. Restore it first." };
  }

  // Same check on the source side — impossible today (0167's
  // patients_not_deleted_and_merged check keeps a merged row from also being
  // deleted), but cheap insurance against restoring rows onto a deleted target.
  const { data: sourceRow } = await admin
    .from("patients")
    .select("deleted_at, merged_into_id")
    .eq("id", m.source_id)
    .maybeSingle();
  if (sourceRow?.deleted_at) {
    return { ok: false, error: "Can't undo: the source patient has since been deleted. Restore it first." };
  }

  const moved = (m.moved ?? {}) as Record<string, (string | number)[]>;

  // Null out exactly the fields the merge filled (merge only fills NULL keep
  // fields, and only from this known set). Typed to those columns. Computed
  // BEFORE the step runner so the "clear_filled_fields" step below can use it.
  const filled = (m.filled_from_source ?? []) as string[];
  const clear: Partial<Record<"middle_name" | "sex" | "phone" | "email" | "address", null>> = {};
  for (const f of filled) {
    if (f === "middle_name" || f === "sex" || f === "phone" || f === "email" || f === "address") {
      clear[f] = null;
    }
  }

  // 0184: the lifecycle guard refuses moving any row onto a still-merged
  // (inactive) source patient, so the source's merge marker must be cleared
  // FIRST — before any row moves back. runUndoSteps stops at the first
  // failed step (the ledger is left NOT undone) and every step is
  // idempotent, so re-running Undo after a partial failure is safe.
  const outcome = await runUndoSteps(undoMergeSteps(), async (step) => {
    switch (step.kind) {
      case "clear_source_marker":
        return admin.from("patients").update({ merged_into_id: null, merged_at: null }).eq("id", m.source_id);
      case "move_back": {
        const ids = moved[step.table] ?? [];
        if (ids.length === 0) return { error: null };
        // audit_log.id is bigserial (number), not uuid — cast from the JSON string values.
        return step.table === "audit_log"
          ? admin.from("audit_log").update({ patient_id: m.source_id }).in("id", ids.map(Number))
          : admin.from(step.table).update({ patient_id: m.source_id }).in("id", ids as string[]);
      }
      case "clear_filled_fields":
        return Object.keys(clear).length === 0
          ? { error: null }
          : admin.from("patients").update(clear).eq("id", m.keep_id);
      case "mark_ledger_undone":
        return admin
          .from("patient_merges")
          .update({ undone_at: new Date().toISOString(), undone_by: session.user_id })
          .eq("id", m.id);
    }
  });
  if (!outcome.ok) {
    await reportError({
      scope: "undoMergeAction",
      error: new Error(outcome.error),
      metadata: { merge_id: m.id, failed_at: outcome.failedAt, completed_steps: outcome.completed },
    });
    return {
      ok: false,
      error: `Undo stopped part-way (step ${outcome.completed + 1}: ${outcome.error}). Nothing is marked undone — run Undo again; steps already done are safe to repeat.`,
    };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: m.keep_id,
    action: "patient.merge.undone",
    resource_type: "patient",
    resource_id: m.source_id,
    metadata: { merge_id: m.id, keep_id: m.keep_id, source_id: m.source_id, restored: moved, cleared_fields: filled },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/patient-merge");
  revalidatePath("/staff/admin/patient-merge/candidates");
  revalidatePath("/staff/patients");
  return { ok: true };
}

// One-click merge from the candidates report (ids already known + admin-confirmed
// in the UI). Reuses the audited merge path; keep_id is the OLDER record by default.
export async function mergeCandidateAction(
  _prev: MergeResult | null,
  formData: FormData,
): Promise<MergeResult> {
  const fd = new FormData();
  fd.set("keep_id", String(formData.get("keep_id") ?? ""));
  fd.set("source_id", String(formData.get("source_id") ?? ""));
  fd.set("confirm", "MERGE");
  const res = await mergePatientsAction(null, fd);
  if (res.ok) revalidatePath("/staff/admin/patient-merge/candidates");
  return res;
}

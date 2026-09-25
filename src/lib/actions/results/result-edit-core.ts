import "server-only";

import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { audit } from "@/lib/audit/log";
import type { Json } from "@/types/database";
import { classifyCommitError, editVersionPath, versionBase } from "@/lib/results/result-edit";
import type { AlertRow, ValueRow } from "@/lib/results/value-rows";

// The commit protocol for a structured result's PDF (migration 0172). Every
// finalise and every edit of a result:
//   1. uploads its objects under a path unique to THIS attempt (upsert off),
//      so a retry can never overwrite an object a committed row points at;
//   2. calls one RPC that writes values, PDF pointer, image and alerts in a
//      single transaction under the result's row lock;
//   3. on a DEFINITE rejection (the database answered with an error code —
//      nothing committed) removes exactly this attempt's objects; on an
//      UNKNOWN outcome (no answer: fetch failure, timeout) asks the database
//      whether this attempt committed, and if it cannot tell, KEEPS the
//      objects — an orphan is harmless, deleting a committed PDF is not.
// Nothing is ever removed after a confirmed commit.

type Admin = ReturnType<typeof createAdminClient>;

export const UNCONFIRMED_SAVE_ERROR =
  "Your change was sent, but the save could not be confirmed. Reload the page to check whether it went through before trying again.";

export interface PendingObject {
  bucket: "results" | "result-images";
  path: string;
  body: Buffer | Uint8Array;
  contentType: string;
}

export interface NewImage {
  body: Buffer;
  mime: string;
  filename: string;
  size: number;
  ext: string;
}

type RpcOutcome<T> = { data: T | null; error: { code?: string | null; message: string } | null };

type CommitOutcome<T> =
  | { status: "committed"; data: T | null }
  | { status: "failed"; error: string };

async function removeObjects(admin: Admin, objects: readonly PendingObject[]) {
  for (const bucket of ["results", "result-images"] as const) {
    const paths = objects.filter((o) => o.bucket === bucket).map((o) => o.path);
    if (paths.length > 0) await admin.storage.from(bucket).remove(paths);
  }
}

/**
 * Upload → RPC → classify. `probe` asks the database whether THIS attempt
 * committed: true / false, or null when it cannot tell either.
 */
async function commitWithUploads<T>(
  admin: Admin,
  uploads: readonly PendingObject[],
  call: () => PromiseLike<RpcOutcome<T>>,
  probe: () => Promise<boolean | null>,
): Promise<CommitOutcome<T>> {
  const uploaded: PendingObject[] = [];
  for (const o of uploads) {
    const { error } = await admin.storage
      .from(o.bucket)
      .upload(o.path, o.body, { contentType: o.contentType, upsert: false });
    if (error) {
      // Nothing points at any of this attempt's objects yet.
      await removeObjects(admin, uploaded);
      return {
        status: "failed",
        error: `${o.bucket === "results" ? "PDF" : "Image"} upload failed: ${error.message}`,
      };
    }
    uploaded.push(o);
  }

  let outcome: RpcOutcome<T>;
  try {
    outcome = await call();
  } catch (e) {
    outcome = { data: null, error: { code: null, message: e instanceof Error ? e.message : String(e) } };
  }
  if (!outcome.error) return { status: "committed", data: outcome.data };

  // [R1] Even a definite rejection is double-checked before anything is
  // removed: a rejection of THIS call must never delete the objects of an
  // attempt that did commit (an overlapping replay of the same attempt).
  let committed: boolean | null;
  try {
    committed = await probe();
  } catch {
    committed = null;
  }
  if (committed === true) return { status: "committed", data: null };

  const rejected = classifyCommitError(outcome.error) === "rejected";
  const message = translatePgError({
    code: outcome.error.code ?? undefined,
    message: outcome.error.message,
  });
  if (rejected && committed === false) {
    await removeObjects(admin, uploaded);
    return { status: "failed", error: message };
  }
  if (rejected) {
    // Rejected, but the probe could not run: keep the objects.
    return { status: "failed", error: message };
  }
  return { status: "failed", error: UNCONFIRMED_SAVE_ERROR };
}

// ---------------------------------------------------------------------------
// Edit of a finished result
// ---------------------------------------------------------------------------

export interface CommitResultEditArgs {
  resultId: string;
  /** results.amendment_count the editor's form was opened on. */
  expectedAmendmentCount: number;
  /** results.storage_path the form was opened on (names the new object). */
  currentStoragePath: string;
  editorId: string;
  reason: string;
  /** A live test on this result; the amendment row is filed under it. */
  anchorTestRequestId: string;
  pdf: Buffer;
  /** null = PDF-only edit (an uploaded send-out PDF): values untouched. */
  values: ValueRow[] | null;
  /** null = keep the image; only the imaging single-test path passes one. */
  newImage: (NewImage & { currentImagePath: string | null; fallbackBase: string }) | null;
  /** null = leave critical alerts alone (PDF-only edit). */
  alerts: AlertRow[] | null;
}

export interface CommitResultEditData {
  replayed: boolean;
  amendmentSeq: number;
  priorStoragePath: string;
  newStoragePath: string;
  newImagePath: string | null;
  alertsAdded: Array<Pick<AlertRow, "parameter_name" | "direction" | "observed_value_si" | "threshold_si">>;
  alertsRemoved: number;
  alertsKeptAcknowledged: number;
}

export async function commitResultEdit(
  args: CommitResultEditArgs,
): Promise<{ ok: true; data: CommitResultEditData } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const attemptId = randomUUID();
  const nextVersion = args.expectedAmendmentCount + 2; // v1 is the original

  const newStoragePath = editVersionPath(
    versionBase(args.currentStoragePath),
    nextVersion,
    attemptId,
  );
  const uploads: PendingObject[] = [];
  let newImagePath: string | null = null;
  if (args.newImage) {
    const base = args.newImage.currentImagePath
      ? versionBase(args.newImage.currentImagePath)
      : args.newImage.fallbackBase;
    newImagePath = editVersionPath(base, nextVersion, attemptId, args.newImage.ext);
    uploads.push({
      bucket: "result-images",
      path: newImagePath,
      body: args.newImage.body,
      contentType: args.newImage.mime,
    });
  }
  uploads.push({ bucket: "results", path: newStoragePath, body: args.pdf, contentType: "application/pdf" });

  // What the committed attempt did to critical alerts, as recorded on its
  // amendment row (0176) — read by the probe when the RPC's answer was lost.
  let probedOutcome: Json | null = null;
  const outcome = await commitWithUploads<Json>(
    admin,
    uploads,
    () =>
      admin.rpc("result_edit_commit", {
        p_attempt_id: attemptId,
        p_result_id: args.resultId,
        p_expected_amendment_count: args.expectedAmendmentCount,
        p_editor: args.editorId,
        p_reason: args.reason,
        p_anchor_test_request_id: args.anchorTestRequestId,
        p_new_storage_path: newStoragePath,
        p_new_file_size_bytes: args.pdf.byteLength,
        p_values: args.values as unknown as Json,
        p_new_image: args.newImage
          ? ({
              storage_path: newImagePath,
              filename: args.newImage.filename,
              mime_type: args.newImage.mime,
              size_bytes: args.newImage.size,
            } as Json)
          : (null as unknown as Json),
        p_alerts: args.alerts as unknown as Json,
      }),
    async () => {
      const { data, error } = await admin
        .from("result_amendments")
        .select("id, commit_outcome")
        .eq("attempt_id", attemptId)
        .maybeSingle();
      if (error) return null;
      if (data) probedOutcome = data.commit_outcome;
      return data != null;
    },
  );
  if (outcome.status === "failed") return { ok: false, error: outcome.error };

  const d = (outcome.data ?? probedOutcome ?? {}) as {
    replayed?: boolean;
    outcome_unknown?: boolean;
    amendment_seq?: number;
    prior_storage_path?: string;
    alerts_added?: CommitResultEditData["alertsAdded"];
    alerts_removed?: number;
    alerts_kept_acknowledged?: number;
  };
  // Confirmed by the probe or by the RPC's replay branch: the response was
  // lost. Since 0176 the commit records what it did to critical alerts on its
  // amendment row and both paths hand that back, so the audit rows below are
  // exact. Only when no record exists (an edit from before 0176, or a
  // concurrent probe that raced the row) fall back to the alerts this attempt
  // SENT (a superset) rather than none — flagged, so the critical-value audit
  // row is never silently skipped.
  const replayed = d.replayed ?? outcome.data == null;
  const recorded = d.alerts_added !== undefined && !d.outcome_unknown;
  return {
    ok: true,
    data: {
      replayed,
      amendmentSeq: d.amendment_seq ?? args.expectedAmendmentCount + 1,
      priorStoragePath: d.prior_storage_path ?? args.currentStoragePath,
      newStoragePath,
      newImagePath,
      alertsAdded: replayed && !recorded ? (args.alerts ?? []) : (d.alerts_added ?? []),
      alertsRemoved: d.alerts_removed ?? 0,
      alertsKeptAcknowledged: d.alerts_kept_acknowledged ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// First finalise of a structured result
// ---------------------------------------------------------------------------

export interface CommitResultFinaliseArgs {
  resultId: string;
  finaliserId: string;
  /** Object path WITHOUT extension, e.g. `<resultId>` or `<patient>/<visit>/<tr>`. */
  base: string;
  pdf: Buffer;
  /** The instant printed on the PDF; becomes results.finalised_at. */
  finalisedAt: Date;
  /** The COMPLETE value set the PDF was rendered from. */
  values: ValueRow[];
  image: NewImage | null;
  alerts: AlertRow[];
}

export interface CommitResultFinaliseData {
  storagePath: string;
  imagePath: string | null;
  alertsAdded: Array<Pick<AlertRow, "parameter_name" | "direction" | "observed_value_si" | "threshold_si">>;
}

export async function commitResultFinalise(
  args: CommitResultFinaliseArgs,
): Promise<{ ok: true; data: CommitResultFinaliseData } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const attemptId = randomUUID();
  const storagePath = editVersionPath(args.base, 1, attemptId);
  const imagePath = args.image ? editVersionPath(args.base, 1, attemptId, args.image.ext) : null;

  const uploads: PendingObject[] = [];
  if (args.image && imagePath) {
    uploads.push({ bucket: "result-images", path: imagePath, body: args.image.body, contentType: args.image.mime });
  }
  uploads.push({ bucket: "results", path: storagePath, body: args.pdf, contentType: "application/pdf" });

  const outcome = await commitWithUploads<Json>(
    admin,
    uploads,
    () =>
      admin.rpc("result_finalise_commit", {
        p_result_id: args.resultId,
        p_finaliser: args.finaliserId,
        p_values: args.values as unknown as Json,
        p_storage_path: storagePath,
        p_file_size_bytes: args.pdf.byteLength,
        p_finalised_at: args.finalisedAt.toISOString(),
        p_new_image:
          args.image && imagePath
            ? ({
                storage_path: imagePath,
                filename: args.image.filename,
                mime_type: args.image.mime,
                size_bytes: args.image.size,
              } as Json)
            : (null as unknown as Json),
        p_alerts: args.alerts as unknown as Json,
      }),
    async () => {
      // This attempt's object path is unique, so "the row points at it"
      // is exactly "this attempt committed".
      const { data, error } = await admin
        .from("results")
        .select("storage_path")
        .eq("id", args.resultId)
        .maybeSingle();
      if (error || !data) return null;
      return data.storage_path === storagePath;
    },
  );
  if (outcome.status === "failed") return { ok: false, error: outcome.error };

  // Probe-confirmed (response lost): a finalise inserts every alert it sent
  // (none can exist before a result's first finalise), so they are exact.
  const d = (outcome.data ?? {}) as { alerts_added?: CommitResultFinaliseData["alertsAdded"] };
  return {
    ok: true,
    data: {
      storagePath,
      imagePath,
      alertsAdded: outcome.data == null ? args.alerts : (d.alerts_added ?? []),
    },
  };
}

// ---------------------------------------------------------------------------
// Audit rows for what an edit did to critical alerts
// ---------------------------------------------------------------------------

export async function auditAlertChanges(
  data: Pick<
    CommitResultEditData,
    "alertsAdded" | "alertsRemoved" | "alertsKeptAcknowledged" | "replayed"
  >,
  ctx: {
    actorId: string;
    patientId: string;
    resultId: string;
    testRequestIds: string[];
    ip: string | null;
    ua: string | null;
  },
): Promise<void> {
  if (data.alertsAdded.length > 0) {
    await audit({
      actor_id: ctx.actorId,
      actor_type: "staff",
      patient_id: ctx.patientId,
      action: "result.critical_value_detected",
      resource_type: "result",
      resource_id: ctx.resultId,
      metadata: {
        test_request_ids: ctx.testRequestIds,
        source: "edit",
        // true = the commit was confirmed after its response was lost; the
        // list is what this edit sent, not necessarily what was new.
        outcome_replayed: data.replayed,
        alerts: data.alertsAdded.map((a) => ({
          parameter: a.parameter_name,
          direction: a.direction,
          observed: a.observed_value_si,
          threshold: a.threshold_si,
        })),
      },
      ip_address: ctx.ip,
      user_agent: ctx.ua,
    });
  }
  if (data.alertsRemoved > 0) {
    await audit({
      actor_id: ctx.actorId,
      actor_type: "staff",
      patient_id: ctx.patientId,
      action: "result.critical_alert_withdrawn",
      resource_type: "result",
      resource_id: ctx.resultId,
      metadata: {
        test_request_ids: ctx.testRequestIds,
        withdrawn_count: data.alertsRemoved,
        kept_acknowledged_count: data.alertsKeptAcknowledged,
      },
      ip_address: ctx.ip,
      user_agent: ctx.ua,
    });
  }
}

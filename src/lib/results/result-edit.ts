/**
 * Pure helpers for editing a FINISHED result (migration 0172,
 * `result_edit_commit`). No I/O here — the server core that uploads and calls
 * the RPC is `src/lib/actions/results/result-edit-core.ts`.
 */

/** Test statuses past the bench: a result exists and is on file. */
export const EDITABLE_STATUSES = ["result_uploaded", "ready_for_release", "released"] as const;

export function isEditableStatus(status: string): boolean {
  return (EDITABLE_STATUSES as readonly string[]).includes(status);
}

export const REASON_MIN = 5;
export const REASON_MAX = 2000;

/** Same bounds and wording as the single-test amend flow; the RPC re-checks. */
export function validateEditReason(
  raw: unknown,
): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < REASON_MIN) {
    return { ok: false, error: "Please describe the reason for the edit (5+ characters)." };
  }
  if (reason.length > REASON_MAX) {
    return { ok: false, error: "Reason is too long (2000 characters max)." };
  }
  return { ok: true, reason };
}

/**
 * Storage object for one edit ATTEMPT of a result. `base` is the current
 * object path without its `.pdf` / versioned tail; `nextVersion` is the
 * version number the edit will become (amendment_count + 2 — v1 is the
 * original). The attempt token makes every attempt's object unique, so a
 * crashed attempt's leftover can never block the next save (uploads use
 * `upsert: false`), and a rollback can only ever remove its own object.
 */
export function editVersionPath(
  base: string,
  nextVersion: number,
  attemptId: string,
  ext = "pdf",
): string {
  const token = attemptId.replace(/-/g, "").slice(0, 8);
  return `${base}.v${nextVersion}.${token}.${ext}`;
}

/** Strip the extension and any `.vN` / `.vN.token` tail from a stored path. */
export function versionBase(storagePath: string): string {
  return storagePath
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/\.v\d+(\.[0-9a-f]{8})?$/i, "");
}

/**
 * Did the RPC certainly NOT commit? PostgREST reports a database error with
 * its SQLSTATE (5 characters, e.g. P0065, 23505) and its own failures with a
 * `PGRST…` code — either way the transaction was rolled back or never ran, so
 * this attempt's uploaded objects can be removed. A thrown fetch / timeout /
 * missing code is UNKNOWN: the transaction may have committed, and deleting
 * the object a committed row points at would break the report.
 */
export function classifyCommitError(
  err: { code?: string | null } | null | undefined,
): "rejected" | "unknown" {
  const code = err?.code ?? "";
  if (/^[0-9A-Z]{5}$/.test(code) || /^PGRST\d+$/.test(code)) return "rejected";
  return "unknown";
}

export interface ComparableValue {
  numeric_value_si: number | null;
  numeric_value_conv: number | null;
  text_value: string | null;
  select_value: string | null;
  is_blank: boolean;
}

/**
 * How many parameters an edit changed: added, removed, or with any field
 * different. For the audit row only.
 */
export function countValueChanges(
  prior: ReadonlyMap<string, ComparableValue>,
  next: ReadonlyMap<string, ComparableValue>,
): number {
  let n = 0;
  for (const [id, v] of next) {
    const before = prior.get(id);
    if (
      !before ||
      before.numeric_value_si !== v.numeric_value_si ||
      before.numeric_value_conv !== v.numeric_value_conv ||
      before.text_value !== v.text_value ||
      before.select_value !== v.select_value ||
      before.is_blank !== v.is_blank
    ) {
      n += 1;
    }
  }
  for (const id of prior.keys()) if (!next.has(id)) n += 1;
  return n;
}

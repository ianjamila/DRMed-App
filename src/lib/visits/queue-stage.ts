/**
 * Reception visit-queue stage logic.
 *
 * The /staff/visits/queue page sorts each of today's visits into one of three
 * stages. The rules live here as pure functions (no `server-only`, no DB) so
 * they are unit-tested and reusable:
 *
 *   - waiting    — payment_status is unpaid or partial. Money comes first.
 *   - processing — paid/waived AND at least one lab/imaging test_request is
 *                  still outstanding (not released/cancelled).
 *   - completed  — paid/waived AND nothing lab/imaging is outstanding. Consult-
 *                  only visits land here once paid: on main there's no consult
 *                  "done" signal, so there's nothing left to wait on.
 */

// Sections a lab/imaging worker acts on in the queue — the union of medtech's
// bench and the imaging tech's modalities (mirrors sectionsForRole). Anything
// else (consultation, procedure, vaccine, home_service, unsectioned) needs no
// lab worklist step and so never holds a visit in "processing".
export const LAB_IMAGING_SECTIONS: ReadonlySet<string> = new Set([
  "chemistry",
  "hematology",
  "immunology",
  "urinalysis",
  "microbiology",
  "send_out",
  "imaging_xray",
  "imaging_ultrasound",
  "imaging_ecg",
]);

// A test_request is terminal once it's released or cancelled — no further
// lab/imaging work is owed for it.
const TERMINAL_TEST_STATUSES: ReadonlySet<string> = new Set([
  "released",
  "cancelled",
]);

export type QueueStage = "waiting" | "processing" | "completed";

// Minimal shape the stage logic needs from a test_request. Callers flatten the
// services join into `section`/`name` before handing rows over, keeping this
// module decoupled from Supabase's object|array row typing.
export interface QueueTestLike {
  status: string;
  is_package_header: boolean;
  section: string | null;
  name?: string | null;
}

// A leaf (non-package-header) lab/imaging test that hasn't reached a terminal
// status. Package headers are skipped — their components carry the real section
// and are counted individually, exactly like the medtech queue.
export function isOutstandingLabImaging(t: QueueTestLike): boolean {
  if (t.is_package_header) return false;
  if (TERMINAL_TEST_STATUSES.has(t.status)) return false;
  return t.section != null && LAB_IMAGING_SECTIONS.has(t.section);
}

export function visitStage(
  paymentStatus: string,
  tests: readonly QueueTestLike[],
): QueueStage {
  const paid = paymentStatus === "paid" || paymentStatus === "waived";
  if (!paid) return "waiting";
  return tests.some(isOutstandingLabImaging) ? "processing" : "completed";
}

// Names of the lab/imaging tests still outstanding on a visit — used to tell
// reception what a Processing patient is still waiting on.
export function outstandingLabImagingNames(
  tests: readonly QueueTestLike[],
): string[] {
  return tests
    .filter(isOutstandingLabImaging)
    .map((t) => t.name ?? "—");
}

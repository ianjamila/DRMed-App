/**
 * Query-surface coverage for `visits` and `test_requests`.
 *
 * One AST pass over `src/`, two independent classification maps:
 *
 *   SURFACES   — does this `test_requests` read mean LAB work, or the whole
 *                bill? (#160, #162, #163)
 *   LIFECYCLES — does this `visits` / `test_requests` read mean LIVE rows, or
 *                does it span soft-deleted ones? (0125)
 *
 * They are separate questions about the same queries, which is why they share
 * a scanner and nothing else. The lab half is documented immediately below;
 * the soft-delete half above its own map, further down.
 *
 * (The filename is historical — the lab half came first.)
 *
 * WHY THIS EXISTS
 * ---------------
 * `test_requests` doubles as the visit's BILL LINE. A doctor consultation and
 * a CBC are both rows in it, told apart only by the joined `services.kind`
 * (0090). That one design decision has now produced the SAME bug three times:
 *
 *   #160  the results archive and the patient portal listed consultations as
 *         lab results awaiting collection
 *   #162  Lab TAT measured 7,399 consultations as ~0-hour "turnarounds",
 *         dragging the clinic's mean from 0.1197h to 0.0851h, and Stuck Tests
 *         named a consultation nobody could ever finish as its only row
 *
 * Each fix was correct and each was invisible to the next author, because
 * nothing in the code says which surfaces MEAN "lab". This test says it.
 *
 * WHAT IT ENFORCES
 * ----------------
 *   1. CLASSIFICATION — every file that READS `test_requests` appears in
 *      `SURFACES` below, tagged `lab` or `all` with a reason. A new file that
 *      reads the table and classifies itself as neither fails. This is the
 *      property that actually catches the next instance: you cannot add a lab
 *      surface without being asked, in code review, which kind it is.
 *
 *   2. COVERAGE — every read chain in a `lab` file carries the doctor-kind
 *      exclusion (`DOCTOR_KINDS_PG_LIST`, `DOCTOR_KIND_VALUES`, or
 *      `classifyKind` for a JS-side split).
 *
 *   3. NO OVER-FILTERING — no chain in an `all` file carries it. Dropping
 *      doctor lines from a receipt, a bill, an accounting sync or a deletion
 *      ledger is the same bug pointed the other way, and it loses money
 *      rather than merely miscounting.
 *
 *   4. THE EMBED IS AN INNER JOIN — a chain that filters on `services.kind`
 *      must select `services!inner`. This one is a genuine footgun: PostgREST
 *      silently IGNORES a filter on an embedded resource that was joined with
 *      a LEFT join, so `.not("services.kind", ...)` against a plain
 *      `services ( … )` embed compiles, runs, returns the unfiltered rows, and
 *      looks exactly like a working fix.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * Writes (`insert`/`update`/`delete`/`upsert`) are detected and skipped — they
 * address rows by id, not by meaning.
 *
 * It only sees `.from("visits")` / `.from("test_requests")` in TypeScript. It
 * does NOT see the SQL VIEWS that read those tables server-side — as of 0144
 * ten of them do (`v_hmo_unbilled`, `v_hmo_stuck`, `v_hmo_ar_aging`,
 * `v_hmo_provider_summary`, `v_daily_revenue_by_service`, and five
 * `v_ops_daily_*`), and none carries a `deleted_at` predicate. Some do not
 * need one (the ops views key off `payments`, and a deleted visit can hold
 * none — P0045), but `v_hmo_unbilled` is the picklist the HMO claim batch is
 * built from, so it can still offer a deleted line for billing. Closing that
 * needs a migration, not a filter here. Do not read a green run as covering
 * them.
 *
 * Granularity is per CHAIN, falling back to the enclosing function when a
 * chain is built across statements (`let q = …; if (x) q = q.eq(…)`), which
 * several report loaders do. So a `lab` file whose filter sits in a sibling
 * statement of the same function passes. That is deliberate: the alternative
 * is false failures on correct code, and the classification check above is
 * what carries the real weight.
 *
 * FIXING A FAILURE
 * ----------------
 * Decide what the surface MEANS to the person reading it:
 *
 *   - It shows/counts/measures LAB work → add `DOCTOR_KINDS_PG_LIST`:
 *
 *       import { DOCTOR_KINDS_PG_LIST } from "@/lib/visits/classification";
 *       .select("…, services!inner ( kind, section )")   // !inner is required
 *       .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
 *
 *   - It means EVERY bill line on the visit (money, receipts, audit,
 *     deletion, the patient's own itemised visit) → add the file to
 *     `SURFACES` as `all` with a one-line reason. Do not add the filter.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const SRC_DIR = join(process.cwd(), "src");

/** The two soft-deletable tables (0125). Both are scanned in one pass. */
const TABLES = ["visits", "test_requests"] as const;
type Table = (typeof TABLES)[number];
const isTable = (s: string): s is Table => (TABLES as readonly string[]).includes(s);

/** The doctor-line rules below concern this table only. */
const TABLE: Table = "test_requests";

/** Identifiers that mean "this chain splits doctor lines from lab lines". */
const DOCTOR_FILTER_MARKERS = [
  "DOCTOR_KINDS_PG_LIST",
  "DOCTOR_KIND_VALUES",
  "classifyKind",
  "isDoctorKind",
];

type Meaning = "lab" | "all" | "structural" | "mixed";

interface Surface {
  meaning: Meaning;
  why: string;
}

/**
 * Every file that READS `test_requests`, and what its reads MEAN.
 *
 * `lab`        — presents, counts, measures or queues the row as LAB WORK. A
 *                doctor consultation showing up is a bug. Every read chain
 *                MUST exclude doctor kinds.
 * `all`        — means every billable line on the visit. Excluding doctor
 *                kinds would be a bug in the other direction, and an
 *                expensive one (a receipt that drops a consultation loses
 *                money). No read chain may exclude them.
 * `structural` — lab-meaning, but a doctor line cannot reach the query in the
 *                first place because of the SHAPE of the data, not a filter:
 *                it addresses a package header (always `lab_package`), or a
 *                row that must already carry a result template / a stored
 *                result file / a `report_group_id`, none of which a doctor
 *                service has. Asserted by nothing — so `why` has to name the
 *                barrier, and a reviewer has to agree it holds.
 *
 * `structural` is the escape hatch, so treat a new one as a design smell:
 * bug #4 in this PR (undo a released consultation → it parks at
 * `ready_for_release` → the generic Release button emails the patient about a
 * lab result that doesn't exist) was exactly a "can't happen" invariant that
 * turned out to happen. Prefer an explicit filter whenever one is cheap.
 *
 * Paths are relative to `src/`, posix-separated.
 */
const SURFACES: Record<string, Surface> = {
  // --- Reports -------------------------------------------------------------
  "lib/reports/lab-tat.ts": {
    meaning: "lab",
    why: "Lab turnaround time. A consult goes requested → released at the counter with no bench step, so every one is a ~0-hour 'turnaround' that isn't one (#162).",
  },
  "lib/reports/stuck-tests.ts": {
    meaning: "lab",
    why: "Work ageing on the bench. A consult has no queue step that could clear it, so it ages forever and this list is the one place that reads that as a problem to chase (#162).",
  },
  "lib/reports/deleted-entries.ts": {
    meaning: "all",
    why: "Audit trail of every delete/restore event. A deleted consultation is as much a deletion as a deleted test.",
  },
  "lib/reports/undone-releases.ts": {
    meaning: "all",
    why: "Audit trail of every undone release. A consultation's release can be undone, and that undo is exactly what this report exists to show.",
  },

  // --- Lab worklist (the bench) -------------------------------------------
  "app/(staff)/staff/(dashboard)/queue/page.tsx": {
    meaning: "lab",
    why: "The lab worklist. Doctor lines were visible and claimable here for admin/pathologist, whose section list is null (unrestricted) so the section gate never ran.",
  },
  "app/(staff)/staff/(dashboard)/queue/[id]/page.tsx": {
    meaning: "lab",
    why: "The bench detail page — claim, upload, key a result. Refuses doctor lines outright; reachable by deep link from the visit page.",
  },
  "app/(staff)/staff/(dashboard)/queue/actions.ts": {
    meaning: "lab",
    why: "Claim/unclaim/reassign bench work. A consultation has no bench step to claim, and claiming one would park it in in_progress forever.",
  },
  "app/(staff)/staff/(dashboard)/queue/[id]/actions.ts": {
    meaning: "structural",
    why: "Upload/amend/download a RESULT. Each gate requires either a claim the queue no longer grants a doctor line, or an existing result_test_requests row with a storage_path — a doctor service has no result template and no stored file, so none can be minted for one.",
  },
  "app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/page.tsx": {
    meaning: "structural",
    why: "Scoped by services.report_group_id. Report groups are the consolidated chemistry panels; a doctor service carries no report_group_id, so it cannot appear in one.",
  },
  "app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/actions.ts": {
    meaning: "structural",
    why: "Acts on ids sourced only from the report-group-scoped page above, which no doctor line can reach.",
  },
  "lib/actions/results/finalise-consolidated.ts": {
    meaning: "structural",
    why: "Same report_group_id scoping as the consolidated page it serves.",
  },

  // --- Results archive -----------------------------------------------------
  "app/(staff)/staff/(dashboard)/results/page.tsx": {
    meaning: "lab",
    why: "The released-results archive. Consultations were listed here as results awaiting collection (#160).",
  },
  "app/(staff)/staff/(dashboard)/results/[testRequestId]/pdf/route.ts": {
    meaning: "structural",
    why: "Streams a stored result PDF. Requires a result_test_requests row with a storage_path, which a doctor line never has — there is no document to serve.",
  },

  // --- Dashboards ----------------------------------------------------------
  "app/(staff)/staff/(dashboard)/_dashboards/lab-dashboard.tsx": {
    meaning: "lab",
    why: "The medtech/pathologist home screen. Every tile counts bench work; a consultation in any of them overstates the lab's load.",
  },
  "app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx": {
    meaning: "lab",
    why: "'Results released to patients' and 'Queue' both mean lab. Measured on prod: doctor lines were up to 75% of the released-today count.",
  },
  "app/(staff)/staff/(dashboard)/_dashboards/reception-dashboard.tsx": {
    meaning: "lab",
    why: "'Pending release' means lab results awaiting release. (The order-breakdown strip beside it deliberately shows every class and splits them in JS with bucketOf, so it neither needs nor carries the query filter.)",
  },

  // --- Patient portal ------------------------------------------------------
  "app/(patient)/portal/(authenticated)/page.tsx": {
    meaning: "all",
    why: "The patient's own visit. Fetches every kind on purpose, then routes doctor lines to a 'Consultations' section and lab lines to results — the split is in JS, not the query (#160).",
  },
  "app/(patient)/portal/(authenticated)/actions.ts": {
    meaning: "structural",
    why: "Download a released result by id, plus package header/component reads. Requires a stored result file, or a package header — neither exists for a doctor line.",
  },
  "app/(patient)/portal/(authenticated)/data-export/route.ts": {
    meaning: "all",
    why: "RA 10173 subject-access export. It must contain every line the clinic holds on the patient, consultations included — dropping any would make the export incomplete.",
  },

  // --- Money, billing and the visit itself ---------------------------------
  "app/(staff)/staff/(dashboard)/visits/[id]/page.tsx": {
    meaning: "all",
    why: "The visit detail page itemises the whole bill and badges each line's class. Doctor lines are half of what it exists to show.",
  },
  "app/(staff)/staff/(dashboard)/visits/[id]/actions.ts": {
    meaning: "all",
    why: "Release/undo/mark-done act on whichever bill line the operator selected, doctor lines included — markDoctorLineDoneAction is specifically FOR them.",
  },
  "app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts": {
    meaning: "all",
    why: "An HMO claim batch can be lab OR doctor work. The file separates the two rather than dropping either.",
  },
  "lib/accounting/sync.ts": {
    meaning: "mixed",
    why: "Feeds three accounting sheet tabs from three queries in one file. Lab Services takes the COMPLEMENT of the doctor kinds; Doctor Consultations and Doctor Procedures each enumerate theirs. Every peso reaches exactly one tab — so the file both filters and doesn't, by design.",
  },
  "lib/visits/archive-query.ts": {
    meaning: "all",
    why: "The Visits archive shows and filter-chips all three classes (Lab / Doctor Consults / Doctor Procedures) — classifying them is its whole job.",
  },
  "lib/actions/visits/queue-deletion.ts": {
    meaning: "all",
    why: "Soft-delete/restore of whatever line reception selected. A mis-keyed consultation is exactly the sort of line that gets deleted.",
  },

  // --- Notifications -------------------------------------------------------
  "lib/notifications/notify-released.ts": {
    meaning: "lab",
    why: "Sends 'Your DRMed lab result is ready' with a portal link. There is no document behind a consultation, so it must never fire for one — it did, via undo → re-release.",
  },

  // --- Public ---------------------------------------------------------------
  "app/display/page.tsx": {
    meaning: "all",
    why: "The waiting-room board is a PATIENT queue, not a lab board: someone waiting to see the doctor is genuinely waiting, and the room needs to see them. Deliberately unfiltered — don't 'fix' this.",
  },
};

// ---------------------------------------------------------------------------
// Soft delete (0125) — the second invariant, over BOTH tables
// ---------------------------------------------------------------------------

/**
 * Identifiers that mean "this scope has already established the row is live".
 *
 * Only for helpers that do the check themselves. A helper named here is a
 * promise a reviewer has to keep, so keep the list short.
 */
const LIVE_FILTER_MARKERS = ["refuseIfVisitDeleted"];

type Lifecycle = "live" | "any";

interface LifecycleSurface {
  lifecycle: Lifecycle;
  why: string;
}

/**
 * Every file that READS `visits` or `test_requests`, and whether its reads
 * mean LIVE rows or span deleted ones too.
 *
 * `live` — presents, counts, bills, acts on or notifies about current data. A
 *          soft-deleted row appearing is a bug. Every read chain must exclude
 *          them, and for `test_requests` that means BOTH halves (see below).
 * `any`  — deliberately spans deleted rows: the deletion ledger, the restore
 *          path, the archive's Deleted view, a historical audit trail, the
 *          visit page that has to render the deletion itself. No assertion is
 *          made about these files, so `why` has to earn it.
 *
 * THE TRAP THAT MAKES THIS TWO FILTERS, NOT ONE
 * ---------------------------------------------
 * Soft-deleting a VISIT does not cascade to its `test_requests`. The only
 * cascade in 0125 is package header → its components, inside `test_requests`
 * (fn_queue_delete_cascade). So a deleted visit keeps a full set of lines
 * whose own `deleted_at` is still null, and a read that filters only
 * `deleted_at` still sees every one of them. A `test_requests` read that
 * means "live" needs `.is("deleted_at", null)` AND
 * `.is("visits.deleted_at", null)` — the second over a `visits!inner` embed,
 * because PostgREST silently ignores a filter on a LEFT-joined embed.
 *
 * AND THE ONE THAT MAKES IT WORTH ENFORCING
 * -----------------------------------------
 * Two surfaces had skipped the filter on the reasoning that a released line
 * can never be soft-deleted — 0125's guard raises P0043 when `old.status` is
 * already `'released'`. That is an ORDERING claim, and the database enforces
 * only one direction of it: a line deleted while at `ready_for_release` can
 * still be released afterwards. Nothing rejected the second step. This is the
 * same shape as bug #4 in #163, and the same lesson: an invariant you cannot
 * state as a filter is one you are choosing to trust.
 *
 * Paths are relative to `src/`, posix-separated.
 */
const LIFECYCLES: Record<string, LifecycleSurface> = {
  // --- Deliberately spans deleted rows -------------------------------------
  "lib/reports/deleted-entries.ts": {
    lifecycle: "any",
    why: "The deletion ledger. Reading only live rows would leave it permanently empty — the deleted rows ARE the report.",
  },
  "lib/reports/undone-releases.ts": {
    lifecycle: "any",
    why: "A historical audit trail, hydrated from audit_log resource_ids. A line whose release was once undone and which was deleted later still belongs in the record of what happened.",
  },
  "lib/visits/archive-query.ts": {
    lifecycle: "any",
    why: "The Visits archive has a Live / Deleted / All view toggle; applyView() applies is-null, not-is-null or nothing per view. Filtering here would delete the Deleted view.",
  },
  "lib/actions/visits/queue-deletion.ts": {
    lifecycle: "any",
    why: "Delete and restore. The restore path reads with .not('deleted_at','is',null) on purpose — it is looking for exactly the rows every other surface hides.",
  },
  "app/(staff)/staff/(dashboard)/visits/[id]/page.tsx": {
    lifecycle: "any",
    why: "The one page that must render a deleted visit: the red banner with who deleted it and why, the Deleted entries panel, and the Restore control. It selects deleted_at and splits live from deleted in JS.",
  },
  "components/staff/notification-bell.tsx": {
    lifecycle: "any",
    why: "A transient client-side toast for realtime INSERTs, capped at 10 and cleared on reload — never a worklist. The only inserter is visit creation, so the visit is new; and /staff/queue/[id] shows the deletion properly if one is ever clicked stale.",
  },

  // --- Live: the lab bench and its result artefacts ------------------------
  "app/(staff)/staff/(dashboard)/queue/page.tsx": {
    lifecycle: "live",
    why: "The lab worklist. A deleted line has left the operational pipeline and must not be claimable.",
  },
  "app/(staff)/staff/(dashboard)/queue/[id]/page.tsx": {
    lifecycle: "live",
    why: "The bench detail page. Selects both deleted_at columns and renders a 'Deleted from the queue' page instead of the work form.",
  },
  "app/(staff)/staff/(dashboard)/queue/actions.ts": {
    lifecycle: "live",
    why: "Claim/unclaim/reassign. Claiming a deleted line would park it in in_progress with nobody able to finish it.",
  },
  "app/(staff)/staff/(dashboard)/queue/[id]/actions.ts": {
    lifecycle: "live",
    why: "Upload, amend, finalise, download a result. A deleted line accepts no result work and mints no signed URL.",
  },
  "app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/page.tsx": {
    lifecycle: "live",
    why: "The consolidated chemistry panel's entry screen — bench work, same rule as the queue it belongs to.",
  },
  "app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/actions.ts": {
    lifecycle: "live",
    why: "Writes the consolidated panel's results. Same rule as the page that feeds it.",
  },
  "lib/actions/results/finalise-consolidated.ts": {
    lifecycle: "live",
    why: "Finalises the consolidated panel and renders its PDF. A deleted line has no result to publish.",
  },
  "app/(staff)/staff/(dashboard)/results/page.tsx": {
    lifecycle: "live",
    why: "The released-results archive — what is waiting to be collected. A deleted line is not.",
  },
  "app/(staff)/staff/(dashboard)/results/[testRequestId]/pdf/route.ts": {
    lifecycle: "live",
    why: "Streams a stored result PDF to staff by route param. A deleted line's document must not be served, and the route shows no deletion banner of its own.",
  },

  // --- Live: dashboards, queues and boards ---------------------------------
  "app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx": {
    lifecycle: "live",
    why: "Today's counts. A deleted entry is not today's work.",
  },
  "app/(staff)/staff/(dashboard)/_dashboards/lab-dashboard.tsx": {
    lifecycle: "live",
    why: "The medtech/pathologist home screen — every tile counts bench work that still exists.",
  },
  "app/(staff)/staff/(dashboard)/_dashboards/reception-dashboard.tsx": {
    lifecycle: "live",
    why: "The reception home screen — today's visits and what is pending release.",
  },
  "app/(staff)/staff/(dashboard)/visits/queue/page.tsx": {
    lifecycle: "live",
    why: "The day's visit queue. Deleting a visit is exactly how reception takes it off this list.",
  },
  "app/display/page.tsx": {
    lifecycle: "live",
    why: "The waiting-room board. A deleted visit's patient is not waiting for anything.",
  },
  "app/(staff)/staff/(dashboard)/patients/[id]/page.tsx": {
    lifecycle: "live",
    why: "The patient's visit history as the clinic stands behind it.",
  },
  "app/(staff)/staff/(dashboard)/appointments/actions.ts": {
    lifecycle: "live",
    why: "Links an appointment to its visit. A deleted visit is not the one the patient turned up for.",
  },

  // --- Live: money ---------------------------------------------------------
  "lib/accounting/sync.ts": {
    lifecycle: "live",
    why: "Appends released lines to the accounting Google Sheet. Append-only with a watermark — a row crosses once and is never revisited, so anything wrong stays wrong.",
  },
  "app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts": {
    lifecycle: "live",
    why: "Builds the claim batch the clinic bills an HMO provider for. A deleted line must never be billed to anyone.",
  },
  "app/(staff)/staff/(dashboard)/admin/accounting/patient-ar/page.tsx": {
    lifecycle: "live",
    why: "What patients still owe. A deleted visit is unpaid by construction (P0042) and bills nothing.",
  },
  "app/(staff)/staff/(dashboard)/payments/new/actions.ts": {
    lifecycle: "live",
    why: "Records a payment. P0045 blocks the insert at the database, but only as a raw Postgres error — the filter is what produces a sentence the operator can act on.",
  },
  "app/(staff)/staff/(dashboard)/payments/new/page.tsx": {
    lifecycle: "live",
    why: "The payment form's own visit load — the other half of the action above.",
  },
  "lib/actions/accounting/visits-attending.ts": {
    lifecycle: "live",
    why: "Reassigns the attending physician, which moves a professional fee. Reads deleted_at and refuses in JS with a restore-first message.",
  },
  "app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx": {
    lifecycle: "live",
    why: "A printable receipt. Nothing is billed on a deleted visit, so there is nothing to print.",
  },
  "app/(staff)/staff/(dashboard)/visits/[id]/receipt/log-print-action.ts": {
    lifecycle: "live",
    why: "Audit-logs the receipt print (RA 10173). Matches its group-receipt sibling, which has carried the filter since 0125.",
  },
  "app/(staff)/staff/(dashboard)/visits/group/[groupId]/receipt/page.tsx": {
    lifecycle: "live",
    why: "The split-encounter receipt — same rule as the single-visit one.",
  },
  "app/(staff)/staff/(dashboard)/visits/group/[groupId]/receipt/log-print-action.ts": {
    lifecycle: "live",
    why: "Audit-logs the group receipt print. This is the sibling the single-visit one was brought into line with.",
  },

  // --- Live: release, notification and the patient's own view ---------------
  "app/(staff)/staff/(dashboard)/visits/[id]/actions.ts": {
    lifecycle: "live",
    why: "Release, undo, mark-done. Guarded once per action by refuseIfVisitDeleted, plus deleted_at on each line read — see that helper's comment for the HMO path that made this reachable.",
  },
  "lib/notifications/notify-released.ts": {
    lifecycle: "live",
    why: "Sends 'your result is ready' with a portal link. A deleted line has nothing behind that link.",
  },
  "lib/notifications/notify-released-bulk.ts": {
    lifecycle: "live",
    why: "The consolidated version of the same message, for a package or bulk release.",
  },
  "app/(patient)/portal/(authenticated)/page.tsx": {
    lifecycle: "live",
    why: "What the patient sees of their own visit. The clinic deleted it; the patient should not be looking at it.",
  },
  "app/(patient)/portal/(authenticated)/visits/[id]/page.tsx": {
    lifecycle: "live",
    why: "One visit in the portal, same rule as the list that links to it.",
  },
  "app/(patient)/portal/(authenticated)/actions.ts": {
    lifecycle: "live",
    why: "Patient result and package downloads. Exported Server Actions, so the id is caller-controlled — a stale one must not still mint a signed URL.",
  },
  "app/(patient)/portal/(authenticated)/data-export/route.ts": {
    lifecycle: "live",
    why: "The RA 10173 subject-access export: the clinic's current record of the patient. A mis-keyed line the clinic withdrew is not part of it.",
  },
  "lib/actions/visits/reissue-pin.ts": {
    lifecycle: "live",
    why: "Issues a fresh portal PIN. A deleted visit grants no portal access to re-issue.",
  },

  // --- Live: reports and admin tools ---------------------------------------
  "lib/reports/lab-tat.ts": {
    lifecycle: "live",
    why: "Turnaround time. This is one of the two surfaces that had reasoned P0043 made the filter a no-op; see the note at the top of this section for why that did not hold.",
  },
  "lib/reports/stuck-tests.ts": {
    lifecycle: "live",
    why: "Work ageing on the bench. A deleted line has stopped ageing — chasing it would waste the lab's time.",
  },
  "lib/reports/patients-without-consent.ts": {
    lifecycle: "live",
    why: "Who still needs a consent form. A deleted visit needs nothing.",
  },
  "app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts": {
    lifecycle: "live",
    why: "The pre-merge preview's visit count, which an admin reads to confirm they have the right patient. (The merge itself writes, and deliberately carries deleted visits across to the surviving patient — writes are not scanned.)",
  },
};

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

const isCheckable = (p: string) =>
  /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && !/\.d\.ts$/.test(p);

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (isCheckable(full)) out.push(full);
  }
  return out;
}

const rel = (full: string) => relative(SRC_DIR, full).split(sep).join("/");

/**
 * One top-level call in the chain, with its arguments flattened to the shapes
 * the predicates below care about: a string literal (or a hoisted constant
 * resolved to one), the `null` keyword, or `OTHER` for anything else.
 *
 * The doctor-line rules only ever ask "does this literal appear anywhere in
 * the chain", so they use `literals`/`identifiers`. The soft-delete rules
 * cannot: `.is("deleted_at", null)` and `.not("deleted_at", "is", null)`
 * mention the same column and mean OPPOSITE things, so they need to see which
 * method each argument was passed to.
 */
const OTHER = Symbol("other");
interface Call {
  method: string;
  args: (string | null | typeof OTHER)[];
}

interface Chain {
  file: string;
  line: number;
  /** Which of `TABLES` the chain reads. */
  table: Table;
  /** Method names in call order, e.g. ["from", "select", "eq", "not"]. */
  methods: string[];
  /** Each call with its top-level argument shapes, in call order. */
  calls: Call[];
  /** Every string literal passed anywhere in the chain. */
  literals: string[];
  /** Every identifier referenced anywhere in the chain. */
  identifiers: string[];
  /** Source text of the nearest enclosing function (or the whole file). */
  scopeText: string;
}

const WRITE_METHODS = new Set(["insert", "update", "delete", "upsert"]);

/** The table named by `<something>.from("…")`, when it is one of ours. */
function tableOf(node: ts.Node): Table | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "from") {
    return null;
  }
  const [arg] = node.arguments;
  if (!arg || !ts.isStringLiteralLike(arg) || !isTable(arg.text)) return null;
  return arg.text;
}

/**
 * Walk UP from `.from(TABLE)` through the `.a().b().c()` spine, collecting the
 * methods called on its result. Stops at the first parent that isn't another
 * link in the same chain.
 */
function collectChain(start: ts.CallExpression): {
  methods: string[];
  calls: ts.CallExpression[];
} {
  const methods = ["from"];
  const calls: ts.CallExpression[] = [start];
  let current: ts.Node = start;

  for (;;) {
    const access = current.parent;
    if (
      !access ||
      !ts.isPropertyAccessExpression(access) ||
      access.expression !== current
    ) {
      break;
    }
    const call = access.parent;
    if (!call || !ts.isCallExpression(call) || call.expression !== access) break;
    methods.push(access.name.text);
    calls.push(call);
    current = call;
  }
  return { methods, calls };
}

/** Nearest enclosing function-like node, for the cross-statement fallback. */
function enclosingScope(node: ts.Node, src: ts.SourceFile): ts.Node {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return src;
}

/**
 * Map every `const X = "…"` in the file to its text.
 *
 * Selects are routinely hoisted into a constant (`STUCK_SELECT`, `LINE_SELECT`)
 * because they're long and shared by a page and its CSV. Without this the
 * scanner sees `.select(STUCK_SELECT)` as an opaque identifier and reports a
 * correct `services!inner` embed as a missing one.
 */
function stringConstants(src: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      out.set(node.name.text, node.initializer.text);
    }
    node.forEachChild(visit);
  };
  visit(src);
  return out;
}

function scanFile(full: string): Chain[] {
  const text = readFileSync(full, "utf8");
  if (!TABLES.some((t) => text.includes(t))) return [];

  const src = ts.createSourceFile(
    full,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    full.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const consts = stringConstants(src);
  const chains: Chain[] = [];

  /** The shape of one top-level argument, for the soft-delete predicates. */
  const shapeOf = (a: ts.Node): string | null | typeof OTHER => {
    if (ts.isStringLiteralLike(a)) return a.text;
    if (a.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(a)) return consts.get(a.text) ?? OTHER;
    return OTHER;
  };

  const visit = (node: ts.Node) => {
    const table = tableOf(node);
    if (table && ts.isCallExpression(node)) {
      const { methods, calls } = collectChain(node);
      const literals: string[] = [];
      const identifiers: string[] = [];

      for (const call of calls) {
        for (const arg of call.arguments) {
          const collectArg = (a: ts.Node) => {
            if (ts.isStringLiteralLike(a)) {
              literals.push(a.text);
            } else if (ts.isIdentifier(a)) {
              identifiers.push(a.text);
              // A hoisted select constant counts as the string it holds.
              const resolved = consts.get(a.text);
              if (resolved !== undefined) literals.push(resolved);
            }
            a.forEachChild(collectArg);
          };
          collectArg(arg);
        }
      }

      const scope = enclosingScope(node, src);
      chains.push({
        file: rel(full),
        line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1,
        table,
        methods,
        calls: calls.map((call, i) => ({
          method: methods[i]!,
          args: call.arguments.map(shapeOf),
        })),
        literals,
        identifiers,
        scopeText: scope.getText(src),
      });
    }
    node.forEachChild(visit);
  };
  visit(src);

  return chains;
}

const allChains = walkFiles(SRC_DIR).flatMap(scanFile);
const readChains = allChains.filter(
  (c) => !c.methods.some((m) => WRITE_METHODS.has(m)),
);

/**
 * The doctor-line rules concern `test_requests` alone — `visits` has no
 * `services.kind` to split on. The soft-delete rules below use every chain.
 */
const testRequestReads = readChains.filter((c) => c.table === TABLE);

/**
 * Does this chain reach `services` at all?
 *
 * A chain that embeds neither `services` nor any `services.*` column cannot
 * filter on `services.kind` without growing a join it has no other use for —
 * and it isn't presenting lab work either. In practice these are single-row
 * pre-reads for an audit row ("who holds this line right now?"), addressed by
 * id. Requiring the filter there would mean adding a join purely to satisfy
 * this test, so they're exempt from the lab-coverage rule below.
 *
 * A lab LIST always joins services (it needs the section, the name, or the
 * turnaround), so this exemption doesn't let a worklist through.
 */
function touchesServices(chain: Chain): boolean {
  return chain.literals.some((l) => /\bservices\b/.test(l));
}

/** Does this chain (or its enclosing function) split doctor from lab lines? */
function hasDoctorFilter(chain: Chain): boolean {
  const inChain = chain.identifiers.some((id) =>
    DOCTOR_FILTER_MARKERS.includes(id),
  );
  if (inChain) return true;
  return DOCTOR_FILTER_MARKERS.some((m) => chain.scopeText.includes(m));
}

/** Does this chain embed `services` as an INNER join? */
function hasInnerServicesEmbed(chain: Chain): boolean {
  return chain.literals.some((l) => /services\s*!\s*inner/.test(l));
}

/** Does this chain embed `visits` as an INNER join? */
function hasInnerVisitsEmbed(chain: Chain): boolean {
  return chain.literals.some((l) => /visits\s*!\s*inner/.test(l));
}

/**
 * The columns this chain pins to NULL — i.e. `.is(col, null)` or the
 * equivalent `.filter(col, "is", null)`.
 *
 * Polarity is the whole point of reading the calls structurally rather than
 * grepping for the column name: `.is("deleted_at", null)` and
 * `.not("deleted_at", "is", null)` name the same column and mean opposite
 * things, and the restore path uses the second one deliberately.
 */
function nullPinnedColumns(chain: Chain): string[] {
  const out: string[] = [];
  for (const { method, args } of chain.calls) {
    if (method === "is" && typeof args[0] === "string" && args[1] === null) {
      out.push(args[0]);
    }
    if (
      method === "filter" &&
      typeof args[0] === "string" &&
      args[1] === "is" &&
      (args[2] === null || args[2] === "null")
    ) {
      out.push(args[0]);
    }
  }
  return out;
}

/** Column paths in the select string, e.g. "deleted_at" or "visits( … deleted_at … )". */
const selectText = (chain: Chain) =>
  chain.calls
    .filter((c) => c.method === "select")
    .flatMap((c) => c.args)
    .filter((a): a is string => typeof a === "string")
    .join(" ")
    // A hoisted select constant reaches `literals` but not `calls`.
    .concat(" ", chain.literals.join(" "));

/**
 * Is the row's OWN `deleted_at` accounted for?
 *
 * Three accepted forms, all of which a reviewer can see at the call site:
 *   1. the query filter, `.is("deleted_at", null)`
 *   2. selecting the column and branching on it in JS — the pattern the bench
 *      detail page and the physician-reassign action use, because they want to
 *      SAY the row was deleted rather than merely return nothing
 *   3. a filter built in a sibling statement of the same function, or a named
 *      helper from LIVE_FILTER_MARKERS
 */
function excludesDeletedRows(chain: Chain): boolean {
  if (nullPinnedColumns(chain).some((c) => c === "deleted_at")) return true;
  if (/(^|[^.\w])deleted_at/.test(selectText(chain))) return true;
  if (/\.is\(\s*"deleted_at"/.test(chain.scopeText)) return true;
  return LIVE_FILTER_MARKERS.some((m) => chain.scopeText.includes(m));
}

/**
 * Is the row's VISIT accounted for, by this chain itself?
 *
 * Only asked of `test_requests` chains, and only because deleting a visit does
 * not cascade to its lines — see the header of the LIFECYCLES map.
 */
function pinsVisitLiveDirectly(chain: Chain): boolean {
  if (nullPinnedColumns(chain).some((c) => c === "visits.deleted_at")) return true;
  if (/visits[^)]*deleted_at/.test(selectText(chain))) return true;
  if (/\.is\(\s*"visits\.deleted_at"/.test(chain.scopeText)) return true;
  return LIVE_FILTER_MARKERS.some((m) => chain.scopeText.includes(m));
}

/**
 * …or by an EARLIER query in the same function that already proved it.
 *
 * Several actions read once to decide, then read again to hydrate: the portal
 * data export fetches the patient's live visits and then their lines by
 * `visit_id`; the bench detail page loads the guarded test and then its package
 * components by `parent_id`; claim/unclaim re-reads `assigned_to` after the
 * guarded lookup. Demanding a second `visits!inner` embed on the follow-up
 * would add a join for no reason, so a sibling chain in the same scope counts —
 * but only a sibling that genuinely establishes it, not merely the presence of
 * the word somewhere in the function.
 *
 * Scope is the nearest enclosing function, so "sibling" means a query the same
 * call actually runs. A module-level chain would scope to the whole file; there
 * are none today, and a new one would be worth looking at anyway.
 */
function excludesDeletedVisits(chain: Chain, all: Chain[]): boolean {
  if (pinsVisitLiveDirectly(chain)) return true;

  const sameScope = (s: Chain) =>
    s.file === chain.file && s.scopeText === chain.scopeText;

  // A chain keyed on `visit_id` is selecting lines OF a set of visits, so the
  // query that produced that set is what decides whether they were live. That
  // query is often a scope or two away — the portal's data export builds its
  // visit ids in GET() and reads the lines inside a nested chunking helper —
  // so for this shape alone the sibling may sit anywhere in the file. It still
  // has to be a `visits` read that genuinely excludes deleted rows.
  const keyedOnVisitId = chain.calls.some(
    (c) => (c.method === "in" || c.method === "eq") && c.args[0] === "visit_id",
  );
  const sameFile = (s: Chain) => s.file === chain.file;

  return all.some(
    (s) =>
      s !== chain &&
      (s.table === "visits"
        ? (keyedOnVisitId ? sameFile(s) : sameScope(s)) && excludesDeletedRows(s)
        : sameScope(s) && pinsVisitLiveDirectly(s)),
  );
}

const describeChain = (c: Chain) => `${c.file}:${c.line}`;

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe("lab surfaces exclude doctor lines", () => {
  it("finds test_requests queries to scan (guard against a bad walk)", () => {
    expect(allChains.length).toBeGreaterThan(20);
    expect(testRequestReads.length).toBeGreaterThan(10);
  });

  it("classifies every file that reads test_requests", () => {
    const unclassified = [
      ...new Set(testRequestReads.map((c) => c.file)),
    ].filter((f) => !(f in SURFACES));

    expect(
      unclassified.sort(),
      `These files read ${TABLE} but aren't classified in SURFACES.\n` +
        `${TABLE} doubles as the visit's BILL LINE, so doctor consultations ` +
        `and procedures live in it alongside lab tests. Decide what each ` +
        `surface MEANS and add it to SURFACES:\n` +
        `  "lab" — shows/counts/measures LAB work (must exclude doctor kinds)\n` +
        `  "all" — means every billable line on the visit (must not)\n` +
        `See the header of this file for the fix.`,
    ).toEqual([]);
  });

  it("keeps 'mixed' honest — it must genuinely be both", () => {
    const notActuallyMixed = Object.entries(SURFACES)
      .filter(([, s]) => s.meaning === "mixed")
      .filter(([file]) => {
        const chains = testRequestReads.filter((c) => c.file === file);
        const filtered = chains.filter((c) =>
          c.identifiers.some((id) => DOCTOR_FILTER_MARKERS.includes(id)),
        );
        return filtered.length === 0 || filtered.length === chains.length;
      })
      .map(([f]) => f);

    expect(
      notActuallyMixed.sort(),
      `"mixed" is for a file whose reads genuinely split both ways — some ` +
        `excluding doctor kinds, some deliberately keeping them (the ` +
        `accounting sync's three sheet tabs). A file where ALL reads filter ` +
        `is "lab"; one where NONE do is "all" or "structural". Re-classify ` +
        `it rather than using "mixed" to opt out of both checks.`,
    ).toEqual([]);
  });

  it("gives every structural exemption a stated reason", () => {
    const unexplained = Object.entries(SURFACES)
      .filter(([, s]) => s.meaning === "structural")
      .filter(([, s]) => s.why.trim().length < 60)
      .map(([f]) => f);

    expect(
      unexplained.sort(),
      `"structural" means "a doctor line cannot reach this query because of ` +
        `the shape of the data" — the one meaning this test cannot verify. ` +
        `Each needs a 'why' that NAMES the barrier (a package header, a ` +
        `required result template, a stored result file, a report_group_id) ` +
        `so a reviewer can check it still holds.`,
    ).toEqual([]);
  });

  it("has no stale SURFACES entries", () => {
    const seen = new Set(testRequestReads.map((c) => c.file));
    const stale = Object.keys(SURFACES).filter((f) => !seen.has(f));
    expect(
      stale.sort(),
      `These SURFACES entries no longer read ${TABLE} — delete them so the ` +
        `list stays a true map of the surfaces that exist.`,
    ).toEqual([]);
  });

  it("excludes doctor lines from every lab-meaning read", () => {
    const missing = testRequestReads
      .filter((c) => SURFACES[c.file]?.meaning === "lab")
      .filter(touchesServices)
      .filter((c) => !hasDoctorFilter(c))
      .map(describeChain);

    expect(
      missing.sort(),
      `These reads are on a lab-meaning surface but don't exclude doctor ` +
        `kinds, so consultations and procedures will be counted or shown as ` +
        `lab work.\nAdd:\n` +
        `  .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)\n` +
        `with a "services!inner ( … )" embed in the select.`,
    ).toEqual([]);
  });

  it("does not drop doctor lines from bill-line reads", () => {
    const overFiltered = testRequestReads
      .filter((c) => SURFACES[c.file]?.meaning === "all")
      .filter((c) =>
        c.identifiers.some((id) => DOCTOR_FILTER_MARKERS.includes(id)),
      )
      .map(describeChain);

    expect(
      overFiltered.sort(),
      `These reads are on a surface that means EVERY billable line on the ` +
        `visit, but they exclude doctor kinds. A receipt, bill, accounting ` +
        `sync or deletion ledger that silently drops consultations loses ` +
        `money rather than merely miscounting. Remove the filter, or ` +
        `re-classify the file as "lab" in SURFACES if that's what it means.`,
    ).toEqual([]);
  });

  it("joins services as an INNER embed wherever it filters on services.kind", () => {
    const leftJoined = testRequestReads
      .filter((c) =>
        c.identifiers.some((id) => DOCTOR_FILTER_MARKERS.includes(id)),
      )
      .filter((c) => c.literals.some((l) => l.includes("services.kind")))
      .filter((c) => !hasInnerServicesEmbed(c))
      .map(describeChain);

    expect(
      leftJoined.sort(),
      `These chains filter on "services.kind" but embed services as a LEFT ` +
        `join. PostgREST silently IGNORES a filter on a left-joined embed — ` +
        `the query runs, returns the UNFILTERED rows, and looks like a ` +
        `working fix. Change the select to "services!inner ( … )".`,
    ).toEqual([]);
  });
});

describe("live surfaces exclude soft-deleted rows", () => {
  it("classifies every file that reads visits or test_requests", () => {
    const unclassified = [...new Set(readChains.map((c) => c.file))].filter(
      (f) => !(f in LIFECYCLES),
    );

    expect(
      unclassified.sort(),
      `These files read ${TABLES.join(" or ")} but aren't classified in ` +
        `LIFECYCLES.\nBoth tables are soft-deleted (0125): a row that was ` +
        `removed from the queue stays in the table with deleted_at set. ` +
        `Decide what each surface MEANS and add it:\n` +
        `  "live" — current data (must exclude deleted rows)\n` +
        `  "any"  — deliberately spans them (the deletion ledger, restore, ` +
        `the archive's Deleted view, an audit trail)\n` +
        `See the header of the LIFECYCLES map for the fix.`,
    ).toEqual([]);
  });

  it("gives every 'any' surface a stated reason", () => {
    const unexplained = Object.entries(LIFECYCLES)
      .filter(([, s]) => s.lifecycle === "any")
      .filter(([, s]) => s.why.trim().length < 60)
      .map(([f]) => f);

    expect(
      unexplained.sort(),
      `"any" opts a file out of both checks below, so it is the escape ` +
        `hatch — each needs a 'why' naming the reason deleted rows BELONG ` +
        `there (it is the ledger, it is the restore path, it renders the ` +
        `deletion itself), not merely that the filter is inconvenient.`,
    ).toEqual([]);
  });

  it("has no stale LIFECYCLES entries", () => {
    const seen = new Set(readChains.map((c) => c.file));
    const stale = Object.keys(LIFECYCLES).filter((f) => !seen.has(f));
    expect(
      stale.sort(),
      `These LIFECYCLES entries no longer read either table — delete them so ` +
        `the list stays a true map of the surfaces that exist.`,
    ).toEqual([]);
  });

  it("excludes soft-deleted rows from every live read", () => {
    const missing = readChains
      .filter((c) => LIFECYCLES[c.file]?.lifecycle === "live")
      .filter((c) => !excludesDeletedRows(c))
      .map(describeChain);

    expect(
      missing.sort(),
      `These reads are on a live surface but don't exclude soft-deleted ` +
        `rows (0125), so entries the clinic removed from the queue will be ` +
        `shown, counted, billed or notified about.\nAdd:\n` +
        `  .is("deleted_at", null)\n` +
        `or select deleted_at and branch on it, if the surface needs to SAY ` +
        `the row was deleted rather than just return nothing.`,
    ).toEqual([]);
  });

  it("excludes lines on a deleted VISIT from every live read", () => {
    const missing = readChains
      .filter((c) => c.table === "test_requests")
      .filter((c) => LIFECYCLES[c.file]?.lifecycle === "live")
      .filter((c) => !excludesDeletedVisits(c, readChains))
      .map(describeChain);

    expect(
      missing.sort(),
      `These reads exclude deleted test_requests but not lines on a deleted ` +
        `VISIT — and deleting a visit does NOT cascade to its lines (0125's ` +
        `only cascade is package header → components). A deleted visit ` +
        `therefore keeps a full set of rows whose own deleted_at is null, ` +
        `and this query still sees every one of them.\nAdd:\n` +
        `  .select("…, visits!inner ( id )")   // !inner is required\n` +
        `  .is("visits.deleted_at", null)`,
    ).toEqual([]);
  });

  it("joins visits as an INNER embed wherever it filters on visits.deleted_at", () => {
    const leftJoined = readChains
      .filter((c) => nullPinnedColumns(c).includes("visits.deleted_at"))
      .filter((c) => !hasInnerVisitsEmbed(c))
      .map(describeChain);

    expect(
      leftJoined.sort(),
      `These chains filter on "visits.deleted_at" but embed visits as a LEFT ` +
        `join. PostgREST silently IGNORES a filter on a left-joined embed — ` +
        `the query runs, returns the UNFILTERED rows, and looks exactly like ` +
        `a working fix. Change the select to "visits!inner ( … )".`,
    ).toEqual([]);
  });
});

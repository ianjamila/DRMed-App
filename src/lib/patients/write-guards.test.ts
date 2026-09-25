import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

// Standing gate for the app-level active-patient write guards (Task 22/23,
// spec 2026-09-24-patient-delete-design.md "History pages keep working").
// Until PR 3's database-side child-table guards land, these app checks are
// the ONLY barrier against a write landing on a deleted/merged patient's
// visits, tests, money, results or claims — so a future write path that
// forgets the guard must fail a test, not wait for a manual grep.
//
// Every `.from(TABLE).insert/update/upsert/delete(...)` (or `.rpc(name, …)`
// to a known writer RPC) on the tables below, in every "use server" file and
// every src/app/api/**/route.ts, must resolve — from its enclosing NAMED
// function, walking through same-file helpers it calls — to a call to one of
// the guard functions. Anything that can't is either a real gap (fix it) or
// a deliberate exception, listed in EXEMPT with a `why`.

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const WRITE_TABLES = new Set([
  "visits",
  "test_requests",
  "payments",
  "appointments",
  "patient_consents",
  "visit_pins",
  "hmo_claim_items",
  "hmo_claim_batches",
  "hmo_payment_allocations",
  "hmo_claim_resolutions",
  "results",
  "result_test_requests",
  "appointment_attachments",
  "patients",
]);
const WRITE_METHODS = new Set(["insert", "update", "upsert", "delete"]);

// RPCs (outside the `.from(table).verb()` shape) known to write one of the
// tables above, filled from a grep of every `.rpc("` call site in src/
// (2026-09-25, post-rebase). appointments_insert_slot_guarded is
// deliberately left out — it lives in a plain lib module
// (src/lib/appointments/create.ts, no "use server", outside the widened
// src/lib/actions/**·src/lib/results/** scan below too), reached only
// through callers that already resolve an active patient first (see EXEMPT
// below) — but the mechanism stays wired for when one is added here.
const KNOWN_WRITER_RPCS = new Set<string>([
  "correct_payment", // payments/[id]/{edit,move}/actions.ts — money moves off/onto a visit.
  "result_edit_commit", // result-edit-core.ts commitResultEdit — amends a finished result.
  "result_finalise_commit", // result-edit-core.ts commitResultFinalise — first finalise of a structured result.
  "result_save_draft", // queue/[id]/actions.ts saveDraftValues — draft values under the result's row lock.
  // delete_patient/restore_patient ARE the lifecycle-changing RPCs
  // themselves (0167) — the app-level active-patient guard exists to keep
  // OTHER writes off an inactive record; requiring it here would be
  // circular. See their EXEMPT entries below.
  "delete_patient",
  "restore_patient",
]);

// Names that count as "this write is guarded" WHEN CALLED DIRECTLY from the
// write's own enclosing function. Every assert*Active helper in
// require-active.ts matches the first pattern; the other two are the
// non-assert primitive guard shapes used elsewhere (getActivePatientSession/
// isActivePatient gate the portal and the edit route).
const GUARD_PATTERN = /\b(assert\w*Active|getActivePatientSession|isActivePatient)\s*\(/;

// file:function → why THIS same-file helper itself counts as a guard, so a
// caller that invokes it (and nothing else) is credited too. This is the
// ONLY transitive credit given — deliberately a single, explicit hop, not a
// recursive walk through every same-file function a write's enclosing
// function happens to call. (The old recursive walk over-credited: e.g.
// recordPaymentAction called redeemGiftCode on an unrelated branch, and
// because redeemGiftCode itself guards its own write, recordPaymentAction
// was wrongly credited for a write it makes on a completely different,
// unguarded branch.) Add an entry only for a helper whose OWN body calls a
// GUARD_PATTERN primitive (or another listed wrapper) before doing/enabling
// the write — never for a helper that merely happens to guard on some other
// branch.
const GUARD_WRAPPERS: Record<string, string> = {
  [`src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts:refuseIfVisitDeleted`]:
    "Wraps assertVisitPatientActive and returns an early-refusal object every caller checks before writing (6 call sites: release/undo-release/mark-done family).",
  // NOTE: prepareStructured itself still calls assertPatientActive before its
  // OWN two writes (a new results/result_test_requests row) — those resolve
  // directly against GUARD_PATTERN, with no wrapper credit needed. A
  // GUARD_WRAPPERS entry for it went stale post-rebase: 0172 moved the
  // draft/finalise/amend writes themselves out of saveDraftAction/
  // finaliseStructuredAction's own bodies and into separate helpers
  // (saveDraftValues here; commitResultEdit/commitResultFinalise in
  // result-edit-core.ts) that do not call prepareStructured directly — so no
  // caller's write is ever credited THROUGH this wrapper. See the EXEMPT
  // entries below for where that credit now belongs.
};

// file:function → why it deliberately has no guard. Seeded from the plan's
// explicit "not guarded, on purpose" list (Task 22/23) plus every private
// helper whose write happens after its caller's own guard already ran.
const EXEMPT: Record<string, string> = {
  [`src/app/(staff)/staff/(dashboard)/queue/actions.ts:claimTestAction`]:
    "A deleted/merged patient has no open lines to claim; claiming does not bill or release.",
  [`src/app/(staff)/staff/(dashboard)/queue/actions.ts:performUnclaim`]:
    "Handing a claim back reduces work, same reasoning as claimTestAction; shared by unclaimTestAction/unclaimOwnTestAction/unclaimFromQueueAction.",
  [`src/app/(staff)/staff/(dashboard)/queue/actions.ts:reassignTestAction`]:
    "Reassigning an already-claimed line does not put new work or money on the record.",
  [`src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/actions.ts:claimConsolidated`]:
    "Same as claimTestAction, for a consolidated report — claiming does not bill.",
  [`src/app/(marketing)/appointments/cancel/[id]/actions.ts:cancelAppointmentAction`]:
    "Public cancel-by-link reduces work (cancels), same reasoning as staff cancel.",
  [`src/app/(marketing)/schedule/actions.ts:storeLabRequestFiles`]:
    "Called by submitBookingAction only after that function's own active-only patient resolution.",
  [`src/app/(marketing)/register/actions.ts:submitRegistrationAction`]:
    "The consent-grant write only runs on the brand-new-patient branch (!res.reused) — resolvePatient created a fresh, always-active row, matching the plan's 'brand-new record — guard passes' exception.",
  [`src/app/(patient)/portal/login/actions.ts:signInPatient`]:
    "PIN login authenticates via an activePatients(...)-filtered lookup before any visit_pins write (see query-surfaces.test.ts SURFACES); getActivePatientSession can't run yet — there is no session until login succeeds.",
  [`src/app/(staff)/staff/(dashboard)/patients/actions.ts:createPatientAction`]:
    "Insert-only — a brand-new patient row is active by construction (deleted_at/merged_into_id default null).",
  [`src/app/(staff)/staff/(dashboard)/admin/import-patients/actions.ts:importPatientsAction`]:
    "Insert-only — same as createPatientAction, a bulk-imported row is active by construction.",
  [`src/app/api/cron/appointment-reminders/route.ts:GET`]:
    "Stamps reminder_sent_at only after an inline deleted_at/merged_into_id check on the embedded patient row (the sender itself re-checks too); not a monetary or clinical write.",
  [`src/app/api/cron/data-retention/route.ts:GET`]:
    "Deletes expired visit_pins past the retention cutoff regardless of patient lifecycle — a retention policy, not clinical/financial work.",
  [`src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts:mergePatientsAction`]:
    "Task 15 merge — inline-checks deleted_at/merged_into_id on both rows before writing; the merge/undo-merge lifecycle path is reviewed separately from Task 22/23's active-patient rule.",
  [`src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts:undoMergeAction`]:
    "Task 15 undo-merge — the paired lifecycle RPC-equivalent caller to mergePatientsAction above.",
  [`src/lib/actions/visits/queue-deletion.ts:deleteVisitAction`]:
    "Deletes stay unguarded by design (Task 23) — they remove work, never put it back.",
  [`src/lib/actions/visits/queue-deletion.ts:deleteTestRequestsAction`]:
    "Deletes stay unguarded by design (Task 23) — they remove work, never put it back.",
  [`src/app/(staff)/staff/(dashboard)/appointments/actions.ts:attachPatientToAppointmentAction`]:
    "The patient is resolved via an activePatients(...)-filtered read or resolvePatient (active-only, Task 9) earlier in this same function, before the attach write.",
  [`src/app/(staff)/staff/(dashboard)/appointments/actions.ts:deleteAppointmentAction`]:
    "Deletes reduce work and stay unguarded, same reasoning as cancelAppointmentAction (Task 22 note).",
  [`src/app/(staff)/staff/(dashboard)/appointments/actions.ts:markLikelyNoShowsAction`]:
    "Bulk confirmed → no_show only — takes work off the record, the same transition transitionGroup leaves unguarded for the single No-show button. Its Undo (undoLikelyNoShowsAction) puts work back and does call assertAppointmentsPatientsActive.",
  [`src/app/(staff)/staff/(dashboard)/visits/new/actions.ts:createOneVisit`]:
    "Private helper invoked by createVisitAction only after that function's own assertPatientActive guard already passed.",
  [`src/app/(staff)/staff/(dashboard)/visits/new/actions.ts:deleteVisitCascade`]:
    "Rollback-only cleanup of a visit/tests just created in this same guarded call; a delete, not new work.",
  [`src/app/(staff)/staff/(dashboard)/payments/new/actions.ts:voidRedemptionPayment`]:
    "Rollback helper invoked by redeemGiftCode only after that function's own assertVisitPatientActive guard already passed, to void the payment it just inserted.",
  [`src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts:saveDraftValues`]:
    "Invoked by saveDraftAction only after prepareStructured (which calls assertPatientActive) already passed; the result_save_draft RPC call lives in this separate helper, not in prepareStructured's own body.",
  [`src/lib/actions/results/result-edit-core.ts:commitResultEdit`]:
    "Shared commit helper for the result_edit_commit RPC — every caller (amend-consolidated.ts's amendConsolidatedReport, queue/[id]/actions.ts's amendResultAction/amendStructuredResultAction) calls assertPatientActive before invoking it.",
  [`src/lib/actions/results/result-edit-core.ts:commitResultFinalise`]:
    "Shared commit helper for the result_finalise_commit RPC — every caller (finalise-consolidated.ts's finaliseConsolidatedReport, queue/[id]/actions.ts's finaliseStructuredAction via prepareStructured) calls assertVisitPatientActive/assertPatientActive before invoking it.",
  [`src/lib/actions/patients/lifecycle.ts:deletePatientAction`]:
    "delete_patient IS the lifecycle-deleting RPC itself — the database refuses it (P0058) when the record is already deleted or merged, so an app-level active-patient guard here would be circular.",
  [`src/lib/actions/patients/lifecycle.ts:restorePatientAction`]:
    "restore_patient IS the lifecycle-restoring RPC itself — guarding it with assertPatientActive would be backwards (restore only makes sense on a currently-INACTIVE record); the database enforces its own precondition (P0061).",
  [`src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts:submitBatchAction`]:
    "I1 (2026-09-25 rebase review): whole-batch guards were removed. A batch's items are guarded when added (createClaimBatchAction/addItemsToBatchAction, both assertTestRequestsPatientsActive) and per-item edits keep assertClaimItemsPatientsActive; the delete_patient blocker already refuses to delete a patient with any non-voided hmo_claim_item, so a batch status change can never land on an inactive patient's claim.",
  [`src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts:acknowledgeBatchAction`]:
    "Same reasoning as submitBatchAction above — a status change on a batch whose items are all already guarded at creation/edit time.",
  [`src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts:voidBatchAction`]:
    "Same reasoning as submitBatchAction above; voiding also reduces work rather than adding it.",
  [`src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts:bulkSetHmoResponseAction`]:
    "Same reasoning as submitBatchAction above — a bulk item-response update on a batch whose items are already guarded at creation/edit time.",
};

const isCheckable = (p: string) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && !/\.d\.ts$/.test(p);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (isCheckable(full)) out.push(full);
  }
  return out;
}
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

const isApiRoute = (f: string) => /\/app\/api\/.*\/route\.tsx?$/.test(f.replace(/\\/g, "/"));
// A write no longer has to sit directly in a "use server" action body — since
// 0172 the money/result RPCs (result_edit_commit, result_finalise_commit,
// correct_payment's callers) are shared out to plain lib helpers a "use
// server" file calls. Scan those helper directories too, so the write site
// the RPC call itself lives at (not just its caller) is covered.
const isScannedLibDir = (f: string) => {
  const r = rel(f);
  return r.startsWith("src/lib/actions/") || r.startsWith("src/lib/results/");
};
const files = walk(SRC).filter(
  (f) => isApiRoute(f) || isScannedLibDir(f) || /"use server"/.test(readFileSync(f, "utf8")),
);

interface WriteSite {
  file: string;
  line: number;
  fnKey: string; // enclosing named function, or "<module>"
}

interface FnInfo {
  name: string;
  text: string;
  node: ts.Node;
}

// Walks up from `node` to the nearest NAMED function — a `function foo(){}`
// declaration, or `const foo = (...) => {}` / `const foo = async function(){}`
// — skipping anonymous callbacks (inline arrows passed as arguments, object-
// literal method values) so an inline `insertGrant: async (row) => …` still
// resolves to the outer action, not to "insertGrant".
function enclosingNamedFunction(node: ts.Node): { name: string; node: ts.Node } | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return { name: cur.name.text, node: cur };
    if (
      ts.isVariableDeclaration(cur) &&
      ts.isIdentifier(cur.name) &&
      cur.initializer &&
      (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))
    ) {
      return { name: cur.name.text, node: cur };
    }
    cur = cur.parent;
  }
  return null;
}

function scanSource(text: string, file: string): { writes: WriteSite[]; fns: Map<string, FnInfo> } {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  // Same unwrap as query-surfaces.test.ts — see through `as`/parens/
  // `satisfies`/`!` on a string-literal argument.
  const unwrap = (n: ts.Node): ts.Node => {
    if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) return unwrap(n.expression);
    if (ts.isParenthesizedExpression(n)) return unwrap(n.expression);
    if (ts.isNonNullExpression(n)) return unwrap(n.expression);
    return n;
  };
  const lit = (a: ts.Node | undefined): string | null => {
    if (!a) return null;
    const n = unwrap(a);
    return ts.isStringLiteralLike(n) ? n.text : null;
  };

  // Every top-level named function (declaration or const-arrow/function-expr)
  // in this file, keyed by name, with its own source text.
  const fns = new Map<string, FnInfo>();
  const collectFns = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name) {
      fns.set(n.name.text, { name: n.name.text, text: n.getText(src), node: n });
    } else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      fns.set(n.name.text, { name: n.name.text, text: n.getText(src), node: n });
    }
    n.forEachChild(collectFns);
  };
  collectFns(src);

  const writes: WriteSite[] = [];
  const record = (node: ts.Node) => {
    const enclosing = enclosingNamedFunction(node);
    writes.push({
      file,
      line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1,
      fnKey: enclosing?.name ?? "<module>",
    });
  };

  const visit = (node: ts.Node) => {
    // `.from("table")....verb(...)` chains, same walk shape as
    // query-surfaces.test.ts.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "from"
    ) {
      const table = lit(node.arguments[0]);
      if (table && WRITE_TABLES.has(table)) {
        const methods: string[] = [];
        let current: ts.Node = node;
        for (;;) {
          const access = current.parent;
          if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== current) break;
          const call = access.parent;
          if (!call || !ts.isCallExpression(call) || call.expression !== access) break;
          methods.push(access.name.text);
          current = call;
        }
        if (methods.some((m) => WRITE_METHODS.has(m))) record(node);
      }
    }
    // `.rpc("name", …)` to a known writer RPC.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "rpc"
    ) {
      const rpcName = lit(node.arguments[0]);
      if (rpcName && KNOWN_WRITER_RPCS.has(rpcName)) record(node);
    }
    node.forEachChild(visit);
  };
  visit(src);
  return { writes, fns };
}

const scanned = files.map((f) => ({ file: rel(f), ...scanSource(readFileSync(f, "utf8"), rel(f)) }));

// guarded(fnName): true only for (a) a DIRECT GUARD_PATTERN call inside that
// function's own text, or (b) a direct call (by identifier text, same file)
// to a helper explicitly listed in GUARD_WRAPPERS for this file. No further
// transitivity — a wrapper's own call to some third helper does not chain,
// and a write's enclosing function gets no credit for calling an unlisted
// same-file function just because that function happens to guard somewhere
// in its own body (that was the recordPaymentAction/redeemGiftCode bug: an
// unrelated branch's helper is not evidence this function's write is safe).
// Forward-only in the same sense as before: a helper invoked AFTER its
// caller's guard already ran (e.g. a rollback) still needs an EXEMPT entry.
function makeGuardChecker(file: string, fns: Map<string, FnInfo>, usedWrappers: Set<string>) {
  const memo = new Map<string, boolean>();
  function guarded(name: string): boolean {
    if (memo.has(name)) return memo.get(name)!;
    const fn = fns.get(name);
    if (!fn) return false;
    let result = GUARD_PATTERN.test(fn.text);
    let via: string | null = null;
    if (!result) {
      for (const [otherName] of fns) {
        if (otherName === name) continue;
        const wrapperKey = `${file}:${otherName}`;
        if (!GUARD_WRAPPERS[wrapperKey]) continue;
        if (new RegExp(`\\b${otherName}\\s*\\(`).test(fn.text)) {
          result = true;
          via = wrapperKey;
          break;
        }
      }
    }
    if (via) usedWrappers.add(via);
    memo.set(name, result);
    return result;
  }
  return guarded;
}

const usedWrappers = new Set<string>();
const unresolvedByFile = scanned.map(({ file, writes, fns }) => {
  const guarded = makeGuardChecker(file, fns, usedWrappers);
  const bad = writes.filter((w) => w.fnKey === "<module>" || !guarded(w.fnKey));
  return { file, bad };
});
const unresolved = unresolvedByFile.flatMap(({ file, bad }) => bad.map((w) => ({ file, fnKey: w.fnKey, line: w.line })));
const requiredKeys = new Set(unresolved.map((w) => `${w.file}:${w.fnKey}`));

describe("every patient-table write is guarded or explicitly exempt", () => {
  it("finds files to scan", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it("finds write call sites (guards a broken walk)", () => {
    const total = scanned.reduce((n, s) => n + s.writes.length, 0);
    expect(total).toBeGreaterThan(30);
  });

  it("every write resolves to a guard call or an EXEMPT entry", () => {
    const bad = unresolved
      .filter((w) => !EXEMPT[`${w.file}:${w.fnKey}`])
      .map((w) => `${w.file}:${w.fnKey}:${w.line}`);
    expect(
      bad,
      "Call an assert*PatientActive helper (or getActivePatientSession / isActivePatient) directly from this function, or add file:function to GUARD_WRAPPERS (if it's a shared precondition helper) or to EXEMPT with a why.",
    ).toEqual([]);
  });

  it("has no stale EXEMPT entries", () => {
    const stale = Object.keys(EXEMPT).filter((k) => !requiredKeys.has(k));
    expect(stale, "This write is now guarded (or gone) — remove the EXEMPT entry.").toEqual([]);
  });

  it("every EXEMPT entry has a real why", () => {
    const bad = Object.entries(EXEMPT).filter(([, why]) => why.trim().length < 15);
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it("has no stale GUARD_WRAPPERS entries", () => {
    const stale = Object.keys(GUARD_WRAPPERS).filter((k) => !usedWrappers.has(k));
    expect(stale, "No write actually gets credited through this wrapper any more — remove the entry.").toEqual([]);
  });

  it("every GUARD_WRAPPERS entry has a real why", () => {
    const bad = Object.entries(GUARD_WRAPPERS).filter(([, why]) => why.trim().length < 15);
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it("sees through AsExpression/ParenthesizedExpression/SatisfiesExpression/NonNullExpression on the table literal", () => {
    const forms = [
      `db.from("visits" as const).update({}).eq("id", x)`,
      `db.from(("visits")).update({}).eq("id", x)`,
      `db.from("visits" satisfies string).update({}).eq("id", x)`,
      `db.from("visits"!).update({}).eq("id", x)`,
    ];
    for (const form of forms) {
      const { writes } = scanSource(`async function f(){ ${form}; }`, "wrapped.ts");
      expect(writes, form).toHaveLength(1);
    }
  });

  it("control: a read (no write verb) on a tracked table is not a write site", () => {
    const { writes } = scanSource(`async function f(){ db.from("visits").select("id").eq("id", x); }`, "control.ts");
    expect(writes).toHaveLength(0);
  });

  it("control: a write on an untracked table is not picked up", () => {
    const { writes } = scanSource(`async function f(){ db.from("clinic_closures").insert({}); }`, "control.ts");
    expect(writes).toHaveLength(0);
  });

  it("does not let a caller's guard leak backward onto a callee it invokes afterward", () => {
    // `middle` calls the guard AND calls `inner` — but the write lives
    // inside `inner`, which itself calls nothing guarded. Guardedness must
    // attach to the write's OWN enclosing function, not to whichever
    // function happens to call it (this is exactly voidRedemptionPayment's
    // real shape: a rollback helper invoked after its caller's own guard).
    const src = `
      function isActivePatient(p) { return true; }
      function inner() { db.from("payments").insert({}); }
      function middle() { isActivePatient(x); return inner(); }
      export async function outer() { return middle(); }
    `;
    const { writes, fns } = scanSource(src, "chain.ts");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.fnKey).toBe("inner");
    const guarded = makeGuardChecker("chain.ts", fns, new Set());
    expect(guarded("inner")).toBe(false);
  });

  it("resolves a write when its own enclosing function calls a guarded helper", () => {
    const src = `
      function assertPatientActive(id) { return check(id); }
      function prepareThing() { assertPatientActive(x); db.from("results").insert({}); }
      export async function saveDraftAction() { return prepareThing(); }
    `;
    const { writes, fns } = scanSource(src, "chain2.ts");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.fnKey).toBe("prepareThing");
    const guarded = makeGuardChecker("chain2.ts", fns, new Set());
    expect(guarded("prepareThing")).toBe(true);
  });

  it("gives wrapper credit only through the explicit GUARD_WRAPPERS allowlist, not any same-file call", () => {
    // saveDraftAction calls prepareThing (which itself guards) — but
    // prepareThing is NOT in GUARD_WRAPPERS for this synthetic file, so the
    // caller of a write inside a DIFFERENT function must not be credited.
    const src = `
      function assertPatientActive(id) { return check(id); }
      function prepareThing() { assertPatientActive(x); }
      export async function saveDraftAction() {
        prepareThing();
        db.from("results").insert({});
      }
    `;
    const { writes, fns } = scanSource(src, "chain3.ts");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.fnKey).toBe("saveDraftAction");
    const guarded = makeGuardChecker("chain3.ts", fns, new Set());
    expect(guarded("saveDraftAction")).toBe(false);
  });

  it("mutation proof: a new unguarded correct_payment RPC caller is picked up and stays unresolved", () => {
    // A hand-written control, not the real payments/[id]/{edit,move} files —
    // proves a FUTURE caller of a KNOWN_WRITER_RPC that skips the guard and
    // isn't in GUARD_WRAPPERS/EXEMPT would fail "every write resolves to a
    // guard call or an EXEMPT entry" (it is neither guarded nor exempt here).
    const src = `
      export async function newUnguardedCaller() {
        admin.rpc("correct_payment", { p_payment_id: x });
      }
    `;
    const { writes, fns } = scanSource(src, "mutation-control.ts");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.fnKey).toBe("newUnguardedCaller");
    const guarded = makeGuardChecker("mutation-control.ts", fns, new Set());
    expect(guarded("newUnguardedCaller")).toBe(false);
  });
});

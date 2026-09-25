import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

// Every READ of the `patients` table, in src/ and scripts/, declares what it
// means (spec 2026-09-24-patient-delete-design.md, "One shared active patient
// rule"):
//
//   active    — a directory, picker, matching or authentication read. Must
//               exclude deleted AND merged records, by wrapping the builder in
//               activePatients(...) or chaining .is("deleted_at", null) and
//               .is("merged_into_id", null) on the same chain.
//   history   — reads a record named by history (a visit's patient, an audit
//               row, a portal export). Must NOT filter, or deleted and merged
//               records vanish from history. This is the "future blanket
//               filter cannot hide history" guard.
//   lifecycle — reads a record in order to DECIDE on its lifecycle (the write
//               guards, the delete dialog, fixture lookups). Must select both
//               deleted_at and merged_into_id.
//   mixed     — a file with more than one of the above; every chain is still
//               checked against "not unfiltered-and-unexplained" below.
//
// SQL views/functions are pinned separately in active-views.test.ts.

const ROOT = process.cwd();
const DIRS = [join(ROOT, "src"), join(ROOT, "scripts")];

type Meaning = "active" | "history" | "lifecycle" | "mixed";
interface Surface {
  meaning: Meaning;
  why: string;
}

const S = "app/(staff)/staff/(dashboard)";

const SURFACES: Record<string, Surface> = {
  // --- active: directory / pickers / matching / authentication -------------
  [`src/${S}/appointments/new-appointment-actions.ts`]: { meaning: "active", why: "Staff booking: patient search and the submitted existing-patient id." },
  [`src/${S}/appointments/actions.ts`]: { meaning: "active", why: "Attach-patient picks an existing record; an inactive one reads as not found." },
  [`src/${S}/visits/new/page.tsx`]: { meaning: "active", why: "New-visit picker and ?patient_id= preselection." },
  [`src/${S}/admin/settings/consent-gate/page.tsx`]: { meaning: "active", why: "Worklist count of active patients without consent." },
  [`src/${S}/marketing/sources/page.tsx`]: { meaning: "active", why: "New-patient acquisition count counts active records only." },
  "src/app/(patient)/portal/login/actions.ts": { meaning: "active", why: "PIN login authenticates active records only, before PIN work and again before the cookie." },
  "src/app/(marketing)/find-my-id/actions.ts": { meaning: "active", why: "DRM-ID recovery answers for active records only." },
  "src/app/(marketing)/schedule/actions.ts": { meaning: "active", why: "Public lookup and the submitted existing-patient id." },
  "src/lib/patients/find-duplicates.ts": { meaning: "active", why: "Duplicate candidates are active records only." },
  "src/lib/portal/consent-guard.ts": { meaning: "active", why: "Portal consent check re-reads the session patient as an active record only; no merge chain (0167)." },
  "src/lib/auth/require-patient.ts": { meaning: "active", why: "getActivePatientSession — portal access for active records only, no merge chain." },
  "scripts/clinical-backfill/engine.ts": { meaning: "active", why: "Backfill patient index and token-reuse map match active records only." },
  "scripts/clinical-backfill/followups/worksheet.ts": { meaning: "active", why: "Worksheet candidates are active records only." },

  // --- history: never filtered ---------------------------------------------
  [`src/${S}/patients/[id]/page.tsx`]: { meaning: "history", why: "The record page stays reachable for deleted/merged records (banner + read-only)." },
  [`src/${S}/patients/[id]/consent/print/page.tsx`]: { meaning: "history", why: "Printing a signed consent form of any record." },
  [`src/${S}/patients/[id]/consent/signed/page.tsx`]: { meaning: "history", why: "Viewing a signed consent form of any record." },
  [`src/${S}/patients/[id]/edit-actions.ts`]: { meaning: "history", why: "Reads consent_current of a target already proven active by assertPatientActive." },
  "src/lib/actions/results/amend-consolidated.ts": { meaning: "history", why: "Reads sex/birthdate of a target already proven active by assertPatientActive above." },
  [`src/${S}/audit/page.tsx`]: { meaning: "history", why: "Audit enrichment must keep deleted and merged names." },
  [`src/${S}/queue/[id]/actions.ts`]: { meaning: "history", why: "Demographics of an existing result's patient; writes are guarded separately." },
  "src/app/(patient)/portal/(authenticated)/data-export/route.ts": { meaning: "history", why: "RA 10173 export of the signed-in (already active-checked) patient's own record." },
  "src/components/staff/notification-bell.tsx": { meaning: "history", why: "Names the patient of a past staff event." },
  "src/lib/appointments/booking-alert.ts": { meaning: "history", why: "Names the patient of a booking that already happened." },
  "src/lib/consent/gate.ts": { meaning: "history", why: "Resolves the actual visit's consent state, never a directory lookup." },
  "src/lib/emails-log/query.ts": { meaning: "history", why: "Email history must still find deleted and merged identities." },

  // --- lifecycle: reads the state to decide ----------------------------------
  [`src/${S}/patients/[id]/edit/page.tsx`]: { meaning: "lifecycle", why: "The edit route refuses inactive records before rendering a form." },
  "src/lib/patients/require-active.ts": { meaning: "lifecycle", why: "The write guards." },
  "src/lib/patients/lifecycle-display.ts": { meaning: "lifecycle", why: "Banner data for deleted/merged records." },
  "src/lib/actions/patients/lifecycle.ts": { meaning: "lifecycle", why: "Delete dialog preview of the target record." },
  "src/lib/notifications/active-patient-recipient.ts": { meaning: "lifecycle", why: "Final recipient check before every patient email/SMS." },
  "scripts/seed-test-users.ts": { meaning: "lifecycle", why: "Fixture lookup refuses a DRM-ID held by an inactive record." },
  "scripts/seed-sample-results.ts": { meaning: "lifecycle", why: "Fixture lookup refuses a DRM-ID held by an inactive record." },
  "scripts/seed-screenshot-data.ts": { meaning: "lifecycle", why: "Fixture lookup refuses a DRM-ID held by an inactive record." },
  "scripts/smoke-chemistry-consolidated.ts": { meaning: "lifecycle", why: "Fixture lookup refuses a DRM-ID held by an inactive record." },

  // --- mixed ----------------------------------------------------------------
  [`src/${S}/admin/patient-merge/actions.ts`]: { meaning: "mixed", why: "Preview/candidates are active; merge and undo load lifecycle; the recent-merges list is history." },
  "scripts/patient-dedup/engine.ts": { meaning: "mixed", why: "loadRows is active; mergeOne re-reads lifecycle before writing." },
};

const isCheckable = (p: string) =>
  /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && !/\.d\.ts$/.test(p);

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

interface Chain {
  file: string;
  line: number;
  methods: string[];
  isArgs: [string | null, string | null][]; // .is(col, value) pairs
  selectText: string;
  wrappedActive: boolean;
  isWrite: boolean;
}

const WRITE = new Set(["insert", "update", "delete", "upsert"]);

function scanSource(text: string, full: string): Chain[] {
  if (!text.includes('"patients"')) return [];
  const src = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true,
    full.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const consts = new Map<string, string>();
  const collectConsts = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
        && (ts.isStringLiteralLike(n.initializer))) consts.set(n.name.text, n.initializer.text);
    n.forEachChild(collectConsts);
  };
  collectConsts(src);
  // Strip the wrapper syntax a literal can hide behind — `"patients" as const`,
  // `("patients")`, `"patients" satisfies string`, `x!` — so the scanner sees
  // through them to the literal underneath instead of going blind on the site.
  const unwrap = (n: ts.Node): ts.Node => {
    if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) return unwrap(n.expression);
    if (ts.isParenthesizedExpression(n)) return unwrap(n.expression);
    if (ts.isNonNullExpression(n)) return unwrap(n.expression);
    return n;
  };
  const lit = (a: ts.Node | undefined): string | null => {
    if (!a) return null;
    const n = unwrap(a);
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isTemplateExpression(n)) return n.getText(src);
    if (ts.isIdentifier(n)) return consts.get(n.text) ?? null;
    if (n.kind === ts.SyntaxKind.NullKeyword) return "null";
    return null;
  };
  const out: Chain[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "from" && lit(node.arguments[0]) === "patients") {
      const methods = ["from"];
      const isArgs: [string | null, string | null][] = [];
      let selectText = "";
      let current: ts.Node = node;
      for (;;) {
        const access = current.parent;
        if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== current) break;
        const call = access.parent;
        if (!call || !ts.isCallExpression(call) || call.expression !== access) break;
        const m = access.name.text;
        methods.push(m);
        if (m === "is") isArgs.push([lit(call.arguments[0]), lit(call.arguments[1])]);
        if (m === "select") selectText += " " + (lit(call.arguments[0]) ?? "");
        current = call;
      }
      const parent = current.parent;
      const wrappedActive = !!parent && ts.isCallExpression(parent)
        && ts.isIdentifier(parent.expression) && parent.expression.text === "activePatients";
      // A wrapped chain continues after activePatients(...): collect those links too.
      if (wrappedActive) {
        let cur: ts.Node = parent;
        for (;;) {
          const access = cur.parent;
          if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== cur) break;
          const call = access.parent;
          if (!call || !ts.isCallExpression(call) || call.expression !== access) break;
          methods.push(access.name.text);
          cur = call;
        }
      }
      out.push({
        file: rel(full),
        line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1,
        methods, isArgs, selectText, wrappedActive,
        isWrite: methods.some((m) => WRITE.has(m)),
      });
    }
    node.forEachChild(visit);
  };
  visit(src);
  return out;
}

const chains = DIRS.flatMap((d) => walk(d)).flatMap((f) => scanSource(readFileSync(f, "utf8"), f));
const reads = chains.filter((c) => !c.isWrite);

const isActiveFiltered = (c: Chain) =>
  c.wrappedActive ||
  (c.isArgs.some(([col, v]) => col === "deleted_at" && v === "null") &&
   c.isArgs.some(([col, v]) => col === "merged_into_id" && v === "null"));
// History must keep BOTH deleted and merged records visible, so a read that
// filters on EITHER column alone already breaks it — this is deliberately
// looser than isActiveFiltered (which requires both, the "active" bar).
const filtersEither = (c: Chain) =>
  c.wrappedActive ||
  c.isArgs.some(([col, v]) => (col === "deleted_at" || col === "merged_into_id") && v === "null");
const readsLifecycle = (c: Chain) => /\bdeleted_at\b/.test(c.selectText) && /\bmerged_into_id\b/.test(c.selectText)
  || /PATIENT_LIFECYCLE_COLUMNS/.test(c.selectText);
const at = (c: Chain) => `${c.file}:${c.line}`;

describe("patients reads declare the active rule", () => {
  it("finds patients reads to scan (guards a broken walk)", () => {
    expect(reads.length).toBeGreaterThan(30);
  });

  it("classifies every file that reads patients", () => {
    const unclassified = [...new Set(reads.map((c) => c.file))].filter((f) => !SURFACES[f]).sort();
    expect(unclassified, "Add each file to SURFACES with a meaning and a why (see the header).").toEqual([]);
  });

  it("has no stale SURFACES entries", () => {
    const files = new Set(reads.map((c) => c.file));
    expect(Object.keys(SURFACES).filter((f) => !files.has(f))).toEqual([]);
  });

  it("filters every active read", () => {
    const bad = reads.filter((c) => SURFACES[c.file]?.meaning === "active" && !isActiveFiltered(c)).map(at);
    expect(bad, "Wrap the builder in activePatients(...) — directly, not via a later reassignment.").toEqual([]);
  });

  it("never filters a history read", () => {
    const bad = reads.filter((c) => SURFACES[c.file]?.meaning === "history" && filtersEither(c)).map(at);
    expect(bad, "History must keep deleted and merged records visible.").toEqual([]);
  });

  it("selects the lifecycle columns on every lifecycle read", () => {
    const bad = reads.filter((c) => SURFACES[c.file]?.meaning === "lifecycle" && !readsLifecycle(c)).map(at);
    expect(bad).toEqual([]);
  });

  it("leaves no unexplained chain in a mixed file", () => {
    // In a mixed file every read is either active-filtered or selects the
    // lifecycle columns (a history read in a mixed file selects them too, so
    // it can show the record's state and so this rule stays per-chain).
    const bad = reads.filter((c) => SURFACES[c.file]?.meaning === "mixed"
      && !isActiveFiltered(c) && !readsLifecycle(c)).map(at);
    expect(bad).toEqual([]);
  });

  it("scanner polarity: a .not(deleted_at) chain is not active", () => {
    const [c] = scanSource(`db.from("patients").select("id").not("deleted_at", "is", null).is("merged_into_id", null)`, "x.ts");
    expect(isActiveFiltered(c!)).toBe(false);
    const [w] = scanSource(`activePatients(db.from("patients").select("id")).eq("id", x)`, "y.ts");
    expect(isActiveFiltered(w!)).toBe(true);
  });

  it("sees through AsExpression, ParenthesizedExpression, SatisfiesExpression and NonNullExpression on the table-name literal", () => {
    const forms = [
      `db.from("patients" as const).select("id")`,
      `db.from(("patients")).select("id")`,
      `db.from("patients" satisfies string).select("id")`,
      `db.from("patients"!).select("id")`,
    ];
    for (const form of forms) {
      const chains = scanSource(form, "wrapped.ts");
      expect(chains, form).toHaveLength(1);
    }
  });

  it("control: .from(\"visits\") is never picked up as a patients read", () => {
    const chains = scanSource(`db.from("visits" as const).select("id")`, "control.ts");
    expect(chains).toHaveLength(0);
  });
});

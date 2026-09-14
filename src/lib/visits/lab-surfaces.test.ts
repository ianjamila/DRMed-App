/**
 * Lab-surface coverage for `test_requests`.
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
const TABLE = "test_requests";

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

interface Chain {
  file: string;
  line: number;
  /** Method names in call order, e.g. ["from", "select", "eq", "not"]. */
  methods: string[];
  /** Every string literal passed anywhere in the chain. */
  literals: string[];
  /** Every identifier referenced anywhere in the chain. */
  identifiers: string[];
  /** Source text of the nearest enclosing function (or the whole file). */
  scopeText: string;
}

const WRITE_METHODS = new Set(["insert", "update", "delete", "upsert"]);

/** True when `node` is `<something>.from("test_requests")`. */
function isTableFrom(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "from") {
    return false;
  }
  const [arg] = node.arguments;
  return !!arg && ts.isStringLiteralLike(arg) && arg.text === TABLE;
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
  if (!text.includes(TABLE)) return [];

  const src = ts.createSourceFile(
    full,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    full.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const consts = stringConstants(src);
  const chains: Chain[] = [];

  const visit = (node: ts.Node) => {
    if (isTableFrom(node)) {
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
        methods,
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

const describeChain = (c: Chain) => `${c.file}:${c.line}`;

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe("lab surfaces exclude doctor lines", () => {
  it("finds test_requests queries to scan (guard against a bad walk)", () => {
    expect(allChains.length).toBeGreaterThan(20);
    expect(readChains.length).toBeGreaterThan(10);
  });

  it("classifies every file that reads test_requests", () => {
    const unclassified = [
      ...new Set(readChains.map((c) => c.file)),
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
        const chains = readChains.filter((c) => c.file === file);
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
    const seen = new Set(readChains.map((c) => c.file));
    const stale = Object.keys(SURFACES).filter((f) => !seen.has(f));
    expect(
      stale.sort(),
      `These SURFACES entries no longer read ${TABLE} — delete them so the ` +
        `list stays a true map of the surfaces that exist.`,
    ).toEqual([]);
  });

  it("excludes doctor lines from every lab-meaning read", () => {
    const missing = readChains
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
    const overFiltered = readChains
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
    const leftJoined = readChains
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

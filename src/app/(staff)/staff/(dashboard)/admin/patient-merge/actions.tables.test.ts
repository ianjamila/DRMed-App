import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0167: current_patient_id() is active-only, so once a patient is merged
// away, its portal session can no longer reach ANY row still pointing at the
// tombstoned id through RLS. Merge (and undo) must move every FK table that
// carries a direct patient_id — including appointment_attachments, whose
// lab-request uploads have no other owner (they hang off patient_id, not
// off an appointment/visit row that itself moves). This pins the table list
// on both the app-level merge action and the CLI dedup engine so a future
// new FK-to-patients table can't be added to one and silently forgotten on
// the other.

const ACTIONS_FILE = join(
  process.cwd(),
  "src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts",
);
const ENGINE_FILE = join(process.cwd(), "scripts/patient-dedup/engine.ts");

const actionsSrc = readFileSync(ACTIONS_FILE, "utf8");
const engineSrc = readFileSync(ENGINE_FILE, "utf8");

// The FK tables every merge path must move, keyed to the literal moved[]/
// movedIds key each implementation uses.
const FK_TABLES = [
  "visits",
  "appointments",
  "audit_log",
  "critical_alerts",
  "patient_consents",
  "appointment_attachments",
];

describe("patient merge moves every patient_id FK table", () => {
  it("app-level merge (mergePatientsAction) reassigns each table to keep_id", () => {
    for (const table of FK_TABLES) {
      const re = new RegExp(
        `\\.from\\("${table}"\\)\\s*\\n?\\s*\\.update\\(\\{ patient_id: keep_id \\}\\)`,
      );
      expect(actionsSrc, `mergePatientsAction must reassign ${table}`).toMatch(re);
    }
  });

  it("app-level undo (undoMergeAction) re-points each table back to source_id", () => {
    for (const table of FK_TABLES) {
      const re = new RegExp(
        `\\.from\\("${table}"\\)\\.update\\(\\{ patient_id: m\\.source_id \\}\\)`,
      );
      expect(actionsSrc, `undoMergeAction must re-point ${table}`).toMatch(re);
    }
  });

  it("appointment_attachments is captured in the moved-ids ledger and the audited/returned counts", () => {
    expect(actionsSrc).toMatch(/appointment_attachments:\s*\(attachments \?\? \[\]\)\.map/);
    expect(actionsSrc).toMatch(/appointment_attachments: attachments\?\.length \?\? 0/);
  });

  it("CLI dedup engine (mergeOne) reassigns the same FK_TABLES set", () => {
    // Extract the literal FK_TABLES array declaration itself — not just a
    // "${table}" match anywhere in the file, which a comment or an unrelated
    // string could satisfy without the table actually being in the list.
    const decl = /const FK_TABLES = \[([^\]]*)\]/.exec(engineSrc);
    expect(decl, "engine.ts must declare a FK_TABLES array").toBeTruthy();
    const engineTables = Array.from((decl![1].matchAll(/"([^"]+)"/g))).map((m) => m[1]);
    for (const table of FK_TABLES) {
      expect(engineTables, `FK_TABLES must include ${table}`).toContain(table);
    }
    // And no extra table on the engine side that the app-level merge doesn't
    // also move — the two lists must stay in lockstep both ways.
    expect(engineTables.sort()).toEqual([...FK_TABLES].sort());
  });
});

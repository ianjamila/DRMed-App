import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EDIT_COMMIT_0179_HUNKS } from "@/lib/results/edit-commit-0179-hunks";

// 0184 (patient lifecycle locks) owns the FINAL body of these functions.
// A fresh replay applies migrations in NUMBER order, prod in SHIP order, so
// both must end on a body that carries 0184's lock (Codex plan review P1-3):
//  1. the highest-numbered definition carries the function's lifecycle marker;
//  2. no migration numbered below 0184 defines it except those already on
//     main when 0184 shipped (frozen below). A branch numbered below 0184
//     that still needs to change one of these (0170 sheet-sync:
//     resolve_patient_guarded; 0183 waived-balance: correct_payment) must
//     put that re-creation in a NEW migration, claimed fresh, numbered above
//     0184, whose body is 0184's plus its own edits.
//  3. 0184's result_edit_commit still carries every 0179 hunk.

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const FILES = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const LIFECYCLE = "0184_patient_lifecycle_locks.sql";

type Owned = { marker: (body: string) => boolean; allowedBelow: readonly string[] };

// allowedBelow: FROZEN at implementation from
// `grep -liE "create +(or +replace +)?function +public\.<name>\(" supabase/migrations/*.sql`
// on this branch (2026-09-28, HEAD d7bb490c) — every file below 0184 that
// re-creates the function, taken verbatim from that grep's output, never by
// hand-guessing.
export const OWNED: Record<string, Owned> = {
  delete_patient: { marker: (b) => /for\s+no\s+key\s+update/i.test(b), allowedBelow: ["0167_patient_soft_delete.sql"] },
  restore_patient: { marker: (b) => /for\s+no\s+key\s+update/i.test(b), allowedBelow: ["0167_patient_soft_delete.sql"] },
  result_save_draft: { marker: (b) => /lifecycle_lock_results[\s\S]*lifecycle_lock_and_assert/.test(b), allowedBelow: ["0172_result_edit_commit.sql"] },
  result_finalise_commit: { marker: (b) => /lifecycle_lock_results[\s\S]*lifecycle_lock_and_assert/.test(b), allowedBelow: ["0172_result_edit_commit.sql"] },
  result_edit_commit: {
    marker: (b) => /lifecycle_lock_results[\s\S]*lifecycle_lock_and_assert/.test(b),
    allowedBelow: ["0172_result_edit_commit.sql", "0176_result_patient_download_and_remarks.sql", "0179_result_copy_followups.sql"],
  },
  correct_payment: {
    marker: (b) => /lifecycle_lock_and_assert/.test(b),
    allowedBelow: ["0161_payment_correction.sql", "0174_correct_payment_stale_guard.sql", "0183_waived_balance_gl.sql"],
  },
  appointments_insert_slot_guarded: {
    marker: (b) => /lifecycle_lock_and_assert/.test(b),
    allowedBelow: ["0112_booking_hardening.sql", "0154_website_messages_inbox.sql"],
  },
  resolve_patient_guarded: {
    marker: (b) => /lifecycle_lock\(/.test(b) && /lower\(p\.last_name\)/.test(b),
    allowedBelow: ["0112_booking_hardening.sql", "0158_resolve_patient_referral_source.sql", "0167_patient_soft_delete.sql", "0170_sheet_sync_foundation.sql"],
  },
  current_patient_id: {
    marker: (b) => !/app\.current_patient_id/.test(b),
    allowedBelow: ["0001_init.sql", "0114_portal_rls_enforcement.sql", "0167_patient_soft_delete.sql"],
  },
  recompute_hmo_batch_status: { marker: (b) => /for\s+no\s+key\s+update/i.test(b), allowedBelow: ["0034_hmo_ar_subledger.sql"] },
  // Controller correction (Task 15, 2026-09-28): 0184 ALSO re-creates
  // recompute_clinic_fee_for_unreleased (section (4f), copied verbatim from
  // 0136 with an active-patient filter added). Earlier definers: 0065, 0066,
  // 0129, 0136 (0118 only changed grants; 0180 only `comment on function` —
  // neither re-creates the body, confirmed by the create-or-replace grep).
  recompute_clinic_fee_for_unreleased: {
    marker: (b) => /pt\.deleted_at\s+is\s+null\s+and\s+pt\.merged_into_id\s+is\s+null/i.test(b),
    allowedBelow: [
      "0065_recompute_clinic_fee_helper.sql",
      "0066_fix_recompute_clinic_fee.sql",
      "0129_physician_fee_defaults.sql",
      "0136_physician_compensation_table.sql",
    ],
  },
};

/** Every definition of public.<name>(…) in the given files: [file, body] in file order. */
export function definitions(files: { name: string; text: string }[], name: string): [string, string][] {
  const head = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "gi");
  const out: [string, string][] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(head)) {
      const start = m.index!;
      // The function's dollar-quote tag varies (`$$`, `$function$`, …) — find
      // the tag actually used right after this signature (the first `as
      // <tag>` following it) rather than assuming `$$`, so a body that closes
      // with a different tag (e.g. recompute_clinic_fee_for_unreleased in
      // 0136/0184, which use `$function$`) is not silently over-captured
      // through to some unrelated later function's `$$;`.
      const window = f.text.slice(start, start + 20000);
      const tagMatch = /\bas\s+(\$[a-zA-Z_]*\$)/i.exec(window);
      const tag = tagMatch ? tagMatch[1] : "$$";
      const searchFrom = tagMatch ? start + tagMatch.index + tagMatch[0].length : start;
      const end = f.text.indexOf(`\n${tag};`, searchFrom);
      out.push([f.name, f.text.slice(start, end < 0 ? undefined : end)]);
    }
  }
  return out;
}

/** Problems with the owned functions over a migration set (pure, so it can be mutation-tested). */
export function ownedFunctionProblems(files: { name: string; text: string }[]): string[] {
  const problems: string[] = [];
  for (const [name, o] of Object.entries(OWNED)) {
    const defs = definitions(files, name);
    const last = defs.at(-1);
    if (!last) { problems.push(`${name}: no definition`); continue; }
    if (last[0] < LIFECYCLE) problems.push(`${name}: last defined in ${last[0]}, below 0184`);
    if (!o.marker(last[1])) problems.push(`${name}: its highest-numbered definition (${last[0]}) lost the 0184 lifecycle marker`);
    for (const [file] of defs) {
      if (file < LIFECYCLE && !o.allowedBelow.includes(file)) {
        problems.push(`${name}: re-created in ${file}, numbered below 0184 — move it to a new migration above 0184 (see the replay rule)`);
      }
    }
  }
  return problems;
}

const real = FILES.map((name) => ({ name, text: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));

describe("0184-owned functions survive replay AND ship order", () => {
  it("no problems on the real migrations", () => {
    expect(ownedFunctionProblems(real)).toEqual([]);
  });

  it("mutation: a lower-numbered branch re-creating correct_payment is caught", () => {
    const body = definitions(real, "correct_payment").at(-1)![1];
    // A synthetic name that can never be in allowedBelow (Codex recheck P3 —
    // 0183 itself may legitimately be allow-listed if it lands first).
    const intruder = { name: "0183_zz_synthetic_intruder.sql", text: `${body}\n$$;` };
    const files = [...real, intruder].sort((a, b) => a.name.localeCompare(b.name));
    expect(ownedFunctionProblems(files).join("\n")).toMatch(/correct_payment: re-created in 0183_zz_synthetic_intruder\.sql/);
  });

  it("mutation: a higher-numbered definition without the lock is caught", () => {
    const files = [...real, { name: "9999_later.sql", text: "create or replace function public.correct_payment(x uuid) returns void language sql as $$ select 1\n$$;" }];
    expect(ownedFunctionProblems(files).join("\n")).toMatch(/correct_payment: its highest-numbered definition \(9999_later\.sql\) lost/);
  });

  it("0184's result_edit_commit still carries every 0179 hunk", () => {
    const body = definitions(real, "result_edit_commit").find(([f]) => f === LIFECYCLE)![1];
    for (const h of EDIT_COMMIT_0179_HUNKS) expect(body, h.label).toContain(h.to);
  });

  it("0184's recompute_clinic_fee_for_unreleased body is captured to its own $function$ close, not over-captured", () => {
    const body = definitions(real, "recompute_clinic_fee_for_unreleased").find(([f]) => f === LIFECYCLE)![1];
    // Over-capture would run past this function into resolve_patient_guarded (5).
    expect(body).not.toContain("resolve_patient_guarded");
  });
});

// Pins 0170's SQL accent fold (v_accent_from / v_accent_to, used by
// sheet_sync_apply_customer_ops's create-branch concurrent-registration
// recheck) against names.ts's nameNormOf/normalizeName — the same
// "read the source of truth" idea as format.test.ts's CHECK-list tests.
// Reads the two translate() literals straight out of the migration text, so
// a hand-edit to either list is caught here instead of silently drifting
// from what normalizeName actually folds a character to.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeName } from "../legacy-import/normalize-name";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/0170_sheet_sync_foundation.sql"),
  "utf8",
);

function constText(name: string): string {
  const re = new RegExp(`${name}\\s+constant\\s+text\\s*:=\\s*'([^']*)'`);
  const m = re.exec(MIGRATION);
  if (!m) throw new Error(`${name} not found in 0170 — regex is broken or the constant was renamed`);
  return m[1];
}

const ACCENT_FROM = constText("v_accent_from");
const ACCENT_TO = constText("v_accent_to");

describe("0170's SQL accent fold matches names.ts's normalizeName", () => {
  it("found both lists and they're the same length (regex isn't broken)", () => {
    expect(ACCENT_FROM.length).toBeGreaterThan(0);
    expect(ACCENT_FROM.length).toBe(ACCENT_TO.length);
  });

  it("every accented character folds to normalizeName's answer for it", () => {
    for (let i = 0; i < ACCENT_FROM.length; i++) {
      const accented = ACCENT_FROM[i];
      const expected = ACCENT_TO[i];
      expect(normalizeName(accented), `char ${i} (${accented})`).toBe(expected);
    }
  });

  it("the uppercase form of each character folds the same way once lower-cased (the SQL lower()s first)", () => {
    for (let i = 0; i < ACCENT_FROM.length; i++) {
      const accented = ACCENT_FROM[i].toUpperCase();
      const expected = ACCENT_TO[i];
      expect(normalizeName(accented.toLowerCase()), `char ${i} (${accented})`).toBe(expected);
    }
  });

  it("a full accented name folds to the same normalized string in JS and via a translate() simulation of the SQL", () => {
    const sqlFold = (s: string) => {
      let out = "";
      for (const ch of s.toLowerCase()) {
        const idx = ACCENT_FROM.indexOf(ch);
        out += idx === -1 ? ch : ACCENT_TO[idx];
      }
      return out.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    };
    // "Peña, José" — an invented name (never a real patient), covering ñ and é.
    expect(sqlFold("Peña")).toBe(normalizeName("Peña"));
    expect(sqlFold("José")).toBe(normalizeName("José"));
  });
});

import { describe, expect, it } from "vitest";
import {
  claimFileName,
  claimedNumberOf,
  formatMigration,
  formatPCode,
  migrationNumberOf,
  nextFree,
  pCodesIn,
} from "./number-claims.mjs";

describe("number claims", () => {
  it("reads a migration number from a file name or path", () => {
    expect(migrationNumberOf("0162_consent_list_and_record_fidelity.sql")).toBe(162);
    expect(migrationNumberOf("supabase/migrations/0007_x.sql")).toBe(7);
    expect(migrationNumberOf("README.md")).toBeNull();
    expect(migrationNumberOf("0162.sql")).toBeNull();
  });

  it("finds every P-code in SQL or TypeScript text", () => {
    expect(pCodesIn(`raise exception 'x' using errcode = 'P0057'; case "P0062": P00 P12345`)).toEqual([57, 62]);
  });

  it("takes the number above the highest seen, never a gap", () => {
    expect(nextFree([160, 162, 163, 166, 170])).toBe(171);
    expect(nextFree([])).toBe(1);
  });

  it("round-trips claim file names", () => {
    expect(claimFileName("migration", 171)).toBe("migration-0171");
    expect(claimFileName("pcode", 65)).toBe("pcode-P0065");
    expect(claimedNumberOf("migration", "migration-0171")).toBe(171);
    expect(claimedNumberOf("pcode", "pcode-P0065")).toBe(65);
    expect(claimedNumberOf("pcode", "migration-0171")).toBeNull();
    expect(formatMigration(9)).toBe("0009");
    expect(formatPCode(9)).toBe("P0009");
  });
});

import { describe, it, expect } from "vitest";
import {
  missingRequiredImportColumns,
  parseImportCsv,
  PatientImportRowSchema,
} from "./patient-import";

// Bug: the admin CSV import rejected a file that left out optional columns
// (middle_name, sex, phone, email, address) instead of treating the omitted
// column the same as a blank cell. Papa.parse only puts a key in the row
// object for headers that exist in the file, so an omitted column comes back
// as `undefined`, not `""` — the schema didn't accept `undefined` for those
// fields. These tests exercise the same parse-then-validate pipeline the
// server action uses (`parseImportCsv` + `PatientImportRowSchema`).

describe("import CSV: omitted optional columns", () => {
  it("(a) a file with only the required columns imports", () => {
    const csv = `first_name,last_name,birthdate\nMaria,Santos,1985-03-12`;
    const parsed = parseImportCsv(csv);
    expect(parsed.errors).toHaveLength(0);
    expect(missingRequiredImportColumns(parsed.meta.fields ?? [])).toHaveLength(0);

    const result = PatientImportRowSchema.safeParse(parsed.data[0]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        first_name: "Maria",
        last_name: "Santos",
        birthdate: "1985-03-12",
        middle_name: null,
        sex: null,
        phone: null,
        email: null,
        address: null,
      });
    }
  });

  it("(b) some optional columns omitted, others present, in a different column order", () => {
    // email, middle_name and address are left out entirely; phone and sex
    // are present, and the whole header order is shuffled from EXPECTED_COLUMNS.
    const csv = `phone,last_name,first_name,birthdate,sex\n+639171234567,dela Cruz,Juan,1972-11-08,male`;
    const parsed = parseImportCsv(csv);
    expect(parsed.errors).toHaveLength(0);
    expect(missingRequiredImportColumns(parsed.meta.fields ?? [])).toHaveLength(0);

    const result = PatientImportRowSchema.safeParse(parsed.data[0]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        first_name: "Juan",
        last_name: "dela Cruz",
        middle_name: null,
        birthdate: "1972-11-08",
        sex: "male",
        phone: "+639171234567",
        email: null,
        address: null,
      });
    }
  });

  it("(c) a missing REQUIRED column still fails with today's message", () => {
    // birthdate header is missing entirely.
    const csv = `first_name,last_name\nMaria,Santos`;
    const parsed = parseImportCsv(csv);
    expect(parsed.errors).toHaveLength(0);

    const missing = missingRequiredImportColumns(parsed.meta.fields ?? []);
    expect(missing).toEqual(["birthdate"]);
    // Same string the server action returns today.
    const message = `Missing required columns: ${missing.join(", ")}.`;
    expect(message).toBe("Missing required columns: birthdate.");
  });

  it("(d) an empty cell and an omitted column produce the same parsed row", () => {
    const withBlankCell = {
      first_name: "Ana",
      last_name: "Lim",
      birthdate: "1990-06-22",
      middle_name: "",
      sex: "",
      phone: "",
      email: "",
      address: "",
    };
    const withOmittedColumns = {
      first_name: "Ana",
      last_name: "Lim",
      birthdate: "1990-06-22",
      // middle_name, sex, phone, email, address all absent.
    };

    const blankResult = PatientImportRowSchema.safeParse(withBlankCell);
    const omittedResult = PatientImportRowSchema.safeParse(withOmittedColumns);

    expect(blankResult.success).toBe(true);
    expect(omittedResult.success).toBe(true);
    if (blankResult.success && omittedResult.success) {
      expect(omittedResult.data).toEqual(blankResult.data);
    }
  });
});

describe("missingRequiredImportColumns", () => {
  it("still flags unknown/misspelled headers as not satisfying the requirement", () => {
    // "birth_date" (misspelled) does not count as "birthdate" being present.
    const missing = missingRequiredImportColumns([
      "first_name",
      "last_name",
      "birth_date",
    ]);
    expect(missing).toEqual(["birthdate"]);
  });

  it("reports nothing missing when all three required columns are present", () => {
    const missing = missingRequiredImportColumns([
      "last_name",
      "first_name",
      "birthdate",
      "some_unknown_column",
    ]);
    expect(missing).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { refuseGeneratedTypes } from "./db-types-check.mjs";

const ok = "export type Json = string\n\nexport type Database = {\n  public: {\n    Functions: {\n      staff_role: { Args: never; Returns: string }\n    }\n  }\n}\n";

describe("refuseGeneratedTypes", () => {
  it("accepts a normal generator run", () => {
    expect(refuseGeneratedTypes(ok)).toBeNull();
  });
  it("refuses empty or broken output, so a failed run never overwrites the types", () => {
    expect(refuseGeneratedTypes("")).toMatch(/no Database type/);
    expect(refuseGeneratedTypes("Error: connection refused")).toMatch(/no Database type/);
  });
  it("refuses dblink functions installed in public and says how to move them", () => {
    const polluted = ok.replace("staff_role:", "dblink_exec: { Args: { \"\": string }; Returns: string }\n      staff_role:");
    expect(refuseGeneratedTypes(polluted)).toMatch(/alter extension dblink set schema extensions/);
  });
});

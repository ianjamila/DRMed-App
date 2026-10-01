import { describe, expect, it } from "vitest";
import { refuseGeneratedTypes, typesSourceArgs } from "./db-types-check.mjs";

describe("typesSourceArgs", () => {
  it("defaults to the local stack", () => {
    expect(typesSourceArgs([])).toEqual({ args: ["--local"] });
  });
  it("accepts --workdir in both the spaced and the = form", () => {
    expect(typesSourceArgs(["--workdir", "/tmp/iso"])).toEqual({ args: ["--local", "--workdir", "/tmp/iso"] });
    expect(typesSourceArgs(["--workdir=/tmp/iso"])).toEqual({ args: ["--local", "--workdir", "/tmp/iso"] });
  });
  it("accepts --db-url in both forms", () => {
    expect(typesSourceArgs(["--db-url", "postgres://x"])).toEqual({ args: ["--db-url", "postgres://x"] });
    expect(typesSourceArgs(["--db-url=postgres://x"])).toEqual({ args: ["--db-url", "postgres://x"] });
  });
  it("refuses unknown or misspelled options instead of falling back to the shared stack", () => {
    expect(typesSourceArgs(["--work-dir=/tmp/iso"]).error).toBeTruthy();
    expect(typesSourceArgs(["/tmp/iso"]).error).toBeTruthy();
  });
  it("refuses a missing value, an empty value and both sources at once", () => {
    expect(typesSourceArgs(["--workdir"]).error).toBeTruthy();
    expect(typesSourceArgs(["--workdir="]).error).toMatch(/needs a value/);
    expect(typesSourceArgs(["--db-url="]).error).toMatch(/needs a value/);
    expect(typesSourceArgs(["--db-url", "postgres://x", "--workdir", "/tmp/iso"]).error).toMatch(/not both/);
  });
});

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

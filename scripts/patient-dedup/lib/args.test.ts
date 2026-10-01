// scripts/patient-dedup/lib/args.test.ts
import { describe, expect, it } from "vitest";
import { parseDedupArgs } from "./args";

const ADMIN = "a0000000-0000-4000-8000-000000000196";

describe("parseDedupArgs", () => {
  it("dry-run needs no actor", () => {
    expect(parseDedupArgs([])).toEqual({ commit: false, actor: null });
  });
  it("--commit requires --actor", () => {
    expect(() => parseDedupArgs(["--commit"])).toThrow(/--actor=<admin staff id>/);
  });
  it("accepts --actor=<uuid> and --actor <uuid>", () => {
    expect(parseDedupArgs(["--commit", `--actor=${ADMIN}`])).toEqual({ commit: true, actor: ADMIN });
    expect(parseDedupArgs(["--commit", "--actor", ADMIN])).toEqual({ commit: true, actor: ADMIN });
  });
  it("rejects a malformed actor", () => {
    expect(() => parseDedupArgs(["--commit", "--actor=admin"])).toThrow(/UUID/);
    expect(() => parseDedupArgs(["--commit", "--actor"])).toThrow(/UUID/);
  });
});

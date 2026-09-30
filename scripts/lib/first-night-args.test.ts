import { describe, expect, it } from "vitest";
import { EXIT_USAGE, resolveCliArgs } from "./first-night-args";

const TODAY = "2026-09-30";
const ok = (argv: string[]) => {
  const r = resolveCliArgs(argv, TODAY);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r;
};

describe("first-night CLI arguments", () => {
  it("defaults to the last 7 days ending today, threshold 40, text output", () => {
    expect(ok([])).toEqual({ ok: true, params: { from: "2026-09-24", to: TODAY, threshold: 40 }, json: false });
  });
  it("reads --from/--to/--threshold in both `--flag value` and `--flag=value` forms", () => {
    expect(ok(["--from", "2026-09-01", "--to=2026-09-10", "--threshold", "100"]).params).toEqual({ from: "2026-09-01", to: "2026-09-10", threshold: 100 });
  });
  it("--days counts back from --to (or today), inclusive", () => {
    expect(ok(["--days", "3"]).params).toMatchObject({ from: "2026-09-28", to: TODAY });
    expect(ok(["--days=1", "--to", "2026-09-10"]).params).toMatchObject({ from: "2026-09-10", to: "2026-09-10" });
  });
  it("accepts up to 400 days, refuses 401", () => {
    expect(ok(["--days", "400"]).params.from).toBe("2025-08-27");
    expect(resolveCliArgs(["--days", "401"], TODAY).ok).toBe(false);
  });
  it("--json sets json; --prod and other runner flags are ignored", () => {
    const r = ok(["--json", "--prod"]);
    expect(r.json).toBe(true);
    expect(r.params.to).toBe(TODAY);
  });
  it("accepts --yes (the env-guard flag that skips the prod countdown) and ignores it", () => {
    expect(ok(["--prod", "--yes"]).params.to).toBe(TODAY);
    expect(ok(["--yes", "--days", "2"]).params).toMatchObject({ from: "2026-09-29", to: TODAY });
  });
  it("usage errors exit 64, distinct from the check's own 1 (mismatch/error) and 2 (spike)", () => {
    expect(EXIT_USAGE).toBe(64);
  });
  it("refuses --days together with --from, a bad --days, and unknown flags", () => {
    const err = (argv: string[]) => { const r = resolveCliArgs(argv, TODAY); return r.ok ? [] : r.errors; };
    expect(err(["--days", "3", "--from", "2026-09-01"])[0]).toMatch(/either --days or --from/);
    expect(err(["--days", "0"])[0]).toMatch(/--days must be a whole number/);
    expect(err(["--days", "abc"])[0]).toMatch(/--days must be a whole number/);
    expect(err(["--frm", "2026-09-01"])[0]).toMatch(/Unknown option --frm/);
    expect(err(["--from"])[0]).toMatch(/--from needs a value/);
  });
  it("passes plain-English range errors through", () => {
    const r = resolveCliArgs(["--from", "2026-09-10", "--to", "2026-09-01"], TODAY);
    expect(!r.ok && r.errors[0]).toMatch(/first day must be on or before/);
  });
});

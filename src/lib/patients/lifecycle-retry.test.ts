import { describe, expect, it, vi } from "vitest";
import { isLifecycleRetryable, withLifecycleRetry } from "./lifecycle-retry";

type Out = { data: string | null; error: { code?: string | null; message: string } | null };
const ok: Out = { data: "done", error: null };
const err = (code: string | null): Out => ({ data: null, error: { code, message: code ?? "network" } });

describe("isLifecycleRetryable", () => {
  it("retries a moved record, a deadlock and a serialization failure", () => {
    for (const code of ["P0072", "40P01", "40001"]) expect(isLifecycleRetryable({ code })).toBe(true);
  });
  it("never retries a refusal, a missing code or success", () => {
    for (const code of ["P0058", "P0059", "23505", "P0073", null, undefined]) {
      expect(isLifecycleRetryable(code === undefined ? null : { code })).toBe(false);
    }
  });
});

describe("withLifecycleRetry", () => {
  it("returns the first result when it is not retryable", async () => {
    const call = vi.fn(async () => err("P0058"));
    expect(await withLifecycleRetry(call)).toEqual(err("P0058"));
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("calls exactly once more after P0072 and returns the second result", async () => {
    const call = vi.fn<() => Promise<Out>>().mockResolvedValueOnce(err("P0072")).mockResolvedValueOnce(ok);
    expect(await withLifecycleRetry(call)).toEqual(ok);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("does not loop: a second retryable failure is returned as is", async () => {
    const call = vi.fn(async () => err("40P01"));
    expect(await withLifecycleRetry(call)).toEqual(err("40P01"));
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("never retries an unknown outcome (no code) — it may have committed", async () => {
    const call = vi.fn(async () => err(null));
    await withLifecycleRetry(call);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

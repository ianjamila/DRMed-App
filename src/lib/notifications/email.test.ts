import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sendEmail } from "./email";

const INPUT = { to: "owner@example.com", subject: "S", text: "T" };

beforeEach(() => {
  vi.stubEnv("NOTIFICATIONS_LIVE", "true");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("RESEND_FROM_EMAIL", "DRMed <noreply@drmed.ph>");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const headersOf = (f: ReturnType<typeof vi.fn>) => (f.mock.calls[0]![1] as { headers: Record<string, string> }).headers;

describe("sendEmail", () => {
  it("returns the Resend id on a 2xx", async () => {
    stubFetch(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    expect(await sendEmail(INPUT)).toEqual({ ok: true, id: "em_1" });
  });

  it("sends an Idempotency-Key header only when one is given", async () => {
    const f1 = stubFetch(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    await sendEmail({ ...INPUT, idempotencyKey: "patient_sources_weekly:2026-09-28:owner@example.com:1" });
    expect(headersOf(f1)["Idempotency-Key"]).toBe("patient_sources_weekly:2026-09-28:owner@example.com:1");

    const f2 = stubFetch(async () => new Response(JSON.stringify({ id: "em_2" }), { status: 200 }));
    await sendEmail(INPUT);
    expect(headersOf(f2)["Idempotency-Key"]).toBeUndefined();
  });

  it("marks a non-2xx answer as a DEFINITE failure (Resend read the request and refused it)", async () => {
    stubFetch(async () => new Response("invalid", { status: 422 }));
    const r = await sendEmail(INPUT);
    expect(r).toMatchObject({ ok: false, kind: "error", definite: true });
    expect((r as { error: string }).error).toContain("422");
  });

  it("marks a thrown fetch as NOT definite (the request may have reached Resend)", async () => {
    stubFetch(async () => {
      throw new Error("socket hang up");
    });
    expect(await sendEmail(INPUT)).toMatchObject({ ok: false, kind: "error", definite: false, error: "socket hang up" });
  });

  it("marks a 2xx with an unreadable body as NOT definite (the mail was probably accepted)", async () => {
    stubFetch(async () => new Response("<html>not json</html>", { status: 200 }));
    expect(await sendEmail(INPUT)).toMatchObject({ ok: false, kind: "error", definite: false });
  });

  it("skips (and never calls fetch) when this environment is not live", async () => {
    vi.stubEnv("NOTIFICATIONS_LIVE", "");
    const f = stubFetch(async () => new Response("{}", { status: 200 }));
    const r = await sendEmail(INPUT);
    expect(r).toMatchObject({ ok: false, kind: "skipped" });
    expect(f).not.toHaveBeenCalled();
  });
});

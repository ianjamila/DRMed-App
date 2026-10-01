import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PROVIDER_TIMEOUT_MS } from "./channel-status";
import { sendEmail } from "./email";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NOTIFICATIONS_LIVE", "true");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("RESEND_FROM_EMAIL", "DRMed <noreply@example.test>");
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendEmail Idempotency-Key", () => {
  it("sends Idempotency-Key when given one", async () => {
    const r = await sendEmail({ to: "a@example.com", subject: "s", text: "t", idempotencyKey: "result-notice:n1:email" });
    expect(r).toEqual({ ok: true, id: "em_1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers).toMatchObject({ Authorization: "Bearer re_test_key", "Idempotency-Key": "result-notice:n1:email" });
  });

  it("sends no Idempotency-Key header when none is given (every other sender is unchanged)", async () => {
    await sendEmail({ to: "a@example.com", subject: "s", text: "t" });
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Idempotency-Key");
  });
});

describe("provider timeout", () => {
  it("bounds the Resend call with a 15 s abort signal and reports a timeout as an error (ambiguous, never 'sent')", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    const r = await sendEmail({ to: "a@example.com", subject: "s", text: "t" });
    expect(r).toMatchObject({ ok: false, kind: "error" });
    const init = fetchMock.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(PROVIDER_TIMEOUT_MS).toBe(15_000);
  });
});

describe("sendEmail — definite vs uncertain failures (Patient Sources digest, at most once)", () => {
  const INPUT = { to: "owner@example.com", subject: "S", text: "T" };

  it("marks a non-2xx answer as a DEFINITE failure (Resend read the request and refused it)", async () => {
    fetchMock.mockResolvedValue(new Response("invalid", { status: 422 }));
    const r = await sendEmail(INPUT);
    expect(r).toMatchObject({ ok: false, kind: "error", definite: true });
    expect((r as { error: string }).error).toContain("422");
  });

  it("marks a thrown fetch (incl. a timeout) as NOT definite (the request may have reached Resend)", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    expect(await sendEmail(INPUT)).toMatchObject({ ok: false, kind: "error", definite: false, error: "socket hang up" });
  });

  it("marks a 2xx with an unreadable body as NOT definite (the mail was probably accepted)", async () => {
    fetchMock.mockResolvedValue(new Response("<html>not json</html>", { status: 200 }));
    expect(await sendEmail(INPUT)).toMatchObject({ ok: false, kind: "error", definite: false });
  });

  it("skips (and never calls fetch) when this environment is not live", async () => {
    vi.stubEnv("NOTIFICATIONS_LIVE", "");
    const r = await sendEmail(INPUT);
    expect(r).toMatchObject({ ok: false, kind: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

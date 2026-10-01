import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sendSms } from "./sms";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NOTIFICATIONS_LIVE", "true");
  vi.stubEnv("SEMAPHORE_API_KEY", "key");
  vi.stubEnv("SEMAPHORE_SENDER_NAME", "DRMED");
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendSms timeout", () => {
  it("bounds the Semaphore call with an abort signal; a timeout is an error, never 'sent'", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    const r = await sendSms({ to: "09171234567", message: "hi" });
    expect(r).toMatchObject({ ok: false, kind: "error" });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ retryPatientNoticeAction: vi.fn() }));

import { retryPatientNoticeAction } from "./actions";
import { RetryNoticeButton } from "./retry-notice-button";

// 0188: a successful retry takes its row (and this button) off the list as
// the page re-renders, so the outcome travels in the URL to a banner at the
// top of the page instead of being shown here.

beforeEach(() => {
  vi.mocked(retryPatientNoticeAction).mockReset();
  router.replace.mockReset();
});
afterEach(cleanup);

describe("Retry notice", () => {
  it("retries this correction and hands the outcome to the page banner", async () => {
    vi.mocked(retryPatientNoticeAction).mockResolvedValue({ ok: true, data: { outcome: "sent" } });
    render(<RetryNoticeButton amendmentId="am-1" showingAll={false} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry notice" }));
    expect(retryPatientNoticeAction).toHaveBeenCalledWith("am-1");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/staff/result-follow-ups?retried=sent"));
  });

  it("keeps the followed-up view when it was showing", async () => {
    vi.mocked(retryPatientNoticeAction).mockResolvedValue({ ok: true, data: { outcome: "failed" } });
    render(<RetryNoticeButton amendmentId="am-1" showingAll />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry notice" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/staff/result-follow-ups?retried=failed&all=1"));
  });

  it("shows a refusal next to the button and stays on the page", async () => {
    vi.mocked(retryPatientNoticeAction).mockResolvedValue({ ok: false, error: "There's nothing to retry for this patient any more — refresh the list." });
    render(<RetryNoticeButton amendmentId="am-1" showingAll={false} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry notice" }));
    expect((await screen.findByRole("alert")).textContent).toContain("nothing to retry");
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retry notice" })).toBeTruthy();
  });
});

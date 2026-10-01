// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ retryReleaseNoticeAction: vi.fn() }));

import { retryReleaseNoticeAction } from "./actions";
import { RetryReleaseNoticeButton } from "./retry-release-notice-button";

beforeEach(() => {
  vi.mocked(retryReleaseNoticeAction).mockReset();
  router.replace.mockReset();
});
afterEach(cleanup);

describe("Retry sending", () => {
  it("queues the retry and hands the outcome to the page banner", async () => {
    vi.mocked(retryReleaseNoticeAction).mockResolvedValue({ ok: true, data: { queued: true } });
    render(<RetryReleaseNoticeButton noticeId="n-1" showingAll={false} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry sending" }));
    expect(retryReleaseNoticeAction).toHaveBeenCalledWith("n-1");
    expect(router.replace).toHaveBeenCalledWith("/staff/result-follow-ups?noticeRetried=1");
  });

  it("keeps the followed-up view when it was showing", async () => {
    vi.mocked(retryReleaseNoticeAction).mockResolvedValue({ ok: true, data: { queued: true } });
    render(<RetryReleaseNoticeButton noticeId="n-1" showingAll />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry sending" }));
    expect(router.replace).toHaveBeenCalledWith("/staff/result-follow-ups?noticeRetried=1&all=1");
  });

  it("shows a refusal next to the button and stays on the page", async () => {
    vi.mocked(retryReleaseNoticeAction).mockResolvedValue({ ok: false, error: "That notice isn't waiting for a retry any more — refresh the list." });
    render(<RetryReleaseNoticeButton noticeId="n-1" showingAll={false} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry sending" }));
    expect((await screen.findByRole("alert")).textContent).toContain("isn't waiting");
    expect(router.replace).not.toHaveBeenCalled();
  });
});

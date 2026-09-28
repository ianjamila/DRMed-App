import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoticeChannelsPanel } from "./notice-channels-panel";

describe("NoticeChannelsPanel", () => {
  it("shows each channel's status in words", () => {
    const html = renderToStaticMarkup(
      <NoticeChannelsPanel
        email={{ ready: true }}
        sms={{ ready: false, code: "not_configured", reason: "SEMAPHORE_API_KEY / SEMAPHORE_SENDER_NAME not configured" }}
      />,
    );
    expect(html).toContain("Sending status");
    expect(html).toContain("Ready");
    expect(html).toContain("Semaphore API key or sender name is missing");
    // The raw skip reason (setting names) stays out of the page.
    expect(html).not.toContain("SEMAPHORE_API_KEY");
  });
});

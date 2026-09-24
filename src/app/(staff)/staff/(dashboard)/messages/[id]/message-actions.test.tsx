import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("../actions", () => ({
  updateMessageKindAction: vi.fn(),
  updateMessageNotesAction: vi.fn(),
  updateMessageStatusAction: vi.fn(),
}));

import { MessageActionsPanel } from "./message-actions";

function render(canQuote: boolean) {
  return renderToStaticMarkup(
    <MessageActionsPanel
      messageId="msg-1"
      status="new"
      kind="general"
      staffNotes=""
      firstName="Ana"
      hasLinkedAppointment={false}
      canQuote={canQuote}
    />,
  );
}

// "Send a quote" links to /staff/quote, which only QUICK_QUOTE_ROLES may open.
// A viewer outside that list must not get a button that bounces them.
describe("Send a quote button", () => {
  it("shows for a viewer who may use Quick Quote", () => {
    const html = render(true);
    expect(html).toContain('href="/staff/quote?message=msg-1"');
    expect(html).toContain("Send a quote");
  });

  it("is hidden for a viewer who may not", () => {
    const html = render(false);
    expect(html).not.toContain("/staff/quote");
    expect(html).not.toContain("Send a quote");
    // The rest of the panel still renders.
    expect(html).toContain("Book appointment");
  });
});

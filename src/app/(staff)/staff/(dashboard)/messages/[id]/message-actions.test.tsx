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

function renderStatus(status: "new" | "replied" | "booked" | "closed") {
  return renderToStaticMarkup(
    <MessageActionsPanel
      messageId="msg-1"
      status={status}
      kind="general"
      staffNotes=""
      firstName="Ana"
      hasLinkedAppointment={false}
      canQuote={false}
    />,
  );
}

// The status buttons come from STATUS_TRANSITIONS — same labels and order as
// before the matrix existed (Mark replied / Mark closed / Reopen).
describe("status buttons follow the shared matrix", () => {
  const buttons = (html: string) =>
    [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]).filter((t) =>
      ["Mark replied", "Mark closed", "Reopen"].includes(t!),
    );
  it.each([
    ["new", ["Mark replied", "Mark closed"]],
    ["replied", ["Mark closed", "Reopen"]],
    ["booked", ["Mark closed", "Reopen"]],
    ["closed", ["Reopen"]],
  ] as const)("%s → %j", (status, want) => {
    expect(buttons(renderStatus(status))).toEqual(want);
  });
});

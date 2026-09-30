// @vitest-environment jsdom
// S4 (sync review gaps): a HANDLED (dismissed = "Keep deleted") deleted-patient
// match must not offer "Keep deleted" again — sheet_review_resolve only accepts
// link / create on it and refuses a second dismiss (P0064). The OPEN card keeps
// the button.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/staff/admin/sheet-sync",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("./actions", () => ({
  resolveReviewItemAction: vi.fn(),
  approveResortGroupAction: vi.fn(),
  mapAnswerToChannelAction: vi.fn(),
}));

import { HandledRows } from "./review-queue";
import { DeletedPatientMatchControls } from "./review-actions";

afterEach(cleanup);

const payload = {
  link_keys: ["reyes|ana#1990-01-01"],
  rows: [{ sheet_row: 12, link_key: "reyes|ana#1990-01-01", name_raw: "Reyes, Ana", dob: "1990-01-01", registered_on: null, phone_last4: null }],
  candidates: [],
  reason: "matches_deleted_patient",
  held_because: "matches_deleted_patient",
  deleted_patient_id: "gone-1",
};
const handledItem = (over: Record<string, unknown> = {}) => ({
  id: "item-1", tab: "customers" as const, item_key: "reyes|ana#1990-01-01", kind: "possible_existing_patient" as const,
  payload, status: "dismissed" as const, resolution: { action: "dismiss", keep_undone: true },
  resolved_by: null, resolved_at: "2026-09-30T02:00:00Z", first_seen_at: "2026-09-29T02:00:00Z", last_seen_at: "2026-09-30T02:00:00Z",
  ...over,
});

function renderHandled(item: ReturnType<typeof handledItem>) {
  return render(
    <table><tbody><HandledRows item={item} resolverNames={new Map()} /></tbody></table>,
  );
}

describe("deleted-patient match controls", () => {
  it("open card: Create, Keep deleted and Find the deleted record are all offered", () => {
    render(<DeletedPatientMatchControls itemId="item-1" rowLabel="row 12" />);
    expect(screen.getByRole("button", { name: /Create a new patient for row 12/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Keep row 12 deleted/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Find the deleted record/ })).toBeTruthy();
  });

  it("handled (kept deleted) item: no Keep deleted button, Create and Find still offered", () => {
    renderHandled(handledItem());
    expect(screen.getByText("Matches a deleted patient record")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /deleted$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Keep row 12 deleted/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Create a new patient for row 12/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Find the deleted record/ })).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: unknown[][] = [];
let reply: unknown;
vi.mock("./actions", () => ({
  releaseSelectedAction: async (...a: unknown[]) => {
    calls.push(a);
    return reply;
  },
  undoReleaseSelectedAction: async () => ({ ok: true, count: 0 }),
}));

import { ReleaseOutcomeProvider } from "@/components/staff/release/release-outcome";
import { REPORT_REFUSAL } from "@/lib/queue/report-release-scope";
import { BulkActionBar } from "./bulk-action-bar";
import { SelectionProvider, useRowSelection } from "./selection-context";

const scope = { memberIds: ["a", "b", "c"], label: "chemistry" };

function Select({ ids }: { ids: string[] }) {
  const { toggle } = useRowSelection();
  useEffect(() => {
    for (const id of ids) toggle(id, "release");
  }, [ids, toggle]);
  return null;
}

function bar(ids: string[], readyIds: string[]) {
  return (
    <ReleaseOutcomeProvider>
      <SelectionProvider>
        <Select ids={ids} />
        <BulkActionBar
          visitId="v1"
          moneySettled
          preferredMedium="email"
          consentOnFile
          gateRequired={false}
          viewedCountById={{}}
          reportScopeByTrId={{ a: scope, b: scope, c: scope }}
          readyIds={readyIds}
        />
      </SelectionProvider>
    </ReleaseOutcomeProvider>
  );
}

beforeEach(() => {
  calls.length = 0;
  reply = { ok: true, count: 1, alsoReleasedCount: 2, skipped: [], warnings: [] };
  vi.stubGlobal("alert", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BulkActionBar release", () => {
  it("previews the other ready members of a selected combined report", () => {
    render(bar(["a", "x"], ["a", "b", "c", "x"]));
    expect(
      screen.getByText("Releasing these also releases 2 other tests on the same combined report."),
    ).toBeTruthy();
  });

  it("shows no preview when the selection already covers the report or there is none", () => {
    render(bar(["a", "b", "c"], ["a", "b", "c"]));
    expect(screen.queryByText(/also releases/)).toBeNull();
  });

  it("reports the count, the pulled-in tests and each skipped reason through the provider", async () => {
    reply = {
      ok: true,
      count: 1,
      alsoReleasedCount: 2,
      skipped: [{ id: "x", reason: REPORT_REFUSAL.notFinished(1) }],
      warnings: [],
    };
    render(bar(["a", "x"], ["a", "b", "c", "x"]));
    fireEvent.click(screen.getByRole("button", { name: /Release selected/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const notice = await screen.findByText(/Also released 2 other tests/);
    expect(notice.textContent).toContain("Released 1 test.");
    expect(notice.textContent).toContain(REPORT_REFUSAL.notFinished(1));
    expect(alert).not.toHaveBeenCalled();
  });
});

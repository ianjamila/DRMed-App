// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReleaseOutcomeProvider, releaseOutcomeText, useReleaseOutcome } from "./release-outcome";

afterEach(cleanup);

const base = { changedCount: 0, alsoReleasedCount: 0, skipped: [], warnings: [] };

describe("releaseOutcomeText", () => {
  it("counts released tests", () => {
    expect(releaseOutcomeText({ ...base, changedCount: 1 })).toBe("Released 1 test.");
    expect(releaseOutcomeText({ ...base, changedCount: 3 })).toBe("Released 3 tests.");
  });
  it("mentions the other tests released on the same combined report", () => {
    expect(releaseOutcomeText({ ...base, changedCount: 1, alsoReleasedCount: 2 })).toBe(
      "Released 1 test.\nAlso released 2 other tests on the same combined report.",
    );
    expect(releaseOutcomeText({ ...base, alsoReleasedCount: 1 })).toContain("Also released 1 other test on");
  });
  it("includes skip reasons and warnings, de-duplicated", () => {
    const text = releaseOutcomeText({
      ...base,
      skipped: [{ id: "a", reason: "Not ready." }, { id: "b", reason: "Not ready." }],
      warnings: ["The patient was not notified."],
    });
    expect(text).toBe("Not ready.\nThe patient was not notified.");
  });
  it("is null when there is nothing to say", () => {
    expect(releaseOutcomeText(base)).toBeNull();
  });
});

function Trigger() {
  const outcome = useReleaseOutcome();
  return (
    <button type="button" onClick={() => outcome?.show("Released 1 test.\nThe patient was not notified.")}>
      go
    </button>
  );
}

describe("ReleaseOutcomeProvider", () => {
  it("keeps the notice after the triggering child unmounts; Dismiss removes it", () => {
    const { rerender } = render(
      <ReleaseOutcomeProvider>
        <Trigger />
      </ReleaseOutcomeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    rerender(<ReleaseOutcomeProvider>{null}</ReleaseOutcomeProvider>);
    expect(screen.getByRole("status").textContent).toContain("The patient was not notified.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("clears the notice when resetKey changes, and re-announces an identical message", () => {
    const { rerender } = render(
      <ReleaseOutcomeProvider resetKey="a">
        <Trigger />
      </ReleaseOutcomeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    const first = screen.getByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(screen.getByRole("status")).not.toBe(first); // remounted so the live region re-announces
    rerender(
      <ReleaseOutcomeProvider resetKey="a">
        <Trigger />
      </ReleaseOutcomeProvider>,
    );
    expect(screen.queryByRole("status")).not.toBeNull();
    rerender(
      <ReleaseOutcomeProvider resetKey="b">
        <Trigger />
      </ReleaseOutcomeProvider>,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("useReleaseOutcome is null outside a provider", () => {
    function Probe() {
      return <p>{useReleaseOutcome() === null ? "no provider" : "provider"}</p>;
    }
    render(<Probe />);
    expect(screen.getByText("no provider")).toBeTruthy();
  });
});

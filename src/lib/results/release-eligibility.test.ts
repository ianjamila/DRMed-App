import { describe, expect, it } from "vitest";
import { allLinksReleased } from "./release-eligibility";

describe("allLinksReleased", () => {
  it("a single-test result reduces to a plain released check (released)", () => {
    expect(allLinksReleased(["released"])).toBe(true);
  });

  it("a single-test result reduces to a plain released check (not released)", () => {
    expect(allLinksReleased(["ready_for_release"])).toBe(false);
    expect(allLinksReleased(["result_uploaded"])).toBe(false);
    expect(allLinksReleased(["in_progress"])).toBe(false);
  });

  it("a consolidated result with every sibling released is eligible", () => {
    expect(allLinksReleased(["released", "released", "released"])).toBe(true);
  });

  it("undoing ONE sibling's release withholds the whole shared PDF", () => {
    expect(allLinksReleased(["released", "released", "ready_for_release"])).toBe(
      false,
    );
  });

  it("fails closed on no links at all", () => {
    expect(allLinksReleased([])).toBe(false);
  });
});

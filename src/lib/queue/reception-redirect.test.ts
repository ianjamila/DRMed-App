import { describe, expect, it } from "vitest";
import { receptionQueueHref } from "./reception-redirect";

describe("receptionQueueHref", () => {
  it("lands on Released today with nothing else when there is nothing to carry", () => {
    expect(receptionQueueHref({})).toBe("/staff/queue?filter=released_today");
  });

  it("keeps the search, visit #, dates, page size and sort the link carried", () => {
    const href = receptionQueueHref({
      q: "Cruz FBS",
      visit: "37",
      start: "2026-09-01",
      end: "2026-09-30",
      size: "25",
      sort: "visit_number",
      dir: "desc",
    });
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/staff/queue");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      filter: "released_today",
      q: "Cruz FBS",
      visit: "37",
      start: "2026-09-01",
      end: "2026-09-30",
      size: "25",
      sort: "visit_number",
      dir: "desc",
    });
  });

  it("drops the page (a different tab's page 3 means nothing here) and the lab-only Mine toggle", () => {
    const url = new URL(receptionQueueHref({ filter: "all", page: "3", mine: "1", q: "Cruz" }), "http://x");
    expect(Object.fromEntries(url.searchParams)).toEqual({ filter: "released_today", q: "Cruz" });
  });

  it("drops blank values", () => {
    expect(receptionQueueHref({ q: "  ", visit: "" })).toBe("/staff/queue?filter=released_today");
  });
});

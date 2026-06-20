import { describe, it, expect } from "vitest";
import { REVIEW_PATH, reviewLink, reviewLinkAbsolute, reviewLinkSource } from "./review";

describe("reviewLinkSource", () => {
  it("passes through known sources", () => {
    expect(reviewLinkSource("receipt")).toBe("receipt");
    expect(reviewLinkSource("poster")).toBe("poster");
    expect(reviewLinkSource("portal")).toBe("portal");
    expect(reviewLinkSource("email")).toBe("email");
  });

  it("falls back to 'unknown' for missing or junk values", () => {
    expect(reviewLinkSource(null)).toBe("unknown");
    expect(reviewLinkSource(undefined)).toBe("unknown");
    expect(reviewLinkSource("")).toBe("unknown");
    expect(reviewLinkSource("RECEIPT")).toBe("unknown");
    expect(reviewLinkSource("../evil")).toBe("unknown");
  });
});

describe("reviewLink", () => {
  it("builds a relative tracked path", () => {
    expect(reviewLink("receipt")).toBe("/review?src=receipt");
    expect(reviewLink("portal")).toBe(`${REVIEW_PATH}?src=portal`);
  });
});

describe("reviewLinkAbsolute", () => {
  it("joins a base origin to the tracked path", () => {
    expect(reviewLinkAbsolute("https://drmed.ph", "email")).toBe(
      "https://drmed.ph/review?src=email",
    );
  });

  it("tolerates a trailing slash on the base", () => {
    expect(reviewLinkAbsolute("https://drmed.ph/", "poster")).toBe(
      "https://drmed.ph/review?src=poster",
    );
  });
});

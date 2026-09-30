import { describe, expect, it } from "vitest";
import { RELEASE_MEDIA, RELEASE_MEDIUM_OPTIONS, isReleaseMedium } from "./release-media";

describe("release media", () => {
  it("lists the six media the DB accepts, in dropdown order", () => {
    expect(RELEASE_MEDIA).toEqual(["physical", "email", "viber", "gcash", "pickup", "other"]);
    expect(RELEASE_MEDIUM_OPTIONS.map((o) => o.value)).toEqual([...RELEASE_MEDIA]);
    expect(RELEASE_MEDIUM_OPTIONS[0]).toEqual({ value: "physical", label: "Physical" });
  });
  it("narrows unknown input", () => {
    expect(isReleaseMedium("email")).toBe(true);
    expect(isReleaseMedium("fax")).toBe(false);
    expect(isReleaseMedium(null)).toBe(false);
  });
});

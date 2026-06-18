import { describe, it, expect } from "vitest";
import {
  to12h, hoursLabel, hoursWithLastRegistration, addressLines, streetAddressLine,
  telHref, directionsHrefs, mapEmbedSrc, isOpenNow,
} from "./nap";
import { CONTACT } from "./site";

describe("to12h", () => {
  it("formats 24h HH:mm as 12h with meridiem", () => {
    expect(to12h("08:00")).toBe("8:00 AM");
    expect(to12h("16:30")).toBe("4:30 PM");
    expect(to12h("17:00")).toBe("5:00 PM");
    expect(to12h("00:00")).toBe("12:00 AM");
    expect(to12h("12:00")).toBe("12:00 PM");
  });
});

describe("hours strings", () => {
  it("hoursLabel matches the canonical CONTACT.hours", () => {
    expect(hoursLabel()).toBe(CONTACT.hours);
    expect(hoursLabel()).toContain("8:00 AM");
  });
  it("hoursWithLastRegistration appends the reception cut-off", () => {
    expect(hoursWithLastRegistration()).toBe(
      "Monday – Saturday, 8:00 AM – 5:00 PM (last registration 4:30 PM)",
    );
  });
});

describe("address helpers", () => {
  it("addressLines returns [occupant line, street+city line]", () => {
    const [top, bottom] = addressLines();
    expect(top).toBe("4/F DRMed Clinic and Laboratory");
    expect(bottom).toBe("Northridge Plaza, Congressional Avenue, Quezon City");
  });
  it("streetAddressLine is the name-less mailing line with the floor", () => {
    expect(streetAddressLine()).toBe(
      "4/F Northridge Plaza, Congressional Avenue, Quezon City",
    );
  });
});

describe("hrefs", () => {
  it("telHref builds tel: links from E164 numbers", () => {
    expect(telHref("mobile")).toBe("tel:+639166043208");
    expect(telHref("landline")).toBe("tel:+63283553517");
  });
  it("directionsHrefs returns google/waze/apple deep links", () => {
    const d = directionsHrefs();
    expect(d.google).toMatch(/^https?:\/\//);
    expect(d.waze).toContain("waze.com");
    expect(d.apple).toContain("maps.apple.com");
  });
  it("mapEmbedSrc is a cookie-free output=embed url", () => {
    expect(mapEmbedSrc()).toContain("output=embed");
  });
});

describe("isOpenNow (Asia/Manila, Mon–Sat 08:00–17:00)", () => {
  it("open during business hours on a weekday", () => {
    // 2026-06-18 is a Thursday. 01:00Z = 09:00 Manila.
    expect(isOpenNow(new Date("2026-06-18T01:00:00Z"))).toBe(true);
    // 00:30Z = 08:30 Manila (just opened)
    expect(isOpenNow(new Date("2026-06-18T00:30:00Z"))).toBe(true);
  });
  it("closed before opening and after closing", () => {
    // 23:30Z Wed = 07:30 Manila Thu (before open)
    expect(isOpenNow(new Date("2026-06-17T23:30:00Z"))).toBe(false);
    // 09:30Z = 17:30 Manila (after close)
    expect(isOpenNow(new Date("2026-06-18T09:30:00Z"))).toBe(false);
  });
  it("open on Saturday (the week-boundary day Sunday is not)", () => {
    // 2026-06-20 is a Saturday. 03:00Z = 11:00 Manila Sat — within hours.
    expect(isOpenNow(new Date("2026-06-20T03:00:00Z"))).toBe(true);
  });
  it("closed all day Sunday", () => {
    // 2026-06-21 is a Sunday. 03:00Z = 11:00 Manila Sun.
    expect(isOpenNow(new Date("2026-06-21T03:00:00Z"))).toBe(false);
  });
});

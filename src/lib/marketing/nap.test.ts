import { describe, it, expect } from "vitest";
import {
  to12h, hoursLabel, hoursWithLastRegistration, addressLines, streetAddressLine,
  telHref, directionsHrefs, mapEmbedSrc, isOpenNow, clinicStatus, hoursLines, hoursAllLabel,
  openingHoursStrings, hoursSundayShort, to12hCompact,
} from "./nap";
import { CONTACT, HOURS } from "./site";

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

describe("Sunday lab-only hours stay in step with HOURS", () => {
  it("hoursSunday text is derived-consistent with HOURS.sunday", () => {
    expect(CONTACT.hoursSunday).toContain(to12h(HOURS.sunday.opens));
    expect(CONTACT.hoursSunday).toContain("12:00 NN");
    expect(HOURS.sunday.closes).toBe("12:00");
    expect(CONTACT.hoursSunday).toMatch(/lab tests only/);
  });
  it("hoursLines / hoursAllLabel carry both lines; hoursWithLastRegistration stays Mon–Sat", () => {
    expect(hoursLines()).toEqual([CONTACT.hours, CONTACT.hoursSunday]);
    expect(hoursAllLabel()).toBe(`${CONTACT.hours}; ${CONTACT.hoursSunday}`);
    expect(hoursWithLastRegistration()).not.toContain("Sunday");
  });
  it("openingHoursStrings derives the schema.org strings from HOURS", () => {
    expect(openingHoursStrings()).toEqual(["Mo-Sa 08:00-17:00", "Su 08:00-12:00"]);
  });
});

describe("clinicStatus / isOpenNow (Asia/Manila, Mon–Sat 08:00–17:00, Sun 08:00–12:00 lab only)", () => {
  // 2026-06-21 is a Sunday; Manila = UTC+8, so 07:59 Manila = 23:59Z the day before.
  const sun = (h: number, m: number) =>
    new Date(Date.UTC(2026, 5, 21, h - 8, m, 0));
  const sat = (h: number, m: number) =>
    new Date(Date.UTC(2026, 5, 20, h - 8, m, 0));
  it("Sunday 07:59 closed, 08:00 lab-only, 11:59 lab-only, 12:00 closed", () => {
    expect(clinicStatus(sun(7, 59))).toBe("closed");
    expect(clinicStatus(sun(8, 0))).toBe("lab-only");
    expect(clinicStatus(sun(11, 59))).toBe("lab-only");
    expect(clinicStatus(sun(12, 0))).toBe("closed");
    expect(clinicStatus(sun(15, 0))).toBe("closed");
  });
  it("isOpenNow is true inside the Sunday window and false outside", () => {
    expect(isOpenNow(sun(8, 0))).toBe(true);
    expect(isOpenNow(sun(11, 59))).toBe(true);
    expect(isOpenNow(sun(12, 0))).toBe(false);
    expect(isOpenNow(sun(7, 59))).toBe(false);
  });
  it("Saturday 16:59 is open (full service), 17:00 closed", () => {
    expect(clinicStatus(sat(16, 59))).toBe("open");
    expect(clinicStatus(sat(17, 0))).toBe("closed");
  });
  it("Monday 08:00 is open; the Sunday-night to Monday-early gap stays closed", () => {
    const mon = (h: number, m: number) => new Date(Date.UTC(2026, 5, 22, h - 8, m, 0));
    expect(clinicStatus(mon(0, 30))).toBe("closed");
    expect(clinicStatus(mon(7, 59))).toBe("closed");
    expect(clinicStatus(mon(8, 0))).toBe("open");
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
  it("open on Saturday", () => {
    // 2026-06-20 is a Saturday. 03:00Z = 11:00 Manila Sat — within hours.
    expect(isOpenNow(new Date("2026-06-20T03:00:00Z"))).toBe(true);
  });
  it("Sunday afternoon and evening are closed", () => {
    // 2026-06-21 is a Sunday. 06:00Z = 14:00 Manila Sun (after the 12nn lab-only close).
    expect(isOpenNow(new Date("2026-06-21T06:00:00Z"))).toBe(false);
  });
});

describe("SMS-short hours", () => {
  it("to12hCompact drops :00 and writes noon as 12nn", () => {
    expect(to12hCompact("08:00")).toBe("8am");
    expect(to12hCompact("12:00")).toBe("12nn");
    expect(to12hCompact("16:30")).toBe("4:30pm");
    expect(to12hCompact("00:00")).toBe("12am");
  });
  it("hoursSundayShort is derived from HOURS.sunday and stays short", () => {
    expect(hoursSundayShort()).toBe("Sun 8am–12nn lab only");
    expect(hoursSundayShort().length).toBeLessThanOrEqual(24);
    // The short form must keep saying it is lab-only, like the long form.
    expect(CONTACT.hoursSunday).toMatch(/lab tests only/);
    expect(hoursSundayShort()).toMatch(/lab only/);
  });
});

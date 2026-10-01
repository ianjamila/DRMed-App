// Pure NAP (name/address/phone) derivations. Single source for the formatted
// strings + map/tel hrefs used across the marketing site, so address/phone/hours
// only ever change in site.ts. No `server-only` — unit-tested.

import { CONTACT, HOURS, GEO, SITE } from "./site";

/** "08:00" -> "8:00 AM", "16:30" -> "4:30 PM". */
export function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const mer = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${mer}`;
}

/** Canonical clinic-hours display string. */
export function hoursLabel(): string {
  return CONTACT.hours;
}

/** Sunday walk-in lab-only hours display string. */
export function hoursSundayLabel(): string {
  return CONTACT.hoursSunday;
}

/** "8:00" -> "8am", "12:00" -> "12nn", "16:30" -> "4:30pm" — for length-limited SMS. */
export function to12hCompact(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  if (h === 12 && m === 0) return "12nn";
  const mer = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${mer}` : `${h12}:${String(m).padStart(2, "0")}${mer}`;
}

/** Short Sunday lab-only hours for SMS: "Sun 8am–12nn lab only". Derived from HOURS.sunday. */
export function hoursSundayShort(): string {
  const { day, opens, closes } = HOURS.sunday;
  return `${day.slice(0, 3)} ${to12hCompact(opens)}–${to12hCompact(closes)} lab only`;
}

/** [Mon–Sat line, Sunday line] — for stacked displays (footer, contact). */
export function hoursLines(): [string, string] {
  return [CONTACT.hours, CONTACT.hoursSunday];
}

/** Every opening day on one line — for prose / plain-text surfaces (llms.txt). */
export function hoursAllLabel(): string {
  return `${CONTACT.hours}; ${CONTACT.hoursSunday}`;
}

const DAY_ABBR: Record<string, string> = {
  Monday: "Mo", Tuesday: "Tu", Wednesday: "We", Thursday: "Th",
  Friday: "Fr", Saturday: "Sa", Sunday: "Su",
};

/** schema.org `openingHours` strings, derived from HOURS ("Mo-Sa 08:00-17:00", "Su 08:00-12:00"). */
export function openingHoursStrings(): string[] {
  const first = HOURS.days[0];
  const last = HOURS.days[HOURS.days.length - 1];
  return [
    `${DAY_ABBR[first]}-${DAY_ABBR[last]} ${HOURS.opens}-${HOURS.closes}`,
    `${DAY_ABBR[HOURS.sunday.day]} ${HOURS.sunday.opens}-${HOURS.sunday.closes}`,
  ];
}

/** Hours + the reception cut-off, for the booking form. */
export function hoursWithLastRegistration(): string {
  return `${CONTACT.hours} (last registration ${to12h(HOURS.lastRegistration)})`;
}

/** Two-line address block: [occupant line, "street, city"]. */
export function addressLines(): [string, string] {
  return [CONTACT.address.line1, `${CONTACT.address.line2}, ${CONTACT.address.city}`];
}

/** Name-less mailing line with floor — for places that show the clinic name separately. */
export function streetAddressLine(): string {
  return `${CONTACT.address.floor} ${CONTACT.address.line2}, ${CONTACT.address.city}`;
}

/** tel: link from the E164 numbers. */
export function telHref(which: "mobile" | "landline"): string {
  return `tel:${which === "mobile" ? CONTACT.phone.mobileE164 : CONTACT.phone.landlineE164}`;
}

function latLng(): string | null {
  return GEO.lat != null && GEO.lng != null ? `${GEO.lat},${GEO.lng}` : null;
}

/** Google / Waze / Apple directions deep links. Prefers the verified pin/coords. */
export function directionsHrefs(): { google: string; waze: string; apple: string } {
  const q = encodeURIComponent(CONTACT.address.full);
  const ll = latLng();
  return {
    google: GEO.mapUrl || `https://www.google.com/maps/search/?api=1&query=${q}`,
    waze: ll ? `https://waze.com/ul?ll=${ll}&navigate=yes` : `https://waze.com/ul?q=${q}`,
    apple: ll
      ? `https://maps.apple.com/?ll=${ll}&q=${encodeURIComponent(SITE.name)}`
      : `https://maps.apple.com/?q=${q}`,
  };
}

/** No-API-key Google Maps iframe src. Sets Google cookies once loaded, so it is
 *  rendered only after the user clicks the placeholder (see MapEmbed). */
export function mapEmbedSrc(): string {
  const target = latLng() ?? CONTACT.address.full;
  return `https://maps.google.com/maps?q=${encodeURIComponent(target)}&z=16&output=embed`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
}

export type ClinicStatus = "open" | "lab-only" | "closed";

/**
 * Open status at `now` in Asia/Manila: "open" Mon–Sat 08:00–17:00 (everything),
 * "lab-only" Sunday 08:00–12:00 (walk-in lab tests only), otherwise "closed".
 * Pure (date passed in).
 */
export function clinicStatus(now: Date): ClinicStatus {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: HOURS.timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  // en-US hour12:false can render midnight as "24"; normalise so 00:xx stays early.
  const mins = (hour % 24) * 60 + minute;
  if (
    (HOURS.days as readonly string[]).includes(weekday) &&
    mins >= toMinutes(HOURS.opens) &&
    mins < toMinutes(HOURS.closes)
  ) {
    return "open";
  }
  if (
    weekday === HOURS.sunday.day &&
    mins >= toMinutes(HOURS.sunday.opens) &&
    mins < toMinutes(HOURS.sunday.closes)
  ) {
    return "lab-only";
  }
  return "closed";
}

/** Is the clinic open at `now` (any service, incl. the Sunday lab-only window)? */
export function isOpenNow(now: Date): boolean {
  return clinicStatus(now) !== "closed";
}

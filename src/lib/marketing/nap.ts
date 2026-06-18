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

/** Is the clinic open at `now`? Computed in Asia/Manila from HOURS. Pure (date passed in). */
export function isOpenNow(now: Date): boolean {
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
  const open = parseInt(HOURS.opens.split(":")[0], 10) * 60 + parseInt(HOURS.opens.split(":")[1], 10);
  const close = parseInt(HOURS.closes.split(":")[0], 10) * 60 + parseInt(HOURS.closes.split(":")[1], 10);
  const mins = hour * 60 + minute;
  return (HOURS.days as readonly string[]).includes(weekday) && mins >= open && mins < close;
}

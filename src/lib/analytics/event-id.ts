// Generates the random id that pairs a browser Pixel event with its
// server-side Conversions API twin so Meta de-dupes them (see meta-pixel.ts /
// meta-capi.ts). It is a throwaway correlation token — deliberately NOT a
// DRM-ID, booking_group_id, or any other clinic record identifier, so nothing
// identifying ever reaches an ad platform (RA 10173).
//
// `crypto.randomUUID` only exists in secure contexts (https / localhost). On a
// plain-http origin — an IP-address dev server, a LAN preview — it is
// undefined and calling it throws. These ids are generated inside form-submit
// handlers for booking, registration, and contact, so an unguarded call would
// take down a conversion flow to serve marketing measurement. It falls back
// instead: uniqueness only has to hold well enough to de-dupe one event pair.
export function newEventId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // Fall through to the non-crypto path below.
  }
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

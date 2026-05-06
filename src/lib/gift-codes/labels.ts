export const GIFT_CODE_STATUSES = [
  "generated",
  "purchased",
  "redeemed",
  "cancelled",
] as const;
export type GiftCodeStatus = (typeof GIFT_CODE_STATUSES)[number];

export const STATUS_LABELS: Record<GiftCodeStatus, string> = {
  generated: "Generated",
  purchased: "Purchased",
  redeemed: "Redeemed",
  cancelled: "Cancelled",
};

export const STATUS_BADGE: Record<GiftCodeStatus, string> = {
  generated: "bg-sky-100 text-sky-900",
  purchased: "bg-amber-100 text-amber-900",
  redeemed: "bg-emerald-100 text-emerald-900",
  cancelled: "bg-zinc-100 text-zinc-700",
};

// Crockford base32: omits I, L, O, U to avoid confusion with 1, 0, V.
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const GIFT_CODE_PATTERN = /^GC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

// Normalise common transcription mistakes (lowercase, I→1, L→1, O→0)
// before matching against the DB. Spaces and dashes are stripped so a
// scanner that drops separators still works.
export function normaliseGiftCode(input: string): string {
  const upper = input.toUpperCase().replace(/[\s]/g, "");
  // If user typed without the GC- prefix or mid-dashes, accept that too.
  const compact = upper.replace(/-/g, "");
  const tr = compact
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
  if (tr.length === 14 && tr.startsWith("GC")) {
    const body = tr.slice(2);
    return `GC-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
  }
  if (tr.length === 12) {
    return `GC-${tr.slice(0, 4)}-${tr.slice(4, 8)}-${tr.slice(8, 12)}`;
  }
  return upper;
}

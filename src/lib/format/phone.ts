/**
 * Phone display helpers — input is E.164 (+639xxxxxxxxx), output is PH local
 * (09xxxxxxxxx) for staff-facing screens. Storage stays E.164 — this is
 * presentation-only.
 */

/**
 * Convert E.164 PH mobile (+639xxxxxxxxx) to PH local (09xxxxxxxxx).
 * - Pass-through if already in 09xxxxxxxxx form.
 * - Returns the raw string for anything else (defensive — we don't want to
 *   blank a field reception can read just because it isn't normalized).
 */
export function formatPhoneLocal(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/[^0-9+]/g, "");
  if (digits.startsWith("+639") && digits.length === 13) {
    return `0${digits.slice(3)}`;
  }
  if (digits.startsWith("639") && digits.length === 12) {
    return `0${digits.slice(2)}`;
  }
  if (digits.startsWith("09") && digits.length === 11) {
    return digits;
  }
  return raw;
}

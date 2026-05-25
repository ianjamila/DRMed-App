interface PhoneResult {
  e164: string | null;
  unparseable: boolean;
}

/**
 * Normalize a Philippine mobile number to E.164 (+639XXXXXXXXX).
 * Accepts 09xxxxxxxxx, 639xxxxxxxxx, 9xxxxxxxxx, and tolerates
 * spaces, dashes, parens, and + prefixes.
 */
export function normalizePhone(raw: string | undefined | null): PhoneResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { e164: null, unparseable: false };

  const digits = trimmed.replace(/[^0-9]/g, "");

  if (digits.length === 11 && digits.startsWith("09")) {
    return { e164: `+63${digits.substring(1)}`, unparseable: false };
  }
  if (digits.length === 12 && digits.startsWith("639")) {
    return { e164: `+${digits}`, unparseable: false };
  }
  if (digits.length === 10 && digits.startsWith("9")) {
    return { e164: `+63${digits}`, unparseable: false };
  }
  if (digits.length === 13 && digits.startsWith("0639")) {
    return { e164: `+${digits.substring(1)}`, unparseable: false };
  }

  return { e164: null, unparseable: true };
}

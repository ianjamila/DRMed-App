import "server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "./labels";

// Generate one GC-XXXX-YYYY-ZZZZ code from cryptographic randomness.
// 12 char body × log2(32) = 60 bits of entropy. With even 100k codes
// outstanding, the birthday collision risk is < 10^-9, well within the
// retry-on-conflict ceiling we use for batch insertion.
export function generateGiftCode(): string {
  const bytes = randomBytes(12);
  const chars: string[] = [];
  for (let i = 0; i < 12; i++) {
    chars.push(CROCKFORD_ALPHABET[bytes[i]! % 32]!);
  }
  return `GC-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

export function generateGiftCodes(count: number): string[] {
  const seen = new Set<string>();
  while (seen.size < count) seen.add(generateGiftCode());
  return Array.from(seen);
}

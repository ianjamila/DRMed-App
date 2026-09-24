/**
 * Fallback words for a stored snake_case code that has no label yet:
 * `partially_paid` → "Partially paid". Label maps use it so an unknown value
 * reads as a phrase rather than leaking the raw code onto a staff screen.
 */
export function humaniseCode(code: string): string {
  const words = code.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

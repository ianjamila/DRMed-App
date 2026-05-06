// "Dr. Maria Cecilia Castelo-Brojas" → "MC"
export function physicianInitials(name: string): string {
  const stripped = name.replace(/^Dr\.\s*/, "");
  const parts = stripped.split(/[\s-]+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts[parts.length - 1]?.[0] ?? "";
  return (first + last).toUpperCase();
}

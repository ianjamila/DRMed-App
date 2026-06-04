// Parse the LAB SERVICE "NEW / REPEAT CUSTOMER" cell to a marker.
export function parseNewRepeat(raw: string): "new" | "repeat" | null {
  const s = (raw ?? "").trim().toUpperCase();
  if (!s || s === "N/A" || s === "NA") return null;
  if (s.startsWith("N")) return "new";       // NEW, N
  if (s.startsWith("R")) return "repeat";    // REPEAT, R
  return null;
}

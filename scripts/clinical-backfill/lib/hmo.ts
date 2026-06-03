// HMO provider normalization (mirrors scripts/history-import/* 12.B logic).

function titleCase(s: string): string {
  return s.toLowerCase().split(/(\s+)/)
    .map((w) => (w.match(/^\s+$/) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

export function normaliseHmoProvider(raw: string): string {
  const t = (raw ?? "").trim();
  if (!t) return "(unknown HMO)";
  const lower = t.toLowerCase();
  const map: Record<string, string> = {
    maxicare: "Maxicare", intellicare: "Intellicare", etiqa: "Etiqa",
    cocolife: "Cocolife", avega: "Avega", valucare: "Valucare", icare: "iCare",
    generali: "Generali", amaphil: "Amaphil", "med asia": "Med Asia", medasia: "Med Asia",
  };
  return map[lower] ?? titleCase(t);
}

export function isHmoRow(r: { hmo_flag: string; hmo_provider: string; mop: string }): boolean {
  return (
    r.hmo_flag.trim().toUpperCase().includes("YES") ||
    !!r.hmo_provider.trim() ||
    r.mop.trim().toUpperCase() === "HMO"
  );
}

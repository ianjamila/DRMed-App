// Reviewed surname → physician full_name map (spec §3.2). Explicit, not fuzzy —
// doctor identity is high-stakes. Keys are normalized surnames (NO dots/spaces,
// uppercase). Unlisted surnames + ambiguous bare "DANTES" resolve to null ("Other").

export function normSurname(raw: string): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const MAP: Record<string, string> = {
  GAYO: "Dr. Katherine Gayo",
  RVICENCIO: "Dr. Robert Vicencio",
  AVICENCIO: "Dr. Aurora Vicencio",
  LORENZO: "Dr. Angelica Lorenzo",
  BROJAS: "Dr. Maria Cecilia Castelo-Brojas",
  ELLEAZAR: "Dr. Jaemari Elleazar",
  MANUEL: "Dr. Archangel Manuel",
  MENDOZA: "Dr. Armelle Keisha Mendoza",
  ARCEGA: "Dr. Alain Arcega",
  ANTONIO: "Dr. Dominique Antonio",
  PACIS: "Dr. Julie Ann Pacis-Caling",
  ANGLO: "Dr. Claudette Anglo",
  NMARIANO: "Dr. Nadia Mariano",
  FDANTES: "Dr. Ferdinand Dantes",
  ADANTES: "Dr. Angelle Dantes",
  LIBIRAN: "Dr. Gideon Libiran",
  BALDEVISO: "Dr. Lei Baldeviso",
  ALVAREZ: "Dr. Mary Rose Alvarez",
  // Off-roster (JOSON, SEVILLEJA, CHING, SAYSON, VILLANUEVA) and bare DANTES are
  // intentionally absent → resolveSurname returns null ("Other").
};

/** Resolve a raw sheet surname to a physician full_name, or null for "Other". */
export function resolveSurname(raw: string): string | null {
  return MAP[normSurname(raw)] ?? null;
}

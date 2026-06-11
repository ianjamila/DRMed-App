// scripts/clinical-backfill/followups/resolutions.ts
//
// Parse + validate the clinic-partner's decision file (the filled
// `clinical-cluster-resolutions.csv`) and turn it into the two things the
// follow-up runners need:
//   • the SAME-cluster merge list (consumed by resolve.ts)
//   • a matchKey → patient_id override map (consumed by the clinical engine, so a
//     DISTINCT cluster's held rows import to the partner-chosen patient instead of
//     being held)
//
// Pure logic only — no DB, no `server-only` import — so it is unit-testable.

export type Decision = "SAME" | "DISTINCT" | "SKIP";

export interface Resolution {
  clusterKey: string;     // matchKey, e.g. "vicencio|robert"
  sheetName: string;
  decision: Decision;
  targetDrm: string;      // survivor (SAME) or held-row owner (DISTINCT); "" for SKIP
  notes: string;
}

const DECISIONS: ReadonlySet<string> = new Set(["SAME", "DISTINCT", "SKIP"]);

/** Minimal CSV parse matching report.ts's writer (every cell quoted, "" escapes "). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let inq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inq = false; }
      else cell += c;
    } else if (c === '"') inq = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (cell !== "" || row.length) { row.push(cell); rows.push(row); row = []; cell = ""; } if (c === "\r" && text[i + 1] === "\n") i++; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export interface ParseResult { resolutions: Resolution[]; errors: string[]; }

/**
 * Parse the resolutions CSV text. Header row required:
 *   cluster_key, sheet_name, candidates, decision, target_drm, notes
 * Blank `decision` rows are treated as undecided (SKIP) and ignored, not errored,
 * so a partially-filled sheet is safe to run incrementally. Hard errors: an
 * unknown decision token, or SAME/DISTINCT with no target_drm.
 */
export function parseResolutions(text: string): ParseResult {
  const rows = parseCsv(text);
  const errors: string[] = [];
  const resolutions: Resolution[] = [];
  if (!rows.length) return { resolutions, errors: ["empty file"] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const ci = { key: col("cluster_key"), name: col("sheet_name"), dec: col("decision"), tgt: col("target_drm"), notes: col("notes") };
  for (const [k, v] of Object.entries(ci)) if (v < 0) errors.push(`missing column: ${k}`);
  if (errors.length) return { resolutions, errors };

  const seen = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const clusterKey = (row[ci.key] ?? "").trim();
    if (!clusterKey) continue; // blank line
    const decisionRaw = (row[ci.dec] ?? "").trim().toUpperCase();
    if (!decisionRaw) continue; // undecided — skip silently
    if (!DECISIONS.has(decisionRaw)) { errors.push(`${clusterKey}: unknown decision "${row[ci.dec]}"`); continue; }
    const decision = decisionRaw as Decision;
    const targetDrm = (row[ci.tgt] ?? "").trim().toUpperCase();
    if ((decision === "SAME" || decision === "DISTINCT") && !targetDrm) {
      errors.push(`${clusterKey}: ${decision} requires a target_drm`); continue;
    }
    if (seen.has(clusterKey)) { errors.push(`${clusterKey}: duplicate cluster row`); continue; }
    seen.add(clusterKey);
    resolutions.push({ clusterKey, sheetName: (row[ci.name] ?? "").trim(), decision, targetDrm, notes: (row[ci.notes] ?? "").trim() });
  }
  return { resolutions, errors };
}

/**
 * matchKey → patient_id override for the clinical engine. Both SAME and DISTINCT
 * map their cluster to the chosen target patient; SKIP is omitted (stays held).
 * `drmToId` resolves a DRM-ID to a live patient uuid. A target DRM that doesn't
 * resolve is reported in `errors` rather than silently dropped.
 */
export function buildOverrideMap(
  resolutions: Resolution[], drmToId: Map<string, string>,
): { overrides: Map<string, string>; errors: string[] } {
  const overrides = new Map<string, string>();
  const errors: string[] = [];
  for (const res of resolutions) {
    if (res.decision === "SKIP") continue;
    const id = drmToId.get(res.targetDrm);
    if (!id) { errors.push(`${res.clusterKey}: target ${res.targetDrm} not found among live patients`); continue; }
    overrides.set(res.clusterKey, id);
  }
  return { overrides, errors };
}

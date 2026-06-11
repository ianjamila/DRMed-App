// scripts/clinical-backfill/followups/worksheet.ts
//
// Clinical-backfill follow-up — AMBIGUOUS resolution worksheet generator (read-only).
//
// The clinical backfill holds a row as "ambiguous" when the sheet name matches 2+
// live patients sharing a matchKey (surname + first given token). Those rows are
// NOT in prod. The sheet carries no DOB/contact, so name alone cannot say which
// person a held transaction belongs to — every cluster is a human (clinic-partner)
// decision (RA 10173: never auto-pick an identity).
//
// This script produces the decision artifacts the partner needs and the machine-
// readable contract the resolver consumes once decisions are in:
//   1. clinical-followup-worksheet.csv  — one row per cluster, candidates side by
//      side (DRM-ID / DOB / middle / sex / phone / visits), the dedup tool's own
//      verdict, a NON-BINDING hint, and how many held rows the cluster unblocks.
//   2. clinical-followup-detail.csv     — one row per held transaction (date,
//      service, amount) so the partner can see what each cluster's labs were.
//   3. clinical-cluster-resolutions.template.csv — the blank decision sheet the
//      partner / Ian fills (cluster_key, decision, target_drm). This is the exact
//      file `resolve.ts` reads to import the held rows.
//
// Run: tsx --env-file=.env.local scripts/clinical-backfill/followups/worksheet.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../src/types/database";
import { loadTab } from "../lib/xlsx";
import type { RawRow, TabConfig } from "../lib/types";
import { parseTransactionName, matchKey } from "../lib/names";
import { planCluster, completeness } from "../../patient-dedup/lib/plan";
import type { PatientRow } from "../../patient-dedup/lib/types";
import { writeCsv } from "../report";

const LAB_CFG: TabConfig = {
  tab: "LAB SERVICE", sheetName: "LAB SERVICE", isConsult: false,
  cols: { posting_date: 1, control_no: 2, test_no: 3, patient_name: 4, hmo_flag: 5,
    hmo_provider: 6, service: 8, base: 9, final: 14, mop: 15, or_number: 25, date_paid: 26 },
};
const CONSULT_CFG: TabConfig = {
  tab: "DOCTOR CONSULTATION", sheetName: "DOCTOR CONSULTATION", isConsult: true,
  cols: { posting_date: 1, control_no: 2, test_no: 3, patient_name: 4, hmo_flag: 5,
    hmo_provider: 6, service: 8, base: 9, final: 12, clinic_fee: 13, doctor_pf: 17,
    mop: 14, or_number: 23, date_paid: 1 },
};

function adminClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required."); process.exit(2); }
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function fetchAll<T>(q: (from: number, to: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []; let from = 0; const page = 1000;
  for (;;) { const b = await q(from, from + page - 1); out.push(...b); if (b.length < page) break; from += page; }
  return out;
}

// Latest CSV of a given prefix written by an earlier dry-run.
async function latestCsv(prefix: string): Promise<string | null> {
  const dir = path.resolve("tmp");
  const files = (await fs.readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith(".csv"));
  if (!files.length) return null;
  files.sort();
  return path.join(dir, files[files.length - 1]);
}
// Minimal CSV parse (our writer quotes every cell and escapes " as "").
function parseCsv(text: string): string[][] {
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

interface HeldRow { tab: TabConfig["tab"]; row_number: number; name: string; candidates: string[]; date: string; raw?: RawRow; }
interface Cluster {
  key: string;                 // matchKey, e.g. "vicencio|robert"
  display: string;             // sheet name as it appears, e.g. "VICENCIO,ROBERT ALAIN"
  candidateIds: string[];
  patients: PatientRow[];
  held: HeldRow[];
  nLab: number; nConsult: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function main(): Promise<void> {
  const admin = adminClient();

  // 1. held rows from the latest ambiguous dry-run CSVs ---------------------
  const labCsv = await latestCsv("clinical-LAB SERVICE-ambiguous-");
  const conCsv = await latestCsv("clinical-DOCTOR CONSULTATION-ambiguous-");
  if (!labCsv || !conCsv) { console.error("Missing ambiguous CSVs — run the lab + consult dry-runs first."); process.exit(2); }
  console.log(`Lab ambiguous:     ${path.basename(labCsv)}`);
  console.log(`Consult ambiguous: ${path.basename(conCsv)}`);

  const held: HeldRow[] = [];
  for (const [csv, tab] of [[labCsv, "LAB SERVICE"], [conCsv, "DOCTOR CONSULTATION"]] as const) {
    const rows = parseCsv(await fs.readFile(csv, "utf8"));
    for (const r of rows.slice(1)) {
      if (r.length < 4 || r[0] === "row") continue;
      held.push({ tab, row_number: Number(r[0]), name: r[1], candidates: r[2].split("|").filter(Boolean), date: r[3] });
    }
  }
  console.log(`Held rows: ${held.length} (lab ${held.filter((h) => h.tab === "LAB SERVICE").length}, consult ${held.filter((h) => h.tab === "DOCTOR CONSULTATION").length})`);

  // 2. enrich held rows with service + amount from the sheet ----------------
  for (const cfg of [LAB_CFG, CONSULT_CFG]) {
    const xlsx = `${process.env.HOME ?? ""}/Downloads/DR MED MASTERSHEET.xlsx`;
    const byRn = new Map<number, RawRow>();
    for (const rr of await loadTab(xlsx, cfg)) byRn.set(rr.row_number, rr);
    for (const h of held) if (h.tab === cfg.tab) h.raw = byRn.get(h.row_number);
  }

  // 3. patient details for every candidate ----------------------------------
  const ids = [...new Set(held.flatMap((h) => h.candidates))];
  const pats = await fetchAll<Omit<PatientRow, "visit_count">>(async (lo, hi) => {
    const { data, error } = await admin.from("patients")
      .select("id, drm_id, first_name, last_name, middle_name, sex, phone, email, birthdate, address, created_at")
      .in("id", ids.slice(lo, Math.min(hi + 1, ids.length)));
    if (error) throw new Error(error.message);
    return (data ?? []) as Omit<PatientRow, "visit_count">[];
  });
  // visit counts for the candidates
  const vcounts = new Map<string, number>();
  for (const v of await fetchAll<{ patient_id: string }>(async (lo, hi) => {
    const { data, error } = await admin.from("visits").select("patient_id").in("patient_id", ids.slice(lo, Math.min(hi + 1, ids.length)));
    if (error) throw new Error(error.message);
    return (data ?? []) as { patient_id: string }[];
  })) vcounts.set(v.patient_id, (vcounts.get(v.patient_id) ?? 0) + 1);
  const patById = new Map<string, PatientRow>(pats.map((p) => [p.id, { ...p, visit_count: vcounts.get(p.id) ?? 0 }]));

  // 4. group held rows into clusters ---------------------------------------
  const byKey = new Map<string, Cluster>();
  for (const h of held) {
    const { last, first } = parseTransactionName(h.name);
    const key = matchKey(last, first);
    let c = byKey.get(key);
    if (!c) {
      const patients = h.candidates.map((id) => patById.get(id)).filter((p): p is PatientRow => !!p);
      c = { key, display: h.name, candidateIds: [...h.candidates], patients, held: [], nLab: 0, nConsult: 0 };
      byKey.set(key, c);
    }
    // union candidate ids (defensive — should be identical across a cluster's rows)
    for (const id of h.candidates) if (!c.candidateIds.includes(id)) {
      c.candidateIds.push(id); const p = patById.get(id); if (p && !c.patients.includes(p)) c.patients.push(p);
    }
    c.held.push(h);
    if (h.tab === "LAB SERVICE") c.nLab++; else c.nConsult++;
  }
  const clusters = [...byKey.values()].sort((a, b) => (b.nLab + b.nConsult) - (a.nLab + a.nConsult));
  console.log(`Clusters: ${clusters.length}`);

  // 5. recommendation hint (NON-BINDING — partner confirms) -----------------
  const dayDiff = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
  const transposed = (a: string, b: string) => {  // YYYY-MM-DD with mm/dd swapped
    const [, ma, da] = a.split("-"); const [, mb, db] = b.split("-");
    return a.slice(0, 4) === b.slice(0, 4) && ma === db && da === mb && ma !== da;
  };
  function hint(c: Cluster): { lean: string; reason: string } {
    if (c.patients.length < 2) return { lean: "DATA?", reason: "fewer than 2 candidate records found" };
    const ps = [...c.patients].sort((a, b) => completeness(b) - completeness(a));
    const dobs = ps.map((p) => p.birthdate).filter((d): d is string => !!d);
    const SRJR = /\b(jr|sr|ii|iii|iv|2nd|3rd)\b/;
    const anyGen = ps.some((p) => SRJR.test(`${p.first_name ?? ""} ${p.middle_name ?? ""}`.toLowerCase()));
    if (anyGen) return { lean: "DISTINCT?", reason: "a Jr/Sr/II/III generational marker is present" };
    if (c.patients.length > 2) return { lean: "MANUAL", reason: `${c.patients.length}-way cluster — decide each member` };
    if (dobs.length === 2) {
      if (dobs[0] === dobs[1]) return { lean: "SAME?", reason: "identical birthdates" };
      if (transposed(dobs[0], dobs[1])) return { lean: "SAME?", reason: "birthdates are month/day transposed (entry typo)" };
      const dd = dayDiff(dobs[0], dobs[1]);
      if (dd <= 3) return { lean: "SAME?", reason: `birthdates differ by ${dd}d (likely entry typo)` };
      if (dd > 365 * 8) return { lean: "DISTINCT?", reason: `birthdates differ by ${Math.round(dd / 365)}y` };
      return { lean: "REVIEW", reason: `birthdates differ by ${Math.round(dd)}d — unclear` };
    }
    // name-only (stubs) — compare full given names
    const g = ps.map((p) => (p.first_name ?? "").toLowerCase().trim());
    if (g[0] !== g[1] && (g[0].startsWith(g[1]) || g[1].startsWith(g[0]))) return { lean: "SAME?", reason: "one given name is a prefix of the other" };
    if (g[0] !== g[1]) {
      // small edit distance on full first name => likely a typo of one person
      const ed = lev(g[0], g[1]);
      if (ed <= 2) return { lean: "SAME?", reason: `given names differ by ${ed} char(s) — likely a typo` };
      return { lean: "DISTINCT?", reason: "given names differ materially" };
    }
    return { lean: "REVIEW", reason: "no distinguishing signal — partner to decide" };
  }

  // 6. emit worksheet -------------------------------------------------------
  const fmtCand = (p: PatientRow) =>
    `${p.drm_id} | dob ${p.birthdate ?? "—"} | mid ${p.middle_name ?? "—"} | ${p.sex ?? "—"} | ph ${p.phone ? "y" : "—"} | ${p.visit_count}v`;
  const wsHead = ["cluster_key", "sheet_name", "held_lab", "held_consult", "held_total",
    "candidate_A", "candidate_B", "candidate_C", "dedup_verdict", "hint", "hint_reason"];
  const wsRows: string[][] = [];
  for (const c of clusters) {
    const plan = c.patients.length >= 2 ? planCluster(c.patients) : null;
    const verdict = plan
      ? `keep ${plan.canonical.drm_id}; ${[...plan.auto.map((a) => a.tier), ...plan.review.map((r) => r.reason)].join(",")}`
      : "n/a";
    const ordered = plan ? [plan.canonical, ...c.patients.filter((p) => p.id !== plan.canonical.id)] : c.patients;
    const h = hint(c);
    wsRows.push([c.key, c.display, String(c.nLab), String(c.nConsult), String(c.nLab + c.nConsult),
      ordered[0] ? fmtCand(ordered[0]) : "", ordered[1] ? fmtCand(ordered[1]) : "", ordered[2] ? fmtCand(ordered[2]) : "",
      verdict, h.lean, h.reason]);
  }
  const wsPath = await writeCsv("clinical-followup-worksheet", wsHead, wsRows);

  // 7. emit per-transaction detail -----------------------------------------
  const dHead = ["cluster_key", "sheet_name", "tab", "sheet_row", "date", "service", "base_php", "final_php", "candidates_drm"];
  const dRows: string[][] = [];
  for (const c of clusters) {
    const drms = c.patients.map((p) => p.drm_id).join(" / ");
    for (const h of c.held.sort((a, b) => a.date.localeCompare(b.date))) {
      const base = h.raw ? round2(h.raw.base) : 0;
      const final = h.raw ? round2(h.tab === "DOCTOR CONSULTATION" ? h.raw.clinic_fee : (h.raw.final > 0 ? h.raw.final : h.raw.base)) : 0;
      dRows.push([c.key, c.display, h.tab, String(h.row_number), h.date, h.raw?.service ?? "(?)", base.toFixed(2), final.toFixed(2), drms]);
    }
  }
  const dPath = await writeCsv("clinical-followup-detail", dHead, dRows);

  // 8. emit the blank resolutions template (the resolver's input contract) --
  const rHead = ["cluster_key", "sheet_name", "candidates", "decision", "target_drm", "notes"];
  const rRows = clusters.map((c) => [c.key, c.display,
    c.patients.map((p) => `${p.drm_id}(${p.birthdate ?? "—"}${p.middle_name ? " " + p.middle_name : ""})`).join(" | "),
    "", "", ""]);
  const rPath = await writeCsv("clinical-cluster-resolutions.template", rHead, rRows);

  console.log(`\nWorksheet:   ${wsPath}`);
  console.log(`Detail:      ${dPath}`);
  console.log(`Resolutions: ${rPath}`);
  console.log(`\nFill 'decision' (SAME | DISTINCT | SKIP) + 'target_drm' in the resolutions file, then run resolve.ts.`);
  console.log(`  SAME     → merge the other candidate(s) into target_drm, then the held rows import to it.`);
  console.log(`  DISTINCT → keep the records separate; the held rows belong to target_drm.`);
  console.log(`  SKIP     → leave held (undecided).`);
}

// tiny Levenshtein for the typo hint
function lev(a: string, b: string): number {
  const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

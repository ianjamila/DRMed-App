import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { requireLocalOrExplicitProd } from "../lib/env-guard";
import { writeCsv } from "../clinical-backfill/report";
import { readEnrichment } from "./lib/read-enrichment";
import { resolveSurname } from "./lib/physician-map";
import { classifyDiscount } from "./lib/discount-type";
import { parseNewRepeat } from "./lib/new-repeat";

interface Args { xlsx: string; commit: boolean; confirmed: boolean; }
export function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const xlsx = argv.find((a) => a.startsWith("--xlsx="))?.substring(7)
    ?? `${process.env.HOME ?? ""}/Downloads/DR MED MASTERSHEET.xlsx`;
  return {
    xlsx,
    commit: argv.includes("--commit"),
    confirmed: argv.includes('--confirm="I-mean-it"') || argv.includes("--confirm=I-mean-it"),
  };
}

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

// chunked "update ... where id in (...)" helper
async function applyByIds(
  admin: SupabaseClient<Database>, table: "visits" | "test_requests",
  patch: Record<string, unknown>, ids: string[],
): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { error } = await admin.from(table).update(patch as never).in("id", slice);
    if (error) throw new Error(`update ${table} ${JSON.stringify(patch)}: ${error.message}`);
    n += slice.length;
  }
  return n;
}

interface LegacyTr {
  id: string; visit_id: string; legacy_source_ref: string;
  discount_amount_php: number | null; discount_kind: string | null;
}

export async function run(): Promise<void> {
  const args = parseArgs();
  console.log(`Reading enrichment from ${args.xlsx}`);
  const sheet = await readEnrichment(args.xlsx);
  console.log(`  ${sheet.size} source rows indexed`);

  const admin = adminClient();

  // physician full_name -> id
  const physRows = await fetchAll<{ id: string; full_name: string }>(async (lo, hi) => {
    const { data, error } = await admin.from("physicians").select("id,full_name").range(lo, hi);
    if (error) throw new Error(error.message); return (data ?? []) as { id: string; full_name: string }[];
  });
  const physIdByName = new Map(physRows.map((p) => [p.full_name, p.id]));

  // committed legacy test_requests
  const trs = await fetchAll<LegacyTr>(async (lo, hi) => {
    const { data, error } = await admin.from("test_requests")
      .select("id,visit_id,legacy_source_ref,discount_amount_php,discount_kind")
      .not("legacy_source_ref", "is", null).range(lo, hi);
    if (error) throw new Error(error.message); return (data ?? []) as LegacyTr[];
  });
  console.log(`  ${trs.length} committed legacy test_requests`);

  // current attending_physician_id / source_new_repeat per visit (idempotency: only fill NULLs)
  const visitState = new Map<string, { phys: string | null; nr: string | null }>();
  const visits = await fetchAll<{ id: string; attending_physician_id: string | null; source_new_repeat: string | null }>(async (lo, hi) => {
    const { data, error } = await admin.from("visits")
      .select("id,attending_physician_id,source_new_repeat").not("legacy_import_run_id", "is", null).range(lo, hi);
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; attending_physician_id: string | null; source_new_repeat: string | null }[];
  });
  for (const v of visits) visitState.set(v.id, { phys: v.attending_physician_id, nr: v.source_new_repeat });

  // build update buckets
  const visitPhys = new Map<string, string[]>();   // physician_id -> visit ids
  const visitNR = new Map<"new" | "repeat", string[]>();
  const trDiscount = new Map<string, string[]>();   // discount_kind -> test_request ids
  const unmatchedDocs = new Map<string, number>();  // surname -> count

  for (const tr of trs) {
    const e = sheet.get(tr.legacy_source_ref);
    if (!e) continue;
    const isConsult = tr.legacy_source_ref.startsWith("DOCTOR CONSULTATION");

    // 1. doctor (consult only) -> visit.attending_physician_id (fill-NULL-only)
    if (isConsult) {
      const fullName = resolveSurname(e.doctorSurname);
      const st = visitState.get(tr.visit_id);
      if (st && st.phys === null) {
        if (fullName) {
          const pid = physIdByName.get(fullName);
          if (!pid) throw new Error(`physician not found: ${fullName}`);
          (visitPhys.get(pid) ?? visitPhys.set(pid, []).get(pid)!).push(tr.visit_id);
          st.phys = pid; // mark so multi-line visits aren't double-bucketed
        } else if (e.doctorSurname.trim()) {
          unmatchedDocs.set(e.doctorSurname.toUpperCase(), (unmatchedDocs.get(e.doctorSurname.toUpperCase()) ?? 0) + 1);
        }
      }
    }

    // 2. discount type -> test_request.discount_kind (only reclassify the lumped 'custom')
    if ((tr.discount_amount_php ?? 0) > 0 && tr.discount_kind === "custom") {
      const kind = classifyDiscount(
        isConsult
          ? { senior: e.discountSenior, other: e.discountOther }
          : { senior: e.discountSenior, d10: e.discount10, d5: e.discount5 },
        isConsult,
      );
      if (kind) (trDiscount.get(kind) ?? trDiscount.set(kind, []).get(kind)!).push(tr.id);
    }

    // 3. new/repeat (lab only) -> visit.source_new_repeat (fill-NULL-only)
    if (!isConsult) {
      const nr = parseNewRepeat(e.newRepeat);
      const st = visitState.get(tr.visit_id);
      if (nr && st && st.nr === null) {
        (visitNR.get(nr) ?? visitNR.set(nr, []).get(nr)!).push(tr.visit_id);
        st.nr = nr;
      }
    }
  }

  // summary
  const physTotal = [...visitPhys.values()].reduce((s, a) => s + a.length, 0);
  const discTotal = [...trDiscount.values()].reduce((s, a) => s + a.length, 0);
  const nrTotal = [...visitNR.values()].reduce((s, a) => s + a.length, 0);
  console.log(`\n=== enrichment dry-run ===`);
  console.log(`  doctor attribution:   ${physTotal} visits (across ${visitPhys.size} physicians)`);
  console.log(`  unmatched doctors:    ${[...unmatchedDocs.values()].reduce((a, b) => a + b, 0)} consults (${unmatchedDocs.size} surnames)`);
  console.log(`  discount reclassify:  ${discTotal} test_requests`);
  console.log(`  new/repeat set:       ${nrTotal} visits`);

  const csv = await writeCsv(
    "enrich-unmatched-doctors", ["surname", "count"],
    [...unmatchedDocs.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => [s, String(n)]),
  );
  console.log(`\nUnmatched-doctors CSV: ${csv}`);

  if (!args.commit) {
    console.log(`\nDry-run. To commit (dev): npm run enrich:clinical -- --commit --confirm="I-mean-it"\n`);
    return;
  }
  if (!args.confirmed) { console.error('\n--commit requires --confirm="I-mean-it".'); process.exit(3); }
  requireLocalOrExplicitProd("enrich:clinical");

  let applied = 0;
  for (const [pid, ids] of visitPhys) applied += await applyByIds(admin, "visits", { attending_physician_id: pid }, ids);
  for (const [nr, ids] of visitNR) applied += await applyByIds(admin, "visits", { source_new_repeat: nr }, ids);
  for (const [kind, ids] of trDiscount) applied += await applyByIds(admin, "test_requests", { discount_kind: kind }, ids);

  console.log(`\nCommit complete: doctor +${physTotal}, new/repeat +${nrTotal}, discount +${discTotal} (rows touched ${applied})`);
}

/**
 * 12.B — post settlement JEs for LAB SERVICE HMO claims marked PAID
 * (i.e., status='paid' AND date_paid IS NOT NULL).
 *
 * For each such claim:
 *   DR 1020 BPI         final_amount_php
 *   CR 1110 AR-HMO      final_amount_php
 *   posting_date = date_paid
 *
 * Idempotency: notes='xlsx HMO SETTLEMENT claim_id={uuid}'. Updates the
 * historic_hmo_claims row's journal_entry_id pointer on success.
 *
 *   npm run import:history:hmo-settlements -- --commit --confirm="I-mean-it"
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { requireLocalOrExplicitProd } from "../lib/env-guard";

interface Args { commit: boolean; confirmed: boolean; }
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    commit: argv.includes("--commit"),
    confirmed: argv.includes('--confirm="I-mean-it"') || argv.includes("--confirm=I-mean-it"),
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

async function main() {
  const args = parseArgs();

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.");
    process.exit(2);
  }
  if (args.commit) requireLocalOrExplicitProd("import:history:hmo-settlements");

  const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // CoA codes
  const { data: accounts } = await admin.from("chart_of_accounts").select("id, code");
  const codeToId = new Map((accounts ?? []).map((a) => [a.code, a.id]));
  const drBpiId = codeToId.get("1020")!;
  const crArHmoId = codeToId.get("1110")!;

  // Fetch all LAB SERVICE PAID claims with date_paid + no JE yet linked.
  // Page through to avoid the 1000-row cap.
  let from = 0;
  const PAGE = 1000;
  const candidates: { id: string; final_amount_php: number; date_paid: string; hmo_provider: string; patient_name: string; service_description: string | null }[] = [];
  while (true) {
    const { data, error } = await admin
      .from("historic_hmo_claims" as never)
      .select("id, final_amount_php, date_paid, hmo_provider, patient_name, service_description, journal_entry_id, status, source_tab")
      .eq("source_tab", "LAB SERVICE")
      .eq("status", "paid")
      .not("date_paid", "is", null)
      .is("journal_entry_id", null)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("ERROR fetching candidates:", error);
      process.exit(3);
    }
    type Row = typeof candidates[number] & { journal_entry_id: string | null; status: string; source_tab: string };
    const rows = (data as Row[]) ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      candidates.push({
        id: r.id,
        final_amount_php: Number(r.final_amount_php),
        date_paid: r.date_paid,
        hmo_provider: r.hmo_provider,
        patient_name: r.patient_name,
        service_description: r.service_description,
      });
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }

  console.log(`Candidates (PAID + date_paid + no JE yet): ${candidates.length}`);
  if (candidates.length === 0) {
    console.log("Nothing to settle.");
    return;
  }
  const total = candidates.reduce((s, c) => s + c.final_amount_php, 0);
  console.log(`Total to settle: ₱${total.toFixed(2)}`);

  // Per-provider breakdown
  const byProvider = new Map<string, { n: number; total: number }>();
  for (const c of candidates) {
    const cur = byProvider.get(c.hmo_provider) ?? { n: 0, total: 0 };
    cur.n += 1;
    cur.total += c.final_amount_php;
    byProvider.set(c.hmo_provider, cur);
  }
  console.log("\nBy provider:");
  for (const [p, v] of [...byProvider.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${v.n.toString().padStart(4)}  ₱${v.total.toFixed(2).padStart(12)}  ${p}`);
  }

  if (!args.commit) {
    console.log(`\nDry-run. To commit:\n  npm run import:history:hmo-settlements -- --commit --confirm="I-mean-it"\n`);
    return;
  }
  if (!args.confirmed) {
    console.error('ERROR: --commit requires --confirm="I-mean-it".');
    process.exit(3);
  }

  const runStamp = new Date().toISOString();
  let posted = 0, failed = 0;
  for (const c of candidates) {
    const fy = Number(c.date_paid.slice(0, 4));
    const { data: nextNum, error: numErr } = await admin.rpc("je_next_number", { p_fiscal_year: fy });
    if (numErr || !nextNum) { console.error(`${c.id}: je_next_number`, numErr); failed++; continue; }

    const amt = round2(c.final_amount_php);
    const desc = `[history] HMO settlement: ${c.hmo_provider} / ${c.patient_name}`.slice(0, 500);
    const notes = `imported_at=${runStamp} | xlsx HMO SETTLEMENT claim_id=${c.id} | service=${c.service_description ?? "?"}`.slice(0, 2000);

    const { data: je, error: jeErr } = await admin
      .from("journal_entries")
      .insert({
        entry_number: nextNum,
        posting_date: c.date_paid,
        description: desc,
        notes,
        status: "draft",
        source_kind: "history_import" as never,
        source_id: null,
      })
      .select("id")
      .single();
    if (jeErr || !je) { console.error(`${c.id}: JE insert`, jeErr); failed++; continue; }

    const lineDesc = `Settle HMO ${c.hmo_provider}: ${c.patient_name}`.slice(0, 500);
    const { error: lErr } = await admin.from("journal_lines").insert([
      { entry_id: je.id, account_id: drBpiId, debit_php: amt, credit_php: 0, description: lineDesc, line_order: 1 },
      { entry_id: je.id, account_id: crArHmoId, debit_php: 0, credit_php: amt, description: lineDesc, line_order: 2 },
    ]);
    if (lErr) {
      console.error(`${c.id}: lines insert (rolling back JE):`, lErr);
      await admin.from("journal_entries").delete().eq("id", je.id);
      failed++; continue;
    }
    const { error: pErr } = await admin
      .from("journal_entries")
      .update({ status: "posted", posted_at: new Date().toISOString() })
      .eq("id", je.id);
    if (pErr) { console.error(`${c.id}: post flip`, pErr); failed++; continue; }

    // Link back to subledger row.
    await admin
      .from("historic_hmo_claims" as never)
      .update({ journal_entry_id: je.id } as never)
      .eq("id", c.id);

    posted++;
    if (posted % 100 === 0) process.stdout.write(`\r  posted ${posted}/${candidates.length}`);
  }
  process.stdout.write("\n");
  console.log(`\nSettlement commit complete:`);
  console.log(`  Posted: ${posted}`);
  console.log(`  Failed: ${failed}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

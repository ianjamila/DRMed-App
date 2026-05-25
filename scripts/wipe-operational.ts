/**
 * wipe-operational.ts
 *
 * Wipes all operational data tables (patients, visits, payments, GL bridge,
 * audit_log, etc.) while preserving reference / config tables.
 *
 * ⚠️  HIGH-RISK DESTRUCTIVE SCRIPT — defaults to dry-run. ⚠️
 *
 * Usage:
 *   npm run wipe:operational                               # dry-run (safe)
 *   npm run wipe:operational -- --commit --confirm="I-mean-it"  # executes wipe
 *
 * Required env vars:
 *   NEXT_PUBLIC_SUPABASE_URL      — Supabase REST endpoint
 *   SUPABASE_SERVICE_ROLE_KEY     — service-role key (bypasses RLS)
 *
 * NOTE: Cannot import from src/lib/supabase/admin.ts because that module
 * imports "server-only" which throws outside the Next.js server context.
 * We inline an identical admin client here — same env vars, same options.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import type { Database } from "../src/types/database";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCKER_CONTAINER = "supabase_db_DRMed";

/**
 * Tables to wipe, in children-before-parents order.
 * TRUNCATE … CASCADE handles FK ordering automatically, but the order is
 * preserved here for observable row counts and for the audit trail.
 *
 * Skipped from original plan (not in current schema):
 *   - structured_results_drafts  → not a table; migration 0008 modifies `results`
 *   - imaging_attachments        → not found in any migration
 *   - gift_code_redemptions      → not a table; redemptions are tracked inline in `gift_codes`
 *   - hmo_ar_subledger           → migration file name, not a table (actual tables below)
 *   - eod_cash_reconciliation    → migration file name; actual tables are eod_close_records etc.
 *
 * NOT wiped (config / reference tables):
 *   - report_groups              → admin-managed config (id, code, name, is_active); referenced as
 *                                  FK target by services.report_group_id and
 *                                  result_templates.report_group_id. Wiping would break consolidated
 *                                  report generation for newly-imported patients.
 *   - cash_shifts                → shift definitions (AM/PM), not per-day transactional data.
 */
const WIPE_TABLES: string[] = [
  // Audit log first — we will re-insert exactly one ops.wipe row at the end.
  "audit_log",
  // Result leaf children
  "result_amendments",
  "result_values",
  "result_test_requests",  // added in 0051; links results ↔ test_requests for consolidated reports
  "results",
  // Critical alerts (FK → test_requests)
  "critical_alerts",
  // Core clinical workflow
  "test_requests",
  "visit_pins",
  // Gift codes: redeemed_visit_id has ON DELETE RESTRICT → must precede both payments and visits.
  "gift_codes",
  "payments",
  "appointments",
  // HMO AR subledger (tables from migration 0034_hmo_ar_subledger.sql)
  "hmo_claim_resolutions",
  "hmo_claim_items",
  "hmo_payment_allocations",
  "hmo_claim_batches",
  // GL bridge (journal_entries → journal_lines parent → child)
  "journal_lines",
  "journal_entries",
  // EOD operational transaction data (per-day petty cash adjustments and reconciliation rows).
  // These may drive JEs, so positioned after journal_entries.
  "eod_cash_adjustments",
  "eod_close_records",
  // Top-level operational roots
  "visits",
  "patients",
  // Marketing / inbound (operational, not config)
  "inquiries",
  "contact_messages",
];

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const hasCommit = args.includes("--commit");
const confirmArg = args.find((a) => a.startsWith("--confirm="));
const confirmValue = confirmArg ? confirmArg.slice("--confirm=".length).replace(/^"|"$/g, "") : null;
const REQUIRED_CONFIRM = "I-mean-it";

// ---------------------------------------------------------------------------
// Supabase service-role client (read counts; same pattern as src/lib/supabase/admin.ts)
// ---------------------------------------------------------------------------

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "ERROR: Missing required env vars.\n" +
        "  NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.\n" +
        "  For local stack: eval \"$(npx supabase status -o env | sed 's/^/export /')\"\n" +
        "  then: export NEXT_PUBLIC_SUPABASE_URL=\"$API_URL\""
    );
    process.exit(2);
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// Row-count helper (uses REST API — works for read-only counts)
// ---------------------------------------------------------------------------

async function countRows(
  admin: ReturnType<typeof createAdminClient>,
  table: string
): Promise<number> {
  // We use `any` here because WIPE_TABLES contains tables that may not all be
  // in the Database type's Keys union (e.g., tables added in later migrations
  // before types were regenerated). The count query is safe regardless.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count, error } = await (admin.from(table as any) as any).select("*", {
    count: "exact",
    head: true,
  });
  if (error) {
    // Non-fatal: print warning but continue — the table may exist in the DB
    // even if it's not in the TS types yet.
    console.warn(`  WARN: count query failed for "${table}": ${error.message}`);
    return -1;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Print row counts for all wipe tables
// ---------------------------------------------------------------------------

async function printRowCounts(
  admin: ReturnType<typeof createAdminClient>,
  label: string
): Promise<void> {
  console.log(`\n${label}`);
  console.log("─".repeat(50));
  let grandTotal = 0;
  for (const table of WIPE_TABLES) {
    const n = await countRows(admin, table);
    const countStr = n === -1 ? "(query error)" : n.toLocaleString();
    console.log(`  ${table.padEnd(32)} ${countStr}`);
    if (n > 0) grandTotal += n;
  }
  console.log("─".repeat(50));
  console.log(`  ${"TOTAL".padEnd(32)} ${grandTotal.toLocaleString()}`);
}

// ---------------------------------------------------------------------------
// Build the TRUNCATE SQL transaction
// ---------------------------------------------------------------------------

function buildWipeSql(): string {
  const truncateLines = WIPE_TABLES.map(
    (t) => `  TRUNCATE TABLE public.${t} CASCADE;`
  ).join("\n");

  const tablesList = JSON.stringify(WIPE_TABLES);

  return `
BEGIN;

${truncateLines}

-- Audit trail of the wipe itself. actor_type='system' per the audit_log check
-- constraint: ('staff', 'patient', 'system', 'anonymous').
INSERT INTO public.audit_log (
  actor_type,
  action,
  resource_type,
  metadata
) VALUES (
  'system',
  'ops.wipe',
  'operational_tables',
  '${JSON.stringify({ tables_wiped: WIPE_TABLES, table_count: WIPE_TABLES.length })}'::jsonb
);

COMMIT;
`.trim();
}

// ---------------------------------------------------------------------------
// Execute wipe via docker exec → psql (Option B from the task spec)
// Reason: exec_sql RPC is not exposed by default in Supabase REST; psql via
// docker exec is the reliable path for DDL-level statements (TRUNCATE).
// ---------------------------------------------------------------------------

function executeWipe(sql: string): void {
  console.log("\nExecuting wipe transaction via docker exec...");
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      DOCKER_CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      input: sql,
      encoding: "utf-8",
    }
  );

  if (result.error) {
    console.error("WIPE FAILED — could not spawn docker:", result.error.message);
    process.exit(4);
  }

  if (result.status !== 0) {
    console.error("WIPE FAILED — psql exited with non-zero status:");
    if (result.stderr) console.error(result.stderr);
    if (result.stdout) console.error(result.stdout);
    process.exit(4);
  }

  if (result.stdout) {
    // Print psql output for transparency (TRUNCATE / INSERT confirmations)
    console.log(result.stdout);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(60));
  console.log("  wipe-operational.ts");
  console.log("  Operational data wipe — " + WIPE_TABLES.length + " tables");
  console.log("=".repeat(60));

  const admin = createAdminClient();

  // Step 1 — Pre-counts (always, even in dry-run).
  await printRowCounts(admin, "PRE-WIPE ROW COUNTS (current state)");

  // Step 2 — Dry-run gate.
  const isCommit = hasCommit && confirmValue === REQUIRED_CONFIRM;

  if (!isCommit) {
    // Diagnose exactly which flag is wrong so the user knows what to fix.
    if (!hasCommit && !confirmArg) {
      console.log("\n[DRY-RUN] No writes performed.");
      console.log(
        "\nTo execute the wipe, re-run with BOTH flags:\n" +
          '  npm run wipe:operational -- --commit --confirm="I-mean-it"'
      );
    } else if (!hasCommit && confirmArg) {
      console.log("\n[DRY-RUN] --confirm provided but --commit is missing.");
      console.log(
        '  To execute: npm run wipe:operational -- --commit --confirm="I-mean-it"'
      );
    } else if (hasCommit && confirmValue !== REQUIRED_CONFIRM) {
      console.error(
        `\n[ABORT] --commit provided but --confirm value is wrong.` +
          `\n  Got:      "${confirmValue}"` +
          `\n  Expected: "${REQUIRED_CONFIRM}"` +
          "\n  No writes performed."
      );
      process.exit(3);
    } else {
      // hasCommit but no --confirm at all
      console.error(
        `\n[ABORT] --commit provided but --confirm="I-mean-it" is missing.` +
          "\n  No writes performed."
      );
      process.exit(3);
    }
    process.exit(0);
  }

  // Step 3 — Execute the wipe.
  console.log(
    "\n[COMMIT] Both --commit and --confirm=\"I-mean-it\" provided. Executing wipe..."
  );
  const sql = buildWipeSql();
  executeWipe(sql);
  console.log("Wipe transaction committed.");

  // Step 4 — Post-commit verification.
  await printRowCounts(admin, "POST-WIPE ROW COUNTS (should all be 0 except audit_log = 1)");

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});

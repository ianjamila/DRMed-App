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
 *   NEXT_PUBLIC_SUPABASE_URL      — Supabase REST endpoint (for row counts)
 *   SUPABASE_SERVICE_ROLE_KEY     — service-role key (bypasses RLS)
 *   SUPABASE_DB_URL               — direct Postgres connection string for the
 *                                   TRUNCATE transaction. Format:
 *                                     postgresql://user:pass@host:port/postgres
 *                                   For LOCAL stack: postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *                                   For PROD:        use the Supabase pooler URL with the DB password
 *
 * NOTE: Cannot import from src/lib/supabase/admin.ts because that module
 * imports "server-only" which throws outside the Next.js server context.
 * We inline an identical admin client here — same env vars, same options.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import type { Database } from "../src/types/database";

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
// Execute wipe via direct pg.Client connection to SUPABASE_DB_URL.
//
// Earlier version of this script ran psql via `docker exec` against a
// hardcoded local container, which silently no-op'd when env vars pointed
// at remote — counts were read against prod but the TRUNCATE landed on
// local. The pg.Client path uses the same URL pattern the rest of the
// project uses and works against any reachable Postgres (local stack,
// pooler, direct connection).
// ---------------------------------------------------------------------------

function describeTarget(rawUrl: string): string {
  // Strip the password segment so we can print the target without leaking creds.
  // postgresql://user:pass@host:port/db → postgresql://user:***@host:port/db
  return rawUrl.replace(/(:\/\/[^:/@]+:)[^@]+(@)/, "$1***$2");
}

async function executeWipe(sql: string, dbUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: dbUrl });
  try {
    await client.connect();
  } catch (err) {
    console.error("WIPE FAILED — could not connect to SUPABASE_DB_URL:");
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`Target: ${describeTarget(dbUrl)}`);
    process.exit(4);
  }

  try {
    // pg's client.query accepts a multi-statement string and runs it in
    // an implicit transaction when wrapped in BEGIN/COMMIT (which buildWipeSql does).
    await client.query(sql);
    console.log("Wipe transaction committed via pg.Client.");
  } catch (err) {
    console.error("WIPE FAILED — psql/pg error:");
    console.error(err instanceof Error ? err.message : String(err));
    // pg.Client auto-rolls back the transaction on uncaught error.
    process.exit(4);
  } finally {
    await client.end();
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

  // Fail early if SUPABASE_DB_URL is missing — needed for the commit phase,
  // and the user should see the target before any work runs.
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error(
      "\nERROR: SUPABASE_DB_URL must be set (direct Postgres connection string).\n" +
        "  For local stack: postgresql://postgres:postgres@127.0.0.1:54322/postgres\n" +
        "  For prod:        use the Supabase pooler URL (Dashboard → Connect → Pooler / Session, port 5432)\n" +
        "\n" +
        "Add it to .env.local then re-run: set -a; source .env.local; set +a; npm run wipe:operational"
    );
    process.exit(2);
  }
  console.log("Target: " + describeTarget(dbUrl));

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
  await executeWipe(sql, dbUrl);

  // Step 4 — Post-commit verification.
  await printRowCounts(admin, "POST-WIPE ROW COUNTS (should all be 0 except audit_log = 1)");

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});

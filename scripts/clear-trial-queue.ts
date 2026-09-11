/**
 * clear-trial-queue.ts
 *
 * Clears the TRIAL-ERA QUEUE so day one starts empty: soft-deletes the
 * unpaid visits created through the app during the trial period, with a
 * recorded reason and an audit row each, exactly as the in-app Delete
 * button does.
 *
 * ⚠️  Writes to whatever database you point it at. Defaults to dry-run. ⚠️
 *
 * Usage (local, the default target):
 *   npm run clear:trial-queue -- --actor-email=you@drmed.ph
 *
 * Usage (production — this is the real one; `--prod` is the opt-in, and the
 * guard prints the host and project ref then pauses so you can bail):
 *   npm run clear:trial-queue -- --prod --actor-email=you@drmed.ph
 *   npm run clear:trial-queue -- --prod --actor-email=you@drmed.ph --commit --confirm=<project ref>
 *
 * Always run it once WITHOUT --commit first and read the list it prints.
 *
 * The --confirm value is the database you are actually pointed at —
 * `local`, or the Supabase PROJECT REF for a remote one. The guard banner
 * prints it. A value memorised from one target will not work on another.
 *
 * WHAT IT TOUCHES, and what it deliberately does not:
 *
 *   IN SCOPE — app-created visits (numbered, not the `H-` historical
 *   import) that are UNPAID. Soft-delete only: `deleted_at`/`deleted_by`/
 *   `delete_reason` are set on the visit, and migration 0125's triggers
 *   cascade to its test_requests and recalculate the visit total. Nothing
 *   is erased and every row can be restored from the app.
 *
 *   NEVER IN SCOPE — the `H-` historical import. As of 2026-09-11 that is
 *   14,256 visits across 6,712 real patients going back to Dec 2023: the
 *   clinic's actual records. The visit-number filter below is the guard,
 *   and the script refuses outright if the set it resolves looks too big.
 *
 *   NEVER IN SCOPE — any PAID visit. Those carry recorded money and posted
 *   journal entries, and migration 0125's P0042 trigger blocks deleting
 *   them anyway. Clearing one means voiding its payment first, which is a
 *   deliberate decision for a person to make in the app, not a bulk script.
 *
 *   NOT IN SCOPE — appointments and public booking requests. The owner
 *   asked for the queue only. Clearing those is a separate job.
 *
 * NOTE: cannot import src/lib/supabase/admin.ts or src/lib/audit/log.ts —
 * both import "server-only", which throws outside the Next.js server
 * context. The admin client and the audit insert are inlined here, using
 * the same env vars and the same row shape.
 */

import "./lib/load-env";
import {
  CONFIRM_FLAG,
  expectedConfirmToken,
  requireLocalOrExplicitProd,
  requireTargetConfirmation,
} from "./lib/env-guard";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";

/**
 * Refuse to run if the resolved set is larger than this. The trial era is a
 * handful of visits; anything near this number means the filter is wrong and
 * we are about to touch real records. Cheap insurance against a typo in the
 * pattern below turning into a mass deletion.
 */
const MAX_EXPECTED = 25;

/** Recorded on every row, and visible in the app's Deleted entries panel. */
const DELETE_REASON = "Trial data cleared before go-live";

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const actorEmail = args
  .find((a) => a.startsWith("--actor-email="))
  ?.slice("--actor-email=".length)
  .trim();

async function main() {
  // Guard FIRST, before any client exists — a dry run still reads live
  // patient rows, and that is a disclosure in its own right.
  requireLocalOrExplicitProd("clear:trial-queue", {
    writes: "soft-deletes unpaid app-created visits (sets deleted_at, cascades to their tests)",
  });

  if (!actorEmail) {
    console.error(
      "\n--actor-email is required. Every deletion records WHO did it —\n" +
        "pass the staff account this cleanup should be attributed to, e.g.\n" +
        "  npm run clear:trial-queue -- --actor-email=you@drmed.ph\n",
    );
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve the actor. An audit row with a dangling actor is worse than no
  // script at all, so this must be a real, active staff profile.
  //
  // `staff_profiles` carries no email — a staff row IS an auth user
  // (staff_profiles.id references auth.users.id), so the address is looked
  // up there and the profile is loaded by that id.
  const { data: userList, error: userErr } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (userErr) throw userErr;
  const authUser = userList.users.find(
    (u) => u.email?.toLowerCase() === actorEmail.toLowerCase(),
  );
  if (!authUser) {
    console.error(`\nNo sign-in account with email ${actorEmail}.\n`);
    process.exit(1);
  }
  const { data: actor, error: actorErr } = await admin
    .from("staff_profiles")
    .select("id, full_name, role, is_active, deleted_at")
    .eq("id", authUser.id)
    .maybeSingle();
  if (actorErr) throw actorErr;
  if (!actor || actor.deleted_at) {
    console.error(`\nNo live staff profile for ${actorEmail}.\n`);
    process.exit(1);
  }
  if (!actor.is_active) {
    console.error(`\n${actor.full_name} is deactivated — pick an active account.\n`);
    process.exit(1);
  }
  if (actor.role !== "reception" && actor.role !== "admin") {
    console.error(
      `\n${actor.full_name} is a ${actor.role}. Deleting queue entries is a\n` +
        "reception or admin action (QUEUE_DELETE_ROLES) — this script holds\n" +
        "to the same rule the app enforces.\n",
    );
    process.exit(1);
  }

  // App-created visits only. `H-`-prefixed numbers are the historical import
  // and must never match. `not.like` is applied server-side so the historical
  // rows are never even fetched.
  const { data: candidates, error } = await admin
    .from("visits")
    .select(
      "id, visit_number, created_at, payment_status, total_php, deleted_at, patient_id, patients ( drm_id, first_name, last_name ), test_requests ( id, deleted_at )",
    )
    .not("visit_number", "like", "H-%")
    .eq("payment_status", "unpaid")
    .is("deleted_at", null)
    .order("visit_number");
  if (error) throw error;

  const rows = candidates ?? [];
  if (rows.length === 0) {
    console.log("\nNothing to clear — no unpaid app-created visits are open.\n");
    return;
  }
  if (rows.length > MAX_EXPECTED) {
    console.error(
      `\nRefusing to run: resolved ${rows.length} visits, which is more than the\n` +
        `${MAX_EXPECTED} this script expects of the trial era. That usually means the\n` +
        "filter is wrong and real records are in scope. Inspect before forcing.\n",
    );
    process.exit(1);
  }

  console.log(`\n${commit ? "CLEARING" : "DRY RUN — would clear"} ${rows.length} visit(s):\n`);
  let testCount = 0;
  for (const v of rows) {
    const p = Array.isArray(v.patients) ? v.patients[0] : v.patients;
    const live = (v.test_requests ?? []).filter((t) => t.deleted_at === null).length;
    testCount += live;
    console.log(
      `  ${v.visit_number}  ${String(v.created_at).slice(0, 10)}  ` +
        `${p?.drm_id ?? "?"}  ${p?.last_name ?? "?"}, ${p?.first_name ?? "?"}  ` +
        `₱${Number(v.total_php).toFixed(2)}  ${live} test(s)`,
    );
  }
  console.log(`\n  ${testCount} test request(s) cascade with them.`);
  console.log(`  Reason recorded: "${DELETE_REASON}"`);
  console.log(`  Attributed to:   ${actor.full_name} (${actor.role})\n`);

  if (!commit) {
    // Echo back the operator's OWN flags, not a reconstructed set. Rebuilding
    // the line by hand silently dropped --prod, so the suggested command
    // pointed at local while the dry run above had read production — the
    // confirm token would not have matched and the real run would simply not
    // have happened, which is a confusing way to find out.
    const replay = args.filter((a) => a !== "--commit" && !a.startsWith(CONFIRM_FLAG));
    console.log(
      `Dry run only. To apply:\n  npm run clear:trial-queue -- ` +
        `${replay.join(" ")} --commit ${CONFIRM_FLAG}=${expectedConfirmToken()}\n`,
    );
    return;
  }

  requireTargetConfirmation("clear:trial-queue");

  let done = 0;
  for (const v of rows) {
    const p = Array.isArray(v.patients) ? v.patients[0] : v.patients;
    const live = (v.test_requests ?? []).filter((t) => t.deleted_at === null).length;

    // Mirrors deleteVisitAction: the `is("deleted_at", null)` filter is the
    // race guard, and 0125's triggers own the cascade and the unpaid rule —
    // if one slipped to paid since the read above, P0042 rejects it here.
    const { error: delErr } = await admin
      .from("visits")
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: actor.id,
        delete_reason: DELETE_REASON,
      })
      .eq("id", v.id)
      .is("deleted_at", null);
    if (delErr) {
      console.error(`  ${v.visit_number}: SKIPPED — ${delErr.message}`);
      continue;
    }

    // Same action name and metadata shape the app writes, so these are
    // indistinguishable from an in-app deletion in the audit viewer apart
    // from the `via` marker.
    const { error: auditErr } = await admin.from("audit_log").insert({
      actor_id: actor.id,
      actor_type: "staff",
      patient_id: v.patient_id,
      action: "visit.deleted",
      resource_type: "visit",
      resource_id: v.id,
      metadata: {
        reason: DELETE_REASON,
        visit_number: v.visit_number,
        total_php: Number(v.total_php),
        active_test_count: live,
        via: "clear:trial-queue script",
      },
      ip_address: null,
      user_agent: "clear-trial-queue.ts",
    });
    if (auditErr) throw auditErr;

    console.log(`  ${v.visit_number}: cleared (${p?.drm_id ?? "?"})`);
    done += 1;
  }

  console.log(
    `\nCleared ${done} of ${rows.length} visit(s). Every one is restorable from\n` +
      "the app (Deleted entries → Restore); audit rows are permanent by design.\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

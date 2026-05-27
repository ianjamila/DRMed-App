"use server";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveSourceRoute } from "@/lib/accounting/source-kind-resolver";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { revalidatePath } from "next/cache";

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

type JeStub = { id: string; entry_number: string | null } | null;

async function loadJE(id: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("journal_entries")
    .select(`
      *,
      journal_lines (
        id,
        line_order,
        account_id,
        debit_php,
        credit_php,
        description,
        chart_of_accounts:chart_of_accounts!account_id ( code, name )
      )
    `)
    .eq("id", id)
    .maybeSingle();
  return data;
}

/**
 * Fetch a JE with lines, CoA detail, reverse-link stubs, and a resolved
 * source-kind cross-link.
 *
 * Note: Supabase's TS generator does not reliably infer self-referential FK
 * aliases like `journal_entries!reverses` in a single select clause, so the
 * reverses / reversed_by stubs are fetched as two separate lightweight queries
 * to keep the typing exact and avoid unsafe casts.
 */
export async function getJournalEntryAction(id: string): Promise<
  ActionResult<
    NonNullable<Awaited<ReturnType<typeof loadJE>>> & {
      reverses_je: JeStub;
      reversed_by_je: JeStub;
      source_link: { label: string; href: string } | null;
    }
  >
> {
  await requireAdminStaff();

  const je = await loadJE(id);
  if (!je) return { ok: false, error: "JE not found" };

  // Fetch reversal stubs separately to avoid self-FK alias TS ambiguity.
  const admin = createAdminClient();

  const [reversesResult, reversedByResult] = await Promise.all([
    je.reverses
      ? admin
          .from("journal_entries")
          .select("id, entry_number")
          .eq("id", je.reverses)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    je.reversed_by
      ? admin
          .from("journal_entries")
          .select("id, entry_number")
          .eq("id", je.reversed_by)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const reversesJe: JeStub = reversesResult.data
    ? { id: reversesResult.data.id, entry_number: reversesResult.data.entry_number }
    : null;

  const reversedByJe: JeStub = reversedByResult.data
    ? { id: reversedByResult.data.id, entry_number: reversedByResult.data.entry_number }
    : null;

  const sourceLink = await resolveSourceRoute(je.source_kind, je.source_id);

  return {
    ok: true,
    data: {
      ...je,
      reverses_je: reversesJe,
      reversed_by_je: reversedByJe,
      source_link: sourceLink,
    },
  };
}

/**
 * Flip a draft JE to posted. The je_lines_balance_check trigger validates
 * DR=CR at status-flip time, so an unbalanced draft will be rejected with
 * a P0001 error here (rather than silently posting bad lines).
 */
export async function postJournalEntryAction(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  const profile = await requireAdminStaff();
  const admin = createAdminClient();

  const { data: je } = await admin
    .from("journal_entries")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!je) return { ok: false, error: "JE not found" };
  if (je.status !== "draft") {
    return { ok: false, error: "Only draft journal entries can be posted" };
  }

  const { data: updated, error } = await admin
    .from("journal_entries")
    .update({ status: "posted" })
    .eq("id", id)
    .eq("status", "draft")
    .select("id");

  if (error) return { ok: false, error: translatePgError(error) };
  if (!updated || updated.length === 0) {
    return { ok: false, error: "JE could not be posted — it may have changed status" };
  }

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "journal_entry.posted",
    resource_type: "journal_entry",
    resource_id: id,
  });

  revalidatePath(`/staff/admin/accounting/journal/${id}`);
  revalidatePath("/staff/admin/accounting/journal");
  return { ok: true, data: { id } };
}

/**
 * Delete a draft JE and all its lines. Posted JEs cannot be deleted (use
 * reversal instead). Lines are deleted first to avoid the balance-check
 * trigger firing on the last line.
 */
export async function deleteDraftJournalEntryAction(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  const profile = await requireAdminStaff();
  const admin = createAdminClient();

  const { data: je } = await admin
    .from("journal_entries")
    .select("status, entry_number")
    .eq("id", id)
    .maybeSingle();
  if (!je) return { ok: false, error: "JE not found" };
  if (je.status !== "draft") {
    return { ok: false, error: "Only draft journal entries can be deleted" };
  }

  const { error: linesErr } = await admin
    .from("journal_lines")
    .delete()
    .eq("entry_id", id);
  if (linesErr) return { ok: false, error: translatePgError(linesErr) };

  const { error: jeErr } = await admin
    .from("journal_entries")
    .delete()
    .eq("id", id)
    .eq("status", "draft");
  if (jeErr) return { ok: false, error: translatePgError(jeErr) };

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "journal_entry.deleted",
    resource_type: "journal_entry",
    resource_id: id,
    metadata: { entry_number: je.entry_number },
  });

  revalidatePath("/staff/admin/accounting/journal");
  return { ok: true, data: { id } };
}

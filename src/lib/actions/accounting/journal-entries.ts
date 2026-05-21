"use server";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveSourceRoute } from "@/lib/accounting/source-kind-resolver";

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

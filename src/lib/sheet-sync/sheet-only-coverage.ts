import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

// How much of the reception sheet the app holds ONLY as Sheet Sync's reporting
// copy — rows that are not app visits, so the External Sync Status copy to the
// accountant's sheet (which reads app visits) never sends them. Counts and the
// date range only: no amounts leave this module, so the mirror stays out of
// money surfaces (spec §11, mirror-readers.test.ts) while the page can say why
// a tab looks stuck. The rows become real visits only at the switch-over.

export type SheetOnlyTab = "lab" | "consult";

export interface SheetOnlyCoverage {
  rows: number;
  firstDate: string | null;
  lastDate: string | null;
}

async function readTab(tab: SheetOnlyTab): Promise<SheetOnlyCoverage | null> {
  const admin = createAdminClient();
  const [count, first, last] = await Promise.all([
    admin.from("sheet_encounter_lines").select("id", { count: "exact", head: true }).eq("tab", tab),
    admin.from("sheet_encounter_lines").select("service_date").eq("tab", tab).order("service_date", { ascending: true }).limit(1).maybeSingle(),
    admin.from("sheet_encounter_lines").select("service_date").eq("tab", tab).order("service_date", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (count.error || first.error || last.error || count.count === null) return null;
  return {
    rows: count.count,
    firstDate: first.data?.service_date ?? null,
    lastDate: last.data?.service_date ?? null,
  };
}

// A failed read returns null for that tab so the page leaves the line out
// rather than claiming the sheet is empty.
export async function readSheetOnlyCoverage(): Promise<Record<SheetOnlyTab, SheetOnlyCoverage | null>> {
  const [lab, consult] = await Promise.all([readTab("lab"), readTab("consult")]);
  return { lab, consult };
}

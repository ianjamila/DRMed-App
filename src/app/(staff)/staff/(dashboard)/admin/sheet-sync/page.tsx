import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { sectionTabClass, sectionTabsNavClass } from "@/components/staff/section-tabs-style";
import { friendlyManilaDate, manilaDateTime } from "@/lib/dates/manila";
import { ROUTE_NAME } from "@/lib/staff/route-names";
import { missingSheetEnv } from "@/lib/sheet-sync/config";
import type { ReviewKind, TabKey } from "@/lib/sheet-sync/types";
import type { RunOutcome } from "@/lib/sheet-sync/run";
import type { Database } from "@/types/database";
import { SyncSwitch, SyncNow } from "./sync-controls";
import { RunHistory } from "./run-history";
import { ReviewQueue } from "./review-queue";
import { KIND_LABEL, TAB_LABEL, tabErrorLabel } from "./format";

export const metadata = { title: ROUTE_NAME["/staff/admin/sheet-sync"] };
export const dynamic = "force-dynamic";
export const maxDuration = 300; // "Sync now" runs inside this page's server action

const BASE_PATH = "/staff/admin/sheet-sync";
type Client = SupabaseClient<Database>;

const VIEWS = ["overview", "review", "resort", "history"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = {
  overview: "Overview",
  review: "Review queue",
  resort: "Re-sort",
  history: "Run history",
};

// TabOutcome.status is typed "succeeded" | "failed" | "skipped", distinct
// from sheet_sync_runs.status that format.ts's STATUS_LABEL is pinned to
// (format.test.ts) — a separate map avoids reusing one built for a different
// vocabulary. Only "succeeded"/"failed" are ever actually assigned in run.ts
// today (confirmed by reading every `status:` literal there) — a shrunk-sheet
// skip is recorded as status "failed" with a suspect_snapshot error, not a
// "skipped" status — so this map only needs the two live values; a future
// "skipped" would still fall back to "—" via the `??` below rather than
// rendering nothing.
const TAB_STATUS_LABEL: Record<string, string> = {
  succeeded: "Done",
  failed: "Failed",
};

async function countOpenByKind(supabase: Client): Promise<Record<ReviewKind, number>> {
  const kinds = Object.keys(KIND_LABEL) as ReviewKind[];
  const rows = await Promise.all(
    kinds.map(async (kind) => {
      const { count } = await supabase
        .from("sheet_sync_review_items")
        .select("id", { count: "exact", head: true })
        .eq("kind", kind)
        .eq("status", "open");
      return [kind, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(rows) as Record<ReviewKind, number>;
}

async function countOpenByTab(supabase: Client): Promise<Record<TabKey, number>> {
  const tabs = Object.keys(TAB_LABEL) as TabKey[];
  const rows = await Promise.all(
    tabs.map(async (tab) => {
      const { count } = await supabase
        .from("sheet_sync_review_items")
        .select("id", { count: "exact", head: true })
        .eq("tab", tab)
        .eq("status", "open");
      return [tab, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(rows) as Record<TabKey, number>;
}

interface LastRunRow {
  id: string;
  trigger: string;
  dry_run: boolean;
  status: string;
  started_at: string;
  ended_at: string | null;
  per_tab: RunOutcome["perTab"] | null;
  summary: Record<string, unknown> | null;
  error: string | null;
}

export default async function SheetSyncPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAdminStaff();
  const params = await searchParams;
  const view: View = VIEWS.find((v) => v === params.view) ?? "overview";
  const supabase = await createClient();

  const [{ data: settings }, { data: lastRunData }, openByKind, openByTab] = await Promise.all([
    supabase.from("sheet_sync_settings").select("*").eq("id", true).single(),
    supabase
      .from("sheet_sync_runs")
      .select("id, trigger, dry_run, status, started_at, ended_at, per_tab, summary, error")
      .eq("dry_run", false)
      .order("started_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(1),
    countOpenByKind(supabase),
    countOpenByTab(supabase),
  ]);
  const lastRun = (lastRunData?.[0] ?? null) as unknown as LastRunRow | null;
  const envMissing = missingSheetEnv();
  const openTotal = Object.values(openByKind).reduce((a, b) => a + b, 0);

  let pausedByName: string | null = null;
  if (settings?.paused_by) {
    const { data: staff } = await supabase
      .from("staff_profiles")
      .select("full_name")
      .eq("id", settings.paused_by)
      .maybeSingle();
    pausedByName = staff?.full_name ?? null;
  }

  const tabHref = (v: View) => `${BASE_PATH}?view=${v}`;

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title={ROUTE_NAME["/staff/admin/sheet-sync"]}
        subtitle={
          'Keeps patients current from the reception Google Sheet "LAB SERVICES (RECEPTION)" and keeps a copy of ' +
          "its lab and consultation lines for patient-source reports. Nothing here creates visits or payments."
        }
      />

      <nav className={sectionTabsNavClass} aria-label="Sheet sync sections">
        {VIEWS.map((v) => {
          const active = v === view;
          return (
            <Link key={v} href={tabHref(v)} className={sectionTabClass(active)} aria-current={active ? "page" : undefined}>
              {VIEW_LABEL[v]}
              {v === "review" && openTotal > 0 ? (
                <span className="ml-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">
                  {openTotal}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      {view === "overview" && (
        <Overview
          settings={settings ?? null}
          pausedByName={pausedByName}
          lastRun={lastRun}
          envMissing={envMissing}
          openByTab={openByTab}
        />
      )}
      {view === "history" && <RunHistory searchParams={params} />}
      {view === "review" && <ReviewQueue searchParams={params} />}
      {view === "resort" && (
        <Panel className="p-6 text-sm text-[color:var(--color-brand-text-soft)]">
          The re-sort panel lands in a follow-up PR task.
        </Panel>
      )}
    </div>
  );
}

function Overview({
  settings,
  pausedByName,
  lastRun,
  envMissing,
  openByTab,
}: {
  settings: Database["public"]["Tables"]["sheet_sync_settings"]["Row"] | null;
  pausedByName: string | null;
  lastRun: LastRunRow | null;
  envMissing: string[];
  openByTab: Record<TabKey, number>;
}) {
  const paused = settings?.paused ?? true;
  return (
    <div className="space-y-6">
      {envMissing.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>Not configured on this server</AlertTitle>
          <AlertDescription>{envMissing.join(", ")}</AlertDescription>
        </Alert>
      )}

      <Panel className="p-5">
        <p className="font-bold text-[color:var(--color-brand-navy)]">Status</p>
        <div className="mt-2">
          <SyncSwitch paused={paused} />
        </div>
        {paused && (settings?.paused_at || settings?.pause_reason) && (
          <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
            {settings?.paused_at ? `Paused ${manilaDateTime(settings.paused_at)}` : "Paused"}
            {pausedByName ? ` by ${pausedByName}` : ""}
            {settings?.pause_reason ? ` — "${settings.pause_reason}"` : ""}
          </p>
        )}
      </Panel>

      <Panel className="p-5">
        <p className="font-bold text-[color:var(--color-brand-navy)]">Sync now</p>
        <div className="mt-2">
          <SyncNow paused={paused} lastRunPerTab={lastRun?.per_tab ?? null} />
        </div>
      </Panel>

      {lastRun && (
        <Panel className="overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[color:var(--color-brand-bg-mid)] text-xs font-semibold uppercase tracking-wide text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-3 py-2">Tab</th>
                <th className="px-3 py-2">Sheet last updated</th>
                <th className="px-3 py-2">Rows read</th>
                <th className="px-3 py-2">Copied rows</th>
                <th className="px-3 py-2">Open issues</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(TAB_LABEL) as TabKey[]).map((tab) => {
                const out = lastRun.per_tab?.[tab];
                return (
                  <tr key={tab} className="border-b border-[color:var(--color-brand-bg-mid)] last:border-0">
                    <td className="px-3 py-2 font-semibold">{TAB_LABEL[tab]}</td>
                    <td className="px-3 py-2">{out?.last_date ? friendlyManilaDate(out.last_date) : "—"}</td>
                    <td className="px-3 py-2">{out?.rows_read ?? "—"}</td>
                    <td className="px-3 py-2">{out?.mirror_rows ?? "—"}</td>
                    <td className="px-3 py-2">
                      {openByTab[tab] > 0 ? (
                        <Link href={`${BASE_PATH}?view=review`} className="font-semibold text-cyan-700 hover:underline">
                          {openByTab[tab]}
                        </Link>
                      ) : (
                        "0"
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {out?.status === "failed" ? (
                        <span className="text-red-600">{tabErrorLabel(tab, out.error) ?? "Failed"}</span>
                      ) : (
                        (out?.status && TAB_STATUS_LABEL[out.status]) ?? "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      )}

      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        Lab and consultation lines are a reporting copy. They never become visits, payments or accounting entries
        here.
      </p>
    </div>
  );
}

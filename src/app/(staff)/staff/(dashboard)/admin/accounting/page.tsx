import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { manilaDateTime } from "@/lib/dates/manila";
import { CRON_HEARTBEATS } from "@/lib/ops/cron-heartbeats";
import { describeCronSchedule } from "@/lib/ops/cron-schedule";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAccountingEnv,
  readAllWatermarks,
} from "@/lib/accounting/sync";
import { AccountingActions } from "./accounting-actions";
import { ROUTE_NAME } from "@/lib/staff/route-names";

export const metadata = { title: ROUTE_NAME["/staff/admin/accounting"] };
export const dynamic = "force-dynamic";

const SYNC_SCHEDULE = describeCronSchedule(
  CRON_HEARTBEATS.find((c) => c.key === "sync-accounting")?.schedule ?? "",
);

export default async function AccountingAdminPage() {
  await requireAdminStaff();

  const env = readAccountingEnv();
  const watermarks = await readAllWatermarks();
  const lastRun = await readLastRun();

  const envMissing = "missing" in env ? env.missing : null;

  // 12.5 banner counts — computed server-side; tables may not exist yet if
  // migrations haven't been applied; guard with try/catch to avoid breaking
  // the page pre-migration.
  let agingCount = 0;
  let unconfiguredCount = 0;
  try {
    const adminClient = createAdminClient();
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const [aging, unconfigured] = await Promise.all([
      adminClient
        .from("cogs_send_out_entries")
        .select("id", { count: "exact", head: true })
        .is("trueup_id", null)
        .is("voided_at", null)
        .lt("accrued_at", ninetyDaysAgo),
      adminClient
        .from("services")
        .select("id", { count: "exact", head: true })
        .eq("is_send_out", true)
        .or("send_out_unit_cost_php.is.null,send_out_unit_cost_php.eq.0"),
    ]);
    agingCount = aging.count ?? 0;
    unconfiguredCount = unconfigured.count ?? 0;
  } catch {
    // Pre-migration: silently skip banners.
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {ROUTE_NAME["/staff/admin/accounting"]}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          {SYNC_SCHEDULE} (Manila), new sales are copied to the three Google
          Sheets tabs. Each tab below shows how far the copy has reached.
          You can run the copy now, or rewind a tab to copy it again from an
          earlier time.
        </p>
      </header>

      {agingCount > 0 ? (
        <Link
          href="/staff/admin/accounting/cogs/send-outs?filter=age_90_plus"
          className="mb-3 block rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 hover:bg-amber-100"
        >
          <span className="font-bold">{agingCount} send-out accrual{agingCount === 1 ? "" : "s"} over 90 days unbilled.</span>{" "}
          Click to review and match to a Hi Precision bill.
        </Link>
      ) : null}

      {unconfiguredCount > 0 ? (
        <Link
          href="/staff/admin/accounting/cogs/send-outs/unconfigured"
          className="mb-3 block rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 hover:bg-red-100"
        >
          <span className="font-bold">{unconfiguredCount} send-out service{unconfiguredCount === 1 ? "" : "s"} missing unit cost configuration.</span>{" "}
          Click to configure unit costs so COGS accrual fires correctly.
        </Link>
      ) : null}

      {envMissing ? (
        <div className="mb-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-bold">Sheets sync is not yet configured.</p>
          <p className="mt-1">
            Missing environment variables:{" "}
            <code className="rounded bg-amber-100 px-1 py-0.5 text-xs font-mono">
              {envMissing.join(", ")}
            </code>
          </p>
          <p className="mt-1 text-xs">
            See <code className="font-mono">.env.example</code> for setup
            steps. Manual re-sync controls below will report the same missing
            envs until they&apos;re set.
          </p>
        </div>
      ) : null}

      <section className="mb-8">
        <h2 className="font-heading text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Copy progress by tab
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          {lastRun
            ? `Last run ${manilaDateTime(lastRun.at)} (${lastRun.byHand ? "run by hand" : "daily run"}) — ${lastRun.summary}`
            : "No run recorded yet."}
        </p>
        <ul className="mt-2 divide-y divide-[color:var(--color-brand-bg-mid)] rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          {watermarks.map((w) => (
            <li
              key={w.key}
              className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="font-semibold text-[color:var(--color-brand-navy)]">
                  {w.label}
                </p>
                <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                  {w.lastSyncedAt
                    ? `Copied up to ${manilaDateTime(w.lastSyncedAt)}`
                    : "Nothing copied yet — each run looks back 24 hours until the first row is copied"}
                  {lastRun?.rowsByTab.has(w.key)
                    ? ` · ${rowsPhrase(lastRun.rowsByTab.get(w.key) ?? 0)} in the last run`
                    : null}
                </p>
                {w.notes ? (
                  <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                    Last rewind: {w.notes}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <AccountingActions />
    </div>
  );
}

function rowsPhrase(n: number): string {
  return n === 1 ? "1 row added" : `${n} rows added`;
}

// The "Copied up to" time is the newest row copied, not when the sync ran — a
// quiet month leaves it weeks old while the daily run is fine. The run itself
// is in the audit log (the same rows Cron Health reads).
async function readLastRun(): Promise<{
  at: string;
  byHand: boolean;
  summary: string;
  rowsByTab: Map<string, number>;
} | null> {
  const { data } = await createAdminClient()
    .from("audit_log")
    .select("created_at, action, actor_type, metadata")
    .in("action", ["accounting.sync.completed", "accounting.sync.empty", "accounting.sync.skipped"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const meta = (data.metadata ?? {}) as {
    tabs?: { key: string; rows: number; skipped: string | null }[];
  };
  const rowsByTab = new Map((meta.tabs ?? []).map((t) => [t.key, t.rows] as const));
  const total = [...rowsByTab.values()].reduce((sum, n) => sum + n, 0);
  const failed = (meta.tabs ?? []).filter((t) => t.skipped).length;
  const summary =
    data.action === "accounting.sync.skipped"
      ? "skipped: the Google Sheets settings are missing"
      : `${rowsPhrase(total)}${failed > 0 ? `, ${failed} tab${failed === 1 ? "" : "s"} failed` : ""}`;
  return { at: data.created_at, byHand: data.actor_type === "staff", summary, rowsByTab };
}

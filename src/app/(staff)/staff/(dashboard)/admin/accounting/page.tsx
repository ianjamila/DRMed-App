import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAccountingEnv,
  readAllWatermarks,
} from "@/lib/accounting/sync";
import { AccountingActions } from "./accounting-actions";

export const metadata = { title: "Accounting sync — staff" };
export const dynamic = "force-dynamic";

export default async function AccountingAdminPage() {
  await requireAdminStaff();

  const env = readAccountingEnv();
  const watermarks = await readAllWatermarks();

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
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 7C · Admin
        </p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Accounting sync
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Daily 5pm Manila cron appends new rows to the three Google Sheets
          tabs. This page shows the per-tab watermark and lets admins re-run the
          sync now or rewind the watermark for a backfill.
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
          Watermarks
        </h2>
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
                    ? `Last synced ${formatManila(w.lastSyncedAt)}`
                    : "Never synced — first cron run will pick up the last 24h"}
                </p>
                {w.notes ? (
                  <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                    Note: {w.notes}
                  </p>
                ) : null}
              </div>
              <code className="shrink-0 rounded bg-[color:var(--color-brand-bg)] px-2 py-1 text-[10px] font-mono text-[color:var(--color-brand-text-soft)]">
                {w.key}
              </code>
            </li>
          ))}
        </ul>
      </section>

      <AccountingActions />
    </div>
  );
}

// Render an ISO timestamp as Manila local time, e.g. "2026-05-04 17:00".
function formatManila(iso: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(new Date(iso)).replace(",", "");
}

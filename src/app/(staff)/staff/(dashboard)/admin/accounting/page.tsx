import { requireAdminStaff } from "@/lib/auth/require-admin";
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

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 7C · Admin
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Accounting sync
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Daily 5pm Manila cron appends new rows to the three Google Sheets
          tabs. This page shows the per-tab watermark and lets admins re-run the
          sync now or rewind the watermark for a backfill.
        </p>
      </header>

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
        <h2 className="font-[family-name:var(--font-heading)] text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
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

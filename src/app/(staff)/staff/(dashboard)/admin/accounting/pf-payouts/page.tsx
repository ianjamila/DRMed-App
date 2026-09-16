import { loadPfWorklists } from "@/lib/accounting/pf-worklists";
import { loadPfHistory, parsePfHistoryParams } from "@/lib/accounting/pf-history";
import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { pluckOne } from "@/lib/reports/format";
import { todayManilaISODate } from "@/lib/dates/manila";
import { PfPayoutsClient } from "./pf-payouts-client";

export const metadata = { title: "Pay Doctors" };
export const dynamic = "force-dynamic";

export default async function PfPayoutsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { openEntries, pendingHmo } = await loadPfWorklists(admin);

  // 0136 moved compensation_arrangement into physician_compensation, so it now
  // arrives one level deeper in the embed. Flatten it HERE rather than teaching
  // the client to descend: pf-payouts-client declares its own PhysicianInfo
  // shape with the field OPTIONAL, so a stale direct read type-checks fine and
  // silently yields undefined — every doctor would render as "pf split",
  // including the rent_paying and shareholder ones. Same trap that hid in
  // pf-ytd-summary. Keeping the client's contract flat means it cannot recur.
  const openEntriesFlat = openEntries.map((e) => {
    const ph = pluckOne(e.physicians);
    return {
      ...e,
      physicians: ph
        ? {
            id: ph.id,
            full_name: ph.full_name,
            is_active: ph.is_active,
            compensation_arrangement:
              pluckOne(ph.physician_compensation)?.compensation_arrangement ?? null,
          }
        : null,
    };
  });

  // History uses the same start/end date form as the admin reports.
  const historyParams = parsePfHistoryParams(await searchParams, todayManilaISODate());
  const { rows: history, state: historyState } = await loadPfHistory(admin, historyParams);

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Admin · Pay doctors
        </p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Pay Doctors
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Pay each doctor their share of the consults they did. The app already
          worked out the amounts — send each doctor their total by GCash or cash
          the way you normally do, then record it here. &ldquo;Waiting on
          insurance&rdquo; amounts stay held until the HMO pays the clinic.
        </p>
      </header>

      <section className="mb-6 rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-bold text-[color:var(--color-brand-navy)]">
            How this works
          </h2>
          <Link
            href="/staff/admin/accounting/pf-payouts/guide"
            className="shrink-0 text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            Print quick guide →
          </Link>
        </div>
        <ol className="mt-2 space-y-1 text-sm text-[color:var(--color-brand-text-soft)]">
          <li>
            <strong className="text-[color:var(--color-brand-navy)]">1.</strong>{" "}
            Send the doctor their amount by GCash or cash, the way you normally do.
          </li>
          <li>
            <strong className="text-[color:var(--color-brand-navy)]">2.</strong>{" "}
            Click <strong>Pay this doctor</strong>, pick how you paid, then Confirm.
          </li>
          <li>
            <strong className="text-[color:var(--color-brand-navy)]">3.</strong>{" "}
            <strong>Waiting on insurance</strong>{" "}
            means don&apos;t pay yet — it moves to{" "}
            <strong>Ready to pay</strong> once the HMO pays the clinic.
          </li>
        </ol>
      </section>

      <PfPayoutsClient
        openEntries={openEntriesFlat}
        pendingHmo={pendingHmo}
        history={history}
        historyState={historyState}
        nowIso={new Date().toISOString()}
      />
    </div>
  );
}

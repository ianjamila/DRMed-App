"use client";

import { HISTORY_DEFAULT_SORT, type HistorySort, type PfHistoryState } from "@/lib/accounting/pf-history";
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createPfDisbursement } from "@/lib/actions/accounting/pf-disbursements";
import { createBulkPfPayoutCash } from "@/lib/actions/accounting/pf-bulk-payout";
import { manilaDate, todayManilaISODate } from "@/lib/dates/manila";
import { formatPfMethod } from "@/lib/accounting/pf-labels";
import {
  ariaSortFor,
  DEFAULT_PAGE_SIZE,
  buildListHref,
  nextSort,
  pageCount,
} from "@/lib/ui/table-params";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PhysicianInfo = {
  id: string;
  full_name: string;
  compensation_arrangement?: string | null;
  is_active?: boolean | null;
} | null;

type OpenEntry = {
  id: string;
  pf_php: number;
  recognized_at: string | null;
  recognition_basis: string;
  physician_id: string;
  test_request_id: string;
  hmo_allocation_id: string | null;
  created_at: string;
  physicians: PhysicianInfo | PhysicianInfo[];
};

type PendingHmoEntry = {
  id: string;
  pf_php: number;
  recognition_basis: string;
  physician_id: string;
  test_request_id: string;
  created_at: string;
  physicians: { id: string; full_name: string } | { id: string; full_name: string }[] | null;
};

type HistoryDisbursement = {
  id: string;
  batch_number: number;
  posted_date: string;
  method: string;
  total_php: number;
  voided_at: string | null;
  physicians: { id: string; full_name: string } | { id: string; full_name: string }[] | null;
};

type Tab = "open" | "pending_hmo" | "history";

const BASE_PATH = "/staff/admin/accounting/pf-payouts";
const TAB_KEYS = ["open", "pending_hmo", "history"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPhysicianName(p: PhysicianInfo | PhysicianInfo[] | null): string {
  if (!p) return "(unknown)";
  if (Array.isArray(p)) return p[0]?.full_name ?? "(unknown)";
  return p.full_name;
}

function getPhysicianField<K extends keyof NonNullable<PhysicianInfo>>(
  p: PhysicianInfo | PhysicianInfo[] | null,
  key: K
): NonNullable<PhysicianInfo>[K] | undefined {
  if (!p) return undefined;
  if (Array.isArray(p)) return p[0]?.[key];
  return p[key];
}

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
});

// ---------------------------------------------------------------------------
// Root client component
// ---------------------------------------------------------------------------

export function PfPayoutsClient({
  openEntries,
  pendingHmo,
  history,
  historyState,
  nowIso,
}: {
  openEntries: OpenEntry[];
  pendingHmo: PendingHmoEntry[];
  history: HistoryDisbursement[];
  historyState: PfHistoryState;
  nowIso: string;
}) {
  // The tab lives in the URL rather than in component state so that the
  // History tab's `?sort=&dir=&page=&size=` belong to a tab you can link to —
  // and so switching tabs drops them, instead of carrying a sort that means
  // nothing on the tab you just landed on.
  const params = useSearchParams();
  const rawTab = params.get("tab");
  const tab: Tab = (TAB_KEYS as readonly string[]).includes(rawTab ?? "")
    ? (rawTab as Tab)
    : "open";

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "open", label: "Ready to pay", count: openEntries.length },
    { key: "pending_hmo", label: "Waiting on insurance", count: pendingHmo.length },
    { key: "history", label: "Already paid", count: historyState.total },
  ];

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-0 mb-6 border-b border-[color:var(--color-brand-border)]">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={buildListHref(BASE_PATH, { start: params.get("start"), end: params.get("end") }, { tab: t.key === "open" ? null : t.key })}
            aria-current={tab === t.key ? "page" : undefined}
            className={[
              "px-4 py-2 text-sm font-medium transition-colors",
              tab === t.key
                ? "border-b-2 border-[color:var(--color-brand-navy)] text-[color:var(--color-brand-navy)]"
                : "text-[color:var(--color-brand-text-soft)] hover:text-[color:var(--color-brand-navy)]",
            ].join(" ")}
          >
            {t.label}{" "}
            <span className="ml-1 rounded-full bg-[color:var(--color-brand-bg)] px-1.5 py-0.5 text-xs">
              {t.count}
            </span>
          </Link>
        ))}
      </div>

      {tab === "open" && <OpenTab entries={openEntries} />}
      {tab === "pending_hmo" && <PendingHmoTab entries={pendingHmo} nowIso={nowIso} />}
      {tab === "history" && <HistoryTab disbursements={history} historyState={historyState} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 1 — Open
// ---------------------------------------------------------------------------

type PhysicianGroup = {
  name: string;
  arrangement: string;
  isActive: boolean;
  entries: OpenEntry[];
  total: number;
};

function OpenTab({ entries }: { entries: OpenEntry[] }) {
  const [payBatchPid, setPayBatchPid] = useState<string | null>(null);
  const [showBulk, setShowBulk] = useState(false);

  // Group entries by physician
  const byPhysician = new Map<string, PhysicianGroup>();
  for (const e of entries) {
    const pid = e.physician_id;
    if (!byPhysician.has(pid)) {
      byPhysician.set(pid, {
        name: getPhysicianName(e.physicians as PhysicianInfo | PhysicianInfo[] | null),
        arrangement: (getPhysicianField(e.physicians as PhysicianInfo | PhysicianInfo[] | null, "compensation_arrangement") ?? "pf_split") as string,
        isActive: (getPhysicianField(e.physicians as PhysicianInfo | PhysicianInfo[] | null, "is_active") ?? true) as boolean,
        entries: [],
        total: 0,
      });
    }
    const g = byPhysician.get(pid)!;
    g.entries.push(e);
    g.total += Number(e.pf_php);
  }

  // Ordered by doctor name, not Map insertion order — which is whatever order
  // the entries query happened to return, so the same list of doctors could
  // reshuffle between loads. This tab is a payout worklist and stays
  // deliberately UNPAGED: hiding a doctor who is owed money behind a "next
  // page" is how someone gets missed on payout day.
  const groups = Array.from(byPhysician.entries()).sort((a, b) =>
    a[1].name.localeCompare(b[1].name),
  );
  const activePositiveGroups = groups.filter(([, g]) => g.isActive && g.total > 0);
  const inactiveGroups = groups.filter(([, g]) => !g.isActive && g.total !== 0);
  const negativeGroups = groups.filter(([, g]) => g.isActive && g.total < 0);

  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-[color:var(--color-brand-border)] bg-[color:var(--color-brand-bg)] p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
        No doctor PFs awaiting payout. All current visits paid out.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Bulk action */}
      {activePositiveGroups.length > 1 && (
        <div className="flex justify-end">
          <button
            onClick={() => setShowBulk(true)}
            className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white hover:bg-[color:var(--color-brand-cyan)] transition-colors"
          >
            Pay everyone (cash only)
          </button>
        </div>
      )}

      {/* Active physicians — desktop table */}
      {activePositiveGroups.length > 0 && (
        <>
          <div className="hidden md:block overflow-x-auto rounded-md border border-[color:var(--color-brand-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Doctor</th>
                  <th className="px-4 py-3 text-left font-medium">Arrangement</th>
                  <th className="px-4 py-3 text-right font-medium">Entries</th>
                  <th className="px-4 py-3 text-right font-medium">Total PHP</th>
                  <th className="px-4 py-3 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-border)]">
                {activePositiveGroups.map(([pid, g]) => (
                  <tr key={pid} className="hover:bg-[color:var(--color-brand-bg)]/50">
                    <td className="px-4 py-3 font-medium">{g.name}</td>
                    <td className="px-4 py-3 capitalize text-[color:var(--color-brand-text-soft)]">
                      {g.arrangement.replace("_", " ")}
                    </td>
                    <td className="px-4 py-3 text-right">{g.entries.length}</td>
                    <td className="px-4 py-3 text-right font-mono">
                      {PHP.format(g.total)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setPayBatchPid(pid)}
                        className="text-[color:var(--color-brand-cyan)] hover:underline font-medium text-sm"
                      >
                        Pay this doctor
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Active physicians — mobile cards */}
          <div className="md:hidden space-y-3">
            {activePositiveGroups.map(([pid, g]) => (
              <div
                key={pid}
                className="rounded-md border border-[color:var(--color-brand-border)] p-4 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-sm">{g.name}</p>
                    <p className="text-xs text-[color:var(--color-brand-text-soft)] capitalize">
                      {g.arrangement.replace("_", " ")} · {g.entries.length} entries
                    </p>
                  </div>
                  <p className="font-mono text-sm font-semibold">{PHP.format(g.total)}</p>
                </div>
                <button
                  onClick={() => setPayBatchPid(pid)}
                  className="w-full rounded-md border border-[color:var(--color-brand-cyan)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-brand-cyan)] hover:bg-[color:var(--color-brand-cyan)] hover:text-white transition-colors"
                >
                  Pay this doctor
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Inactive doctors sub-section */}
      {inactiveGroups.length > 0 && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 p-4">
          <h3 className="text-sm font-semibold text-yellow-800 mb-2">
            Inactive doctors with open balances — manual review required
          </h3>
          <ul className="space-y-1 text-sm text-yellow-700">
            {inactiveGroups.map(([pid, g]) => (
              <li key={pid}>
                {g.name}: {PHP.format(g.total)} ({g.entries.length} entries)
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Clawback sub-section */}
      {negativeGroups.length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4">
          <h3 className="text-sm font-semibold text-red-800 mb-2">
            Doctor owes clinic (clawback balance)
          </h3>
          <ul className="space-y-1 text-sm text-red-700">
            {negativeGroups.map(([pid, g]) => (
              <li key={pid}>
                {g.name}: {PHP.format(g.total)} — Resolve manually
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Pay batch dialog */}
      {payBatchPid && (
        <PayBatchDialog
          group={byPhysician.get(payBatchPid)!}
          physicianId={payBatchPid}
          onClose={() => setPayBatchPid(null)}
        />
      )}

      {/* Bulk payout dialog */}
      {showBulk && (
        <BulkPayoutDialog
          activeGroups={activePositiveGroups}
          onClose={() => setShowBulk(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pay batch dialog (per-physician)
// ---------------------------------------------------------------------------

type PayMethod = "cash" | "gcash" | "bank_transfer";

function PayBatchDialog({
  group,
  physicianId,
  onClose,
}: {
  group: PhysicianGroup;
  physicianId: string;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<PayMethod>("cash");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleConfirm() {
    setSubmitting(true);
    setErr(null);
    const res = await createPfDisbursement({
      physician_id: physicianId,
      posted_date: todayManilaISODate(),
      method,
      total_php: group.total,
      entry_ids: group.entries.map((e) => e.id),
    });
    setSubmitting(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    onClose();
    window.location.reload();
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Pay {group.name} — {PHP.format(group.total)}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <div>
            <p className="text-sm text-[color:var(--color-brand-text-soft)] mb-1">
              {group.entries.length} unpaid item{group.entries.length === 1 ? "" : "s"} for this doctor will be marked paid.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Payment method
            </label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as PayMethod)}
              className="w-full rounded-md border border-[color:var(--color-brand-border)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]"
            >
              <option value="cash">Cash</option>
              <option value="gcash">GCash</option>
              <option value="bank_transfer">Bank transfer</option>
            </select>
          </div>

          {err && (
            <p className="text-sm text-red-600 rounded-md bg-red-50 border border-red-200 px-3 py-2">
              {err}
            </p>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-md border border-[color:var(--color-brand-border)] hover:bg-[color:var(--color-brand-bg)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={submitting}
              className="px-4 py-2 text-sm font-semibold rounded-md bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)] transition-colors disabled:opacity-60"
            >
              {submitting ? "Saving…" : "Confirm payment"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Bulk payout dialog (all active physicians, cash only)
// ---------------------------------------------------------------------------

function BulkPayoutDialog({
  activeGroups,
  onClose,
}: {
  activeGroups: [string, PhysicianGroup][];
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const grandTotal = activeGroups.reduce((s, [, g]) => s + g.total, 0);

  async function handleConfirm() {
    setSubmitting(true);
    setErr(null);
    const res = await createBulkPfPayoutCash({
      posted_date: todayManilaISODate(),
      by_physician: activeGroups.map(([pid, g]) => ({
        physician_id: pid,
        entry_ids: g.entries.map((e) => e.id),
        total_php: g.total,
      })),
    });
    setSubmitting(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    onClose();
    window.location.reload();
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pay everyone (cash only)</DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <p className="text-sm text-[color:var(--color-brand-text-soft)]">
            One cash payment will be recorded per doctor. (For GCash, pay each
            doctor individually instead.)
          </p>

          <div className="max-h-64 overflow-y-auto divide-y divide-[color:var(--color-brand-border)] rounded-md border border-[color:var(--color-brand-border)]">
            {activeGroups.map(([pid, g]) => (
              <div key={pid} className="flex justify-between px-3 py-2 text-sm">
                <span className="font-medium">{g.name}</span>
                <span className="font-mono">{PHP.format(g.total)}</span>
              </div>
            ))}
          </div>

          <div className="flex justify-between text-sm font-semibold border-t pt-2">
            <span>Grand total</span>
            <span className="font-mono">{PHP.format(grandTotal)}</span>
          </div>

          {err && (
            <p className="text-sm text-red-600 rounded-md bg-red-50 border border-red-200 px-3 py-2">
              {err}
            </p>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-md border border-[color:var(--color-brand-border)] hover:bg-[color:var(--color-brand-bg)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={submitting}
              className="px-4 py-2 text-sm font-semibold rounded-md bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)] transition-colors disabled:opacity-60"
            >
              {submitting ? "Posting…" : "Confirm all"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Tab 2 — Pending HMO
// ---------------------------------------------------------------------------

function PendingHmoTab({ entries, nowIso }: { entries: PendingHmoEntry[]; nowIso: string }) {
  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-[color:var(--color-brand-border)] bg-[color:var(--color-brand-bg)] p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
        Nothing waiting on insurance right now.
      </div>
    );
  }

  // Group by physician
  const byPhys = new Map<string, { name: string; entries: PendingHmoEntry[]; total: number }>();
  for (const e of entries) {
    const pid = e.physician_id;
    if (!byPhys.has(pid)) {
      const p = e.physicians;
      const name = Array.isArray(p) ? (p[0]?.full_name ?? "(unknown)") : (p?.full_name ?? "(unknown)");
      byPhys.set(pid, { name, entries: [], total: 0 });
    }
    const g = byPhys.get(pid)!;
    g.entries.push(e);
    g.total += Number(e.pf_php);
  }

  const nowMs = new Date(nowIso).getTime();

  // Same reasoning as the Ready-to-pay tab: ordered by doctor name so the list
  // is stable across loads, and left unpaged because it is a watchlist of
  // money still owed.
  const physGroups = Array.from(byPhys.entries()).sort((a, b) =>
    a[1].name.localeCompare(b[1].name),
  );

  return (
    <div className="space-y-4">
      {physGroups.map(([pid, g]) => (
        <div
          key={pid}
          className="rounded-md border border-[color:var(--color-brand-border)] overflow-hidden"
        >
          {/* Group header */}
          <div className="flex items-center justify-between px-4 py-3 bg-[color:var(--color-brand-bg)]">
            <span className="font-semibold text-sm">{g.name}</span>
            <span className="text-sm font-mono">
              {PHP.format(g.total)}{" "}
              <span className="text-[color:var(--color-brand-text-soft)] font-sans font-normal">
                ({g.entries.length} item{g.entries.length === 1 ? "" : "s"})
              </span>
            </span>
          </div>

          {/* Sub-rows */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-[color:var(--color-brand-border)] text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Reference</th>
                  <th className="px-4 py-2 text-right font-medium">Fee (₱)</th>
                  <th className="px-4 py-2 text-right font-medium">Days waiting</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-border)]">
                {g.entries.map((e) => {
                  const ageDays = Math.floor(
                    (nowMs - new Date(e.created_at).getTime()) / (1000 * 60 * 60 * 24)
                  );
                  return (
                    <tr key={e.id} className="hover:bg-[color:var(--color-brand-bg)]/50">
                      <td className="px-4 py-2 font-mono">
                        {e.test_request_id.slice(0, 8)}…
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        {PHP.format(Number(e.pf_php))}
                      </td>
                      <td className={`px-4 py-2 text-right ${ageDays > 60 ? "text-red-600" : ageDays > 30 ? "text-yellow-600" : "text-[color:var(--color-brand-text-soft)]"}`}>
                        {ageDays}d
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 3 — History
// ---------------------------------------------------------------------------

function physicianNameOf(
  p: { id: string; full_name: string } | { id: string; full_name: string }[] | null,
): string {
  if (!p) return "(unknown)";
  return Array.isArray(p) ? (p[0]?.full_name ?? "(unknown)") : p.full_name;
}

function HistoryTab({ disbursements, historyState }: { disbursements: HistoryDisbursement[]; historyState: PfHistoryState }) {
  const params = useSearchParams();
  const { sort, size, page: safePage, total, start, end } = historyState;
  const totalPages = pageCount(total, size);
  const rows = disbursements;

  const isDefaultSort =
    sort.key === HISTORY_DEFAULT_SORT.key && sort.dir === HISTORY_DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    tab: "history",
    start: params.get("start") || params.get("end") ? start : null,
    end,
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
  };

  const sortHref = (key: HistorySort) => {
    const next = nextSort(sort, key);
    const nextIsDefault =
      next.key === HISTORY_DEFAULT_SORT.key && next.dir === HISTORY_DEFAULT_SORT.dir;
    return buildListHref(BASE_PATH, baseParams, {
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
      page: null,
    });
  };

  const th = (key: HistorySort, label: string, align: "left" | "right" = "left") => (
    <SortableTh
      key={key}
      label={label}
      href={sortHref(key)}
      state={ariaSortFor(sort, key)}
      align={align}
    />
  );

  return (
    <>
      <form action="" className="my-6 flex flex-wrap items-end gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
        <input type="hidden" name="tab" value="history" />
        <label className="flex flex-col text-sm">Paid from
          <input key={start} type="date" name="start" defaultValue={start} className="mt-1 rounded-md border px-2 py-1.5" />
        </label>
        <label className="flex flex-col text-sm">…to
          <input key={end ?? ""} type="date" name="end" defaultValue={end ?? ""} className="mt-1 rounded-md border px-2 py-1.5" />
        </label>
        {!isDefaultSort && (
          <>
            <input type="hidden" name="sort" value={sort.key} />
            <input type="hidden" name="dir" value={sort.dir} />
          </>
        )}
        {size !== DEFAULT_PAGE_SIZE && <input type="hidden" name="size" value={size} />}
        <button type="submit" className="min-h-11 rounded-md bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white">Apply</button>
        <Link href={buildListHref(BASE_PATH, baseParams, { start: null, end: null, page: null })} className="text-sm hover:underline">Last 90 days</Link>
      </form>
      {total === 0 && <p className="rounded-md border p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">No payments in this date range.</p>}
    <div className="overflow-x-auto rounded-md border border-[color:var(--color-brand-border)]">
      <table className="w-full text-sm md:min-w-[640px]">
        <thead className="bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]">
          <tr>
            {th("batch_number", "Reference no.")}
            {th("posted_date", "Date")}
            {th("physician", "Doctor")}
            {th("method", "Paid by")}
            {th("total_php", "Total", "right")}
            <PlainTh label="" align="right" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--color-brand-border)]">
          {rows.map((d) => {
            const year = d.posted_date.slice(0, 4);
            const batchLabel = `PF-${year}-${String(d.batch_number).padStart(4, "0")}`;
            const isVoided = !!d.voided_at;
            const physName = physicianNameOf(d.physicians);

            return (
              <tr
                key={d.id}
                className={`hover:bg-[color:var(--color-brand-bg)]/50 ${isVoided ? "opacity-50" : ""}`}
              >
                <td className={`px-4 py-3 font-mono text-xs ${isVoided ? "line-through" : ""}`}>
                  {batchLabel}
                </td>
                <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                  {manilaDate(d.posted_date)}
                </td>
                <td className="px-4 py-3">{physName}</td>
                <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                  {formatPfMethod(d.method)}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {PHP.format(Number(d.total_php))}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-3">
                    <Link
                      href={`/staff/admin/accounting/pf-payouts/${d.id}`}
                      className="text-[color:var(--color-brand-cyan)] hover:underline text-xs font-medium"
                    >
                      View
                    </Link>
                    <Link
                      href={`/staff/admin/accounting/pf-payouts/${d.id}/slip`}
                      className="text-[color:var(--color-brand-cyan)] hover:underline text-xs font-medium"
                      aria-label={`Print acknowledgment slip for ${batchLabel}`}
                    >
                      Print slip
                    </Link>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>

    <ListPagination
      page={safePage}
      pageCount={totalPages}
      total={total}
      size={size}
      prevHref={
        safePage > 1
          ? buildListHref(BASE_PATH, baseParams, {
              page: safePage - 1 > 1 ? String(safePage - 1) : null,
            })
          : null
      }
      nextHref={
        safePage < totalPages
          ? buildListHref(BASE_PATH, baseParams, { page: String(safePage + 1) })
          : null
      }
      sizeOptions={PAGE_SIZES.map((s) => ({
        size: s,
        href: buildListHref(BASE_PATH, baseParams, {
          size: s === DEFAULT_PAGE_SIZE ? null : String(s),
          page: null,
        }),
      }))}
      noun="payout"
    />
    </>
  );
}

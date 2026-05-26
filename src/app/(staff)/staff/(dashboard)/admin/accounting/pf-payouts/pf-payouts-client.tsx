"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createPfDisbursement } from "@/lib/actions/accounting/pf-disbursements";
import { createBulkPfPayoutCash } from "@/lib/actions/accounting/pf-bulk-payout";
import { todayManilaISODate } from "@/lib/dates/manila";

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

function formatMethod(m: string): string {
  switch (m) {
    case "cash": return "Cash";
    case "gcash": return "GCash";
    case "bank_transfer": return "Bank transfer";
    default: return m;
  }
}

// ---------------------------------------------------------------------------
// Root client component
// ---------------------------------------------------------------------------

export function PfPayoutsClient({
  openEntries,
  pendingHmo,
  history,
  nowIso,
}: {
  openEntries: OpenEntry[];
  pendingHmo: PendingHmoEntry[];
  history: HistoryDisbursement[];
  nowIso: string;
}) {
  const [tab, setTab] = useState<Tab>("open");

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "open", label: "Open", count: openEntries.length },
    { key: "pending_hmo", label: "Pending HMO", count: pendingHmo.length },
    { key: "history", label: "History (90d)", count: history.length },
  ];

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-0 mb-6 border-b border-[color:var(--color-brand-border)]">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
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
          </button>
        ))}
      </div>

      {tab === "open" && <OpenTab entries={openEntries} />}
      {tab === "pending_hmo" && <PendingHmoTab entries={pendingHmo} nowIso={nowIso} />}
      {tab === "history" && <HistoryTab disbursements={history} />}
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

  const groups = Array.from(byPhysician.entries());
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
            Pay all doctors (cash)
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
                        Pay batch
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
                  Pay batch
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
              {group.entries.length} PF entries will be cleared.
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
              {submitting ? "Posting…" : "Confirm payment"}
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
          <DialogTitle>Pay all doctors (cash)</DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <p className="text-sm text-[color:var(--color-brand-text-soft)]">
            One cash disbursement will be recorded per doctor.
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
        No PFs awaiting HMO settlement.
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

  return (
    <div className="space-y-4">
      {Array.from(byPhys.entries()).map(([pid, g]) => (
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
                ({g.entries.length} entries)
              </span>
            </span>
          </div>

          {/* Sub-rows */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-[color:var(--color-brand-border)] text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Test request</th>
                  <th className="px-4 py-2 text-right font-medium">PF PHP</th>
                  <th className="px-4 py-2 text-right font-medium">Age</th>
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

function HistoryTab({ disbursements }: { disbursements: HistoryDisbursement[] }) {
  if (disbursements.length === 0) {
    return (
      <div className="rounded-md border border-[color:var(--color-brand-border)] bg-[color:var(--color-brand-bg)] p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
        No disbursements in the last 90 days.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-[color:var(--color-brand-border)]">
      <table className="w-full text-sm md:min-w-[640px]">
        <thead className="bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]">
          <tr>
            <th className="px-4 py-3 text-left font-medium">Batch</th>
            <th className="px-4 py-3 text-left font-medium">Date</th>
            <th className="px-4 py-3 text-left font-medium">Doctor</th>
            <th className="px-4 py-3 text-left font-medium">Method</th>
            <th className="px-4 py-3 text-right font-medium">Total</th>
            <th className="px-4 py-3 text-right font-medium"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--color-brand-border)]">
          {disbursements.map((d) => {
            const year = d.posted_date.slice(0, 4);
            const batchLabel = `PF-${year}-${String(d.batch_number).padStart(4, "0")}`;
            const isVoided = !!d.voided_at;
            const physName = Array.isArray(d.physicians)
              ? (d.physicians[0]?.full_name ?? "(unknown)")
              : (d.physicians?.full_name ?? "(unknown)");

            return (
              <tr
                key={d.id}
                className={`hover:bg-[color:var(--color-brand-bg)]/50 ${isVoided ? "opacity-50" : ""}`}
              >
                <td className={`px-4 py-3 font-mono text-xs ${isVoided ? "line-through" : ""}`}>
                  {batchLabel}
                </td>
                <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                  {d.posted_date}
                </td>
                <td className="px-4 py-3">{physName}</td>
                <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                  {formatMethod(d.method)}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {PHP.format(Number(d.total_php))}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/staff/admin/accounting/pf-payouts/${d.id}`}
                    className="text-[color:var(--color-brand-cyan)] hover:underline text-xs font-medium"
                  >
                    View
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

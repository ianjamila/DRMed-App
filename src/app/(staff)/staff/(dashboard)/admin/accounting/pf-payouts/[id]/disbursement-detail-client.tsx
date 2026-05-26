"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { voidPfDisbursement } from "@/lib/actions/accounting/pf-disbursements";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PhysicianRef = {
  id: string;
  full_name: string;
} | { id: string; full_name: string }[] | null;

type StaffRef = {
  id: string;
  full_name: string;
} | { id: string; full_name: string }[] | null;

type Disbursement = {
  id: string;
  batch_number: number;
  posted_date: string;
  method: string;
  total_php: number;
  notes: string | null;
  voided_at: string | null;
  void_reason: string | null;
  journal_entry_id: string | null;
  recorded_at: string;
  physicians: PhysicianRef;
  recorded_by_staff: StaffRef;
};

type Entry = {
  id: string;
  pf_php: number;
  test_request_id: string;
  recognition_basis: string;
  recognized_at: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
});

function getName(ref: PhysicianRef | StaffRef): string {
  if (!ref) return "(unknown)";
  if (Array.isArray(ref)) return ref[0]?.full_name ?? "(unknown)";
  return ref.full_name;
}

function formatMethod(m: string): string {
  switch (m) {
    case "cash": return "Cash";
    case "gcash": return "GCash";
    case "bank_transfer": return "Bank transfer";
    default: return m;
  }
}

function formatBasis(b: string): string {
  switch (b) {
    case "cash_at_release": return "Cash — accrued at release";
    case "hmo_at_settlement": return "HMO — accrued at settlement";
    case "clawback": return "Clawback";
    default: return b;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DisbursementDetailClient({
  disbursement: d,
  entries,
}: {
  disbursement: Disbursement;
  entries: Entry[];
}) {
  const [showVoid, setShowVoid] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const year = d.posted_date.slice(0, 4);
  const batchLabel = `PF-${year}-${String(d.batch_number).padStart(4, "0")}`;
  const isVoided = !!d.voided_at;

  async function handleVoid() {
    if (!reason || reason.trim().length < 3) {
      setErr("Reason must be at least 3 characters.");
      return;
    }
    setSubmitting(true);
    setErr(null);
    const res = await voidPfDisbursement({
      disbursement_id: d.id,
      void_reason: reason.trim(),
    });
    setSubmitting(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    window.location.href = "/staff/admin/accounting/pf-payouts";
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <header>
        <nav className="mb-2 text-xs text-[color:var(--color-brand-text-soft)]">
          <Link
            href="/staff/admin/accounting/pf-payouts"
            className="hover:underline"
          >
            Doctor PF Payouts
          </Link>
          {" / "}
          <span>{batchLabel}</span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
              Phase 12.5 · Admin · Accounting
            </p>
            <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
              {batchLabel}
            </h1>
            {isVoided && (
              <span className="mt-1 inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                VOIDED
              </span>
            )}
          </div>
          {!isVoided && (
            <button
              onClick={() => setShowVoid(true)}
              className="rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100 transition-colors"
            >
              Void disbursement
            </button>
          )}
        </div>
      </header>

      {/* Detail card */}
      <div className="rounded-md border border-[color:var(--color-brand-border)] overflow-hidden">
        <dl className="divide-y divide-[color:var(--color-brand-border)] text-sm">
          {[
            ["Doctor", getName(d.physicians)],
            ["Date", d.posted_date],
            ["Method", formatMethod(d.method)],
            ["Total", PHP.format(Number(d.total_php))],
            ["Recorded by", getName(d.recorded_by_staff)],
            ["Recorded at", new Date(d.recorded_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })],
            ...(d.notes ? [["Notes", d.notes] as [string, string]] : []),
            ...(isVoided
              ? [
                  ["Voided at", new Date(d.voided_at!).toLocaleString("en-PH", { timeZone: "Asia/Manila" })],
                  ["Void reason", d.void_reason ?? "(none)"],
                ]
              : []),
          ].map(([label, value]) => (
            <div key={label} className="grid grid-cols-3 px-4 py-3">
              <dt className="font-medium text-[color:var(--color-brand-text-soft)]">{label}</dt>
              <dd className="col-span-2">{value}</dd>
            </div>
          ))}
          {d.journal_entry_id && (
            <div className="grid grid-cols-3 px-4 py-3">
              <dt className="font-medium text-[color:var(--color-brand-text-soft)]">Journal entry</dt>
              <dd className="col-span-2">
                <Link
                  href={`/staff/admin/accounting/journal/${d.journal_entry_id}`}
                  className="text-[color:var(--color-brand-cyan)] hover:underline text-sm"
                >
                  View JE →
                </Link>
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* Cleared entries */}
      <section>
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[color:var(--color-brand-navy)] mb-3">
          Cleared entries ({entries.length})
        </h2>
        {entries.length === 0 ? (
          <p className="text-sm text-[color:var(--color-brand-text-soft)]">
            No entries found for this disbursement.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-[color:var(--color-brand-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Test request</th>
                  <th className="px-4 py-3 text-left font-medium">Basis</th>
                  <th className="px-4 py-3 text-left font-medium">Recognized at</th>
                  <th className="px-4 py-3 text-right font-medium">PF PHP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-border)]">
                {entries.map((e) => (
                  <tr key={e.id} className="hover:bg-[color:var(--color-brand-bg)]/50">
                    <td className="px-4 py-3 font-mono text-xs">
                      {e.test_request_id.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                      {formatBasis(e.recognition_basis)}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                      {e.recognized_at
                        ? new Date(e.recognized_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {PHP.format(Number(e.pf_php))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Void dialog */}
      {showVoid && (
        <Dialog open onOpenChange={(v) => !v && setShowVoid(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Void disbursement {batchLabel}</DialogTitle>
              <DialogDescription>
                This will reverse the JE and unlink all cleared entries.
                Entries will return to the Open tab. This action cannot be
                undone.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Reason <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason for voiding (required)"
                  rows={3}
                  className="w-full rounded-md border border-[color:var(--color-brand-border)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)] resize-none"
                />
              </div>

              {err && (
                <p className="text-sm text-red-600 rounded-md bg-red-50 border border-red-200 px-3 py-2">
                  {err}
                </p>
              )}

              <div className="flex gap-2 justify-end pt-2">
                <button
                  onClick={() => setShowVoid(false)}
                  className="px-4 py-2 text-sm rounded-md border border-[color:var(--color-brand-border)] hover:bg-[color:var(--color-brand-bg)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleVoid}
                  disabled={!reason.trim() || reason.trim().length < 3 || submitting}
                  className="px-4 py-2 text-sm font-semibold rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-60"
                >
                  {submitting ? "Voiding…" : "Confirm void"}
                </button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

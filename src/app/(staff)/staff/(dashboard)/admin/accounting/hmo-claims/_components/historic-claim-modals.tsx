"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  markHistoricClaimsBilledAction,
  markHistoricClaimsPaidAction,
  unmarkHistoricClaimsBilledAction,
  writeOffHistoricClaimsAction,
} from "../actions";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

export type StaffPick = { id: string; full_name: string };
export type PaymentMethod = { code: string; name: string };

function ModalShell({
  title,
  description,
  onClose,
  children,
  onConfirm,
  confirmLabel,
  confirmDisabled,
  confirmTone = "navy",
  pending,
  error,
}: {
  title: string;
  description: string;
  onClose: () => void;
  children: React.ReactNode;
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  confirmTone?: "navy" | "emerald" | "red";
  pending: boolean;
  error: string | null;
}) {
  const toneCls =
    confirmTone === "emerald"
      ? "bg-emerald-600 text-white"
      : confirmTone === "red"
        ? "bg-red-600 text-white"
        : "bg-[color:var(--color-brand-navy)] text-white";
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]">
          {title}
        </h2>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">{description}</p>
        <div className="mt-4 space-y-3">{children}</div>
        {error && (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending || confirmDisabled}
            className={
              "min-h-[44px] rounded-md px-4 py-2 text-xs font-bold uppercase tracking-wider disabled:opacity-60 " +
              toneCls
            }
          >
            {pending ? "Saving..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function MarkHistoricBilledModal({
  claimIds,
  totalAmount,
  staff,
  onClose,
}: {
  claimIds: string[];
  totalAmount: number;
  staff: StaffPick[];
  onClose: () => void;
}) {
  const router = useRouter();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  const [date, setDate] = useState(today);
  const [staffId, setStaffId] = useState(staff[0]?.id ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    setErr(null);
    if (!staffId) { setErr("Pick a staff member."); return; }
    startTransition(async () => {
      const res = await markHistoricClaimsBilledAction({
        claim_ids: claimIds,
        date_submitted: date,
        billed_by_staff_id: staffId,
      });
      if (!res.ok) { setErr(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  return (
    <ModalShell
      title="Mark as billed"
      description={`Confirm ${claimIds.length} historic ${claimIds.length === 1 ? "claim" : "claims"} (${PHP.format(totalAmount)}) were invoiced to the HMO. Removes them from Unbilled.`}
      onClose={onClose}
      onConfirm={onConfirm}
      confirmLabel="Confirm"
      confirmDisabled={!staffId}
      pending={pending}
      error={err}
    >
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">Date billed</span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          max={today}
          className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm"
        />
      </label>
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">Recorded by</span>
        <select
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
          className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm"
        >
          {staff.length === 0 ? (
            <option value="">No active staff</option>
          ) : (
            staff.map((s) => (
              <option key={s.id} value={s.id}>{s.full_name}</option>
            ))
          )}
        </select>
      </label>
    </ModalShell>
  );
}

export function MarkHistoricPaidModal({
  claimIds,
  totalAmount,
  staff,
  paymentMethods,
  onClose,
}: {
  claimIds: string[];
  totalAmount: number;
  staff: StaffPick[];
  paymentMethods: PaymentMethod[];
  onClose: () => void;
}) {
  const router = useRouter();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  const [datePaid, setDatePaid] = useState(today);
  const [method, setMethod] = useState<string>(paymentMethods[0]?.code ?? "");
  const [orNumber, setOrNumber] = useState("");
  const [staffId, setStaffId] = useState(staff[0]?.id ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    setErr(null);
    if (!staffId) { setErr("Pick a staff member."); return; }
    if (!method) { setErr("Pick a payment method."); return; }
    startTransition(async () => {
      const res = await markHistoricClaimsPaidAction({
        claim_ids: claimIds,
        date_paid: datePaid,
        payment_method: method,
        or_number: orNumber.trim() || null,
        paid_recorded_by_staff_id: staffId,
      });
      if (!res.ok) { setErr(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  return (
    <ModalShell
      title="Mark as paid"
      description={`Record HMO settlement for ${claimIds.length} ${claimIds.length === 1 ? "claim" : "claims"} (${PHP.format(totalAmount)}). Posts a settlement JE per claim.`}
      onClose={onClose}
      onConfirm={onConfirm}
      confirmLabel="Confirm paid"
      confirmTone="emerald"
      confirmDisabled={!staffId || !method}
      pending={pending}
      error={err}
    >
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">Date paid</span>
        <input
          type="date"
          value={datePaid}
          onChange={(e) => setDatePaid(e.target.value)}
          max={today}
          className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm"
        />
      </label>
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">Settled to</span>
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm"
        >
          {paymentMethods.length === 0 ? (
            <option value="">No payment methods configured</option>
          ) : (
            paymentMethods.map((pm) => (
              <option key={pm.code} value={pm.code}>
                {pm.name} ({pm.code})
              </option>
            ))
          )}
        </select>
        <p className="mt-1 text-[10px] text-[color:var(--color-brand-text-soft)]">
          To add a method, go to{" "}
          <a
            href="/staff/admin/accounting/chart-of-accounts"
            className="text-[color:var(--color-brand-cyan)] hover:underline"
          >
            Chart of Accounts
          </a>
          {" "}and enable &quot;Settlement destination&quot; on the account.
        </p>
      </label>
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">OR # (optional)</span>
        <input
          type="text"
          value={orNumber}
          onChange={(e) => setOrNumber(e.target.value)}
          maxLength={50}
          className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm"
        />
      </label>
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">Recorded by</span>
        <select
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
          className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm"
        >
          {staff.length === 0 ? (
            <option value="">No active staff</option>
          ) : (
            staff.map((s) => (
              <option key={s.id} value={s.id}>{s.full_name}</option>
            ))
          )}
        </select>
      </label>
    </ModalShell>
  );
}

export function WriteOffHistoricModal({
  claimIds,
  totalAmount,
  staff,
  onClose,
}: {
  claimIds: string[];
  totalAmount: number;
  staff: StaffPick[];
  onClose: () => void;
}) {
  const router = useRouter();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState("");
  const [staffId, setStaffId] = useState(staff[0]?.id ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    setErr(null);
    if (!reason.trim() || reason.trim().length < 3) {
      setErr("Reason is required (min 3 chars).");
      return;
    }
    if (!staffId) { setErr("Pick a staff member."); return; }
    startTransition(async () => {
      const res = await writeOffHistoricClaimsAction({
        claim_ids: claimIds,
        reason: reason.trim(),
        wrote_off_by_staff_id: staffId,
        write_off_date: date,
      });
      if (!res.ok) { setErr(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  return (
    <ModalShell
      title="Write off"
      description={`Permanently write off ${claimIds.length} ${claimIds.length === 1 ? "claim" : "claims"} (${PHP.format(totalAmount)}). Posts DR 6920 Bad Debt / CR 1110 AR-HMO per claim.`}
      onClose={onClose}
      onConfirm={onConfirm}
      confirmLabel="Confirm write-off"
      confirmTone="red"
      confirmDisabled={!staffId || reason.trim().length < 3}
      pending={pending}
      error={err}
    >
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">Posting date</span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          max={today}
          className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm"
        />
      </label>
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">Reason</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder="e.g., HMO denied claim; no further follow-up possible"
          className="mt-1 w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-2 text-sm"
        />
      </label>
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">Recorded by</span>
        <select
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
          className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm"
        >
          {staff.length === 0 ? (
            <option value="">No active staff</option>
          ) : (
            staff.map((s) => (
              <option key={s.id} value={s.id}>{s.full_name}</option>
            ))
          )}
        </select>
      </label>
    </ModalShell>
  );
}

export async function unmarkSingle(claimId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await unmarkHistoricClaimsBilledAction({ claim_ids: [claimId] });
  if (res.ok) return { ok: true };
  return { ok: false, error: res.error };
}

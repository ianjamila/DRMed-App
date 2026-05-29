"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recordCashAdjustmentAction, voidCashAdjustmentAction }
  from "./actions";
import { PaymentsTabs } from "../_components/payments-tabs";
import type { Database } from "@/types/database";

type Adjustment = Database["public"]["Tables"]["eod_cash_adjustments"]["Row"];
type Shift = { id: string; code: string; label: string };
type Account = { id: string; code: string; name: string; type: string };
type Staff = { id: string; full_name: string; role: string };

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

const friendlyManilaDate = (isoDate: string) => {
  const d = new Date(`${isoDate}T12:00:00+08:00`);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "Asia/Manila",
  }).format(d);
  const longDate = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Manila",
  }).format(d);
  return `${weekday}, ${longDate}`;
};

// Plain-English labels for the stored `kind` codes, so reception never sees
// raw values like "petty_cash" or "float_topup".
const KIND_LABEL: Record<string, string> = {
  petty_cash: "Petty cash",
  salary_advance: "Salary advance",
  courier: "Courier / delivery",
  other_payout: "Other",
  float_topup: "Cash added to drawer",
  float_pullout: "Cash removed from drawer",
};
const kindLabel = (k: string) => KIND_LABEL[k] ?? k;

export function CashDrawerClient(props: {
  sessionUserId: string;
  businessDate: string;
  shifts: Shift[];
  currentShiftId: string;
  state: Record<string, unknown>;
  rows: Adjustment[];
  accounts: Account[];
  staff: Staff[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [openModal, setOpenModal] = useState<"payout" | "topup" | "pullout" | null>(null);

  const s = props.state as {
    opening_float_php?: number;
    cash_payments_php?: number;
    cash_payouts_php?: number;
    expected_cash_php?: number;
    payments_by_method?: Record<string, number>;
    closed?: { id: string; closed_at: string; closed_by: string } | null;
  };
  const closed = !!s.closed;

  const handleVoid = (id: string) => {
    const reason = window.prompt("Why are you removing this entry?");
    if (!reason) return;
    start(async () => {
      const r = await voidCashAdjustmentAction(id, reason);
      if (!r.ok) alert(r.error);
      else router.refresh();
    });
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <PaymentsTabs />
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
          Cash drawer
        </h1>
        <div className="flex flex-col items-start gap-1 text-sm text-[color:var(--color-brand-text-soft)] sm:items-end">
          <span className="font-medium text-[color:var(--color-brand-navy)]">
            {friendlyManilaDate(props.businessDate)}
          </span>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={props.businessDate}
              onChange={(e) =>
                router.push(`/staff/payments/cash-drawer?date=${e.target.value}&shift=${props.currentShiftId}`)
              }
              className="rounded border px-2 py-1"
            />
            {props.shifts.length > 1 && (
              <select
                value={props.currentShiftId}
                onChange={(e) =>
                  router.push(`/staff/payments/cash-drawer?date=${props.businessDate}&shift=${e.target.value}`)
                }
                className="rounded border px-2 py-1"
              >
                {props.shifts.map((sh) => (
                  <option key={sh.id} value={sh.id}>{sh.label}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      </header>

      <section className="rounded-lg border bg-white p-4 shadow-sm">
        <div className="flex justify-between border-b py-2">
          <strong className="text-[color:var(--color-brand-navy)]">Starting cash</strong>
          <span className="font-mono">{PESO(Number(s.opening_float_php ?? 0))}</span>
        </div>
        <div className="flex justify-between border-b py-2">
          <strong className="text-[color:var(--color-brand-navy)]">Cash received today</strong>
          <span className="font-mono">{PESO(Number(s.cash_payments_php ?? 0))}</span>
        </div>
        <div className="flex justify-between border-b py-2">
          <strong className="text-[color:var(--color-brand-navy)]">Cash paid out</strong>
          <span className="font-mono">−{PESO(Number(s.cash_payouts_php ?? 0))}</span>
        </div>
        <div className="flex justify-between pt-3 text-lg">
          <strong className="text-[color:var(--color-brand-navy)]">Cash you should have now</strong>
          <span className="font-mono font-bold text-[color:var(--color-brand-navy)]">
            {PESO(Number(s.expected_cash_php ?? 0))}
          </span>
        </div>
      </section>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          disabled={closed || pending}
          onClick={() => setOpenModal("payout")}
          className="min-h-[44px] rounded border bg-white px-4 py-2 text-sm font-medium text-[color:var(--color-brand-navy)] disabled:opacity-50"
        >
          + Pay out cash
        </button>
        <button
          disabled={closed || pending}
          onClick={() => setOpenModal("topup")}
          className="min-h-[44px] rounded border bg-white px-4 py-2 text-sm font-medium text-[color:var(--color-brand-navy)] disabled:opacity-50"
        >
          + Add cash to drawer
        </button>
        <button
          disabled={closed || pending}
          onClick={() => setOpenModal("pullout")}
          className="min-h-[44px] rounded border bg-white px-4 py-2 text-sm font-medium text-[color:var(--color-brand-navy)] disabled:opacity-50"
        >
          + Remove cash from drawer
        </button>
        <a
          href={`/staff/payments/eod?date=${props.businessDate}&shift=${props.currentShiftId}`}
          className="ml-auto min-h-[44px] rounded bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-semibold text-white"
        >
          {closed ? "View day summary →" : "Count & close day →"}
        </a>
      </div>

      <section className="mt-6 overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="bg-[color:var(--color-bg-mid)] text-left">
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Amount</th>
              <th className="px-3 py-2">Paid to / notes</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {props.rows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-4 text-center text-[color:var(--color-brand-text-soft)]">No cash added or paid out yet today.</td></tr>
            )}
            {props.rows.map((r) => (
              <tr key={r.id} className={r.voided_at ? "opacity-50" : ""}>
                <td className="px-3 py-2 whitespace-nowrap">{new Date(r.recorded_at).toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Manila" })}</td>
                <td className="px-3 py-2">{kindLabel(r.kind)}</td>
                <td className="px-3 py-2 font-mono">{PESO(Number(r.amount_php))}</td>
                <td className="px-3 py-2">{r.payee ?? r.notes ?? "—"}</td>
                <td className="px-3 py-2">
                  {!r.voided_at && !closed && (
                    <button onClick={() => handleVoid(r.id)} className="text-xs text-red-600">Void</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {openModal && (
        <AdjustmentModal
          mode={openModal}
          businessDate={props.businessDate}
          shiftId={props.currentShiftId}
          accounts={props.accounts}
          staff={props.staff}
          onClose={() => setOpenModal(null)}
          onSaved={() => { setOpenModal(null); router.refresh(); }}
        />
      )}
    </main>
  );
}

function AdjustmentModal(props: {
  mode: "payout" | "topup" | "pullout";
  businessDate: string;
  shiftId: string;
  accounts: Account[];
  staff: Staff[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<string>(
    props.mode === "topup" ? "float_topup" :
    props.mode === "pullout" ? "float_pullout" :
    "petty_cash"
  );
  const [amount, setAmount] = useState("");
  const [contraId, setContraId] = useState("");
  const [staffId, setStaffId] = useState("");
  const [payee, setPayee] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const payoutKinds = ["petty_cash", "salary_advance", "courier", "other_payout"];

  // The "contra" account means different things per action; label it plainly.
  const contraLabel =
    props.mode === "topup"
      ? "Where did the cash come from?"
      : props.mode === "pullout"
        ? "Where is the cash going?"
        : "Expense account";

  const onSubmit = () => {
    setErr(null);
    start(async () => {
      const r = await recordCashAdjustmentAction({
        business_date: props.businessDate,
        shift_id: props.shiftId,
        kind: kind as never,
        amount_php: Number(amount),
        payee: payee || null,
        payee_staff_id: kind === "salary_advance" ? (staffId || null) : null,
        contra_account_id: contraId || null,
        notes: notes || null,
      });
      if (!r.ok) setErr(r.error);
      else props.onSaved();
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <h2 className="font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
          {props.mode === "payout" ? "Pay out cash" : props.mode === "topup" ? "Add cash to drawer" : "Remove cash from drawer"}
        </h2>
        {props.mode === "payout" && (
          <label className="mt-3 block text-sm">
            What is this for?
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 block w-full rounded border px-2 py-2">
              {payoutKinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
            </select>
          </label>
        )}
        <label className="mt-3 block text-sm">
          Amount (₱)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="mt-1 block w-full rounded border px-2 py-2" />
        </label>
        {kind === "salary_advance" && (
          <label className="mt-3 block text-sm">
            Staff member
            <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className="mt-1 block w-full rounded border px-2 py-2">
              <option value="">— pick —</option>
              {props.staff.map((s) => <option key={s.id} value={s.id}>{s.full_name} ({s.role})</option>)}
            </select>
          </label>
        )}
        {kind !== "salary_advance" && kind !== "courier" && (
          <label className="mt-3 block text-sm">
            {contraLabel}
            <select value={contraId} onChange={(e) => setContraId(e.target.value)} className="mt-1 block w-full rounded border px-2 py-2">
              <option value="">— pick —</option>
              {props.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </select>
          </label>
        )}
        <label className="mt-3 block text-sm">
          Paid to (optional)
          <input value={payee} onChange={(e) => setPayee(e.target.value)} className="mt-1 block w-full rounded border px-2 py-2" />
        </label>
        <label className="mt-3 block text-sm">
          Notes (optional)
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 block w-full rounded border px-2 py-2" />
        </label>
        {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={props.onClose} disabled={pending} className="min-h-[44px] rounded border px-4 py-2 text-sm">Cancel</button>
          <button onClick={onSubmit} disabled={pending || !amount} className="min-h-[44px] rounded bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

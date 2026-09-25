"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { recordCashAdjustmentAction, voidCashAdjustmentAction }
  from "./actions";
import { PaymentsTabs } from "../_components/payments-tabs";
import { PageHeader } from "@/components/staff/page-header";
import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import { friendlyManilaDate, manilaTime } from "@/lib/dates/manila";
import {
  accountChoicesFor,
  cashKindLabel as kindLabel,
  effectiveCashAccountCode,
  groupAccounts,
  pettyCashChoices,
  staffPicksAccount,
  startingPick,
  type CashRule,
} from "@/lib/accounting/money-routing";
import { SEND_OUT_ACCOUNT_CODE, type PartnerLab } from "@/lib/accounting/partner-labs";
import type { Database } from "@/types/database";

type Adjustment = Database["public"]["Tables"]["eod_cash_adjustments"]["Row"];
type Shift = { id: string; code: string; label: string };
type Account = { id: string; code: string; name: string; type: string };
type Staff = { id: string; full_name: string; role: string };

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

export function CashDrawerClient(props: {
  sessionUserId: string;
  isAdmin: boolean;
  businessDate: string;
  today: string;
  shifts: Shift[];
  currentShiftId: string;
  state: Record<string, unknown>;
  rows: Adjustment[];
  accounts: Account[];
  routing: (CashRule & { kind: string })[];
  staff: Staff[];
  partnerLabs: PartnerLab[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [openModal, setOpenModal] = useState<"payout" | "topup" | "pullout" | null>(null);

  const s = props.state as {
    opening_float_php?: number;
    cash_payments_php?: number;
    gift_code_sales_php?: number;
    bill_payments_php?: number;
    cash_payouts_php?: number;
    expected_cash_php?: number;
    payments_by_method?: Record<string, number>;
    closed?: { id: string; closed_at: string; closed_by: string } | null;
  };
  const closed = !!s.closed;
  const isToday = props.businessDate === props.today;

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
    <main className="px-4 py-8 sm:px-6 lg:px-8">
      <PaymentsTabs />
      <PageHeader
        eyebrow={SECTION_NAME["/staff/payments/cash-drawer"]}
        title={ROUTE_NAME["/staff/payments/cash-drawer"]}
        actions={
          <div className="flex flex-col items-start gap-1 text-sm text-[color:var(--color-brand-text-soft)] sm:items-end">
            <span className="font-medium text-[color:var(--color-brand-navy)]">
              {friendlyManilaDate(props.businessDate)}
            </span>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={props.businessDate}
                max={props.today}
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
              {!isToday && (
                <Link
                  href={`/staff/payments/cash-drawer?shift=${props.currentShiftId}`}
                  className="rounded border border-[color:var(--color-brand-navy)] px-3 py-1 font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
                >
                  Back to today
                </Link>
              )}
            </div>
          </div>
        }
      />

      <section className="rounded-lg border bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b py-2">
          <span className="flex items-center gap-2">
            <strong className="text-[color:var(--color-brand-navy)]">Starting cash</strong>
            {props.isAdmin && (
              <Link
                href="/staff/admin/accounting/money-routing#starting-cash"
                className="text-xs font-semibold text-[color:var(--color-brand-cyan)] underline hover:text-[color:var(--color-brand-navy)]"
              >
                Edit
              </Link>
            )}
          </span>
          <span className="font-mono">{PESO(Number(s.opening_float_php ?? 0))}</span>
          {props.isAdmin && (
            <span className="basis-full text-xs text-[color:var(--color-brand-text-soft)]">
              Admin only — changes the starting amount for every day, not just today.
            </span>
          )}
        </div>
        <div className="flex justify-between border-b py-2">
          <strong className="text-[color:var(--color-brand-navy)]">Cash received today</strong>
          <span className="font-mono">{PESO(Number(s.cash_payments_php ?? 0))}</span>
        </div>
        {Number(s.gift_code_sales_php ?? 0) !== 0 ? (
          <div className="flex justify-between border-b py-2">
            <strong className="text-[color:var(--color-brand-navy)]">
              Gift codes sold for cash
            </strong>
            <span className="font-mono">
              {PESO(Number(s.gift_code_sales_php ?? 0))}
            </span>
          </div>
        ) : null}
        <div className="flex justify-between border-b py-2">
          <strong className="text-[color:var(--color-brand-navy)]">Cash paid out</strong>
          <span className="font-mono">−{PESO(Number(s.cash_payouts_php ?? 0))}</span>
        </div>
        {/* 0149: broken out of "Cash paid out" because nobody on this page
            recorded it — it arrives from Admin → Accounting → AP. Without the
            line, reception sees the drawer drop with no matching action of
            theirs. */}
        {Number(s.bill_payments_php ?? 0) !== 0 ? (
          <div className="flex justify-between border-b py-2 pl-4 text-[color:var(--color-brand-text-soft)]">
            <span>of which supplier bills paid in cash</span>
            <span className="font-mono">−{PESO(Number(s.bill_payments_php ?? 0))}</span>
          </div>
        ) : null}
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
        <table className="w-full text-sm">
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
                <td className="px-3 py-2 whitespace-nowrap">{manilaTime(r.recorded_at)}</td>
                <td className="px-3 py-2">{kindLabel(r.kind)}</td>
                <td className="px-3 py-2 font-mono">{PESO(Number(r.amount_php))}</td>
                <td className="px-3 py-2">{r.payee ?? r.notes ?? "—"}</td>
                <td className="px-3 py-2">
                  {!r.voided_at && !closed && (
                    r.kind === "bill_payment" ? (
                      // 0149: same reasoning as the gift-code row below. The
                      // generic Void would hand the cash back to the till while
                      // the books still record the supplier as paid; P0052
                      // refuses it at the database anyway. Voiding the AP
                      // payment is the one control that moves both.
                      <span
                        className="text-xs text-[color:var(--color-brand-text-soft)]"
                        title="Void the payment instead (Admin → Expenses → Bill Payments) — that reverses this entry too."
                      >
                        Void via AP payments
                      </span>
                    ) : r.kind === "gift_code_sale" ? (
                      // Finding 8 (go-live review): this row can't be
                      // undone with the generic Void — that never touches
                      // `gift_codes`, so the code would stay redeemable
                      // after the money came back out of the drawer.
                      // Cancelling the code is the one control that does
                      // both at once (admin only).
                      <span
                        className="text-xs text-[color:var(--color-brand-text-soft)]"
                        title="Cancel the gift code instead (Admin → Gift Codes) — that reverses this entry too."
                      >
                        Cancel via Gift codes
                      </span>
                    ) : (
                      <button onClick={() => handleVoid(r.id)} className="text-xs text-red-600">Void</button>
                    )
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
          routing={props.routing}
          staff={props.staff}
          partnerLabs={props.partnerLabs}
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
  routing: (CashRule & { kind: string })[];
  staff: Staff[];
  partnerLabs: PartnerLab[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const rules = new Map(props.routing.map((r) => [r.kind, r]));
  const petty = pettyCashChoices(props.accounts);
  // Start the picker on the account Money Routing names for this kind. Petty
  // cash shows the Petty Cash tab's categories, so only pre-fill one of those.
  const firstPick = (k: string) => {
    const id = startingPick(rules.get(k), props.accounts);
    return k === "petty_cash" && !petty.some((c) => c.account.id === id) ? "" : id;
  };
  const initialKind =
    props.mode === "topup" ? "float_topup" :
    props.mode === "pullout" ? "float_pullout" :
    "petty_cash";
  const [kind, setKind] = useState<string>(initialKind);
  const [amount, setAmount] = useState("");
  const [contraId, setContraId] = useState(() => firstPick(initialKind));
  const [staffId, setStaffId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [payee, setPayee] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const payoutKinds = ["petty_cash", "salary_advance", "courier", "other_payout"];
  const changeKind = (k: string) => {
    setKind(k);
    setContraId(firstPick(k));
    setVendorId("");
  };
  // Money Routing decides whether reception picks the account for this kind.
  const showPicker = staffPicksAccount(kind, rules.get(kind));
  const pettyHint = petty.find((c) => c.account.id === contraId)?.hint;
  // 0164: a Send Out (6420) petty-cash payout must say which partner lab it
  // paid — the same rule `sendOutLabRule` enforces server-side. Use the
  // EFFECTIVE account (mirroring `resolve_cash_adjustment_account`), not just
  // whatever the (possibly hidden) picker currently holds — when Money
  // Routing has petty cash defaulting straight to 6420 with no staff pick,
  // `contraId` stays empty and the category picker never even renders, but
  // the database still posts to 6420.
  const selectedAccountCode = effectiveCashAccountCode(contraId || null, rules.get(kind), props.accounts);
  const isSendOut = kind === "petty_cash" && selectedAccountCode === SEND_OUT_ACCOUNT_CODE;

  // The "contra" account means different things per action; label it plainly.
  const contraLabel =
    props.mode === "topup"
      ? "Where did the cash come from?"
      : props.mode === "pullout"
        ? "Where is the cash going?"
        : "Which account should this be recorded to?";

  const onSubmit = () => {
    setErr(null);
    if (isSendOut && !vendorId) {
      setErr("Pick which lab you paid.");
      return;
    }
    start(async () => {
      const r = await recordCashAdjustmentAction({
        business_date: props.businessDate,
        shift_id: props.shiftId,
        kind: kind as never,
        amount_php: Number(amount),
        payee: payee || null,
        payee_staff_id: kind === "salary_advance" ? (staffId || null) : null,
        contra_account_id: contraId || null,
        vendor_id: isSendOut ? (vendorId || null) : null,
        notes: notes || null,
      });
      if (!r.ok) setErr(r.error);
      else props.onSaved();
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <h2 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
          {props.mode === "payout" ? "Pay out cash" : props.mode === "topup" ? "Add cash to drawer" : "Remove cash from drawer"}
        </h2>
        {props.mode === "payout" && (
          <label className="mt-3 block text-sm">
            What is this for?
            <select value={kind} onChange={(e) => changeKind(e.target.value)} className="mt-1 block w-full rounded border px-2 py-2">
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
        {showPicker && kind === "petty_cash" && (
          <label className="mt-3 block text-sm">
            Category
            <select
              value={contraId}
              onChange={(e) => { setContraId(e.target.value); setVendorId(""); }}
              className="mt-1 block w-full rounded border px-2 py-2"
            >
              <option value="">— pick —</option>
              {petty.map((c) => <option key={c.account.id} value={c.account.id} title={c.hint}>{c.category}</option>)}
            </select>
            {pettyHint && <span className="mt-1 block text-xs text-[color:var(--color-brand-text-soft)]">{pettyHint}</span>}
          </label>
        )}
        {isSendOut && (
          <label className="mt-3 block text-sm">
            Which lab?
            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="mt-1 block w-full rounded border px-2 py-2">
              <option value="">— pick —</option>
              {props.partnerLabs.map((lab) => <option key={lab.id} value={lab.id}>{lab.name}</option>)}
            </select>
          </label>
        )}
        {showPicker && kind !== "petty_cash" && (
          <label className="mt-3 block text-sm">
            {contraLabel}
            <select value={contraId} onChange={(e) => setContraId(e.target.value)} className="mt-1 block w-full rounded border px-2 py-2">
              <option value="">— pick —</option>
              {groupAccounts(accountChoicesFor({ side: "cash", key: kind }, props.accounts, contraId || null)).map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                </optgroup>
              ))}
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

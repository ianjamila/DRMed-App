"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  voidBillPaymentAction,
  reallocateBillPaymentAction,
} from "@/lib/actions/accounting/bill-payments";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

type Vendor = { id: string; name: string; tin: string | null };

type AllocationBill = {
  id: string;
  bill_number: string;
  vendor_invoice_number: string | null;
  bill_date: string;
  gross_amount: number;
  outstanding_amount: number | null;
  status: string;
};

type Allocation = {
  id: string;
  allocated_amount: number;
  voided_at: string | null;
  bills: AllocationBill | AllocationBill[] | null;
};

type Payment = {
  id: string;
  payment_number: string;
  payment_date: string;
  method: string;
  amount_php: number;
  reference: string | null;
  cheque_number: string | null;
  cheque_date: string | null;
  voided_at: string | null;
  void_reason: string | null;
  vendors: Vendor | Vendor[] | null;
  bill_payment_allocations: Allocation[];
};

type JournalEntry = {
  id: string;
  entry_number: string;
  source_kind: string;
  status: string;
  posting_date: string;
};

function pluckOne<T>(v: T | T[] | null): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function PaymentDetailClient({
  payment,
  journalEntries,
}: {
  payment: Payment;
  journalEntries: JournalEntry[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Void modal
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");

  // Reallocate modal — keyed by bill_id
  const [reallocOpen, setReallocOpen] = useState(false);
  const [realloc, setRealloc] = useState<Record<string, string>>({});

  const vendor = pluckOne(payment.vendors);
  const activeAllocs = payment.bill_payment_allocations.filter((a) => !a.voided_at);
  const paymentJe = journalEntries.find((j) => j.source_kind === "bill_payment");
  const isVoided = !!payment.voided_at;

  function handleVoid() {
    setError(null);
    startTransition(async () => {
      const r = await voidBillPaymentAction(payment.id, voidReason.trim());
      if (r.ok) {
        setVoidOpen(false);
        setVoidReason("");
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  }

  function openReallocate() {
    // Pre-seed the modal with current allocations.
    const current: Record<string, string> = {};
    for (const a of payment.bill_payment_allocations) {
      if (!a.voided_at) {
        const bill = pluckOne(a.bills);
        if (bill) current[bill.id] = a.allocated_amount.toFixed(2);
      }
    }
    setRealloc(current);
    setReallocOpen(true);
  }

  const reallocSum = Object.values(realloc).reduce((s, v) => s + Number(v || 0), 0);
  const reallocValid =
    Math.round(reallocSum * 100) === Math.round(payment.amount_php * 100);

  function handleReallocate() {
    setError(null);
    const items = Object.entries(realloc)
      .filter(([, v]) => Number(v) > 0)
      .map(([bill_id, v]) => ({ bill_id, allocated_amount: Number(v) }));

    startTransition(async () => {
      const r = await reallocateBillPaymentAction({
        payment_id: payment.id,
        allocations: items,
      });
      if (r.ok) {
        setReallocOpen(false);
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8 space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 12.4 · Admin · AP · Payment
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {payment.payment_number}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            {vendor?.name ?? "—"} · {payment.method} · {payment.payment_date}
            {payment.cheque_number && (
              <> · Cheque #{payment.cheque_number} dated {payment.cheque_date}</>
            )}
            {payment.reference && !payment.cheque_number && <> · Ref: {payment.reference}</>}
          </p>
          {isVoided && (
            <p className="mt-2 inline-block rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
              voided · {payment.void_reason}
            </p>
          )}
        </div>

        {!isVoided && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={openReallocate}
              className="min-h-[44px] rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-gray-50"
            >
              Reallocate
            </button>
            <button
              type="button"
              onClick={() => setVoidOpen(true)}
              className="min-h-[44px] rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-red-700 hover:bg-red-50"
            >
              Void
            </button>
          </div>
        )}
      </header>

      {error && (
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Amount" value={PHP.format(payment.amount_php)} />
        <Stat label="Allocations (active)" value={String(activeAllocs.length)} />
        <Stat
          label="JE"
          value={paymentJe?.entry_number ?? "—"}
        />
      </div>

      {paymentJe && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm">
          Payment journal entry:{" "}
          <Link
            href={`/staff/admin/accounting/journal/${paymentJe.id}`}
            className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
          >
            {paymentJe.entry_number}
          </Link>
        </div>
      )}

      {/* Allocations */}
      <section>
        <h2 className="mb-2 font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
          Allocations
        </h2>
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-3 py-2">Bill</th>
                <th className="px-3 py-2 text-right">Allocated</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {payment.bill_payment_allocations.map((a) => {
                const bill = pluckOne(a.bills);
                return (
                  <tr key={a.id} className={a.voided_at ? "opacity-60" : ""}>
                    <td className="px-3 py-2">
                      {bill ? (
                        <Link
                          href={`/staff/admin/accounting/ap/bills/${bill.id}`}
                          className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                        >
                          {bill.bill_number}
                        </Link>
                      ) : (
                        <span className="text-[color:var(--color-brand-text-soft)]">(bill missing)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {PHP.format(a.allocated_amount)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {a.voided_at ? (
                        <span className="inline-block rounded bg-red-100 px-2 py-0.5 font-medium text-red-800">
                          voided
                        </span>
                      ) : (
                        <span className="inline-block rounded bg-green-100 px-2 py-0.5 font-medium text-green-800">
                          active
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Void Dialog */}
      <Dialog
        open={voidOpen}
        onOpenChange={(o) => {
          if (!o) {
            setVoidOpen(false);
            setVoidReason("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Void {payment.payment_number}?</DialogTitle>
            <DialogDescription>
              Reversal JE posts today. Allocations soft-marked as voided;
              affected bills flip back to posted/partially_paid via the
              recompute trigger.
            </DialogDescription>
          </DialogHeader>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Reason *
            </span>
            <textarea
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              rows={3}
              placeholder="3+ characters required"
              autoFocus
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setVoidOpen(false);
                setVoidReason("");
              }}
              className="min-h-[44px] rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)] hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleVoid}
              disabled={isPending || voidReason.trim().length < 3}
              className="min-h-[44px] rounded-md bg-red-700 px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-red-800 disabled:opacity-50"
            >
              {isPending ? "Voiding…" : "Void payment"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reallocate Dialog */}
      <Dialog
        open={reallocOpen}
        onOpenChange={(o) => {
          if (!o) {
            setReallocOpen(false);
            setRealloc({});
          }
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Reallocate {payment.payment_number}</DialogTitle>
            <DialogDescription>
              Adjust how this payment splits across the vendor&apos;s bills. The
              total must equal {PHP.format(payment.amount_php)}.
            </DialogDescription>
          </DialogHeader>

          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-3 py-2">Bill</th>
                  <th className="px-3 py-2 text-right">Allocate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {payment.bill_payment_allocations.map((a) => {
                  const bill = pluckOne(a.bills);
                  if (!bill) return null;
                  return (
                    <tr key={a.id}>
                      <td className="px-3 py-2 font-medium text-[color:var(--color-brand-navy)]">
                        {bill.bill_number}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={realloc[bill.id] ?? ""}
                          onChange={(e) =>
                            setRealloc((cur) => ({ ...cur, [bill.id]: e.target.value }))
                          }
                          className="min-h-[44px] w-32 rounded-md border border-gray-300 px-3 py-2 text-right text-sm tabular-nums shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div
            className={`text-right text-sm ${
              reallocValid ? "text-green-700" : "text-amber-700"
            }`}
          >
            New total: {PHP.format(reallocSum)} / Required: {PHP.format(payment.amount_php)}
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setReallocOpen(false);
                setRealloc({});
              }}
              className="min-h-[44px] rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)] hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleReallocate}
              disabled={isPending || !reallocValid}
              className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
            >
              {isPending ? "Saving…" : "Save reallocation"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </div>
      <div className="mt-1 font-mono text-lg tabular-nums text-[color:var(--color-brand-navy)]">
        {value}
      </div>
    </div>
  );
}

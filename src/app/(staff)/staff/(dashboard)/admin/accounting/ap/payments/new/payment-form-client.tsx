"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createBillPaymentAction } from "@/lib/actions/accounting/bill-payments";
import { listBillsAction } from "@/lib/actions/accounting/bills";
import { todayManilaISODate } from "@/lib/dates/manila";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

type Vendor = { id: string; name: string };
type Account = { id: string; code: string; name: string };

type OutstandingBill = {
  id: string;
  bill_number: string;
  due_date: string;
  outstanding_amount: number;
  status: string;
};

type PaymentMethod = "cash" | "bank_transfer" | "gcash" | "cheque";
const METHODS: readonly PaymentMethod[] = ["cash", "bank_transfer", "gcash", "cheque"];

function isPaymentMethod(v: string): v is PaymentMethod {
  return (METHODS as readonly string[]).includes(v);
}

export function PaymentFormClient({
  vendors,
  cashAccounts,
}: {
  vendors: Vendor[];
  cashAccounts: Account[];
}) {
  const router = useRouter();

  const [vendorId, setVendorId] = useState("");
  const [bills, setBills] = useState<OutstandingBill[]>([]);
  const [billsLoading, setBillsLoading] = useState(false);

  // Allocation amounts keyed by bill_id (controlled inputs).
  const [allocations, setAllocations] = useState<Record<string, string>>({});

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [cashAccountId, setCashAccountId] = useState("");
  const [paymentDate, setPaymentDate] = useState(todayManilaISODate());
  const [reference, setReference] = useState("");
  const [chequeNumber, setChequeNumber] = useState("");
  const [chequeDate, setChequeDate] = useState(todayManilaISODate());

  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Fetch outstanding bills whenever vendor changes.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!vendorId) {
        setBills([]);
        setAllocations({});
        return;
      }
      setBillsLoading(true);
      try {
        const r = await listBillsAction({ vendor_id: vendorId, limit: 100 });
        if (cancelled) return;
        if (!r.ok) {
          setError(r.error);
          setBills([]);
          return;
        }
        // Filter to outstanding states client-side (action takes single-status only).
        const outstanding = r.data
          .filter((b) => b.status === "posted" || b.status === "partially_paid")
          .map((b) => ({
            id: b.id,
            bill_number: b.bill_number,
            due_date: b.due_date,
            outstanding_amount: Number(b.outstanding_amount),
            status: b.status,
          }));
        setBills(outstanding);
        setAllocations({});
      } finally {
        if (!cancelled) setBillsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [vendorId]);

  function setAllocation(billId: string, value: string) {
    setAllocations((cur) => ({ ...cur, [billId]: value }));
  }

  function autoAllocate() {
    const remaining = Number(amount || 0);
    if (remaining <= 0) return;
    const sorted = [...bills].sort((a, b) => a.due_date.localeCompare(b.due_date));
    const next: Record<string, string> = {};
    let rem = remaining;
    for (const b of sorted) {
      if (rem <= 0) break;
      const take = Math.min(rem, b.outstanding_amount);
      next[b.id] = take.toFixed(2);
      rem -= take;
    }
    setAllocations(next);
  }

  const allocSum = Object.values(allocations).reduce((s, v) => s + Number(v || 0), 0);
  const amountNum = Number(amount || 0);
  // Compare integer centavos to dodge floating-point.
  const allocValid =
    allocSum > 0 &&
    Math.round(allocSum * 100) === Math.round(amountNum * 100);

  function submit() {
    setError(null);
    setFieldError(null);

    type AllocItem = { bill_id: string; allocated_amount: number };
    type CashOrTransferPayload = {
      vendor_id: string;
      payment_date: string;
      method: "cash" | "bank_transfer" | "gcash";
      cash_account_id: string;
      amount_php: number;
      reference: string | null;
      allocations: AllocItem[];
    };
    type ChequePayload = {
      vendor_id: string;
      payment_date: string;
      method: "cheque";
      cash_account_id: string;
      amount_php: number;
      reference: string | null;
      cheque_number: string;
      cheque_date: string;
      allocations: AllocItem[];
    };

    const allocItems: AllocItem[] = Object.entries(allocations)
      .filter(([, v]) => Number(v) > 0)
      .map(([bill_id, v]) => ({ bill_id, allocated_amount: Number(v) }));

    const base = {
      vendor_id: vendorId,
      payment_date: paymentDate,
      cash_account_id: cashAccountId,
      amount_php: amountNum,
      reference: method !== "cheque" && reference ? reference : null,
      allocations: allocItems,
    };

    const payload: CashOrTransferPayload | ChequePayload =
      method === "cheque"
        ? {
            ...base,
            method: "cheque",
            cheque_number: chequeNumber,
            cheque_date: chequeDate,
          }
        : { ...base, method };

    startTransition(async () => {
      const r = await createBillPaymentAction(payload);
      if (!r.ok) {
        setError(r.error);
        setFieldError(r.field ?? null);
        return;
      }
      router.push(`/staff/admin/accounting/ap/payments/${r.data.payment_id}`);
    });
  }

  // --- JSX ---

  const canSubmit = !!vendorId && !!cashAccountId && allocValid && !isPending;

  return (
    <div className="space-y-6">
      {error && (
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Vendor */}
      <Field label="Vendor *" error={fieldError === "vendor_id" ? error : null}>
        <select
          required
          value={vendorId}
          onChange={(e) => setVendorId(e.target.value)}
          className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">Select vendor</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>
      </Field>

      {/* Outstanding bills + allocations */}
      {vendorId && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
              Allocate to bills
            </h2>
            {bills.length > 0 && (
              <button
                type="button"
                onClick={autoAllocate}
                className="min-h-[44px] rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-gray-50"
              >
                Auto-fill from amount
              </button>
            )}
          </div>

          {billsLoading ? (
            <p className="text-sm text-[color:var(--color-brand-text-soft)]">Loading outstanding bills…</p>
          ) : bills.length === 0 ? (
            <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
              No outstanding bills for this vendor.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-md border border-gray-200">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                    <tr>
                      <th className="px-3 py-2">Bill #</th>
                      <th className="px-3 py-2">Due</th>
                      <th className="px-3 py-2 text-right">Outstanding</th>
                      <th className="px-3 py-2 text-right">Allocate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {bills.map((b) => (
                      <tr key={b.id}>
                        <td className="px-3 py-2 font-medium text-[color:var(--color-brand-navy)]">
                          {b.bill_number}
                        </td>
                        <td className="px-3 py-2 text-xs">{b.due_date}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {PHP.format(b.outstanding_amount)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            max={b.outstanding_amount}
                            value={allocations[b.id] ?? ""}
                            onChange={(e) => setAllocation(b.id, e.target.value)}
                            className="min-h-[44px] w-32 rounded-md border border-gray-300 px-3 py-2 text-right text-sm tabular-nums shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div
                className={`mt-2 text-right text-sm ${
                  allocValid ? "text-green-700" : "text-amber-700"
                }`}
              >
                Allocated: {PHP.format(allocSum)} / Payment: {PHP.format(amountNum)}
              </div>
            </>
          )}
        </section>
      )}

      {/* Payment header */}
      <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Payment amount *" error={fieldError === "amount_php" ? error : null}>
          <input
            required
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-right text-sm tabular-nums shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>

        <Field label="Payment date *">
          <input
            required
            type="date"
            value={paymentDate}
            max={todayManilaISODate()}
            onChange={(e) => setPaymentDate(e.target.value)}
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>

        <Field label="Method *">
          <select
            required
            value={method}
            onChange={(e) => {
              if (isPaymentMethod(e.target.value)) setMethod(e.target.value);
            }}
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </Field>

        <Field label="Cash account *" error={fieldError === "cash_account_id" ? error : null}>
          <select
            required
            value={cashAccountId}
            onChange={(e) => setCashAccountId(e.target.value)}
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            <option value="">Select</option>
            {cashAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>

        {method === "cheque" ? (
          <>
            <Field label="Cheque number *">
              <input
                required
                value={chequeNumber}
                onChange={(e) => setChequeNumber(e.target.value)}
                className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              />
            </Field>
            <Field label="Cheque date *">
              <input
                required
                type="date"
                value={chequeDate}
                onChange={(e) => setChequeDate(e.target.value)}
                className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              />
            </Field>
          </>
        ) : (
          <Field label="Reference">
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </Field>
        )}
      </section>

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Record payment"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  error,
}: {
  label: string;
  children: React.ReactNode;
  error?: string | null;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </span>
      {children}
      {error && <span className="mt-1 block text-xs text-red-700">{error}</span>}
    </label>
  );
}

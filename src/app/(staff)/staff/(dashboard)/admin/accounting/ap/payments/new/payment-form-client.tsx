"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createBillPaymentAction } from "@/lib/actions/accounting/bill-payments";
import { listBillsAction } from "@/lib/actions/accounting/bills";
import { todayManilaISODate } from "@/lib/dates/manila";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CircleAlert } from "lucide-react";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

const selectClassName =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

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
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Vendor */}
      <Field label="Vendor *" error={fieldError === "vendor_id" ? error : null}>
        <select
          required
          value={vendorId}
          onChange={(e) => setVendorId(e.target.value)}
          className={selectClassName}
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
              <Button
                type="button"
                variant="outline"
                size="touch"
                onClick={autoAllocate}
              >
                Auto-fill from amount
              </Button>
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
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            max={b.outstanding_amount}
                            value={allocations[b.id] ?? ""}
                            onChange={(e) => setAllocation(b.id, e.target.value)}
                            className="w-32 text-right tabular-nums"
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
          <Input
            required
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="text-right tabular-nums"
          />
        </Field>

        <Field label="Payment date *">
          <Input
            required
            type="date"
            value={paymentDate}
            max={todayManilaISODate()}
            onChange={(e) => setPaymentDate(e.target.value)}
          />
        </Field>

        <Field label="Method *">
          <select
            required
            value={method}
            onChange={(e) => {
              if (isPaymentMethod(e.target.value)) setMethod(e.target.value);
            }}
            className={selectClassName}
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
            className={selectClassName}
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
              <Input
                required
                value={chequeNumber}
                onChange={(e) => setChequeNumber(e.target.value)}
              />
            </Field>
            <Field label="Cheque date *">
              <Input
                required
                type="date"
                value={chequeDate}
                onChange={(e) => setChequeDate(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <Field label="Reference">
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
        )}
      </section>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="brand"
          size="touch"
          onClick={submit}
          disabled={!canSubmit}
        >
          {isPending ? "Saving…" : "Record payment"}
        </Button>
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
    <div className="grid gap-2">
      <Label>{label}</Label>
      {children}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

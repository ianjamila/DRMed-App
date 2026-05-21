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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { CircleAlert } from "lucide-react";
import { StatusBadge } from "@/lib/ui/status-badge";

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
            <p className="mt-2 flex items-center gap-2 text-xs">
              <StatusBadge status="voided" />
              <span className="text-[color:var(--color-brand-text-soft)]">· {payment.void_reason}</span>
            </p>
          )}
        </div>

        {!isVoided && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={openReallocate}
            >
              Reallocate
            </Button>
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={() => setVoidOpen(true)}
              className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
            >
              Void
            </Button>
          </div>
        )}
      </header>

      {error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider">Amount</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-lg tabular-nums">{PHP.format(payment.amount_php)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider">Allocations (active)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-lg tabular-nums">{String(activeAllocs.length)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider">JE</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-lg tabular-nums">{paymentJe?.entry_number ?? "—"}</div>
          </CardContent>
        </Card>
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
                      <StatusBadge status={a.voided_at ? "voided" : "active"} />
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
          <div className="grid gap-2">
            <Label>Reason *</Label>
            <Textarea
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              rows={3}
              placeholder="3+ characters required"
              autoFocus
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={() => {
                setVoidOpen(false);
                setVoidReason("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="touch"
              onClick={handleVoid}
              disabled={isPending || voidReason.trim().length < 3}
              className="bg-red-700 text-white hover:bg-red-800"
            >
              {isPending ? "Voiding…" : "Void payment"}
            </Button>
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
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={realloc[bill.id] ?? ""}
                          onChange={(e) =>
                            setRealloc((cur) => ({ ...cur, [bill.id]: e.target.value }))
                          }
                          className="w-32 text-right tabular-nums"
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
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={() => {
                setReallocOpen(false);
                setRealloc({});
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="brand"
              size="touch"
              onClick={handleReallocate}
              disabled={isPending || !reallocValid}
            >
              {isPending ? "Saving…" : "Save reallocation"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}


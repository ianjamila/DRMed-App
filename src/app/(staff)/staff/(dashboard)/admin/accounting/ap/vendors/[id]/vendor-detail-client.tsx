"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  deactivateVendorAction,
  reactivateVendorAction,
} from "@/lib/actions/accounting/vendors";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { CircleAlert } from "lucide-react";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

// ---------------------------------------------------------------------------
// Local row types — mirror what the server actions return
// ---------------------------------------------------------------------------

type VendorRow = {
  id: string;
  name: string;
  tin: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  notes: string | null;
  default_account_id: string | null;
  default_wt_classification: string | null;
  default_wt_rate: number | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

type BillRow = {
  id: string;
  vendor_invoice_number: string | null;
  bill_date: string;
  due_date: string;
  status: string;
  gross_amount: number;
  outstanding_amount: number;
  description: string | null;
};

type PaymentRow = {
  id: string;
  payment_number: string;
  payment_date: string;
  method: string;
  reference: string | null;
  cheque_number: string | null;
  amount_php: number;
  voided_at: string | null;
};

type Props = { vendor: VendorRow; bills: BillRow[]; payments: PaymentRow[] };

// ---------------------------------------------------------------------------
// Status badge helper
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    posted: "bg-blue-100 text-blue-800",
    partial: "bg-yellow-100 text-yellow-800",
    paid: "bg-green-100 text-green-800",
    voided: "bg-red-100 text-red-800",
  };
  const cls = map[status] ?? "bg-gray-100 text-gray-700";
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${cls}`}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function VendorDetailClient({ vendor, bills, payments }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // KPI derived values
  const activeBills = bills.filter((b) => b.status !== "voided");
  const outstanding = activeBills.reduce((s, b) => s + Number(b.outstanding_amount ?? 0), 0);
  const activePayments = payments.filter((p) => !p.voided_at);
  const totalPaid = activePayments.reduce((s, p) => s + Number(p.amount_php ?? 0), 0);

  const toggleActive = () => {
    setError(null);
    startTransition(async () => {
      const r = vendor.is_active
        ? await deactivateVendorAction(vendor.id)
        : await reactivateVendorAction(vendor.id);
      if (r.ok) {
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.4 · Admin · AP · Vendor
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {vendor.name}
          </h1>
          {!vendor.is_active && (
            <span className="inline-block rounded bg-gray-200 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-gray-600">
              Inactive
            </span>
          )}
        </div>
        <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
          {[vendor.email, vendor.phone, vendor.tin ? `TIN ${vendor.tin}` : null]
            .filter(Boolean)
            .join(" · ") || "No contact details on file"}
        </p>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Error banner                                                        */}
      {/* ------------------------------------------------------------------ */}
      {error && (
        <Alert variant="destructive" className="mb-4">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Action toolbar                                                      */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link
          href={`/staff/admin/accounting/ap/vendors/${vendor.id}/edit`}
          className="min-h-[44px] inline-flex items-center rounded-md border border-[color:var(--color-brand-navy)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg-soft)]"
        >
          + Edit
        </Link>
        <button
          type="button"
          onClick={toggleActive}
          disabled={isPending}
          className="min-h-[44px] inline-flex items-center rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          {isPending
            ? "Saving…"
            : vendor.is_active
              ? "Deactivate"
              : "Reactivate"}
        </button>
        <Link
          href="/staff/admin/accounting/ap/vendors"
          className="min-h-[44px] inline-flex items-center text-xs text-[color:var(--color-brand-text-soft)] hover:underline"
        >
          ← Back to vendors
        </Link>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* KPI grid                                                            */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider">Outstanding</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-lg tabular-nums">{PHP.format(outstanding)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider">Bills</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-lg tabular-nums">{activeBills.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider">Payments</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-lg tabular-nums">{PHP.format(totalPaid)}</div>
          </CardContent>
        </Card>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Bills table                                                         */}
      {/* ------------------------------------------------------------------ */}
      <section className="mb-8">
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
          Bills
        </h2>
        {bills.length === 0 ? (
          <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No bills on record for this vendor.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-3 py-2">Vendor invoice #</th>
                  <th className="px-3 py-2">Bill date</th>
                  <th className="px-3 py-2">Due date</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Gross</th>
                  <th className="px-3 py-2 text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {bills.map((b) => (
                  <tr key={b.id} className={b.status === "voided" ? "opacity-50" : ""}>
                    <td className="px-3 py-2">
                      <Link
                        href={`/staff/admin/accounting/ap/bills/${b.id}`}
                        className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                      >
                        {b.vendor_invoice_number ?? "—"}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs">{b.bill_date}</td>
                    <td className="px-3 py-2 text-xs">{b.due_date}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={b.status} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {PHP.format(b.gross_amount)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {PHP.format(b.outstanding_amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Payments table                                                      */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
          Payments
        </h2>
        {payments.length === 0 ? (
          <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No payments on record for this vendor.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-3 py-2">Payment #</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Method</th>
                  <th className="px-3 py-2">Reference / Cheque</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {payments.map((p) => (
                  <tr key={p.id} className={p.voided_at ? "opacity-50" : ""}>
                    <td className="px-3 py-2">
                      <Link
                        href={`/staff/admin/accounting/ap/payments/${p.id}`}
                        className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                      >
                        {p.payment_number}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs">{p.payment_date}</td>
                    <td className="px-3 py-2 text-xs uppercase">{p.method}</td>
                    <td className="px-3 py-2 text-xs">
                      {p.cheque_number
                        ? `Chq ${p.cheque_number}`
                        : (p.reference ?? "—")}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {PHP.format(p.amount_php)}
                    </td>
                    <td className="px-3 py-2">
                      {p.voided_at ? (
                        <StatusBadge status="voided" />
                      ) : (
                        <StatusBadge status="paid" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

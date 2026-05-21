"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  postBillAction,
  voidBillAction,
  deleteBillDraftAction,
} from "@/lib/actions/accounting/bills";
import { getBillAttachmentDownloadUrlAction } from "@/lib/actions/accounting/bill-attachments";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

type Vendor = {
  id: string;
  name: string;
  tin: string | null;
};

type ChartAccount = { code: string; name: string };

type BillLine = {
  id: string;
  line_no: number;
  description: string | null;
  amount_php: number;
  account_id: string;
  chart_of_accounts: ChartAccount | ChartAccount[] | null;
};

type AllocationPayment = {
  id: string;
  payment_number: string;
  payment_date: string;
  method: string;
  amount_php: number;
  voided_at: string | null;
};

type BillPaymentAllocation = {
  id: string;
  allocated_amount: number;
  voided_at: string | null;
  bill_payments: AllocationPayment | AllocationPayment[] | null;
};

type BillAttachment = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
};

type Bill = {
  id: string;
  bill_number: string;
  status: string;
  vendor_invoice_number: string | null;
  bill_date: string;
  due_date: string;
  description: string | null;
  gross_amount: number;
  wt_amount: number;
  net_payable: number | null;
  paid_amount: number;
  outstanding_amount: number | null;
  wt_classification: string | null;
  wt_rate: number | null;
  wt_exempt: boolean;
  vendors: Vendor | Vendor[] | null;
  bill_lines: BillLine[];
  bill_payment_allocations: BillPaymentAllocation[];
  bill_attachments: BillAttachment[];
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

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  posted: "bg-blue-100 text-blue-800",
  partially_paid: "bg-yellow-100 text-yellow-800",
  paid: "bg-green-100 text-green-800",
  voided: "bg-red-100 text-red-800",
};

export function BillDetailClient({
  bill,
  journalEntries,
}: {
  bill: Bill;
  journalEntries: JournalEntry[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [showVoidConfirm, setShowVoidConfirm] = useState(false);

  const vendor = pluckOne(bill.vendors);
  const postedJe = journalEntries.find((j) => j.source_kind === "bill_post");

  function handlePost() {
    setError(null);
    startTransition(async () => {
      const r = await postBillAction(bill.id);
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }

  function handleDelete() {
    if (!window.confirm(`Delete draft ${bill.bill_number}? This cannot be undone.`)) return;
    setError(null);
    startTransition(async () => {
      const r = await deleteBillDraftAction(bill.id);
      if (r.ok) router.push("/staff/admin/accounting/ap/bills");
      else setError(r.error);
    });
  }

  function handleVoid() {
    setError(null);
    startTransition(async () => {
      const r = await voidBillAction(bill.id, voidReason.trim());
      if (r.ok) {
        setShowVoidConfirm(false);
        setVoidReason("");
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  }

  async function openAttachment(attachmentId: string) {
    setError(null);
    const r = await getBillAttachmentDownloadUrlAction(attachmentId);
    if (r.ok) window.open(r.data.url, "_blank", "noopener");
    else setError(r.error);
  }

  const canEditDelete = bill.status === "draft";
  const canPost = bill.status === "draft";
  const canVoid = ["posted", "partially_paid", "paid"].includes(bill.status);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8 space-y-6">
      {/* HEADER */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 12.4 · Admin · AP · Bill
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {bill.bill_number}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            {vendor?.name ?? "—"} · Invoice {bill.vendor_invoice_number ?? "—"} · billed {bill.bill_date} · due {bill.due_date}
          </p>
          {bill.description && (
            <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">{bill.description}</p>
          )}
          <span
            className={`mt-3 inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[bill.status] ?? "bg-gray-100 text-gray-700"}`}
          >
            {bill.status}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canEditDelete && (
            <Link
              href={`/staff/admin/accounting/ap/bills/${bill.id}/edit`}
              className="min-h-[44px] rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-gray-50 inline-flex items-center"
            >
              Edit
            </Link>
          )}
          {canPost && (
            <button
              type="button"
              onClick={handlePost}
              disabled={isPending}
              className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
            >
              {isPending ? "Posting…" : "Post"}
            </button>
          )}
          {canEditDelete && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={isPending}
              className="min-h-[44px] rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Delete
            </button>
          )}
          {canVoid && (
            <button
              type="button"
              onClick={() => setShowVoidConfirm(true)}
              className="min-h-[44px] rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-red-700 hover:bg-red-50"
            >
              Void
            </button>
          )}
        </div>
      </header>

      {error && (
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* KPI GRID */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Gross" value={PHP.format(bill.gross_amount)} />
        <Stat
          label="WT"
          value={bill.wt_amount > 0 ? PHP.format(bill.wt_amount) : "—"}
          help={bill.wt_classification ?? undefined}
        />
        <Stat label="Net payable" value={bill.net_payable != null ? PHP.format(bill.net_payable) : "—"} />
        <Stat label="Outstanding" value={bill.outstanding_amount != null ? PHP.format(bill.outstanding_amount) : "—"} />
      </div>

      {/* POSTED JE LINK */}
      {postedJe && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm">
          Posted journal entry:{" "}
          <Link
            href={`/staff/admin/accounting/journal/${postedJe.id}`}
            className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
          >
            {postedJe.entry_number}
          </Link>
        </div>
      )}

      {/* LINES */}
      <section>
        <h2 className="mb-2 font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
          Lines
        </h2>
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {bill.bill_lines.map((line) => {
                const account = pluckOne(line.chart_of_accounts);
                return (
                  <tr key={line.id}>
                    <td className="px-3 py-2 tabular-nums">{line.line_no}</td>
                    <td className="px-3 py-2">{line.description ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">
                      {account ? `${account.code} — ${account.name}` : line.account_id}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {PHP.format(line.amount_php)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* PAYMENTS */}
      {bill.bill_payment_allocations.length > 0 && (
        <section>
          <h2 className="mb-2 font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
            Payments
          </h2>
          <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
            {bill.bill_payment_allocations.map((alloc) => {
              const payment = pluckOne(alloc.bill_payments);
              const isVoided = !!alloc.voided_at || !!payment?.voided_at;
              return (
                <li
                  key={alloc.id}
                  className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm ${isVoided ? "opacity-60" : ""}`}
                >
                  <div>
                    {payment ? (
                      <Link
                        href={`/staff/admin/accounting/ap/payments/${payment.id}`}
                        className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                      >
                        {payment.payment_number}
                      </Link>
                    ) : (
                      <span className="text-[color:var(--color-brand-text-soft)]">(payment removed)</span>
                    )}
                    {payment && (
                      <span className="ml-2 text-xs text-[color:var(--color-brand-text-soft)]">
                        {payment.method} · {payment.payment_date}
                      </span>
                    )}
                    {isVoided && (
                      <span className="ml-2 text-xs text-red-700">voided</span>
                    )}
                  </div>
                  <div className="tabular-nums">{PHP.format(alloc.allocated_amount)}</div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* ATTACHMENTS */}
      <section>
        <h2 className="mb-2 font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
          Attachments
        </h2>
        {bill.bill_attachments.length === 0 ? (
          <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-[color:var(--color-brand-text-soft)]">
            No attachments.
            {canEditDelete && " Upload from the Edit page."}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
            {bill.bill_attachments.map((att) => (
              <li key={att.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <button
                  type="button"
                  onClick={() => openAttachment(att.id)}
                  className="text-left font-medium text-[color:var(--color-brand-navy)] hover:underline"
                >
                  {att.filename}
                </button>
                <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                  {Math.round(att.size_bytes / 1024)} KB · {att.mime_type}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* VOID CONFIRMATION DIALOG */}
      <Dialog
        open={showVoidConfirm}
        onOpenChange={(open) => {
          if (!open) {
            setShowVoidConfirm(false);
            setVoidReason("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Void {bill.bill_number}?</DialogTitle>
            <DialogDescription>
              A reversal journal entry will post today. This cannot be undone.
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
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              autoFocus
            />
          </label>

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setShowVoidConfirm(false);
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
              {isPending ? "Voiding…" : "Void bill"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value, help }: { label: string; value: string; help?: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </div>
      <div className="mt-1 font-mono text-lg tabular-nums text-[color:var(--color-brand-navy)]">{value}</div>
      {help && <div className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">{help}</div>}
    </div>
  );
}

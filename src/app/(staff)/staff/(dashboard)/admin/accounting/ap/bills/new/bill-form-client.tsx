"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createBillDraftAction,
  createBillAndPostAction,
  createBillPaidOnEntryAction,
  updateBillDraftAction,
} from "@/lib/actions/accounting/bills";
import { createVendorAction } from "@/lib/actions/accounting/vendors";
import { uploadBillAttachmentAction } from "@/lib/actions/accounting/bill-attachments";
import { todayManilaISODate } from "@/lib/dates/manila";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Account = { id: string; code: string; name: string };

type Vendor = {
  id: string;
  name: string;
  tin: string | null;
  is_active: boolean;
};

type VendorDefaults = {
  default_wt_classification: string | null;
  default_wt_rate: number | null;
  default_account_id: string | null;
};

type BillLineInitial = {
  id: string;
  line_no: number;
  description: string | null;
  amount_php: number;
  account_id: string;
};

// Subset of BillDetail used by the edit form — other fields are ignored.
type BillInitial = {
  vendor_id: string;
  vendor_invoice_number: string | null;
  bill_date: string;
  due_date: string;
  description: string | null;
  wt_classification: string | null;
  wt_rate: number | null;
  wt_exempt: boolean;
  status: string;
  bill_lines: BillLineInitial[] | null;
};

type WtMode = "apply" | "exempt";

type FormLine = {
  description: string;
  amount_php: string; // string for controlled number input
  account_id: string;
};

type PaymentMethod = "cash" | "bank_transfer" | "gcash" | "cheque";

const METHODS: readonly PaymentMethod[] = ["cash", "bank_transfer", "gcash", "cheque"];

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

type Props =
  | {
      mode: "create";
      billId?: undefined;
      initial?: undefined;
      vendors: Vendor[];
      vendorDefaults: Record<string, VendorDefaults>;
      allAccounts: Account[];
      cashAccounts: Account[];
    }
  | {
      mode: "edit";
      billId: string;
      initial: BillInitial;
      vendors: Vendor[];
      vendorDefaults: Record<string, VendorDefaults>;
      allAccounts: Account[];
      cashAccounts: Account[];
    };

function isPaymentMethod(v: string): v is PaymentMethod {
  return (METHODS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function BillFormClient(props: Props) {
  const { mode, vendors: vendorsProp, vendorDefaults, allAccounts, cashAccounts } = props;
  const router = useRouter();

  // Vendor list is mutable to support inline-new-vendor.
  const [vendorList, setVendorList] = useState(vendorsProp);

  // Header state
  const [vendorId, setVendorId] = useState<string>(props.initial?.vendor_id ?? "");
  const [billDate, setBillDate] = useState(props.initial?.bill_date ?? todayManilaISODate());
  const [dueDate, setDueDate] = useState(props.initial?.due_date ?? todayManilaISODate());
  const [invoiceNumber, setInvoiceNumber] = useState(
    props.initial?.vendor_invoice_number ?? ""
  );
  const [description, setDescription] = useState(props.initial?.description ?? "");

  // WT three-state
  const [wtMode, setWtMode] = useState<WtMode>(
    props.initial?.wt_exempt ? "exempt" : "apply"
  );
  const [wtClassification, setWtClassification] = useState(
    props.initial?.wt_classification ?? ""
  );
  const [wtRate, setWtRate] = useState<string>(
    props.initial?.wt_rate != null ? String(props.initial.wt_rate) : ""
  );

  // Lines
  const [lines, setLines] = useState<FormLine[]>(() => {
    if (props.mode === "edit") {
      const sorted = [...(props.initial.bill_lines ?? [])].sort(
        (a, b) => a.line_no - b.line_no
      );
      if (sorted.length > 0) {
        return sorted.map((l) => ({
          description: l.description ?? "",
          amount_php: String(l.amount_php),
          account_id: l.account_id,
        }));
      }
    }
    return [{ description: "", amount_php: "", account_id: "" }];
  });

  // Paid-on-entry (create mode only)
  const [paidOnEntry, setPaidOnEntry] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [cashAccountId, setCashAccountId] = useState<string>("");
  const [paymentDate, setPaymentDate] = useState(todayManilaISODate());
  const [paymentReference, setPaymentReference] = useState("");
  const [chequeNumber, setChequeNumber] = useState("");
  const [chequeDate, setChequeDate] = useState(todayManilaISODate());

  // Attachments staged for upload (uploaded after save).
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  // Submit state
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Inline new vendor dialog
  const [newVendorOpen, setNewVendorOpen] = useState(false);

  // ---------------------------------------------------------------------------
  // Derived totals
  // ---------------------------------------------------------------------------

  const grossAmount = lines.reduce((s, l) => s + Number(l.amount_php || 0), 0);
  const wtRateNum = Number(wtRate || 0);
  const wtAmount =
    wtMode === "exempt" || !wtRateNum
      ? 0
      : Math.round(grossAmount * wtRateNum * 100) / 100;
  const netPayable = grossAmount - wtAmount;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function onVendorChange(id: string) {
    setVendorId(id);
    const defaults = vendorDefaults[id];
    if (!defaults) return;

    // Autofill WT defaults only if "apply" mode and user hasn't typed a custom rate.
    if (wtMode === "apply" && !wtRate) {
      if (defaults.default_wt_classification) {
        setWtClassification(defaults.default_wt_classification);
      }
      if (defaults.default_wt_rate != null) {
        setWtRate(String(defaults.default_wt_rate));
      }
    }

    // Autofill the first line's account if it's the only line and account is empty.
    if (defaults.default_account_id && lines.length === 1 && !lines[0].account_id) {
      setLines([{ ...lines[0], account_id: defaults.default_account_id }]);
    }
  }

  function addLine() {
    setLines((cur) => [...cur, { description: "", amount_php: "", account_id: "" }]);
  }

  function removeLine(idx: number) {
    setLines((cur) => cur.filter((_, i) => i !== idx));
  }

  function updateLine(idx: number, patch: Partial<FormLine>) {
    setLines((cur) => cur.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function buildBasePayload() {
    return {
      vendor_id: vendorId,
      vendor_invoice_number: invoiceNumber || null,
      bill_date: billDate,
      due_date: dueDate,
      description: description || null,
      wt_classification:
        wtMode === "apply" && wtClassification ? wtClassification : null,
      wt_rate: wtMode === "apply" && wtRate ? Number(wtRate) : null,
      wt_exempt: wtMode === "exempt",
      lines: lines.map((l, i) => ({
        line_no: i + 1,
        description: l.description || null,
        amount_php: Number(l.amount_php),
        account_id: l.account_id,
      })),
    };
  }

  function buildPaidOnEntryPayload() {
    return {
      ...buildBasePayload(),
      payment_date: paymentDate,
      method: paymentMethod,
      cash_account_id: cashAccountId,
      reference: paymentMethod !== "cheque" ? paymentReference || null : null,
      cheque_number: paymentMethod === "cheque" ? chequeNumber : null,
      cheque_date: paymentMethod === "cheque" ? chequeDate : null,
    };
  }

  async function uploadPendingAttachments(billId: string) {
    for (const file of pendingFiles) {
      const buf = await file.arrayBuffer();
      // Errors here are reported via reportError inside the action but
      // do not block redirect — the user can re-upload from the detail page.
      await uploadBillAttachmentAction(billId, {
        name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
        bytes: buf,
      });
    }
  }

  type SubmitAction = "save-draft" | "save-post" | "save-paid-on-entry";

  function handleSubmit(action: SubmitAction) {
    setError(null);
    setFieldError(null);

    startTransition(async () => {
      const r =
        mode === "edit"
          ? await updateBillDraftAction(props.billId, buildBasePayload())
          : action === "save-draft"
            ? await createBillDraftAction(buildBasePayload())
            : action === "save-post"
              ? await createBillAndPostAction(buildBasePayload())
              : await createBillPaidOnEntryAction(buildPaidOnEntryPayload());

      if (!r.ok) {
        setError(r.error);
        setFieldError(r.field ?? null);
        return;
      }

      const billId = r.data.id;
      if (pendingFiles.length > 0) {
        await uploadPendingAttachments(billId);
      }
      router.push(`/staff/admin/accounting/ap/bills/${billId}`);
    });
  }

  async function handleInlineNewVendor(name: string) {
    setError(null);
    const r = await createVendorAction({ name });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    // Optimistic add — we know enough to populate the dropdown.
    const newVendor: Vendor = { id: r.data.id, name, tin: null, is_active: true };
    setVendorList((cur) => [...cur, newVendor]);
    onVendorChange(r.data.id);
    setNewVendorOpen(false);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8 space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.4 · Admin · AP · Bill
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {mode === "create" ? "New bill" : "Edit bill"}
        </h1>
      </header>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      {/* ------- Vendor ------- */}
      <section>
        <Field label="Vendor *" error={fieldError === "vendor_id" ? error : null}>
          <div className="flex gap-2">
            <select
              value={vendorId}
              onChange={(e) => onVendorChange(e.target.value)}
              className="min-h-[44px] flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            >
              <option value="">Select vendor</option>
              {vendorList.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setNewVendorOpen(true)}
              className="min-h-[44px] rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-gray-50"
            >
              + New
            </button>
          </div>
        </Field>
      </section>

      {/* ------- Dates + Invoice + Description ------- */}
      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Bill date *">
          <input
            required
            type="date"
            value={billDate}
            onChange={(e) => setBillDate(e.target.value)}
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
        <Field label="Due date *" error={fieldError === "due_date" ? error : null}>
          <input
            required
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
        <Field label="Vendor invoice #">
          <input
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
      </section>

      <Field label="Description">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
      </Field>

      {/* ------- Withholding Tax ------- */}
      <section className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Withholding tax
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex min-h-[44px] items-center gap-2 text-sm">
            <input
              type="radio"
              name="wt"
              checked={wtMode === "apply"}
              onChange={() => setWtMode("apply")}
              className="h-4 w-4"
            />
            Apply WT
          </label>
          <label className="flex min-h-[44px] items-center gap-2 text-sm">
            <input
              type="radio"
              name="wt"
              checked={wtMode === "exempt"}
              onChange={() => setWtMode("exempt")}
              className="h-4 w-4"
            />
            Exempt
          </label>
        </div>
        {wtMode === "apply" && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="WT classification" help="BIR code, e.g. WI160 / WI100 / WI010 / WC010.">
              <input
                value={wtClassification}
                onChange={(e) => setWtClassification(e.target.value)}
                placeholder="WI160"
                className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              />
            </Field>
            <Field label="WT rate" help="Decimal — 0.0200 = 2%.">
              <input
                type="number"
                step="0.0001"
                min="0"
                max="1"
                value={wtRate}
                onChange={(e) => setWtRate(e.target.value)}
                className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              />
            </Field>
          </div>
        )}
      </section>

      {/* ------- Lines ------- */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Lines
          </div>
          <button
            type="button"
            onClick={addLine}
            className="min-h-[44px] rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-gray-50"
          >
            + Add line
          </button>
        </div>

        <div className="space-y-2">
          {lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2">
              <input
                value={line.description}
                onChange={(e) => updateLine(idx, { description: e.target.value })}
                placeholder={`Line ${idx + 1} description`}
                className="col-span-12 min-h-[44px] rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none md:col-span-5"
              />
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={line.amount_php}
                onChange={(e) => updateLine(idx, { amount_php: e.target.value })}
                placeholder="Amount"
                className="col-span-5 min-h-[44px] rounded-md border border-gray-300 px-3 py-2 text-right text-sm tabular-nums shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none md:col-span-3"
              />
              <select
                value={line.account_id}
                onChange={(e) => updateLine(idx, { account_id: e.target.value })}
                className="col-span-6 min-h-[44px] rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none md:col-span-3"
              >
                <option value="">Account</option>
                {allAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => removeLine(idx)}
                disabled={lines.length === 1}
                aria-label={`Remove line ${idx + 1}`}
                className="col-span-1 min-h-[44px] rounded-md border border-gray-300 bg-white text-red-700 hover:bg-red-50 disabled:opacity-40"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {/* Totals strip */}
        <div className="grid grid-cols-3 gap-3 rounded-md border border-gray-200 bg-gray-50 p-3 text-right text-sm">
          <div>
            <div className="text-xs uppercase text-[color:var(--color-brand-text-soft)]">
              Gross
            </div>
            <div className="font-mono tabular-nums">{PHP.format(grossAmount)}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-[color:var(--color-brand-text-soft)]">
              WT
            </div>
            <div className="font-mono tabular-nums">{PHP.format(wtAmount)}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-[color:var(--color-brand-text-soft)]">
              Net payable
            </div>
            <div className="font-mono tabular-nums">{PHP.format(netPayable)}</div>
          </div>
        </div>
      </section>

      {/* ------- Attachments ------- */}
      <section>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Attachments
        </div>
        <input
          type="file"
          multiple
          accept="application/pdf,image/jpeg,image/png"
          onChange={(e) => setPendingFiles(Array.from(e.target.files ?? []))}
          className="text-sm"
        />
        {pendingFiles.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-sm text-[color:var(--color-brand-text-soft)]">
            {pendingFiles.map((f, i) => (
              <li key={i}>
                {f.name}{" "}
                <span className="text-xs">({Math.round(f.size / 1024)} KB)</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------- Paid on entry (create only) ------- */}
      {mode === "create" && (
        <section className="space-y-2 border-t pt-4">
          <label className="flex min-h-[44px] items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={paidOnEntry}
              onChange={(e) => setPaidOnEntry(e.target.checked)}
              className="h-4 w-4"
            />
            <span className="font-semibold">
              Paid on entry — creates bill + payment + allocation in one transaction.
            </span>
          </label>
          {paidOnEntry && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
                  value={paymentMethod}
                  onChange={(e) => {
                    if (isPaymentMethod(e.target.value)) setPaymentMethod(e.target.value);
                  }}
                  className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                >
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Cash account *">
                <select
                  required
                  value={cashAccountId}
                  onChange={(e) => setCashAccountId(e.target.value)}
                  className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                >
                  <option value="">Select cash account</option>
                  {cashAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              {paymentMethod === "cheque" ? (
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
                    value={paymentReference}
                    onChange={(e) => setPaymentReference(e.target.value)}
                    className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                  />
                </Field>
              )}
            </div>
          )}
        </section>
      )}

      {/* ------- Action buttons ------- */}
      <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
        {mode === "create" ? (
          <>
            <button
              type="button"
              onClick={() => handleSubmit("save-draft")}
              disabled={isPending}
              className="min-h-[44px] rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-gray-50 disabled:opacity-50"
            >
              Save as draft
            </button>
            {paidOnEntry ? (
              <button
                type="button"
                onClick={() => handleSubmit("save-paid-on-entry")}
                disabled={isPending}
                className="min-h-[44px] rounded-md bg-green-700 px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-green-800 disabled:opacity-50"
              >
                {isPending ? "Saving…" : "Save, post, and pay"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleSubmit("save-post")}
                disabled={isPending}
                className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
              >
                {isPending ? "Saving…" : "Save & post"}
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={() => handleSubmit("save-draft")}
            disabled={isPending}
            className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save changes"}
          </button>
        )}
      </div>

      {/* Inline new vendor dialog */}
      <InlineNewVendorDialog
        open={newVendorOpen}
        onClose={() => setNewVendorOpen(false)}
        onCreate={handleInlineNewVendor}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlineNewVendorDialog
// ---------------------------------------------------------------------------

function InlineNewVendorDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName("");
    setSubmitting(false);
  }

  async function submit() {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await onCreate(name.trim());
      reset();
    } catch {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New vendor</DialogTitle>
          <DialogDescription>
            Quick-add a vendor by name. You can edit details later from the Vendors page.
          </DialogDescription>
        </DialogHeader>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Vendor name *
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </label>

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="min-h-[44px] rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)] hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !name.trim()}
            className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Field helper
// ---------------------------------------------------------------------------

function Field({
  label,
  children,
  help,
  error,
}: {
  label: string;
  children: React.ReactNode;
  help?: string;
  error?: string | null;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </span>
      {children}
      {help && (
        <span className="mt-1 block text-xs text-[color:var(--color-brand-text-soft)]">
          {help}
        </span>
      )}
      {error && <span className="mt-1 block text-xs text-red-700">{error}</span>}
    </label>
  );
}

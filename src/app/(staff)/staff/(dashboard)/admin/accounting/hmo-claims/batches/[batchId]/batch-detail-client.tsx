"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import type { Database } from "@/types/database";
import {
  voidBatchAction,
  removeItemFromBatchAction,
  voidResolutionAction,
} from "../../actions";
import {
  ResolveItemModal,
  type ResolveItemTarget,
} from "./modals/resolve-item-modal";
import { VoidConfirmModal } from "./modals/void-confirm-modal";
import { BulkSetHmoResponseModal } from "./modals/bulk-set-hmo-response-modal";
import {
  RecordSettlementModal,
  type SettlementItem,
} from "./modals/record-settlement-modal";
import { SubmitBatchModal } from "./modals/submit-batch-modal";
import { AcknowledgeBatchModal } from "./modals/acknowledge-batch-modal";

type BatchRow = Database["public"]["Tables"]["hmo_claim_batches"]["Row"] & {
  hmo_providers: { name: string } | null;
};
type PatientLite = {
  drm_id: string | null;
  first_name: string | null;
  last_name: string | null;
};
type ItemRow = Database["public"]["Tables"]["hmo_claim_items"]["Row"] & {
  test_requests: {
    id: string;
    service_id: string;
    visit_id: string;
    services: { name: string; kind: string } | null;
    visits: { patients: PatientLite | null } | null;
  } | null;
};
type ResolutionRow =
  Database["public"]["Tables"]["hmo_claim_resolutions"]["Row"];
type AllocationRow =
  Database["public"]["Tables"]["hmo_payment_allocations"]["Row"] & {
    payments: {
      reference_number: string | null;
      received_at: string;
    } | null;
  };

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

const STATUS_TONE: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  submitted: "bg-blue-100 text-blue-800",
  acknowledged: "bg-indigo-100 text-indigo-800",
  partial_paid: "bg-amber-100 text-amber-800",
  paid: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  voided: "bg-gray-200 text-gray-500 line-through",
};

const HMO_RESPONSE_LABEL: Record<string, string> = {
  pending: "Pending",
  paid: "Paid",
  rejected: "Rejected",
  no_response: "No response",
};

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-PH");
}
function fmtDateTime(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleString("en-PH");
}

function unresolvedOf(it: ItemRow): number {
  return (
    Number(it.billed_amount_php) -
    Number(it.paid_amount_php) -
    Number(it.patient_billed_amount_php) -
    Number(it.written_off_amount_php)
  );
}

function serviceName(it: ItemRow): string {
  return it.test_requests?.services?.name ?? "Unknown service";
}
function serviceKind(it: ItemRow): string | null {
  return it.test_requests?.services?.kind ?? null;
}

function anonPatient(
  p: PatientLite | null | undefined,
): string {
  if (!p) return "—";
  const fi = (p.first_name?.[0] ?? "").toUpperCase();
  const li = (p.last_name?.[0] ?? "").toUpperCase();
  const initials = fi || li ? `${fi}.${li}.` : "";
  const id = p.drm_id ?? "";
  if (initials && id) return `${initials} · ${id}`;
  return initials || id || "—";
}
function patientOf(it: ItemRow): PatientLite | null {
  return it.test_requests?.visits?.patients ?? null;
}

export function BatchDetailClient({
  batch,
  items,
  resolutions,
  allocations,
}: {
  batch: BatchRow;
  items: ItemRow[];
  resolutions: ResolutionRow[];
  allocations: AllocationRow[];
}) {
  const isVoided = Boolean(batch.voided_at);
  const effectiveStatus = isVoided ? "voided" : batch.status;

  const [bulkOpen, setBulkOpen] = useState(false);
  const [settlementOpen, setSettlementOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<ResolveItemTarget | null>(
    null,
  );
  const [voidBatchOpen, setVoidBatchOpen] = useState(false);
  const [voidResolutionId, setVoidResolutionId] = useState<string | null>(null);
  const [removeMode, setRemoveMode] = useState(false);

  const totals = useMemo(() => {
    let billed = 0;
    let paid = 0;
    let patient = 0;
    let writeOff = 0;
    for (const it of items) {
      billed += Number(it.billed_amount_php);
      paid += Number(it.paid_amount_php);
      patient += Number(it.patient_billed_amount_php);
      writeOff += Number(it.written_off_amount_php);
    }
    return {
      billed,
      paid,
      patient,
      writeOff,
      unresolved: billed - paid - patient - writeOff,
    };
  }, [items]);

  const settlementItems = useMemo<SettlementItem[]>(
    () =>
      items.map((it) => ({
        id: it.id,
        service_name: serviceName(it),
        billed_amount_php: Number(it.billed_amount_php),
        paid_amount_php: Number(it.paid_amount_php),
        patient_billed_amount_php: Number(it.patient_billed_amount_php),
        written_off_amount_php: Number(it.written_off_amount_php),
      })),
    [items],
  );

  return (
    <div className="space-y-6">
      <Header batch={batch} effectiveStatus={effectiveStatus} />
      <TotalsRow totals={totals} />

      {isVoided ? (
        <VoidedBanner reason={batch.void_reason} />
      ) : (
        <ActionsBar
          batch={batch}
          itemsCount={items.length}
          removeMode={removeMode}
          onToggleRemoveMode={() => setRemoveMode((v) => !v)}
          onOpenBulk={() => setBulkOpen(true)}
          onOpenSettlement={() => setSettlementOpen(true)}
          onOpenSubmit={() => setSubmitOpen(true)}
          onOpenAck={() => setAckOpen(true)}
          onOpenVoid={() => setVoidBatchOpen(true)}
        />
      )}

      <ItemsList
        items={items}
        removeMode={removeMode && !isVoided && batch.status === "draft"}
        canResolve={!isVoided}
        onResolve={(it) =>
          setResolveTarget({
            id: it.id,
            service_name: serviceName(it),
            billed_amount_php: Number(it.billed_amount_php),
            paid_amount_php: Number(it.paid_amount_php),
            patient_billed_amount_php: Number(it.patient_billed_amount_php),
            written_off_amount_php: Number(it.written_off_amount_php),
          })
        }
      />

      <ResolutionsLog
        resolutions={resolutions}
        canVoid={!isVoided}
        onVoid={(id) => setVoidResolutionId(id)}
      />

      <AllocationsLog allocations={allocations} />

      <ResolveItemModal
        open={resolveTarget !== null}
        onClose={() => setResolveTarget(null)}
        item={resolveTarget}
      />
      <BulkSetHmoResponseModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        batchId={batch.id}
      />
      <RecordSettlementModal
        open={settlementOpen}
        onClose={() => setSettlementOpen(false)}
        batchId={batch.id}
        items={settlementItems}
      />
      <SubmitBatchModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        batchId={batch.id}
        defaultReferenceNo={batch.reference_no}
      />
      <AcknowledgeBatchModal
        open={ackOpen}
        onClose={() => setAckOpen(false)}
        batchId={batch.id}
        defaultAckRef={batch.hmo_ack_ref}
      />
      <VoidConfirmModal
        open={voidBatchOpen}
        onClose={() => setVoidBatchOpen(false)}
        title="Void batch"
        description="Voiding reverses all related journal entries. Provide a reason for the audit log."
        onConfirm={(reason) =>
          voidBatchAction({ batch_id: batch.id, void_reason: reason })
        }
      />
      <VoidConfirmModal
        open={voidResolutionId !== null}
        onClose={() => setVoidResolutionId(null)}
        title="Void resolution"
        description="Reverses this resolution so the unresolved balance returns."
        onConfirm={(reason) =>
          voidResolutionAction({
            resolution_id: voidResolutionId!,
            void_reason: reason,
          })
        }
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? STATUS_TONE.draft;
  return (
    <span
      className={
        "inline-block rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wider " +
        tone
      }
    >
      {status}
    </span>
  );
}

function Header({
  batch,
  effectiveStatus,
}: {
  batch: BatchRow;
  effectiveStatus: string;
}) {
  const providerName = batch.hmo_providers?.name ?? "Unknown provider";
  const providerHref = `/staff/admin/accounting/hmo-claims/${batch.provider_id}`;
  return (
    <header className="space-y-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.3 · Batch
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {batch.reference_no ?? `Batch #${batch.id.slice(0, 8)}`}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <Link
            href={providerHref}
            className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            {providerName}
          </Link>
          <span aria-hidden className="text-[color:var(--color-brand-bg-mid)]">
            ·
          </span>
          <StatusBadge status={effectiveStatus} />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 text-xs md:grid-cols-4">
        <KeyValue label="Submitted" value={fmtDate(batch.submitted_at)} />
        <KeyValue label="Medium" value={batch.medium ?? "—"} />
        <KeyValue label="Reference" value={batch.reference_no ?? "—"} mono />
        <KeyValue label="HMO ack ref" value={batch.hmo_ack_ref ?? "—"} mono />
      </dl>
    </header>
  );
}

function KeyValue({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <Fragment>
      <div>
        <dt className="text-[color:var(--color-brand-text-soft)]">{label}</dt>
        <dd
          className={
            "mt-0.5 text-[color:var(--color-brand-navy)] " +
            (mono ? "font-mono" : "font-semibold")
          }
        >
          {value}
        </dd>
      </div>
    </Fragment>
  );
}

function TotalsRow({
  totals,
}: {
  totals: {
    billed: number;
    paid: number;
    patient: number;
    writeOff: number;
    unresolved: number;
  };
}) {
  const cells: { label: string; value: number; tone?: "danger" }[] = [
    { label: "Billed", value: totals.billed },
    { label: "Paid", value: totals.paid },
    { label: "Patient billed", value: totals.patient },
    { label: "Written off", value: totals.writeOff },
    {
      label: "Unresolved",
      value: totals.unresolved,
      tone: totals.unresolved > 0 ? "danger" : undefined,
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {cells.map((c) => (
        <div
          key={c.label}
          className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-3"
        >
          <dt className="text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            {c.label}
          </dt>
          <dd
            className={
              "mt-1 text-lg font-semibold " +
              (c.tone === "danger"
                ? "text-red-600"
                : "text-[color:var(--color-brand-navy)]")
            }
          >
            {PHP.format(c.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function VoidedBanner({ reason }: { reason: string | null }) {
  return (
    <div className="rounded-xl border border-red-300 bg-red-50 p-4">
      <p className="text-xs font-bold uppercase tracking-wider text-red-800">
        This batch is voided
      </p>
      <p className="mt-1 text-sm text-red-900">{reason ?? "No reason on file."}</p>
    </div>
  );
}

function ActionsBar({
  batch,
  itemsCount,
  removeMode,
  onToggleRemoveMode,
  onOpenBulk,
  onOpenSettlement,
  onOpenSubmit,
  onOpenAck,
  onOpenVoid,
}: {
  batch: BatchRow;
  itemsCount: number;
  removeMode: boolean;
  onToggleRemoveMode: () => void;
  onOpenBulk: () => void;
  onOpenSettlement: () => void;
  onOpenSubmit: () => void;
  onOpenAck: () => void;
  onOpenVoid: () => void;
}) {
  const status = batch.status;

  const addItemsHref = `/staff/admin/accounting/hmo-claims/batches/new?providerId=${batch.provider_id}&addToBatch=${batch.id}`;

  let buttons: React.ReactNode = null;
  if (status === "draft") {
    buttons = (
      <>
        <ActionButton
          onClick={onOpenSubmit}
          disabled={itemsCount < 1}
          variant="primary"
        >
          Submit
        </ActionButton>
        <Link
          href={addItemsHref}
          className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]"
        >
          Add items
        </Link>
        <ActionButton
          onClick={onToggleRemoveMode}
          variant="ghost"
          aria-pressed={removeMode}
        >
          {removeMode ? "Done removing" : "Remove items"}
        </ActionButton>
        <ActionButton onClick={onOpenVoid} variant="danger">
          Void
        </ActionButton>
      </>
    );
  } else if (status === "submitted") {
    buttons = (
      <>
        <ActionButton onClick={onOpenAck} variant="primary">
          Acknowledge
        </ActionButton>
        <ActionButton onClick={onOpenBulk} variant="ghost">
          Bulk-set HMO response
        </ActionButton>
        <ActionButton onClick={onOpenSettlement} variant="ghost">
          Record HMO settlement
        </ActionButton>
        <ActionButton onClick={onOpenVoid} variant="danger">
          Void
        </ActionButton>
      </>
    );
  } else if (status === "acknowledged") {
    buttons = (
      <>
        <ActionButton onClick={onOpenBulk} variant="primary">
          Bulk-set HMO response
        </ActionButton>
        <ActionButton onClick={onOpenSettlement} variant="ghost">
          Record HMO settlement
        </ActionButton>
        <ActionButton onClick={onOpenVoid} variant="danger">
          Void
        </ActionButton>
      </>
    );
  } else if (
    status === "partial_paid" ||
    status === "paid" ||
    status === "rejected"
  ) {
    buttons = (
      <ActionButton onClick={onOpenBulk} variant="ghost">
        Bulk-set HMO response
      </ActionButton>
    );
  }

  if (!buttons) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">{buttons}</div>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  variant = "ghost",
  ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost" | "danger";
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  const base =
    "min-h-[44px] rounded-md px-3 text-xs font-bold uppercase tracking-wider disabled:opacity-50";
  const tone =
    variant === "primary"
      ? " bg-[color:var(--color-brand-navy)] text-white"
      : variant === "danger"
        ? " bg-red-700 text-white"
        : " border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={base + tone}
      {...rest}
    >
      {children}
    </button>
  );
}

function ItemsList({
  items,
  removeMode,
  canResolve,
  onResolve,
}: {
  items: ItemRow[];
  removeMode: boolean;
  canResolve: boolean;
  onResolve: (it: ItemRow) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
        No items in this batch.
      </div>
    );
  }
  return (
    <section className="space-y-3" aria-label="Items in batch">
      {/* Desktop: table */}
      <div className="hidden overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white md:block">
        <table className="w-full min-w-[940px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Service</th>
              <th className="px-4 py-3" style={{ maxWidth: 120 }}>
                Patient
              </th>
              <th className="px-4 py-3 text-right">Billed</th>
              <th className="px-4 py-3 text-right">Paid</th>
              <th className="px-4 py-3 text-right">Patient billed</th>
              <th className="px-4 py-3 text-right">Written off</th>
              <th className="px-4 py-3 text-right">Unresolved</th>
              <th className="px-4 py-3">HMO response</th>
              <th className="px-4 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <ItemRowDesktop
                key={it.id}
                item={it}
                removeMode={removeMode}
                canResolve={canResolve}
                onResolve={() => onResolve(it)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: card stack */}
      <div className="space-y-3 md:hidden">
        {items.map((it) => (
          <ItemCardMobile
            key={it.id}
            item={it}
            removeMode={removeMode}
            canResolve={canResolve}
            onResolve={() => onResolve(it)}
          />
        ))}
      </div>
    </section>
  );
}

function ItemRowDesktop({
  item,
  removeMode,
  canResolve,
  onResolve,
}: {
  item: ItemRow;
  removeMode: boolean;
  canResolve: boolean;
  onResolve: () => void;
}) {
  const unresolved = unresolvedOf(item);
  const kind = serviceKind(item);
  return (
    <tr className="border-t border-[color:var(--color-brand-bg-mid)]">
      <td className="px-4 py-3">
        <div className="font-semibold text-[color:var(--color-brand-navy)]">
          {serviceName(item)}
        </div>
        {kind ? (
          <div className="text-xs text-[color:var(--color-brand-text-soft)]">
            {kind}
          </div>
        ) : null}
      </td>
      <td
        className="px-4 py-3 text-xs text-[color:var(--color-brand-navy)]"
        style={{ maxWidth: 120 }}
      >
        {anonPatient(patientOf(item))}
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs">
        {PHP.format(Number(item.billed_amount_php))}
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs">
        {PHP.format(Number(item.paid_amount_php))}
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs">
        {PHP.format(Number(item.patient_billed_amount_php))}
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs">
        {PHP.format(Number(item.written_off_amount_php))}
      </td>
      <td
        className={
          "px-4 py-3 text-right font-mono text-xs font-semibold " +
          (unresolved > 0 ? "text-red-700" : "text-[color:var(--color-brand-navy)]")
        }
      >
        {PHP.format(unresolved)}
      </td>
      <td className="px-4 py-3 text-xs">
        {HMO_RESPONSE_LABEL[item.hmo_response] ?? item.hmo_response}
      </td>
      <td className="px-4 py-3 text-right">
        <ItemRowActions
          item={item}
          unresolved={unresolved}
          removeMode={removeMode}
          canResolve={canResolve}
          onResolve={onResolve}
        />
      </td>
    </tr>
  );
}

function ItemCardMobile({
  item,
  removeMode,
  canResolve,
  onResolve,
}: {
  item: ItemRow;
  removeMode: boolean;
  canResolve: boolean;
  onResolve: () => void;
}) {
  const unresolved = unresolvedOf(item);
  const kind = serviceKind(item);
  return (
    <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-[color:var(--color-brand-navy)]">
            {serviceName(item)}
          </div>
          {kind ? (
            <div className="text-xs text-[color:var(--color-brand-text-soft)]">
              {kind}
            </div>
          ) : null}
        </div>
        <span className="rounded-full bg-[color:var(--color-brand-bg)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
          {HMO_RESPONSE_LABEL[item.hmo_response] ?? item.hmo_response}
        </span>
      </div>
      <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
        {anonPatient(patientOf(item))}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <Fragment>
          <dt className="text-[color:var(--color-brand-text-soft)]">Billed</dt>
          <dd className="text-right font-mono text-[color:var(--color-brand-navy)]">
            {PHP.format(Number(item.billed_amount_php))}
          </dd>
        </Fragment>
        <Fragment>
          <dt className="text-[color:var(--color-brand-text-soft)]">Paid</dt>
          <dd className="text-right font-mono text-[color:var(--color-brand-navy)]">
            {PHP.format(Number(item.paid_amount_php))}
          </dd>
        </Fragment>
        <Fragment>
          <dt className="text-[color:var(--color-brand-text-soft)]">
            Patient billed
          </dt>
          <dd className="text-right font-mono text-[color:var(--color-brand-navy)]">
            {PHP.format(Number(item.patient_billed_amount_php))}
          </dd>
        </Fragment>
        <Fragment>
          <dt className="text-[color:var(--color-brand-text-soft)]">
            Written off
          </dt>
          <dd className="text-right font-mono text-[color:var(--color-brand-navy)]">
            {PHP.format(Number(item.written_off_amount_php))}
          </dd>
        </Fragment>
        <Fragment>
          <dt className="text-[color:var(--color-brand-text-soft)]">
            Unresolved
          </dt>
          <dd
            className={
              "text-right font-mono font-semibold " +
              (unresolved > 0
                ? "text-red-700"
                : "text-[color:var(--color-brand-navy)]")
            }
          >
            {PHP.format(unresolved)}
          </dd>
        </Fragment>
      </dl>
      <div className="mt-3 flex justify-end">
        <ItemRowActions
          item={item}
          unresolved={unresolved}
          removeMode={removeMode}
          canResolve={canResolve}
          onResolve={onResolve}
        />
      </div>
    </div>
  );
}

function ItemRowActions({
  item,
  unresolved,
  removeMode,
  canResolve,
  onResolve,
}: {
  item: ItemRow;
  unresolved: number;
  removeMode: boolean;
  canResolve: boolean;
  onResolve: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function onRemove() {
    startTransition(async () => {
      setErr(null);
      const res = await removeItemFromBatchAction({ item_id: item.id });
      if (!res.ok) setErr(res.error);
    });
  }

  if (removeMode) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={onRemove}
          disabled={pending}
          aria-label={`Remove ${serviceName(item)}`}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-red-300 bg-white px-3 text-xs font-bold text-red-700 disabled:opacity-50"
        >
          {pending ? "…" : "× Remove"}
        </button>
        {err ? (
          <span role="alert" className="text-xs text-red-700">
            {err}
          </span>
        ) : null}
      </div>
    );
  }

  const canShow = canResolve && unresolved > 0.005;
  return (
    <button
      type="button"
      onClick={onResolve}
      disabled={!canShow}
      className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] disabled:opacity-40"
    >
      Resolve
    </button>
  );
}

function ResolutionsLog({
  resolutions,
  canVoid,
  onVoid,
}: {
  resolutions: ResolutionRow[];
  canVoid: boolean;
  onVoid: (id: string) => void;
}) {
  return (
    <details className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
      <summary className="flex min-h-[44px] cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-[color:var(--color-brand-navy)]">
        <span>Resolutions log</span>
        <span className="text-xs font-mono text-[color:var(--color-brand-text-soft)]">
          {resolutions.length}
        </span>
      </summary>
      {resolutions.length === 0 ? (
        <p className="px-4 py-4 text-sm text-[color:var(--color-brand-text-soft)]">
          No resolutions yet.
        </p>
      ) : (
        <div className="overflow-x-auto border-t border-[color:var(--color-brand-bg-mid)]">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Resolved at</th>
                <th className="px-4 py-3">Destination</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Notes</th>
                <th className="px-4 py-3 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {resolutions.map((r) => {
                const isVoided = Boolean(r.voided_at);
                const dest =
                  r.destination === "patient_bill"
                    ? "→ patient"
                    : "→ write-off";
                return (
                  <tr
                    key={r.id}
                    className={
                      "border-t border-[color:var(--color-brand-bg-mid)] " +
                      (isVoided ? "opacity-60" : "")
                    }
                  >
                    <td className="px-4 py-3 text-xs">
                      {fmtDateTime(r.resolved_at)}
                    </td>
                    <td
                      className={
                        "px-4 py-3 text-xs " +
                        (isVoided ? "line-through" : "")
                      }
                    >
                      {dest}
                      {isVoided ? " (voided)" : ""}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {PHP.format(Number(r.amount_php))}
                    </td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                      {r.notes ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!isVoided && canVoid ? (
                        <button
                          type="button"
                          onClick={() => onVoid(r.id)}
                          className="min-h-[44px] rounded-md border border-red-300 bg-white px-3 text-xs font-semibold text-red-700"
                        >
                          Void
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function AllocationsLog({ allocations }: { allocations: AllocationRow[] }) {
  return (
    <details className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
      <summary className="flex min-h-[44px] cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-[color:var(--color-brand-navy)]">
        <span>Allocations log</span>
        <span className="text-xs font-mono text-[color:var(--color-brand-text-soft)]">
          {allocations.length}
        </span>
      </summary>
      {allocations.length === 0 ? (
        <p className="px-4 py-4 text-sm text-[color:var(--color-brand-text-soft)]">
          No payment allocations yet.
        </p>
      ) : (
        <div className="overflow-x-auto border-t border-[color:var(--color-brand-bg-mid)]">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Received at</th>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {allocations.map((a) => {
                const isVoided = Boolean(a.voided_at);
                return (
                  <tr
                    key={a.id}
                    className={
                      "border-t border-[color:var(--color-brand-bg-mid)] " +
                      (isVoided ? "opacity-60" : "")
                    }
                  >
                    <td
                      className={
                        "px-4 py-3 text-xs " +
                        (isVoided ? "line-through" : "")
                      }
                    >
                      {fmtDateTime(a.payments?.received_at ?? null)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {a.payments?.reference_number ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs font-semibold">
                      {PHP.format(Number(a.amount_php))}
                    </td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                      {isVoided ? "voided" : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

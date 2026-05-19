"use client";

import { useEffect } from "react";
import { useFocusTrap } from "@/lib/a11y/use-focus-trap";

// =============================================================================
// Generic ConfirmDialog
// =============================================================================
//
// Shared by run-review actions: Re-import DTR (nav-only), Finalise (success),
// Void run (danger + reason), Void payout (danger + reason), Reopen voided
// (primary). The dialog is intentionally dumb — the caller owns the action,
// useTransition, and any router.refresh() side-effects.
//
// Behaviour:
// - Backdrop click + ESC both call onCancel.
// - Body scroll is locked while open.
// - Focus is trapped inside the inner panel.
// - When reasonRequired is true, the confirm button is disabled until the
//   caller-managed reasonValue has non-whitespace text (caller can disable
//   further via isPending).

type ConfirmVariant = "primary" | "danger" | "success";

interface Props {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  confirmVariant: ConfirmVariant;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  isPending?: boolean;
  reasonRequired?: boolean;
  reasonValue?: string;
  onReasonChange?: (next: string) => void;
  // Inline error rendered above the footer. Stays open until the caller
  // dismisses by closing or retrying.
  errorMessage?: string | null;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  confirmVariant,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  isPending = false,
  reasonRequired = false,
  reasonValue = "",
  onReasonChange,
  errorMessage,
}: Props) {
  const panelRef = useFocusTrap<HTMLDivElement>(open);

  // ESC closes (calls onCancel). Listener installed only while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isPending) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, isPending, onCancel]);

  // Body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const reasonBlocks =
    reasonRequired && reasonValue.trim().length === 0;
  const confirmDisabled = isPending || reasonBlocks;

  const confirmClass =
    confirmVariant === "danger"
      ? "bg-rose-700 text-white hover:bg-rose-800"
      : confirmVariant === "success"
        ? "bg-emerald-700 text-white hover:bg-emerald-800"
        : "bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Dismiss dialog"
        onClick={() => {
          if (!isPending) onCancel();
        }}
        className="absolute inset-0 bg-[color:var(--color-brand-navy)]/50 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 w-full max-w-[520px] overflow-hidden rounded-xl bg-white shadow-2xl"
      >
        <div className="border-b border-[color:var(--color-brand-bg-mid)] px-5 py-4">
          <h3 className="font-[family-name:var(--font-heading)] text-base font-extrabold text-[color:var(--color-brand-navy)]">
            {title}
          </h3>
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-4 text-sm text-[color:var(--color-brand-navy)]">
          {body}
          {reasonRequired ? (
            <div className="mt-4">
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                Reason (required)
              </label>
              <textarea
                aria-label="Reason"
                value={reasonValue}
                onChange={(e) => onReasonChange?.(e.target.value)}
                rows={3}
                disabled={isPending}
                placeholder="State why this action is being taken"
                className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:bg-slate-50"
              />
            </div>
          ) : null}
          {errorMessage ? (
            <p
              role="alert"
              className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
            >
              {errorMessage}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-bg-mid)] px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => {
              void onConfirm();
            }}
            disabled={confirmDisabled}
            className={`min-h-[44px] rounded-md px-4 py-2 text-sm font-bold disabled:opacity-50 ${confirmClass}`}
          >
            {isPending ? "Working..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useActionState, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { manilaDateTime } from "@/lib/dates/manila";
import {
  rewindAndSyncAction,
  runSyncAction,
  type AccountingActionResult,
} from "./actions";

// `target` names the scope inside the rewind confirm sentence.
const SCOPE_OPTIONS = [
  { value: "all", label: "All three tabs", target: "all three tabs" },
  { value: "lab_services", label: "Lab Services only", target: "the Lab Services tab" },
  { value: "doctor_consultations", label: "Doctor Consultations only", target: "the Doctor Consultations tab" },
  { value: "doctor_procedures", label: "Doctor Procedures HMO only", target: "the Doctor Procedures HMO tab" },
] as const;

export function AccountingActions() {
  return (
    <div className="grid gap-6">
      <RunNowSection />
      <RewindSection />
    </div>
  );
}

function RunNowSection() {
  const [state, formAction, pending] = useActionState<
    AccountingActionResult | null,
    FormData
  >(runSyncAction, null);

  return (
    <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
      <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Run sync now
      </h2>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        Picks up rows since the current watermark and appends them to the
        configured Sheets tabs. Same code path the cron uses.
      </p>
      <form action={formAction} className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="run-scope">Scope</Label>
          <select
            id="run-scope"
            name="scope"
            defaultValue="all"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
          >
            {SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="submit"
          disabled={pending}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Syncing…" : "Run sync"}
        </Button>
      </form>
      <ActionResult state={state} />
    </section>
  );
}

// What the confirm dialog restates before a rewind: which tabs, from when.
type RewindRequest = { target: string; fromLabel: string };

function RewindSection() {
  const [state, formAction, pending] = useActionState<
    AccountingActionResult | null,
    FormData
  >(rewindAndSyncAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Kept after the dialog closes so its text doesn't blank out mid-fade.
  const [request, setRequest] = useState<RewindRequest | null>(null);
  const [reason, setReason] = useState("");

  // Rewinding re-appends rows the sheet already has (Sheets has no upsert),
  // so the button only opens a confirm step — like voiding a bill, which is
  // less destructive and still asks for a reason. The form submits from the
  // dialog; the reason rides along in a hidden input and is audited.
  function askToConfirm() {
    const form = formRef.current;
    if (!form || !form.reportValidity()) return;
    const data = new FormData(form);
    const scope = String(data.get("scope") ?? "all");
    const from = String(data.get("from") ?? "");
    setRequest({
      target: SCOPE_OPTIONS.find((o) => o.value === scope)?.target ?? scope,
      // The input is Manila wall-clock time with no offset; pin it so the
      // formatter shows the same moment the admin picked.
      fromLabel: manilaDateTime(`${from}:00+08:00`),
    });
    setConfirmOpen(true);
  }

  function cancel() {
    setConfirmOpen(false);
    setReason("");
  }

  function confirm() {
    setConfirmOpen(false);
    // requestSubmit reads the form synchronously, so the hidden reason is
    // captured before the state below clears it for the next rewind.
    formRef.current?.requestSubmit();
    setReason("");
  }

  return (
    <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
      <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Rewind & re-sync from a date
      </h2>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        Sets the chosen tab&apos;s watermark back to the given Manila-local date,
        then re-runs the sync. Use sparingly — this <strong>will</strong>{" "}
        re-append rows that were already exported, since Sheets has no upsert.
      </p>
      <form
        ref={formRef}
        action={formAction}
        className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <input type="hidden" name="reason" value={reason} />
        <div className="grid gap-1.5">
          <Label htmlFor="rewind-scope">Scope</Label>
          <select
            id="rewind-scope"
            name="scope"
            defaultValue="all"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
          >
            {SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="rewind-from">From (Manila local time)</Label>
          <Input id="rewind-from" name="from" type="datetime-local" required />
        </div>
        <Button
          type="button"
          onClick={askToConfirm}
          disabled={pending}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Re-syncing…" : "Rewind & sync"}
        </Button>
      </form>
      <ActionResult state={state} />

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rewind and re-sync?</DialogTitle>
            <DialogDescription>
              Every row from {request?.fromLabel} (Manila time) onward will be
              sent to {request?.target} of the Google Sheet again. Rows already
              in the sheet are not replaced — they will appear twice until
              someone deletes the copies by hand.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="rewind-reason">Reason *</Label>
            <Textarea
              id="rewind-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="3+ characters required"
              autoFocus
            />
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="touch" onClick={cancel}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="touch"
              onClick={confirm}
              disabled={pending || reason.trim().length < 3}
              className="bg-red-700 text-white hover:bg-red-800"
            >
              Rewind &amp; sync
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ActionResult({ state }: { state: AccountingActionResult | null }) {
  if (!state) return null;
  if (!state.ok) {
    return (
      <p className="mt-3 text-sm text-red-600" role="alert">
        {state.error}
      </p>
    );
  }
  const { result } = state;
  return (
    <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900" role="status">
      <p className="font-bold">
        Sync finished — {result.totalRowsAppended} row
        {result.totalRowsAppended === 1 ? "" : "s"} appended.
      </p>
      <ul className="mt-1 grid gap-0.5">
        {result.tabs.map((t) => (
          <li key={t.key}>
            <span className="font-semibold">{t.label}:</span>{" "}
            {t.skippedReason
              ? `skipped (${t.skippedReason})`
              : `${t.rowsAppended} row${t.rowsAppended === 1 ? "" : "s"}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

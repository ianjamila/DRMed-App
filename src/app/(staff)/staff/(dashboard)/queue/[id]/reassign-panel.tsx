"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { unclaimTestAction, reassignTestAction } from "../actions";

interface LabStaffOption {
  id: string;
  full_name: string;
  role: string;
}

// Admin-only panel on the test detail page: hand a stuck claim back to the
// queue (unclaim) or move it to another lab staff member (reassign).
export function ReassignPanel({
  testRequestId,
  assigneeName,
  labStaff,
}: {
  testRequestId: string;
  assigneeName: string;
  labStaff: LabStaffOption[];
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onUnclaim() {
    startTransition(async () => {
      setErr(null);
      const result = await unclaimTestAction(testRequestId, reason.trim());
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      setConfirmOpen(false);
      setReason("");
      router.refresh();
    });
  }

  function onReassign() {
    if (!newAssignee) {
      setErr("Pick a staff member to reassign to.");
      return;
    }
    startTransition(async () => {
      setErr(null);
      const result = await reassignTestAction(testRequestId, newAssignee);
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      setNewAssignee("");
      router.refresh();
    });
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-3 text-xs">
      <p className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        Assignment (admin)
      </p>
      <p className="text-[color:var(--color-brand-text-mid)]">
        Claimed by <span className="font-semibold">{assigneeName}</span>
      </p>

      {!confirmOpen ? (
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="min-h-[44px] text-xs font-semibold text-[color:var(--color-brand-text-soft)] hover:underline"
        >
          Unclaim
        </button>
      ) : (
        <div className="space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2">
          <p className="text-[color:var(--color-brand-text-mid)]">
            Unclaiming puts this test back in the queue for anyone to claim.
            The action is audit-logged.
          </p>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)…"
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2 text-xs"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onUnclaim}
              disabled={pending}
              className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
            >
              {pending ? "Unclaiming…" : "Confirm unclaim"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmOpen(false);
                setReason("");
                setErr(null);
              }}
              className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-[color:var(--color-brand-bg-mid)] pt-2">
        <select
          value={newAssignee}
          onChange={(e) => setNewAssignee(e.target.value)}
          disabled={pending}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1 text-xs"
        >
          <option value="">Reassign to…</option>
          {labStaff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.full_name} ({s.role.replace(/_/g, " ")})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onReassign}
          disabled={pending || !newAssignee}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
        >
          {pending ? "Reassigning…" : "Reassign"}
        </button>
      </div>

      {err ? <p className="text-red-600">{err}</p> : null}
    </div>
  );
}

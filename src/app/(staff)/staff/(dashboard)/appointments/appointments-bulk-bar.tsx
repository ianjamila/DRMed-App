"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BulkBar } from "@/components/staff/row-selection/bulk-bar";
import { BulkOutcomePanel } from "@/components/staff/row-selection/bulk-outcome";
import { useRowSelection } from "@/components/staff/row-selection/selection-context";
import {
  BULK_TARGET,
  bulkActionPlan,
  bulkAppointmentsMessage,
  summariseOutcome,
  type BulkAction,
  type GroupInfo,
} from "@/lib/appointments/bulk-eligibility";
import { bulkDeleteAction, bulkTransitionAction } from "./actions";

interface Props {
  // Every booking group the page rendered, keyed by ApptGroup.key. Serialisable
  // — built by the server page; the selection context only holds keys.
  groupsByKey: Record<string, GroupInfo>;
  isAdmin: boolean;
}

const BUTTONS: Array<{
  action: BulkAction;
  label: string;
  verb: string;
  pastTense: string;
  variant: "success" | "brand" | "outline" | "destructive";
  confirm: ((n: number) => string) | null;
}> = [
  { action: "arrive", label: "Mark arrived", verb: "Marked", pastTense: "arrived", variant: "success", confirm: null },
  { action: "confirm", label: "Confirm", verb: "Confirmed", pastTense: "", variant: "brand", confirm: null },
  {
    action: "noShow", label: "No-show", verb: "Marked", pastTense: "as no-show", variant: "outline",
    confirm: (n) => `Mark ${n} booking${n === 1 ? "" : "s"} as no-show?`,
  },
  {
    action: "cancel", label: "Cancel", verb: "Cancelled", pastTense: "", variant: "outline",
    confirm: (n) => `Cancel ${n} booking${n === 1 ? "" : "s"}? The patient is not notified automatically.`,
  },
  {
    action: "revert", label: "Revert to confirmed", verb: "Reverted", pastTense: "to confirmed", variant: "outline",
    confirm: (n) => `Put ${n} booking${n === 1 ? "" : "s"} back to confirmed?`,
  },
  {
    action: "delete", label: "Delete", verb: "Deleted", pastTense: "", variant: "destructive",
    confirm: (n) => `Delete ${n} booking${n === 1 ? "" : "s"} permanently? This cannot be undone.`,
  },
];

interface Outcome {
  message: string;
  /** The `selectionEdits` value when this outcome was set — see the
   * render-time drop rule below. */
  edits: number;
}

export function AppointmentsBulkBar({ groupsByKey, isAdmin }: Props) {
  const { state, clearKeys, count, selectionEdits } = useRowSelection();
  const router = useRouter();
  const [pending, start] = useTransition();
  // The last action's outcome, naming every booking not changed or skipped.
  // An action only clears the keys it acted on, so other selected rows (e.g.
  // a pending-callback booking under Mark arrived) can leave `count > 0` —
  // the outcome must still show. It survives until the operator makes a new
  // deliberate edit (toggle/setMany bumps `selectionEdits`), not merely until
  // count is next > 0.
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const selected = [...state.keys()]
    .map((key) => ({ key, info: groupsByKey[key] }))
    .filter((g): g is { key: string; info: GroupInfo } => g.info !== undefined)
    .map((g) => ({ key: g.key, status: g.info.status, patientActive: g.info.patientActive }));
  const plan = bulkActionPlan(selected, isAdmin);
  const inactiveCount = selected.filter((g) => !g.patientActive).length;
  // The operator started a new selection (a deliberate toggle/setMany) since
  // this outcome was set — drop it. Post-action pruning (clearKeys) does NOT
  // bump selectionEdits, so a partial action's outcome survives being shown
  // even though rows it acted on were just removed from the selection.
  if (outcome !== null && selectionEdits !== outcome.edits) setOutcome(null);

  function run(button: (typeof BUTTONS)[number]) {
    const keys = plan[button.action].keys;
    if (keys.length === 0 || pending) return;
    if (button.confirm && !confirm(button.confirm(keys.length))) return;
    // Send each booking with the status the operator saw — the server writes
    // with eq("status", from), so a booking changed since then comes back unchanged.
    const batch = keys.map((key) => ({ ids: groupsByKey[key]!.ids, from: groupsByKey[key]!.status }));
    start(async () => {
      const result =
        button.action === "delete"
          ? await bulkDeleteAction(batch)
          : await bulkTransitionAction(batch, BULK_TARGET[button.action]);
      if (!result.ok) {
        alert(result.error);
        // A partial failure can still have committed some rows (see
        // transitionGroups/deleteGroups) — refresh so those show up. Keep
        // the selection so the operator can see/retry what's left.
        router.refresh();
        return;
      }
      const outcomeResult = summariseOutcome(keys, groupsByKey, result.changedIds);
      const notSent = plan[button.action].skippedInactiveKeys;
      setOutcome({
        message: bulkAppointmentsMessage(button, outcomeResult, groupsByKey, notSent),
        edits: selectionEdits,
      });
      // Pruning wins (spec §4): clear everything sent — and the inactive ones the
      // button left out, which the message now names — the panel is the record.
      clearKeys([...keys, ...notSent]);
      router.refresh();
    });
  }

  if (count === 0) {
    return outcome ? (
      <BulkOutcomePanel message={outcome.message} onDismiss={() => setOutcome(null)} />
    ) : null;
  }

  return (
    <BulkBar noun="booking">
      {outcome ? (
        <BulkOutcomePanel inline message={outcome.message} onDismiss={() => setOutcome(null)} />
      ) : null}
      {inactiveCount > 0 ? (
        <span className="text-[11px] text-amber-700">
          {inactiveCount} skipped for Mark arrived, Confirm and Revert — patient record deleted or merged
        </span>
      ) : null}
      {BUTTONS.map((button) => {
        const n = plan[button.action].keys.length;
        if (n === 0) return null;
        return (
          <Button
            key={button.action}
            type="button"
            size="sm"
            variant={button.variant}
            disabled={pending}
            onClick={() => run(button)}
          >
            {button.label} ({n})
          </Button>
        );
      })}
    </BulkBar>
  );
}

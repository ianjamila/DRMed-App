"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BulkBar } from "@/components/staff/row-selection/bulk-bar";
import { useRowSelection } from "@/components/staff/row-selection/selection-context";
import {
  BULK_TARGET,
  bulkActionPlan,
  outcomeMessage,
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
    action: "noShow", label: "No-show", verb: "Marked", pastTense: "no-show", variant: "outline",
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

export function AppointmentsBulkBar({ groupsByKey, isAdmin }: Props) {
  const { state, clearKeys } = useRowSelection();
  const router = useRouter();
  const [pending, start] = useTransition();

  const selected = [...state.keys()]
    .map((key) => ({ key, info: groupsByKey[key] }))
    .filter((g): g is { key: string; info: GroupInfo } => g.info !== undefined)
    .map((g) => ({ key: g.key, status: g.info.status, patientActive: g.info.patientActive }));
  const plan = bulkActionPlan(selected, isAdmin);
  const inactiveCount = selected.filter((g) => !g.patientActive).length;

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
        return;
      }
      const outcome = summariseOutcome(keys, groupsByKey, result.changedIds);
      const message = outcomeMessage(button.verb, button.pastTense, outcome);
      if (message) alert(message);
      // Pruning wins (spec §4): clear everything sent; the alert is the record.
      clearKeys(keys);
      router.refresh();
    });
  }

  return (
    <BulkBar noun="booking">
      {inactiveCount > 0 ? (
        <span className="text-[11px] text-amber-700">
          {inactiveCount} skipped for Mark arrived, Confirm and Revert — patient record deleted
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

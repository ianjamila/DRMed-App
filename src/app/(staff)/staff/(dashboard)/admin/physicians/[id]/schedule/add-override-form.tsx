"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addOverrideAction, type ScheduleResult } from "./actions";

interface Props {
  physicianId: string;
}

export function AddOverrideForm({ physicianId }: Props) {
  const action = addOverrideAction.bind(null, physicianId);
  const [state, formAction, pending] = useActionState<
    ScheduleResult | null,
    FormData
  >(action, null);

  return (
    <form
      action={formAction}
      className="grid gap-3"
      key={state?.ok ? "reset" : "edit"}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="override_on">Date</Label>
          <Input id="override_on" name="override_on" type="date" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="start_time">Start (optional)</Label>
          <Input id="start_time" name="start_time" type="time" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="end_time">End (optional)</Label>
          <Input id="end_time" name="end_time" type="time" />
        </div>
      </div>
      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        Leave both times blank for full-day unavailability. Set both for a
        partial-day window that replaces the recurring block on that date.
      </p>

      <div className="grid gap-1.5">
        <Label htmlFor="reason">Reason (optional)</Label>
        <Input
          id="reason"
          name="reason"
          maxLength={500}
          placeholder="e.g. conference, family emergency"
        />
      </div>

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <div>
        <Button
          type="submit"
          disabled={pending}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Adding…" : "Add override"}
        </Button>
      </div>
    </form>
  );
}

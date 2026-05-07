"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  StableInput,
  StableSelect,
} from "@/components/forms/stable-fields";
import { DAY_NUMBERS } from "@/lib/physicians/schedule";
import { addBlockAction, type ScheduleResult } from "./actions";

interface Props {
  physicianId: string;
}

export function AddBlockForm({ physicianId }: Props) {
  const action = addBlockAction.bind(null, physicianId);
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
          <Label htmlFor="day_of_week">Day</Label>
          <StableSelect
            id="day_of_week"
            name="day_of_week"
            required
            defaultValue="1"
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            {DAY_NUMBERS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </StableSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="start_time">Start</Label>
          <StableInput
            id="start_time"
            name="start_time"
            type="time"
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="end_time">End</Label>
          <StableInput
            id="end_time"
            name="end_time"
            type="time"
            required
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="valid_from">Valid from (optional)</Label>
          <StableInput id="valid_from" name="valid_from" type="date" />
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            Defaults to today.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="valid_until">Valid until (optional)</Label>
          <StableInput id="valid_until" name="valid_until" type="date" />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="notes">Notes (optional)</Label>
        <StableInput id="notes" name="notes" maxLength={500} />
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
          {pending ? "Adding…" : "Add block"}
        </Button>
      </div>
    </form>
  );
}

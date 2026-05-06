"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  deletePhysicianAction,
  type PhysicianResult,
} from "../../actions";

interface Props {
  physicianId: string;
  physicianName: string;
}

export function DeletePhysicianButton({ physicianId, physicianName }: Props) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<PhysicianResult | null>(null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        className="border-red-200 text-red-700 hover:bg-red-50"
      >
        Delete physician
      </Button>
    );
  }

  return (
    <div className="grid gap-3 rounded-lg border-2 border-red-300 bg-red-50 p-4">
      <p className="text-sm text-red-900">
        Permanently remove <strong>{physicianName}</strong> and their
        recurring schedule + overrides? This cannot be undone. If they
        have history you want to keep, uncheck <em>Active</em> on the
        form above instead.
      </p>
      {state && !state.ok ? (
        <p className="text-sm font-semibold text-red-900" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await deletePhysicianAction(physicianId);
              setState(result);
              // Action redirects on success; we only land here on error.
            })
          }
          className="bg-red-600 text-white hover:bg-red-700"
        >
          {pending ? "Deleting…" : "Yes, delete"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setOpen(false);
            setState(null);
          }}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

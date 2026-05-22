"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { softDeleteStaffUserAction } from "../../actions";

interface Props {
  staffUserId: string;
  staffName: string;
}

// Two-step delete:
//   1. Click "Delete user" → reveals the confirmation form
//   2. Type the user's full name exactly → click "Confirm delete"
// The name-echo gate matches the rest of the destructive-action pattern
// used elsewhere in the codebase and prevents accidental deletion via
// keyboard / muscle memory.
export function DeleteForm({ staffUserId, staffName }: Props) {
  const router = useRouter();
  const [revealed, setRevealed] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const cancel = () => {
    setRevealed(false);
    setTyped("");
    setError(null);
  };

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await softDeleteStaffUserAction(staffUserId, formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(result.redirect_to);
      router.refresh();
    });
  };

  if (!revealed) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-rose-900/80">
          Removes the user from sign-in and from the active list. The row
          stays in the database so audit logs continue to resolve to a name;
          you can restore later from Staff users.
        </p>
        <Button
          type="button"
          onClick={() => setRevealed(true)}
          className="bg-rose-700 text-white hover:bg-rose-800"
        >
          Delete user…
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <p className="text-sm font-semibold text-rose-900">
        Type the user&apos;s full name to confirm deletion:
      </p>
      <p className="font-mono text-sm text-rose-900/80">{staffName}</p>
      <div className="grid gap-1.5">
        <Label htmlFor="confirm_name" className="sr-only">
          Confirmation name
        </Label>
        <Input
          id="confirm_name"
          name="confirm_name"
          type="text"
          required
          placeholder="Type the full name exactly"
          autoComplete="off"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>

      {error ? (
        <p className="text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex gap-3">
        <Button
          type="submit"
          disabled={pending || typed.trim() !== staffName}
          className="bg-rose-700 text-white hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Deleting…" : "Confirm delete"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={cancel}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { restoreStaffUserAction } from "./actions";

interface Props {
  staffUserId: string;
  name: string;
}

export function RestoreButton({ staffUserId, name }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onRestore = () => {
    setError(null);
    startTransition(async () => {
      const result = await restoreStaffUserAction(staffUserId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(result.redirect_to);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onRestore}
        disabled={pending}
        className="rounded-md border border-rose-300 bg-white px-3 py-1 text-xs font-bold text-rose-900 hover:bg-rose-100 disabled:opacity-50"
        aria-label={`Restore ${name}`}
      >
        {pending ? "Restoring…" : "Restore"}
      </button>
      {error ? (
        <span className="text-xs text-rose-700" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

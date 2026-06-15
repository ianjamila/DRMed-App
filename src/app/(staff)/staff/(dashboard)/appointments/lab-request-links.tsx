"use client";

import { useState, useTransition } from "react";
import { Paperclip } from "lucide-react";
import { getLabRequestFormUrlAction } from "./lab-request-actions";

export type LabRequestAttachment = { id: string; filename: string };

export function LabRequestLinks({ attachments }: { attachments: LabRequestAttachment[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  function open(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await getLabRequestFormUrlAction(id);
      if (res.ok) window.open(res.url, "_blank", "noopener,noreferrer");
      else setError(res.error);
    });
  }

  return (
    <div className="mt-1">
      <p className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-violet-900">
        <Paperclip className="h-3 w-3" /> Request form
      </p>
      <ul className="mt-1 space-y-0.5">
        {attachments.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => open(a.id)}
              disabled={pending}
              className="max-w-[180px] truncate text-left text-xs text-[color:var(--color-brand-cyan)] underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
            >
              {a.filename}
            </button>
          </li>
        ))}
      </ul>
      {error ? <p className="text-[10px] text-red-700">{error}</p> : null}
    </div>
  );
}

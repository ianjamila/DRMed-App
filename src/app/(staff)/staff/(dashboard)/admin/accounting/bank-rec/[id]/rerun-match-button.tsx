"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { rerunAutoMatch } from "../actions";

export function RerunMatchButton({ statementId }: { statementId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      const r = await rerunAutoMatch(statementId);
      if (!r.ok) {
        alert(r.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-medium text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)] disabled:opacity-60"
    >
      {pending ? "Re-running…" : "Re-run auto-match"}
    </button>
  );
}

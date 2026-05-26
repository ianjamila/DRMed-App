"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { deactivateAccrualTemplate } from "../actions";

export function DeactivateButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onClick() {
    if (
      !confirm(
        "Retire this template? Already-posted JEs are unaffected. You can re-activate later by toggling the form's Active checkbox.",
      )
    ) {
      return;
    }
    startTransition(async () => {
      const r = await deactivateAccrualTemplate(id);
      if (!r.ok) {
        alert(r.error);
        return;
      }
      router.push("/staff/admin/accounting/accrual-templates");
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-2 text-sm font-medium text-[color:var(--color-brand-text-soft)] transition-colors hover:border-red-300 hover:text-red-700 disabled:opacity-60"
    >
      {pending ? "Retiring…" : "Retire"}
    </button>
  );
}

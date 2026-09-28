"use client";

// Admin "View as role" picker. Submits on change (needs JS; the <noscript>
// Go button covers the rest). useActionState gives a pending state (the
// select is disabled and says so) and an inline error — a failed switch no
// longer lands home silently. The hidden return_to is filled with the
// current page at submit time so the action can bring the admin back
// (safeReturnTo decides whether the new role may see it).
//
// Stale-picker fix (Codex P2): the parent renders this with
// key={viewAsStateKey(...)}, so a new server state remounts it and the
// uncontrolled <select> shows the role actually in force.
import { useActionState } from "react";
import { startViewAsAction } from "@/app/(staff)/staff/(dashboard)/view-as/actions";
import { VIEW_AS_ROLES, type ViewAsRole } from "@/lib/auth/view-as";
import { ROLE_LABEL } from "@/lib/staff/role-labels";

interface Props {
  current: ViewAsRole | null;
  /** DOM id for the select (the shell renders up to three of these). */
  id: string;
  className?: string;
}

export function currentPageForReturn(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function ViewAsSelect({ current, id, className }: Props) {
  const [state, formAction, pending] = useActionState(startViewAsAction, { error: null });
  const errorId = `${id}-error`;
  return (
    <form action={formAction} className={className} aria-busy={pending}>
      <label
        htmlFor={id}
        className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
      >
        View as
      </label>
      <input type="hidden" name="return_to" defaultValue="" />
      <select
        id={id}
        name="role"
        defaultValue={current ?? ""}
        disabled={pending}
        aria-describedby={state.error ? errorId : undefined}
        onChange={(e) => {
          const form = e.currentTarget.form;
          const rt = form?.elements.namedItem("return_to");
          if (rt instanceof HTMLInputElement) rt.value = currentPageForReturn();
          form?.requestSubmit();
        }}
        className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-xs disabled:opacity-60"
      >
        <option value="" disabled>
          View as…
        </option>
        {VIEW_AS_ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      {pending && (
        <p className="mt-1 text-[11px] text-[color:var(--color-brand-text-soft)]">Switching…</p>
      )}
      {state.error && (
        <p id={errorId} role="alert" className="mt-1 text-[11px] text-red-700">
          {state.error}
        </p>
      )}
      <noscript>
        <button type="submit" className="mt-1 text-xs underline">
          Go
        </button>
      </noscript>
    </form>
  );
}

"use client";

// Admin "View as role" picker. Submitting on change needs JS, hence a client
// component; the Server Action is imported directly (Next serialises it as
// the form action). `current` pre-selects the role in force so the banner's
// copy of this control reads as "switch", the sidebar's as "start".
import { startViewAsAction } from "@/app/(staff)/staff/(dashboard)/view-as/actions";
import { VIEW_AS_ROLES, type ViewAsRole } from "@/lib/auth/view-as";
import { ROLE_LABEL } from "@/lib/staff/role-labels";

interface Props {
  current: ViewAsRole | null;
  /** DOM id for the select (the shell renders up to two of these). */
  id: string;
  className?: string;
}

export function ViewAsSelect({ current, id, className }: Props) {
  return (
    <form action={startViewAsAction} className={className}>
      <label
        htmlFor={id}
        className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
      >
        View as
      </label>
      <select
        id={id}
        name="role"
        defaultValue={current ?? ""}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-xs"
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
      <noscript>
        <button type="submit" className="mt-1 text-xs underline">
          Go
        </button>
      </noscript>
    </form>
  );
}

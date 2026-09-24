// Small count pill for a sidebar nav item (desktop + mobile) and for a
// collapsed subgroup/section `<summary>` that owns such an item — so the
// total is visible without expanding. Generic: any nav item can carry a
// count via `StaffNav`/`StaffMobileNavTrigger`'s `badges` prop.
const MAX_DISPLAY = 99;

export function NavBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  const display = count > MAX_DISPLAY ? `${MAX_DISPLAY}+` : String(count);
  return (
    <span className="inline-flex min-w-[20px] shrink-0 items-center justify-center rounded-full bg-[color:var(--color-brand-cyan)] px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
      <span aria-hidden="true">{display}</span>
      <span className="sr-only">{`, ${count} new`}</span>
    </span>
  );
}

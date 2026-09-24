// The thin rule an item's `dividerBefore` draws above it. Purely visual, so it
// is hidden from screen readers rather than announced as a separator.
export function NavDivider() {
  return (
    <li
      aria-hidden="true"
      data-nav-divider=""
      className="mx-3 my-1.5 border-t border-[color:var(--color-brand-bg-mid)]"
    />
  );
}

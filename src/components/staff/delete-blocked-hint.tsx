// Stands in for a Delete button the rules do not allow: a greyed-out
// "Delete" plus the reason, so staff see why instead of a button that is
// simply missing. The hint comes from visitDeletability/testDeletability.
export function DeleteBlockedHint({ hint }: { hint: string }) {
  return (
    <span className="inline-flex max-w-[16rem] flex-col items-start text-xs">
      <button
        type="button"
        disabled
        className="cursor-not-allowed font-semibold text-red-700/40"
      >
        Delete
      </button>
      <span className="text-[color:var(--color-brand-text-soft)]">{hint}</span>
    </span>
  );
}

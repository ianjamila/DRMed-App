"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * The "Show voided" switch on the AP Bills and Bill Payments lists. Same
 * checkbox as the HMO provider page's batches tab, but it writes `?voided=1`
 * to the URL instead of local state, so the choice survives Back, a reload
 * and the sort/page links the way every other filter on these lists does.
 */
export function ShowVoidedToggle({
  checked,
  voidedCount,
  toggleHref,
  lockedReason,
}: {
  checked: boolean;
  /** Voided rows among the fetched set, shown or not. */
  voidedCount: number;
  /** Where to go when the box is flipped. */
  toggleHref: string;
  /** When set, the box is shown ticked and disabled with this as its hint. */
  lockedReason?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const locked = lockedReason !== undefined;

  return (
    <label
      title={lockedReason}
      className={`inline-flex min-h-[44px] items-center gap-2 text-xs font-semibold text-[color:var(--color-brand-navy)] ${locked ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        checked={checked || locked}
        disabled={locked || pending}
        onChange={() => startTransition(() => router.push(toggleHref, { scroll: false }))}
        className="h-4 w-4"
      />
      Show voided{voidedCount > 0 ? ` (${voidedCount})` : ""}
    </label>
  );
}

/**
 * Empty-state line for a list whose only matching rows are voided ones —
 * without it, a list that hid everything would read "nothing matches" when
 * there are rows one click away.
 */
export function HiddenVoidedEmptyState({
  noun,
  hiddenVoided,
  showHref,
}: {
  noun: string;
  hiddenVoided: number;
  showHref: string;
}) {
  return (
    <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
      No active {noun}s match your filters. {hiddenVoided} voided {noun}
      {hiddenVoided !== 1 ? "s are" : " is"} hidden —{" "}
      <Link
        href={showHref}
        scroll={false}
        className="font-semibold text-[color:var(--color-brand-navy)] underline"
      >
        show voided
      </Link>
      .
    </p>
  );
}

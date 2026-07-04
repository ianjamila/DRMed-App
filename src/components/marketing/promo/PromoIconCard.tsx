import type { LucideIcon } from "lucide-react";

/**
 * The icon + title + body card shared by the feature/step grids across the
 * /promo landing pages. Two variants, one component:
 *
 * - **plain** (default): icon chip top-left, then title and body — used for
 *   feature grids (turnaround times, specialist roster).
 * - **numbered** (pass `step`): icon chip floated top-right with a large italic
 *   step number — used for "how it works" / path grids.
 *
 * The wrapping grid + {@link Reveal} stagger stay on the page; this renders one
 * card cell.
 */
export function PromoIconCard({
  icon: Icon,
  title,
  body,
  step,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  /** When set, renders the numbered variant with this label (e.g. "01"). */
  step?: string;
}) {
  if (step) {
    return (
      <div className="relative h-full rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)]">
        <span className="absolute right-[22px] top-[22px] grid h-[42px] w-[42px] place-items-center rounded-[13px] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <span
          aria-hidden="true"
          className="font-[family-name:var(--font-display)] text-[28px] italic leading-none text-[color:var(--color-brand-cyan)] opacity-50"
        >
          {step}
        </span>
        <h3 className="mt-[14px] text-[17px] font-bold text-[color:var(--color-brand-navy)]">
          {title}
        </h3>
        <p className="mt-2 text-[14px] leading-[1.55] text-[color:var(--color-ink-soft)]">
          {body}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)]">
      <span className="grid h-[42px] w-[42px] place-items-center rounded-[13px] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <h3 className="mt-4 text-[17px] font-bold text-[color:var(--color-brand-navy)]">
        {title}
      </h3>
      <p className="mt-2 text-[14px] leading-[1.55] text-[color:var(--color-ink-soft)]">
        {body}
      </p>
    </div>
  );
}

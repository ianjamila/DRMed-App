import type { LucideIcon } from "lucide-react";
import { Reveal } from "@/components/marketing/motion";

export interface ProofItem {
  icon: LucideIcon;
  label: string;
}

/**
 * Thin proof-signal strip for campaign landing pages — the TrustStrip recipe
 * (white band, icon chips) parameterized per campaign's proof row.
 */
export function PromoProofRow({ items }: { items: readonly ProofItem[] }) {
  return (
    <div className="border-y border-[color:var(--color-warm-line-soft)] bg-white py-[26px]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <ul className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
            {items.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-[13px]">
                <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <p className="text-sm font-bold text-[color:var(--color-brand-navy)]">
                  {label}
                </p>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </div>
  );
}

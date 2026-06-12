import {
  ShieldCheck,
  Zap,
  BadgePercent,
  House,
  CreditCard,
  type LucideIcon,
} from "lucide-react";
import { Reveal } from "@/components/marketing/motion";
import { TRUST_BAR } from "@/lib/marketing/site";

// Map each TRUST_BAR entry (by index order) to its lucide icon.
// TRUST_BAR titles: Accredited Clinic & Lab, Results in 24 Hours,
// Up to 50% Less, Home & Mobile Service, HMO Accepted.
const TRUST_ICONS: LucideIcon[] = [
  ShieldCheck,
  Zap,
  BadgePercent,
  House,
  CreditCard,
];

/**
 * Thin trust-signal strip between the hero and the How-It-Works section.
 * White background with border-y, 5-column grid on wide screens.
 * Server component — no interactivity needed.
 */
export function TrustStrip() {
  return (
    <div className="border-y border-[color:var(--color-warm-line-soft)] bg-white py-[26px]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-3 lg:grid-cols-5">
            {TRUST_BAR.map((item, i) => {
              const Icon = TRUST_ICONS[i];
              return (
                <div key={item.title} className="flex items-center gap-[13px]">
                  {/* Icon chip */}
                  <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-sm font-bold text-[color:var(--color-brand-navy)]">
                      {item.title}
                    </p>
                    <p className="text-[12.5px] text-[color:var(--color-ink-soft)]">
                      {item.sub}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </Reveal>
      </div>
    </div>
  );
}

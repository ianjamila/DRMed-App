import Image from "next/image";
import { HMO_PARTNERS } from "@/lib/marketing/hmo";

/**
 * Auto-scrolling HMO logo strip.
 *
 * Markup is doubled so the marquee loops seamlessly (the .hmo-ticker keyframe
 * in globals.css scrolls exactly 50% → the seam is invisible).
 * Edge fade: mask-image gradient on the overflow wrapper.
 * Hover behaviour: full-color by default; hover lifts the pill for delight.
 */
export function HmoTicker() {
  return (
    <div
      className="overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_10%,#000_90%,transparent)]"
      aria-label="Accredited HMO partners"
    >
      <div className="hmo-ticker flex w-max items-center gap-[18px] px-[18px]">
        {[...HMO_PARTNERS, ...HMO_PARTNERS].map((p, i) => (
          <div
            key={`${p.slug}-${i}`}
            className="flex h-[84px] w-[170px] shrink-0 items-center justify-center rounded-[18px] border border-[color:var(--color-warm-line-soft)] bg-white p-4 shadow-[var(--shadow-warm-sm)] transition-[transform,box-shadow] duration-[250ms] hover:-translate-y-1 hover:shadow-[var(--shadow-warm-lg)]"
          >
            <Image
              src={`/hmo/${p.slug}.png`}
              alt={p.name}
              width={122}
              height={46}
              className="max-h-[46px] max-w-[122px] object-contain"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

import Image from "next/image";
import { HMO_PARTNERS } from "@/lib/marketing/hmo";

// Auto-scrolling logo strip. Doubled markup so the marquee loops seamlessly.
export function HmoTicker() {
  return (
    <div className="relative overflow-hidden border-y border-white/10 bg-white py-6">
      <div className="hmo-ticker flex w-max items-center gap-12 px-6">
        {[...HMO_PARTNERS, ...HMO_PARTNERS].map((p, i) => (
          <div
            key={`${p.slug}-${i}`}
            className="flex h-14 shrink-0 items-center justify-center"
          >
            <Image
              src={`/hmo/${p.slug}.png`}
              alt={p.name}
              width={140}
              height={56}
              className="h-12 w-auto object-contain opacity-80 grayscale transition hover:opacity-100 hover:grayscale-0"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

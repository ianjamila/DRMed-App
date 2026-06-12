"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import { ArrowRight } from "lucide-react";
import { Eyebrow } from "@/components/marketing/ui/Eyebrow";
import { PillLink } from "@/components/marketing/ui/PillLink";
import {
  HeroStagger,
  HeroStaggerItem,
  CountUp,
  EcgUnderline,
  AmbientGlow,
} from "@/components/marketing/motion";
import { SITE } from "@/lib/marketing/site";

// Local typed stat array matching HERO_STATS shape with numeric `to` for CountUp.
const STATS = [
  { to: 19, suffix: "+", label: "Specialist Physicians" },
  { to: 10, suffix: "+", label: "HMO Partners" },
  { to: 50, suffix: "%", label: "Less vs. Hospitals" },
  { to: 24, suffix: "h", label: "Average Turnaround" },
] as const;

/**
 * Homepage hero section.
 *
 * Motion notes:
 * - Left column uses HeroStagger/HeroStaggerItem for a staggered mount fade-rise.
 * - Hero photo: renders statically (fully visible) below 640 px for LCP.
 *   Above 640 px with prefers-reduced-motion:no-preference, a clip-path reveal
 *   plays via an `is-revealed` class added by useEffect. If matchMedia fails,
 *   the image stays fully visible (safe default).
 * - AmbientGlow: one layer only (guardrail: ≤2 per section).
 */
export function Hero() {
  const mediaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Only animate on ≥640 px screens that haven't opted out of motion.
    const wideEnough = window.matchMedia("(min-width: 640px)");
    const motionOk = window.matchMedia("(prefers-reduced-motion: no-preference)");
    if (wideEnough.matches && motionOk.matches) {
      // rAF so the initial clip-path from globals.css has been applied.
      const id = requestAnimationFrame(() => {
        mediaRef.current?.classList.add("is-revealed");
      });
      return () => cancelAnimationFrame(id);
    }
    // If either check fails the image shows without any clip-path; no cleanup needed.
  }, []);

  return (
    <section
      id="home"
      className="relative overflow-hidden py-[72px] bg-[color:var(--color-warm-bg)]"
    >
      {/* Ambient glow — single layer */}
      <AmbientGlow className="-top-[220px] left-1/2 h-[540px] w-[760px] -translate-x-1/2" />

      {/* Bottom hero waves */}
      <svg
        className="pointer-events-none absolute left-0 right-0 -bottom-px w-full h-[clamp(70px,12vw,150px)]"
        viewBox="0 0 1440 150"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          fill="#F3EEE6"
          fillOpacity="0.55"
          d="M0,96 C240,140 420,52 720,72 C1020,92 1200,138 1440,92 L1440,150 L0,150 Z"
        />
        <path
          fill="#E8F3FB"
          fillOpacity="0.6"
          d="M0,118 C280,84 560,142 840,118 C1120,94 1300,120 1440,108 L1440,150 L0,150 Z"
        />
        <path
          fill="#FFFFFF"
          d="M0,136 C320,118 640,148 960,134 C1200,124 1340,134 1440,130 L1440,150 L0,150 Z"
        />
      </svg>

      <div className="relative z-[1] mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid items-center gap-14 lg:grid-cols-[1.05fr_0.95fr]">
          {/* ── Left column ── */}
          <HeroStagger>
            {/* Eyebrow kicker */}
            <HeroStaggerItem>
              <Eyebrow>Premier Diagnostic Care · Quezon City</Eyebrow>
            </HeroStaggerItem>

            {/* H1 */}
            <HeroStaggerItem>
              <h1 className="mt-4 font-[family-name:var(--font-display)] text-[clamp(46px,11vw,78px)] leading-[1.04] tracking-[-0.01em] text-[color:var(--color-brand-navy)]">
                Your Family&apos;s Well-Being is{" "}
                <EcgUnderline className="italic">Our Mission.</EcgUnderline>
              </h1>
            </HeroStaggerItem>

            {/* Lead */}
            <HeroStaggerItem>
              <p className="mt-6 max-w-[520px] text-base leading-relaxed text-[color:var(--color-ink-mid)] md:text-lg">
                {SITE.description}
              </p>
            </HeroStaggerItem>

            {/* CTAs */}
            <HeroStaggerItem>
              <div className="mt-8 flex flex-wrap gap-3">
                <PillLink href="/schedule" variant="cyan">
                  Book Appointment <ArrowRight className="h-[18px] w-[18px]" />
                </PillLink>
                <PillLink href="/#packages" variant="navy">
                  View Packages
                </PillLink>
                <PillLink href="/#doctors" variant="line">
                  Meet Our Doctors
                </PillLink>
              </div>
            </HeroStaggerItem>

            {/* Stats row */}
            <HeroStaggerItem>
              <div className="mt-11 grid grid-cols-2 gap-x-4 gap-y-6 border-t border-[color:var(--color-warm-line)] pt-7 sm:grid-cols-4">
                {STATS.map((s) => (
                  <div key={s.label}>
                    <div className="font-[family-name:var(--font-display)] text-[40px] leading-none text-[color:var(--color-brand-navy)]">
                      <CountUp to={s.to} />
                      <em className="not-italic italic text-[0.7em] text-[color:var(--color-brand-cyan-text)]">
                        {s.suffix}
                      </em>
                    </div>
                    <p className="mt-1.5 text-[12.5px] font-semibold text-[color:var(--color-ink-soft)]">
                      {s.label}
                    </p>
                  </div>
                ))}
              </div>
            </HeroStaggerItem>
          </HeroStagger>

          {/* ── Right column — hero media ── */}
          <HeroStaggerItem>
            {/*
             * `is-revealed` class is added by the useEffect above on ≥640px
             * non-reduced-motion viewports. The clip-path reveal CSS lives in
             * globals.css (.hero-media.is-revealed .hero-photo-img).
             */}
            <div ref={mediaRef} className="hero-media relative">
              {/* Hero photo — clip-path reveal target */}
              <Image
                src="/hero-clinic.jpg"
                alt="DRMed Clinic, Northridge Plaza"
                width={720}
                height={520}
                // LCP hero image. Next 16 deprecated `priority` (preload-only, no
                // fetchpriority) — use eager + high fetch priority so it loads at
                // High network priority, and `sizes` so mobile pulls a ~750w
                // variant instead of the 1920w 2x (was the simulated-LCP driver).
                loading="eager"
                fetchPriority="high"
                sizes="(min-width: 1024px) 560px, 100vw"
                className="hero-photo-img h-[420px] w-full rounded-[200px_200px_26px_26px] object-cover shadow-[var(--shadow-warm-lg)] md:h-[520px]"
              />

              {/* hero-chip: top-right badge */}
              <div className="absolute -right-2 top-[38px] rounded-2xl bg-white p-[14px_18px] shadow-[var(--shadow-warm-lg)]">
                <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[color:var(--color-brand-cyan-text)]">
                  Average Turnaround
                </p>
                <p className="mt-0.5 font-[family-name:var(--font-display)] text-[20px] text-[color:var(--color-brand-navy)]">
                  24 Hours
                </p>
                <p className="text-[11.5px] text-[color:var(--color-ink-soft)]">
                  Most tests same-day
                </p>
              </div>

              {/* hero-slot: bottom-left pending photo */}
              <div className="absolute -left-2.5 -bottom-[26px] w-[180px] rounded-[18px] bg-white p-2 shadow-[var(--shadow-warm-lg)]">
                <Image
                  src="/photos/blood-draw.jpg"
                  alt="DRMed phlebotomist drawing blood from a seated patient by a window"
                  width={746}
                  height={1000}
                  sizes="180px"
                  className="h-[150px] w-full rounded-[12px] object-cover"
                />
                <p className="px-1 pb-0.5 pt-[7px] text-[10.5px] italic text-[color:var(--color-ink-soft)]">
                  Gentle, unhurried blood draws
                </p>
              </div>
            </div>
          </HeroStaggerItem>
        </div>
      </div>
    </section>
  );
}

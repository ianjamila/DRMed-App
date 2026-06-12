"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

const container = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.09, delayChildren: 0.05 },
  },
};

const item = {
  hidden: { opacity: 0, y: 20 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.2, 0.7, 0.3, 1] as const },
  },
};

/**
 * Container that staggers its {@link HeroStaggerItem} children in on mount.
 * Reduced motion is handled globally by `<MotionConfig reducedMotion="user">`
 * (set in the marketing layout) — it keeps opacity and skips the transform.
 * The render never branches on `useReducedMotion`, so there is no hydration
 * mismatch for reduced-motion clients.
 *
 * Below 640px the entrance is forced static via the `.hero-stagger-item`
 * guardrail in globals.css (opacity:1 !important) so the hero text/LCP paints
 * immediately instead of being gated behind the JS-driven opacity:0 → 1 stagger.
 * Matches the hero photo + ambient "static < 640px" guardrails.
 */
export function HeroStagger({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} variants={container} initial="hidden" animate="show">
      {children}
    </motion.div>
  );
}

export function HeroStaggerItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      className={["hero-stagger-item", className].filter(Boolean).join(" ")}
      variants={item}
    >
      {children}
    </motion.div>
  );
}

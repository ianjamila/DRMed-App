"use client";

import { motion, useScroll, useSpring } from "motion/react";

/**
 * Thin cyan progress bar pinned to the top of the viewport that fills as the
 * page scrolls. Scroll-linked (not time-based), GPU transform only — safe under
 * reduced-motion. Render once at the marketing layout level.
 */
export function ScrollPulse() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 120,
    damping: 30,
    mass: 0.3,
  });

  return (
    <motion.div
      aria-hidden
      className="fixed inset-x-0 top-0 z-[60] h-[2px] origin-left bg-[var(--color-brand-cyan)]"
      style={{ scaleX }}
    />
  );
}

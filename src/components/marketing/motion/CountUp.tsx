"use client";

import { animate, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

interface CountUpProps {
  /** Final value to count to. */
  to: number;
  /** Decimal places to show. */
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Seconds. */
  duration?: number;
  className?: string;
}

/**
 * Counts a number up from 0 to `to` the first time it scrolls into view.
 * Reduced-motion shows the final value immediately. The numeric value uses
 * en-PH grouping so large stats read naturally.
 */
export function CountUp({
  to,
  decimals = 0,
  prefix = "",
  suffix = "",
  duration = 1.4,
  className,
}: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -40px 0px" });
  const reduce = useReducedMotion();
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!inView || reduce) return;
    const controls = animate(0, to, {
      duration,
      ease: [0.2, 0.7, 0.3, 1],
      onUpdate: (v) => setValue(v),
    });
    return () => controls.stop();
  }, [inView, reduce, to, duration]);

  // Reduced motion renders the final value directly (no state churn).
  const formatted = (reduce ? to : value).toLocaleString("en-PH", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return (
    <span ref={ref} className={className}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}

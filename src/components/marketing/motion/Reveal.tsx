"use client";

import { motion, type HTMLMotionProps } from "motion/react";
import type { ReactNode } from "react";

type RevealTag = "div" | "section" | "article" | "li" | "span";

interface RevealProps {
  children: ReactNode;
  /** Seconds to delay the entrance (for manual staggering). */
  delay?: number;
  /** Pixels to rise from. */
  y?: number;
  className?: string;
  /** Rendered element. Defaults to a div. */
  as?: RevealTag;
}

/**
 * Fades + rises content into view once, on scroll. Transform/opacity only.
 *
 * Reduced motion is handled globally by `<MotionConfig reducedMotion="user">`
 * (set in the marketing layout + booking wizard), which skips the transform and
 * keeps the opacity fade. The rendered DOM is identical on the server and the
 * client regardless of the user's motion preference, so there is no hydration
 * mismatch — we never branch the render on `useReducedMotion`.
 */
export function Reveal({ children, delay = 0, y = 18, className, as = "div" }: RevealProps) {
  // motion exposes one component per tag; index access is safe for our tag union.
  const MotionTag = motion[as] as React.ComponentType<HTMLMotionProps<"div">>;

  return (
    <MotionTag
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -80px 0px" }}
      transition={{ duration: 0.6, ease: [0.2, 0.7, 0.3, 1], delay }}
    >
      {children}
    </MotionTag>
  );
}

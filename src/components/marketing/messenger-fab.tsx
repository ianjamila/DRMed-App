"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { MessageCircle } from "lucide-react";

import { SOCIAL } from "@/lib/marketing/site";

/**
 * Floating action button — fixed bottom-right — that links to the clinic's
 * Facebook Messenger. Navy pill expands on hover to reveal a "Message us"
 * label; bg shifts to cyan on hover.
 *
 * Entrance animation (fade + slide-up) is gated on prefers-reduced-motion via
 * motion/react's useReducedMotion hook (reads the OS media query on the
 * client). The FAB is invisible until after hydration to avoid SSR mismatch.
 */
export function MessengerFab() {
  const reduced = useReducedMotion();

  // Mount-gate: keep the FAB hidden on the server pass so there is no
  // hydration mismatch. A ref + a single state update drives this.
  const mountedRef = useRef(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    // Defer by a tick so the entrance animation plays after first paint.
    const id = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(id);
  }, []);

  if (!mounted) return null;

  return (
    <a
      href={SOCIAL.messenger}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Message us on Facebook"
      className={[
        // Position
        "fixed right-[18px] bottom-[18px] z-[85]",
        // Layout — group so child label can respond to group-hover
        "group flex items-center gap-0",
        // Pill shape + navy base
        "rounded-full bg-[color:var(--color-brand-navy)] p-[15px] shadow-[var(--shadow-warm-lg)]",
        // Hover: cyan bg, lift, expand gap + right padding for label
        "transition-all duration-300 hover:bg-[color:var(--color-brand-cyan)] hover:-translate-y-0.5 hover:gap-2 hover:pr-4",
        // Entrance animation (skip if reduced motion)
        reduced
          ? "opacity-100"
          : "animate-[fabIn_0.4s_cubic-bezier(0.34,1.56,0.64,1)_both]",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Icon — always white */}
      <MessageCircle
        size={22}
        strokeWidth={2}
        className="shrink-0 text-white"
        aria-hidden="true"
      />

      {/* Expanding label — slides in on hover */}
      <span
        className="overflow-hidden whitespace-nowrap text-[13.5px] font-bold text-white transition-[max-width,opacity] duration-300 ease-out max-w-0 opacity-0 group-hover:max-w-[120px] group-hover:opacity-100"
        aria-hidden="true"
      >
        Message us
      </span>
    </a>
  );
}

"use client";

import { useEffect, useState } from "react";
import { isOpenNow } from "@/lib/marketing/nap";

/**
 * Inline pill showing whether the clinic is currently open (Asia/Manila,
 * Mon–Sat 08:00–17:00). Renders null until after mount to avoid hydration
 * mismatch — the server can't know the client's Manila time, so we defer
 * entirely to the browser's first paint.
 */
export function OpenNowPill() {
  // Combine mounted + open into one state update to satisfy the
  // react-hooks/set-state-in-effect rule (single setState per effect).
  const [status, setStatus] = useState<"pending" | "open" | "closed">("pending");

  useEffect(() => {
    // One-shot after mount to avoid hydration mismatch (Manila time is client-only).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus(isOpenNow(new Date()) ? "open" : "closed");
  }, []);

  if (status === "pending") return null;

  if (status === "open") {
    return (
      <span
        className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-[rgba(5,150,105,0.18)] px-2.5 py-0.5 align-middle text-[11px] font-bold text-emerald-200"
        aria-label="Clinic is open now"
      >
        {/* Pulsing dot — static for prefers-reduced-motion */}
        <span
          className="h-1.5 w-1.5 rounded-full bg-emerald-400 motion-safe:animate-pulse"
          aria-hidden="true"
        />
        Open now
      </span>
    );
  }

  return (
    <span
      className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-0.5 align-middle text-[11px] font-bold text-white/75"
      aria-label="Clinic is currently closed"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-white/40" aria-hidden="true" />
      Closed now
    </span>
  );
}

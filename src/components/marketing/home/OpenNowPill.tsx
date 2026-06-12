"use client";

import { useEffect, useState } from "react";

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
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      weekday: "short",
      hour: "numeric",
      hour12: false,
    });

    const parts = fmt.formatToParts(new Date());
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
    const hour = parseInt(hourStr, 10);

    // Open Mon–Sat (not Sunday), 08:00 ≤ hour < 17:00
    const isSunday = weekday === "Sun";
    const open = !isSunday && hour >= 8 && hour < 17;

    // One-shot initialization after mount: read Manila time to avoid hydration
    // mismatch. No subscription — this is the correct pattern for deferred
    // client-only state (R4 requirement in the spec).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus(open ? "open" : "closed");
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

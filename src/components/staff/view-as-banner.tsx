"use client";

// Admin "View as role" banner.
//   - "until 4:00 PM" is the server's Manila clock time; "3h 40m left" counts
//     down from the SERVER's remaining time using performance.now(), so a
//     wrong device clock can neither end it early nor freeze it (Codex P2).
//   - Just after the server's expiry the banner refreshes the route; the
//     refreshed render brings a new remainingMs, which re-arms the timer, so
//     an override that is still active never leaves a stuck banner.
//   - useViewAsShellSync picks up switches/exits made in another tab/device.
// Every server render and action uses the database's effective role, so a
// momentarily stale shell can mislead, never authorize.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  countdownRemainingMs,
  expiryRefreshDelay,
  formatRemainingMs,
  viewAsStateKey,
  type ViewAsRole,
} from "@/lib/auth/view-as";
import { ROLE_LABEL } from "@/lib/staff/role-labels";
import { ViewAsSelect } from "./view-as-select";
import { ViewAsExitButton } from "./view-as-exit-button";
import { useViewAsShellSync } from "./use-view-as-shell-sync";

const TICK_MS = 15_000;

interface Props {
  role: ViewAsRole;
  /** ISO-8601; identity of this override (shell-sync + picker key). */
  until: string;
  /** Server-formatted Manila clock time of `until`, e.g. "4:00 PM". */
  untilLabel: string;
  /** Server-computed ms until `until` at render time. */
  remainingMs: number;
}

function useCountdown(remainingMs: number): number {
  const [tick, setTick] = useState<{ base: number; elapsed: number } | null>(null);
  useEffect(() => {
    const start = performance.now();
    const id = setInterval(
      () => setTick({ base: remainingMs, elapsed: performance.now() - start }),
      TICK_MS,
    );
    return () => clearInterval(id);
  }, [remainingMs]);
  return countdownRemainingMs(remainingMs, tick);
}

export function ViewAsBanner({ role, until, untilLabel, remainingMs }: Props) {
  const router = useRouter();
  useViewAsShellSync({ role, until });
  const left = useCountdown(remainingMs);
  useEffect(() => {
    const timer = setTimeout(() => router.refresh(), expiryRefreshDelay(remainingMs));
    return () => clearTimeout(timer);
  }, [remainingMs, router]);

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 print:hidden"
    >
      <p className="min-w-0 flex-1">
        <b>
          Viewing as {ROLE_LABEL[role]} until {untilLabel}
        </b>{" "}
        · {formatRemainingMs(left)} left. Anything you save is recorded under your name.
      </p>
      <ViewAsSelect key={viewAsStateKey({ role, until })} current={role} id="view-as-banner" className="w-44" />
      <ViewAsExitButton />
    </div>
  );
}

/** Headless: rendered for an admin with NO active override so a start made
 *  in another tab/device shows up here on the next navigation or focus. */
export function ViewAsShellSync() {
  useViewAsShellSync(null);
  return null;
}

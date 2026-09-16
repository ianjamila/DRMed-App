"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";

// Only tables in the `supabase_realtime` publication can be subscribed to —
// adding a name here without publishing the table yields a channel that never
// fires. Published so far: appointments + test_requests (0024), critical_alerts
// (0027), visits + payments (0100). Admin's money tables (bills,
// journal_entries, accounting_periods…) are NOT published, which is why the
// admin dashboard refreshes on `intervalMs` instead of a subscription.
export interface Subscription {
  table:
    | "appointments"
    | "test_requests"
    | "visits"
    | "payments"
    | "critical_alerts";
  event?: "INSERT" | "UPDATE" | "*";
}

interface Props {
  // Tables (and optional event) to listen on. The component calls
  // router.refresh() with debounce when any matching event fires, so
  // server-rendered queue / appointments pages stay current without a
  // full page reload.
  subscriptions: readonly Subscription[];
  // Minimum gap between two refreshes. A burst of inserts (e.g. a
  // multi-service booking that fires N test_request rows) should refresh
  // once, not N times.
  debounceMs?: number;
  // Each call site supplies a distinct stable name to avoid channel collisions.
  channelName: string;
  // Poll fallback for pages whose tables aren't in the realtime publication
  // (see the Subscription comment above). Refreshes on this cadence in
  // addition to any subscriptions. Omit (or 0) to disable. Keep it coarse —
  // every tick re-runs the whole server render.
  intervalMs?: number;
}

export function RealtimeRefresher({
  subscriptions,
  debounceMs = 1500,
  channelName,
  intervalMs = 0,
}: Props) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  // Poll fallback. Separate effect so it runs even with no subscriptions, and
  // so re-mounting the channel doesn't restart the clock.
  useEffect(() => {
    if (!intervalMs) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  // Key the effect on the CONTENT of the subscription list, not its identity.
  // An inline array literal is a new object on every render — with `subscriptions` in the dep array the effect tore the channel down
  // and rebuilt it on every router.refresh(), and the refresh is itself triggered by
  // the subscription. That loop made realtime WAL filtering 85% of all prod DB time
  // (10.27M ms over 1.3M calls). Call sites also hoist their arrays to module scope;
  // this serialisation is the belt to that braces.
  const subscriptionKey = JSON.stringify(subscriptions);

  useEffect(() => {
    const subs: Subscription[] = JSON.parse(subscriptionKey);
    if (subs.length === 0) return;

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        // A backgrounded tab re-rendering the whole server page helps nobody and
        // costs a full RSC round-trip. Catch up on the way back instead.
        if (document.visibilityState === "visible") router.refresh();
        timeout = null;
      }, debounceMs);
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    // Stable channel name. The old `-${Math.random()}` suffix worked around a
    // re-mount crash that was itself caused by the dep-array churn above; with a
    // stable key the effect no longer re-runs on every render, so the crash is gone.
    const channel = supabase.channel(channelName);
    for (const sub of subs) {
      channel.on(
        "postgres_changes",
        { event: sub.event ?? "INSERT", schema: "public", table: sub.table },
        () => scheduleRefresh(),
      );
    }
    channel.subscribe();

    return () => {
      if (timeout) clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [supabase, router, subscriptionKey, debounceMs, channelName]);

  return null;
}

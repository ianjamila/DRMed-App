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
interface Subscription {
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
  subscriptions: Subscription[];
  // Minimum gap between two refreshes. A burst of inserts (e.g. a
  // multi-service booking that fires N test_request rows) should refresh
  // once, not N times.
  debounceMs?: number;
  // Stable channel name; defaults to a per-page name to avoid collisions
  // when multiple instances mount.
  channelName?: string;
  // Poll fallback for pages whose tables aren't in the realtime publication
  // (see the Subscription comment above). Refreshes on this cadence in
  // addition to any subscriptions. Omit (or 0) to disable. Keep it coarse —
  // every tick re-runs the whole server render.
  intervalMs?: number;
}

export function RealtimeRefresher({
  subscriptions,
  debounceMs = 1500,
  channelName = "page-refresher",
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

  useEffect(() => {
    if (subscriptions.length === 0) return;

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        router.refresh();
        timeout = null;
      }, debounceMs);
    };

    // Suffix the channel with a per-mount random id. Without it, a
    // re-mount returns Supabase's existing subscribed singleton and
    // .on() throws — same crash as notification-bell.
    const channel = supabase.channel(
      `${channelName}-${Math.random().toString(36).slice(2)}`,
    );
    for (const sub of subscriptions) {
      channel.on(
        "postgres_changes",
        {
          event: sub.event ?? "INSERT",
          schema: "public",
          table: sub.table,
        },
        () => scheduleRefresh(),
      );
    }
    channel.subscribe();

    return () => {
      if (timeout) clearTimeout(timeout);
      supabase.removeChannel(channel);
    };
  }, [supabase, router, subscriptions, debounceMs, channelName]);

  return null;
}

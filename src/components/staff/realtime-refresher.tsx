"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";

interface Subscription {
  table: "appointments" | "test_requests";
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
}

export function RealtimeRefresher({
  subscriptions,
  debounceMs = 1500,
  channelName = "page-refresher",
}: Props) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

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

    const channel = supabase.channel(channelName);
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

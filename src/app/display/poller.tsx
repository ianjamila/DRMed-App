"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

interface Props {
  // How often to refresh, in seconds. Sensible default for a clinic
  // waiting room — fast enough to feel live without hammering the DB.
  intervalSec?: number;
}

// Re-runs the server component on a timer so the kiosk display picks up
// new "now serving" rows without a manual reload. Pure router.refresh
// — no Realtime subscription, since the /display route is unauthed and
// anon users can't subscribe to test_requests events.
export function DisplayPoller({ intervalSec = 10 }: Props) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => {
      router.refresh();
    }, intervalSec * 1000);
    return () => clearInterval(id);
  }, [router, intervalSec]);

  return null;
}

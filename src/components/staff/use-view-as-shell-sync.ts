"use client";

// Keeps an admin's staff shell honest across devices/tabs (Codex P3). The
// dashboard layout is cached across client navigations, so a View-as switch
// made elsewhere would not show here. On every pathname change (not the first
// render) and whenever the tab becomes visible, ask the tiny state endpoint
// and router.refresh() only if the answer differs — never a blind refresh
// per navigation. Rendered only for admins (banner, or ViewAsShellSync).
import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { checkViewAsShell, type ViewAsShellState } from "@/lib/auth/view-as-shell-sync";

export function useViewAsShellSync(expected: ViewAsShellState | null) {
  const router = useRouter();
  const pathname = usePathname();
  const expectedRef = useRef(expected);
  const inflight = useRef<AbortController | null>(null);
  const firstPath = useRef(true);

  useEffect(() => {
    expectedRef.current = expected;
  });

  const check = useCallback(() => {
    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;
    void checkViewAsShell(expectedRef.current, fetch, ctl.signal).then((stale) => {
      if (stale && !ctl.signal.aborted) router.refresh();
    });
  }, [router]);

  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per pathname by design
  }, [pathname]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      inflight.current?.abort();
    };
  }, [check]);
}

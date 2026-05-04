"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

interface Props {
  // Roles that can access /staff/quote — match the page's own gating.
  enabledForRole: boolean;
}

export function StaffQuoteShortcut({ enabledForRole }: Props) {
  const router = useRouter();

  useEffect(() => {
    if (!enabledForRole) return;

    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== "k") return;
      // Don't hijack browser/IDE chords from inside an editable surface;
      // /staff/quote already binds Cmd+K locally to refocus its search input.
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
      router.push("/staff/quote");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabledForRole, router]);

  return null;
}

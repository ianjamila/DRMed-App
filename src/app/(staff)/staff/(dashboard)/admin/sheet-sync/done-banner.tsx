"use client";

// A one-time success banner for an action whose own row/group disappears
// from the list it started on (Map answer, Approve group) — the same
// "success text vanishes with the row" problem Task 14 hit for Undo, fixed
// there by keeping the message in a row that survives. Here there is no
// surviving row, so the message lives in the URL instead: the triggering
// client control (review-actions.tsx) navigates to `?...&done=<kind>&n=<count>`
// on success, page.tsx renders this banner from those (validated) params,
// and this component strips them back out on mount so a later refresh or a
// bookmarked/shared link doesn't repeat a stale success message. The strip
// uses window.history.replaceState, which Next's App Router keeps in sync
// without a server round trip — router.replace would re-render the page
// without the params and unmount this banner immediately.
import { useEffect } from "react";
import { doneBannerMessage, type DoneKind } from "./format";

export function DoneBanner({ kind, n, clearHref }: { kind: DoneKind; n: number; clearHref: string }) {
  useEffect(() => {
    window.history.replaceState(null, "", clearHref);
    // Runs once, right after this banner is shown from the URL — never
    // re-runs on a later render, so it can't fight a subsequent navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <p
      role="status"
      className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900"
    >
      {doneBannerMessage(kind, n)}
    </p>
  );
}

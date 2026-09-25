"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BULK_NO_SHOW_MAX_BOOKINGS, STALE_UNTIMED_AFTER_DAYS } from "@/lib/appointments/stale";
import { markLikelyNoShowsAction, undoLikelyNoShowsAction } from "./actions";

interface Props {
  // One entry per booking the page flagged as a likely no-show — the
  // appointment ids of every service on it.
  bookings: string[][];
}

type Done =
  | { kind: "marked"; bookings: string[][] }
  | { kind: "undone"; count: number; heldBack: number };

function bookingsWord(n: number): string {
  return n === 1 ? "1 booking" : `${n} bookings`;
}

// "Undone — 3 bookings are back on the list. 1 booking stays as no-show …"
function undoneText({ count, heldBack }: { count: number; heldBack: number }): string {
  const back =
    count > 0 ? `Undone — ${bookingsWord(count)} ${count === 1 ? "is" : "are"} back on the list.` : "";
  const held =
    heldBack > 0
      ? `${bookingsWord(heldBack)} ${heldBack === 1 ? "stays" : "stay"} as no-show because the patient record was merged or deleted.`
      : "";
  return [back, held].filter(Boolean).join(" ");
}

/**
 * The "likely no-shows" bar above the Bookings-with-no-set-time section: one
 * button to mark every flagged booking as a no-show, then an Undo for exactly
 * the ones it moved. Stays mounted while the list is empty so the Undo
 * survives the refresh that empties it.
 */
export function LikelyNoShowBar({ bookings }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);

  const batch = bookings.slice(0, BULK_NO_SHOW_MAX_BOOKINGS);
  const overflow = bookings.length - batch.length;

  function markAll() {
    if (
      !confirm(
        `Mark ${bookingsWord(batch.length)} as no-show? They leave this list. You can undo right after.`,
      )
    )
      return;
    setError(null);
    start(async () => {
      const result = await markLikelyNoShowsAction(batch);
      if (!result.ok) {
        setError(result.error);
        router.refresh();
        return;
      }
      setDone({ kind: "marked", bookings: result.data.marked });
      router.refresh();
    });
  }

  function undo(marked: string[][]) {
    setError(null);
    start(async () => {
      const result = await undoLikelyNoShowsAction(marked);
      if (!result.ok) {
        setError(result.error);
        router.refresh();
        return;
      }
      setDone({ kind: "undone", count: result.data.marked.length, heldBack: result.data.heldBack ?? 0 });
      router.refresh();
    });
  }

  if (done?.kind === "marked") {
    return (
      <div
        role="status"
        className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
      >
        <span>
          Marked {bookingsWord(done.bookings.length)} as no-show.
          {error ? <span className="ml-2 font-semibold text-red-700">{error}</span> : null}
        </span>
        <span className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => undo(done.bookings)}>
            {pending ? "…" : "↶ Undo"}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setDone(null)}>
            Dismiss
          </Button>
        </span>
      </div>
    );
  }

  if (batch.length === 0) {
    if (done?.kind === "undone") {
      return (
        <p role="status" className="mb-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          {undoneText(done)}
        </p>
      );
    }
    return error ? (
      <p role="alert" className="mb-3 text-sm font-semibold text-red-700">
        {error}
      </p>
    ) : null;
  }

  return (
    <div
      role="status"
      className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <span>
        <span className="font-semibold">{bookingsWord(bookings.length)}</span>{" "}
        {bookings.length === 1 ? "has" : "have"} waited {STALE_UNTIMED_AFTER_DAYS} days or more and{" "}
        {bookings.length === 1 ? "was" : "were"} never marked arrived — likely no-shows.
        {overflow > 0 ? ` The button marks the oldest ${batch.length}; press it again for the rest.` : null}
        {done?.kind === "undone" ? ` ${undoneText(done)}` : null}
        {error ? <span className="ml-2 font-semibold text-red-700">{error}</span> : null}
      </span>
      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={markAll}>
        {pending ? "…" : `Mark ${batch.length} as no-show`}
      </Button>
    </div>
  );
}

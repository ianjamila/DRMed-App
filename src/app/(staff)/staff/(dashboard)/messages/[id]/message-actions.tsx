"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { STAFF_NOTES_MAX, type ContactMessageKind, type ContactMessageStatus } from "@/lib/contact-messages/labels";
import {
  updateMessageKindAction,
  updateMessageNotesAction,
  updateMessageStatusAction,
} from "../actions";

interface Props {
  messageId: string;
  status: ContactMessageStatus;
  kind: ContactMessageKind;
  staffNotes: string;
  firstName: string;
  hasLinkedAppointment: boolean;
  // Whether this viewer may open Quick Quote (QUICK_QUOTE_ROLES). The inbox is
  // reception + admin today, which is the same list, but the button must not
  // outlive that coincidence if either list changes.
  canQuote: boolean;
}

export function MessageActionsPanel({
  messageId,
  status,
  kind,
  staffNotes,
  hasLinkedAppointment,
  canQuote,
}: Props) {
  const router = useRouter();
  const [statusPending, startStatus] = useTransition();
  const [kindPending, startKind] = useTransition();
  const [notesPending, startNotes] = useTransition();
  const [notes, setNotes] = useState(staffNotes);
  const [notesSaved, setNotesSaved] = useState(false);

  function fireStatus(target: "new" | "replied" | "closed") {
    startStatus(async () => {
      const result = await updateMessageStatusAction(messageId, target);
      if (!result.ok) {
        alert(result.error);
        return;
      }
      router.refresh();
    });
  }

  function fireKind() {
    const next: ContactMessageKind = kind === "corporate" ? "general" : "corporate";
    startKind(async () => {
      const result = await updateMessageKindAction(messageId, next);
      if (!result.ok) {
        alert(result.error);
        return;
      }
      router.refresh();
    });
  }

  function saveNotes() {
    startNotes(async () => {
      const result = await updateMessageNotesAction(messageId, notes);
      if (!result.ok) {
        alert(result.error);
        return;
      }
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 1500);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {status === "new" ? (
          <>
            <Button type="button" size="sm" variant="success" disabled={statusPending} onClick={() => fireStatus("replied")}>
              {statusPending ? "…" : "Mark replied"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={statusPending} onClick={() => fireStatus("closed")}>
              Mark closed
            </Button>
          </>
        ) : null}

        {status === "replied" ? (
          <>
            <Button type="button" size="sm" variant="outline" disabled={statusPending} onClick={() => fireStatus("closed")}>
              Mark closed
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={statusPending} onClick={() => fireStatus("new")}>
              Reopen
            </Button>
          </>
        ) : null}

        {status === "booked" ? (
          <>
            <Button type="button" size="sm" variant="outline" disabled={statusPending} onClick={() => fireStatus("closed")}>
              Mark closed
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={statusPending} onClick={() => fireStatus("new")}>
              Reopen
            </Button>
          </>
        ) : null}

        {status === "closed" ? (
          <Button type="button" size="sm" variant="outline" disabled={statusPending} onClick={() => fireStatus("new")}>
            Reopen
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-[color:var(--color-brand-bg-mid)] pt-3">
        {status !== "booked" ? (
          <Link
            href={`/staff/appointments?from_message=${messageId}`}
            className="min-h-11 inline-flex items-center rounded-md bg-[color:var(--color-brand-navy)] px-3 py-2 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            Book appointment
          </Link>
        ) : null}
        {canQuote ? (
          <Link
            href={`/staff/quote?message=${messageId}`}
            className="min-h-11 inline-flex items-center rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
          >
            Send a quote
          </Link>
        ) : null}
      </div>

      {hasLinkedAppointment && status !== "booked" ? (
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          This message was previously linked to a booking. Booking again will replace that link.
        </p>
      ) : null}

      <div className="border-t border-[color:var(--color-brand-bg-mid)] pt-3">
        <Button type="button" size="sm" variant="outline" disabled={kindPending} onClick={fireKind}>
          {kindPending ? "…" : kind === "corporate" ? "Not a corporate lead" : "Mark as corporate lead"}
        </Button>
      </div>

      <div className="border-t border-[color:var(--color-brand-bg-mid)] pt-3">
        <label htmlFor="staff-notes" className="mb-1 block text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Staff notes
        </label>
        <textarea
          id="staff-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={STAFF_NOTES_MAX}
          rows={4}
          placeholder="Private notes for staff — not shown to the sender."
          className="w-full rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]/20"
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="text-xs text-[color:var(--color-brand-text-soft)]">
            {notes.length}/{STAFF_NOTES_MAX}
          </span>
          <Button type="button" size="sm" variant="brand" disabled={notesPending} onClick={saveNotes}>
            {notesPending ? "Saving…" : notesSaved ? "Saved ✓" : "Save notes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

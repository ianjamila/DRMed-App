"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  StableInput,
  StableSelect,
  StableTextarea,
} from "@/components/forms/stable-fields";
import {
  CHANNEL_LABELS,
  INQUIRY_CHANNELS,
  type InquiryChannel,
} from "@/lib/inquiries/labels";
import {
  createInquiryAction,
  updateInquiryAction,
  type InquiryResult,
} from "./actions";

export interface StaffOption {
  id: string;
  full_name: string;
}

export interface InquiryDefaults {
  id?: string;
  caller_name?: string;
  contact?: string;
  channel?: InquiryChannel;
  service_interest?: string | null;
  called_at?: string; // ISO string from DB
  received_by_id?: string | null;
  status?: "pending" | "confirmed" | "dropped";
  drop_reason?: string | null;
  notes?: string | null;
  linked_appointment_id?: string | null;
  linked_visit_id?: string | null;
}

interface Props {
  initial?: InquiryDefaults;
  staffOptions: StaffOption[];
  defaultReceivedById?: string;
}

// "YYYY-MM-DDTHH:MM" in Asia/Manila for use as an <input type="datetime-local">
// default value. We intentionally read the wall-clock time the call was
// received in PH, not the user's browser timezone.
function toManilaLocalInput(iso?: string): string {
  const date = iso ? new Date(iso) : new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  // hour can come back as "24" at midnight in some Node versions; normalise.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

export function InquiryForm({
  initial,
  staffOptions,
  defaultReceivedById,
}: Props) {
  const router = useRouter();
  const isEdit = Boolean(initial?.id);
  const isLocked = initial?.status === "confirmed";

  const action = isEdit
    ? updateInquiryAction.bind(null, initial!.id!)
    : createInquiryAction;
  const [state, formAction, pending] = useActionState<
    InquiryResult | null,
    FormData
  >(action, null);

  const initialStatus = isLocked
    ? "pending"
    : (initial?.status as "pending" | "dropped" | undefined) ?? "pending";
  const [status, setStatus] = useState<"pending" | "dropped">(initialStatus);

  return (
    <form action={formAction} className="grid gap-5">
      {isLocked ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-semibold">This inquiry is confirmed.</p>
          <p className="mt-1">
            {initial?.linked_appointment_id ? (
              <Link
                href={`/staff/appointments`}
                className="underline hover:no-underline"
              >
                Open the linked appointment
              </Link>
            ) : initial?.linked_visit_id ? (
              <Link
                href={`/staff/visits`}
                className="underline hover:no-underline"
              >
                Open the linked visit
              </Link>
            ) : null}
            {" "}— editing other fields below is fine; status stays confirmed.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="caller_name">Caller name</Label>
          <StableInput
            id="caller_name"
            name="caller_name"
            required
            maxLength={120}
            defaultValue={initial?.caller_name ?? ""}
            placeholder="Juan dela Cruz"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="contact">Contact</Label>
          <StableInput
            id="contact"
            name="contact"
            required
            maxLength={120}
            defaultValue={initial?.contact ?? ""}
            placeholder="0917… or email"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="channel">Channel</Label>
          <StableSelect
            id="channel"
            name="channel"
            defaultValue={initial?.channel ?? "phone"}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            {INQUIRY_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </StableSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="called_at">Called at</Label>
          <StableInput
            id="called_at"
            name="called_at"
            type="datetime-local"
            required
            defaultValue={toManilaLocalInput(initial?.called_at)}
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="received_by_id">Received by</Label>
        <StableSelect
          id="received_by_id"
          name="received_by_id"
          defaultValue={
            initial?.received_by_id ?? defaultReceivedById ?? ""
          }
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">— Unassigned —</option>
          {staffOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.full_name}
            </option>
          ))}
        </StableSelect>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="service_interest">What did they ask about?</Label>
        <StableInput
          id="service_interest"
          name="service_interest"
          maxLength={500}
          defaultValue={initial?.service_interest ?? ""}
          placeholder="e.g. CBC, doctor consultation, package promo"
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="notes">Notes</Label>
        <StableTextarea
          id="notes"
          name="notes"
          rows={3}
          maxLength={2000}
          defaultValue={initial?.notes ?? ""}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
      </div>

      {isLocked ? (
        // Status is locked to confirmed for already-booked inquiries; keep
        // the field present so the action receives a value, but hide it.
        <input type="hidden" name="status" value="pending" />
      ) : (
        <fieldset className="grid gap-3 rounded-lg border border-[color:var(--color-brand-bg-mid)] p-4">
          <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Status
          </legend>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex items-start gap-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-3 text-sm hover:border-[color:var(--color-brand-cyan)]">
              <input
                type="radio"
                name="status"
                value="pending"
                checked={status === "pending"}
                onChange={() => setStatus("pending")}
                className="mt-0.5"
              />
              <div>
                <p className="font-semibold text-[color:var(--color-brand-navy)]">
                  Pending
                </p>
                <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                  Still needs follow-up.
                </p>
              </div>
            </label>
            <label className="flex items-start gap-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-3 text-sm hover:border-[color:var(--color-brand-cyan)]">
              <input
                type="radio"
                name="status"
                value="dropped"
                checked={status === "dropped"}
                onChange={() => setStatus("dropped")}
                className="mt-0.5"
              />
              <div>
                <p className="font-semibold text-[color:var(--color-brand-navy)]">
                  Dropped
                </p>
                <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                  Won&apos;t book — reason required.
                </p>
              </div>
            </label>
          </div>

          {status === "dropped" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="drop_reason">Drop reason</Label>
              <StableTextarea
                id="drop_reason"
                name="drop_reason"
                rows={2}
                maxLength={1000}
                required
                defaultValue={initial?.drop_reason ?? ""}
                className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                placeholder="e.g. price too high, decided not to push through"
              />
            </div>
          ) : null}

          {!isEdit ? (
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              To mark this inquiry confirmed, save it first, then use{" "}
              <span className="font-semibold">Book from this inquiry</span> on
              the inquiry detail page (Phase 10.4).
            </p>
          ) : null}
        </fieldset>
      )}

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="flex gap-3">
        <Button
          type="submit"
          disabled={pending}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Saving…" : isEdit ? "Save changes" : "Create inquiry"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

"use client";

import { useActionState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  bookFromInquiryAction,
  type InquiryResult,
} from "../../actions";

interface ServiceOption {
  id: string;
  code: string;
  name: string;
  kind: string;
}

interface Props {
  inquiryId: string;
  services: ServiceOption[];
}

// Default scheduled-at: today at 9 AM Manila time (or now + 1h, whichever is
// later). Reception almost always books for "today" or "tomorrow", so a
// near-future default is friendlier than an empty field.
function defaultScheduledAt(): string {
  const now = new Date();
  const oneHour = new Date(now.getTime() + 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(oneHour);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

export function BookFromInquiryForm({ inquiryId, services }: Props) {
  const router = useRouter();
  const action = bookFromInquiryAction.bind(null, inquiryId);
  const [state, formAction, pending] = useActionState<
    InquiryResult | null,
    FormData
  >(action, null);

  const grouped = useMemo(() => {
    const byKind = new Map<string, ServiceOption[]>();
    for (const s of services) {
      const list = byKind.get(s.kind) ?? [];
      list.push(s);
      byKind.set(s.kind, list);
    }
    return Array.from(byKind.entries());
  }, [services]);

  return (
    <form action={formAction} className="grid gap-5">
      <div className="grid gap-1.5">
        <Label htmlFor="scheduled_at">Scheduled at</Label>
        <Input
          id="scheduled_at"
          name="scheduled_at"
          type="datetime-local"
          required
          defaultValue={defaultScheduledAt()}
        />
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Manila time. Reception decides which slot — closures aren&apos;t
          enforced here.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="service_id">Service (optional)</Label>
        <select
          id="service_id"
          name="service_id"
          defaultValue=""
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">— Decide on arrival —</option>
          {grouped.map(([kind, list]) => (
            <optgroup key={kind} label={kind.replace(/_/g, " ")}>
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="notes">Notes</Label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          maxLength={2000}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          placeholder="Optional context for the appointment record."
        />
      </div>

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
          {pending ? "Booking…" : "Confirm booking"}
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

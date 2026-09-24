import Link from "next/link";
import { manilaDateTime } from "@/lib/dates/manila";
import { describeConsentEvent, type ConsentHistoryEvent } from "@/lib/consent/history";

// Every consent event for the patient, newest first: each signature, website
// tick, portal acceptance and withdrawal, who signed, and who recorded it.
// The first row is the event that decides today's status (latest by seq, the
// sync trigger's order). Collapsed by default — the panel above already says
// whether consent is on file.
export function ConsentHistory({
  patientId,
  events,
}: {
  patientId: string;
  events: ConsentHistoryEvent[];
}) {
  if (events.length === 0) return null;
  return (
    <details className="mt-2 rounded-xl border border-[color:var(--color-brand-bg-mid)] px-4 py-3">
      <summary className="cursor-pointer text-sm font-bold text-[color:var(--color-brand-navy)]">
        Consent history ({events.length})
      </summary>
      <ol className="mt-3 divide-y divide-[color:var(--color-brand-bg-mid)] text-sm">
        {events.map((e, i) => {
          const line = describeConsentEvent(e);
          return (
            <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
              <div className="min-w-0">
                <p>
                  <span className="font-semibold text-[color:var(--color-brand-navy)]">{line.what}</span>
                  {line.note ? (
                    <span className="text-[color:var(--color-brand-text-mid)]"> — {line.note}</span>
                  ) : null}
                  {i === 0 ? (
                    <span className="ml-2 rounded-full bg-[color:var(--color-brand-bg)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                      Latest
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                  {manilaDateTime(e.created_at)}
                  {line.signer ? ` · ${line.signer}` : ""}
                  {` · Recorded by ${line.recordedBy}`}
                </p>
              </div>
              {line.viewable ? (
                <Link
                  href={`/staff/patients/${patientId}/consent/signed?event=${e.id}`}
                  target="_blank"
                  className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                >
                  View
                </Link>
              ) : null}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

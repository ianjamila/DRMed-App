import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { CONTACT } from "@/lib/marketing/site";
import { CancelButton } from "./cancel-button";

export const metadata = {
  title: "Cancel appointment — drmed.ph",
  // Anyone holding the URL can render this page; keep it out of search.
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ id: string }>;
}

const CANCELLABLE = new Set(["confirmed"]);

// The URL token is the appointment UUID (from the confirmation email/SMS).
// We render only non-PII fields here — service, time, status — so a leaked
// link cannot expose the patient's name or DRM-ID. The recipient already
// knows their own appointment; identifying details aren't needed for them
// to confirm the cancellation.
export default async function CancelAppointmentPage({ params }: Props) {
  const { id } = await params;
  const admin = createAdminClient();

  const { data: appt } = await admin
    .from("appointments")
    .select(
      `
        id, scheduled_at, status,
        services ( name )
      `,
    )
    .eq("id", id)
    .maybeSingle();

  if (!appt) notFound();

  const svc = Array.isArray(appt.services) ? appt.services[0] : appt.services;

  const when = new Date(appt.scheduled_at).toLocaleString("en-PH", {
    dateStyle: "long",
    timeStyle: "short",
  });

  const cancellable = CANCELLABLE.has(appt.status);
  const alreadyCancelled = appt.status === "cancelled";

  return (
    <main className="mx-auto max-w-xl px-4 py-16 sm:px-6 lg:px-8">
      <Link
        href="/"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Back to drmed.ph
      </Link>

      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        {alreadyCancelled
          ? "Already cancelled"
          : cancellable
            ? "Cancel this appointment?"
            : "Can't cancel online"}
      </h1>

      <article className="mt-6 rounded-2xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6 text-sm">
        <Field label="Service" value={svc?.name ?? "—"} />
        <Field label="When" value={when} />
        <Field
          label="Status"
          value={appt.status.replace(/_/g, " ")}
          highlight={alreadyCancelled}
        />
      </article>

      <div className="mt-6">
        {cancellable ? (
          <CancelButton appointmentId={appt.id} />
        ) : alreadyCancelled ? (
          <p className="text-sm text-[color:var(--color-brand-text-mid)]">
            This appointment is already cancelled. If you want to book again,
            head to{" "}
            <Link
              href="/schedule#book"
              className="font-bold text-[color:var(--color-brand-cyan)] hover:underline"
            >
              /schedule
            </Link>
            .
          </p>
        ) : (
          <p className="text-sm text-[color:var(--color-brand-text-mid)]">
            This appointment can no longer be cancelled from the link.
            Please call{" "}
            <a
              href={`tel:${CONTACT.phone.mobileE164}`}
              className="font-bold text-[color:var(--color-brand-cyan)] hover:underline"
            >
              {CONTACT.phone.mobile}
            </a>
            .
          </p>
        )}
      </div>

      {cancellable ? (
        <p className="mt-4 text-xs text-[color:var(--color-brand-text-soft)]">
          Cancellation is final. To reschedule, cancel here and re-book at{" "}
          <Link
            href="/schedule#book"
            className="text-[color:var(--color-brand-cyan)] hover:underline"
          >
            /schedule
          </Link>
          .
        </p>
      ) : null}
    </main>
  );
}

function Field({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-b border-[color:var(--color-brand-bg-mid)] py-2 last:border-b-0">
      <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </span>
      <span
        className={[
          mono ? "font-mono" : "",
          highlight ? "font-semibold text-red-600" : "text-[color:var(--color-brand-navy)]",
        ].join(" ")}
      >
        {value}
      </span>
    </div>
  );
}

import { channelStatusText, type ChannelStatus } from "@/lib/notifications/channel-status";

// Admin Tools › Email Alerts: whether this site can send email and text
// messages at all — the same check every send runs (channel-status.ts), so a
// "not set up" here is exactly why a patient notice or alert would be skipped.
export function NoticeChannelsPanel({ email, sms }: { email: ChannelStatus; sms: ChannelStatus }) {
  const rows = [
    { key: "email", label: "Email", used: "these alerts and patient notices", status: email },
    { key: "sms", label: "Text messages (SMS)", used: "patient notices", status: sms },
  ] as const;
  return (
    <section
      aria-labelledby="notice-channels-heading"
      className="mb-6 rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
    >
      <h2 id="notice-channels-heading" className="text-sm font-bold text-[color:var(--color-brand-navy)]">
        Sending status
      </h2>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.key}>
            <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              {r.label} <span className="font-normal normal-case tracking-normal">— used for {r.used}</span>
            </dt>
            <dd
              className={`mt-1 text-sm font-semibold ${r.status.ready ? "text-emerald-700" : "text-amber-700"}`}
            >
              {channelStatusText(r.key, r.status)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

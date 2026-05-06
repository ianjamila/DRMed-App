import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";

export const metadata = { title: "Newsletter — staff" };

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{
    sent?: string;
    delivered?: string;
    failed?: string;
  }>;
}

export default async function NewsletterAdminPage({ searchParams }: PageProps) {
  await requireAdminStaff();
  const params = await searchParams;
  const admin = createAdminClient();

  const [{ count: activeCount }, { count: totalCount }, campaignsRes] =
    await Promise.all([
      admin
        .from("subscribers")
        .select("id", { count: "exact", head: true })
        .is("unsubscribed_at", null),
      admin.from("subscribers").select("id", { count: "exact", head: true }),
      admin
        .from("newsletter_campaigns")
        .select("id, subject, sent_at, recipient_count")
        .order("sent_at", { ascending: false })
        .limit(20),
    ]);

  const campaigns = campaignsRes.data ?? [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 14 · Admin
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Newsletter
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Compose and send updates to people who opted in via the
            marketing site. Patient transactional emails are separate.
          </p>
        </div>
        <Link
          href="/staff/admin/newsletter/new"
          className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New campaign
        </Link>
      </header>

      {params.sent ? (
        <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-semibold">Campaign sent.</p>
          <p className="mt-1">
            Delivered to {params.delivered ?? "?"} subscriber
            {params.delivered === "1" ? "" : "s"}
            {params.failed && Number(params.failed) > 0
              ? ` · ${params.failed} failed`
              : ""}
            .
          </p>
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2">
        <Stat label="Active subscribers" value={activeCount ?? 0} />
        <Stat
          label="Total ever (incl. unsubscribed)"
          value={totalCount ?? 0}
        />
      </section>

      <section className="mt-8">
        <h2 className="font-[family-name:var(--font-heading)] text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Recent campaigns
        </h2>
        {campaigns.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-6 text-sm text-[color:var(--color-brand-text-soft)]">
            No campaigns sent yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-[color:var(--color-brand-bg-mid)] rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
            {campaigns.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold text-[color:var(--color-brand-navy)]">
                    {c.subject}
                  </p>
                  <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                    {c.sent_at
                      ? new Intl.DateTimeFormat("en-PH", {
                          timeZone: "Asia/Manila",
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        }).format(new Date(c.sent_at))
                      : "Draft"}
                    {c.recipient_count != null
                      ? ` · ${c.recipient_count} recipients`
                      : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-4">
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p className="mt-1 text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        {value}
      </p>
    </div>
  );
}

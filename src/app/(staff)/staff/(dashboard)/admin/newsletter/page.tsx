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
    page?: string;
    filter?: string;
  }>;
}

const PAGE_SIZE = 50;

export default async function NewsletterAdminPage({ searchParams }: PageProps) {
  await requireAdminStaff();
  const params = await searchParams;
  const admin = createAdminClient();

  const filter: "active" | "unsubscribed" | "all" =
    params.filter === "unsubscribed" || params.filter === "all"
      ? params.filter
      : "active";
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let subsQuery = admin
    .from("subscribers")
    .select(
      "id, email, source, consent_at, unsubscribed_at, unsubscribe_token",
      { count: "exact" },
    )
    .order("consent_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (filter === "active") subsQuery = subsQuery.is("unsubscribed_at", null);
  if (filter === "unsubscribed")
    subsQuery = subsQuery.not("unsubscribed_at", "is", null);

  const [
    { count: activeCount },
    { count: totalCount },
    campaignsRes,
    subsRes,
  ] = await Promise.all([
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
    subsQuery,
  ]);

  const campaigns = campaignsRes.data ?? [];
  const subscribers = subsRes.data ?? [];
  const filteredCount = subsRes.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE));

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
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="font-[family-name:var(--font-heading)] text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Subscribers ({filteredCount})
          </h2>
          <nav className="flex gap-2">
            {(["active", "unsubscribed", "all"] as const).map((f) => {
              const active = filter === f;
              const sp = new URLSearchParams();
              if (f !== "active") sp.set("filter", f);
              const qs = sp.toString();
              return (
                <Link
                  key={f}
                  href={
                    qs
                      ? `/staff/admin/newsletter?${qs}`
                      : "/staff/admin/newsletter"
                  }
                  className={`rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wider ${
                    active
                      ? "border-[color:var(--color-brand-navy)] bg-[color:var(--color-brand-navy)] text-white"
                      : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-text-mid)] hover:border-[color:var(--color-brand-cyan)]"
                  }`}
                >
                  {f === "active"
                    ? "Active"
                    : f === "unsubscribed"
                      ? "Unsubscribed"
                      : "All"}
                </Link>
              );
            })}
          </nav>
        </div>
        {subscribers.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-6 text-sm text-[color:var(--color-brand-text-soft)]">
            No subscribers in this view.
          </p>
        ) : (
          <div className="mt-3 overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Subscribed</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {subscribers.map((s) => {
                  const isActive = s.unsubscribed_at === null;
                  return (
                    <tr key={s.id} className="hover:bg-[color:var(--color-brand-bg)]">
                      <td className="px-4 py-3 font-mono text-[color:var(--color-brand-navy)]">
                        {s.email}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                        {sourceLabel(s.source)}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)] whitespace-nowrap">
                        {new Intl.DateTimeFormat("en-PH", {
                          timeZone: "Asia/Manila",
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        }).format(new Date(s.consent_at))}
                      </td>
                      <td className="px-4 py-3">
                        {isActive ? (
                          <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                            Active
                          </span>
                        ) : (
                          <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-700">
                            Unsubscribed
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 ? (
          <div className="mt-3 flex items-center justify-between text-xs text-[color:var(--color-brand-text-soft)]">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Link
                  href={pageHref(page - 1, filter)}
                  className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1 font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
                >
                  ← Newer
                </Link>
              ) : null}
              {page < totalPages ? (
                <Link
                  href={pageHref(page + 1, filter)}
                  className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1 font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
                >
                  Older →
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
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

function pageHref(
  page: number,
  filter: "active" | "unsubscribed" | "all",
): string {
  const sp = new URLSearchParams();
  if (filter !== "active") sp.set("filter", filter);
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `/staff/admin/newsletter?${qs}` : "/staff/admin/newsletter";
}

function sourceLabel(source: string): string {
  switch (source) {
    case "homepage_footer":
      return "Homepage footer";
    case "newsletter_page":
      return "/newsletter";
    case "schedule_form":
      return "Booking form";
    case "admin_added":
      return "Admin-added";
    default:
      return source;
  }
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

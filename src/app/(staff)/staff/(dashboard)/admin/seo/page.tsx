import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { SITE } from "@/lib/marketing/site";
import { allSiteUrls } from "@/lib/seo/indexnow";
import { indexNowEnabled, readPingAuditMetadata } from "@/lib/seo/indexnow-core";
import { createAdminClient } from "@/lib/supabase/admin";
import { REVIEW_AUDIT_ACTION } from "@/lib/seo/review";
import { ResubmitIndexNowButton } from "./resubmit-button";

export const metadata = { title: "Search engines (IndexNow) — staff" };
export const dynamic = "force-dynamic";

export default async function IndexNowAdminPage() {
  await requireAdminStaff();

  const base = SITE.url.replace(/\/$/, "");
  const keyLocation = `${base}/indexnow-key.txt`;
  const keyConfigured = !!process.env.INDEXNOW_KEY?.trim();
  const live = indexNowEnabled(process.env as { VERCEL_ENV?: string; INDEXNOW_KEY?: string });
  const urls = await allSiteUrls();

  const admin = createAdminClient();
  const { data: recentPings } = await admin
    .from("audit_log")
    .select("id, created_at, metadata")
    .eq("action", "seo.indexnow.ping")
    .order("created_at", { ascending: false })
    .limit(25);

  const countReviewScans = async (src: string) => {
    const { count } = await admin
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .eq("action", REVIEW_AUDIT_ACTION)
      .eq("metadata->>src", src);
    return count ?? 0;
  };
  const [scanReceipt, scanPoster, scanPortal, scanEmail] = await Promise.all([
    countReviewScans("receipt"),
    countReviewScans("poster"),
    countReviewScans("portal"),
    countReviewScans("email"),
  ]);
  // Total = sum of the four known sources, so the tiles always add up. Any
  // stray "unknown"-src scan is intentionally excluded from the displayed total.
  const scanTotal = scanReceipt + scanPoster + scanPortal + scanEmail;

  const fmtManila = (iso: string) =>
    new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <Link
          href="/staff"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Search engines (IndexNow)
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          When a doctor or service is added or changed, the affected pages are
          pushed to IndexNow so Bing (which also powers Copilot &amp; DuckDuckGo),
          Yandex and others re-crawl them quickly. Google does not use IndexNow —
          it keeps getting changes through the sitemap and Search Console.
        </p>
      </header>

      <dl className="mb-6 space-y-3 rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white p-4 text-sm">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[color:var(--color-brand-text-soft)]">Verification key</dt>
          <dd className="font-semibold">
            {keyConfigured ? "Configured" : "Not configured"}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[color:var(--color-brand-text-soft)]">Submissions active here</dt>
          <dd className="font-semibold">
            {live ? "Yes (production)" : "No — disabled outside production"}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[color:var(--color-brand-text-soft)]">Key file</dt>
          <dd className="break-all font-mono text-xs">{keyLocation}</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[color:var(--color-brand-text-soft)]">Pages in a full submit</dt>
          <dd className="font-semibold">{urls.length}</dd>
        </div>
      </dl>

      <ResubmitIndexNowButton disabled={!live} />

      <p className="mt-4 text-xs text-[color:var(--color-brand-text-soft)]">
        Use this once after setting the key, or to re-seed every page (for
        example after a content update). Every full submit is recorded in the
        audit log.
      </p>

      <section className="mt-8">
        <h2 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
          Recent IndexNow submissions
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          Every automatic ping (when a doctor or service is added or changed) and
          every full submit is recorded here.
        </p>
        {recentPings && recentPings.length > 0 ? (
          <div className="mt-3 overflow-x-auto rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-[color:var(--color-brand-bg-mid)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  <th className="px-3 py-2 font-semibold">Time</th>
                  <th className="px-3 py-2 font-semibold">Trigger</th>
                  <th className="px-3 py-2 font-semibold">URLs</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentPings.map((row) => {
                  const m = readPingAuditMetadata(row.metadata);
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-[color:var(--color-brand-bg-mid)] last:border-0"
                    >
                      <td className="whitespace-nowrap px-3 py-2">{fmtManila(row.created_at)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{m.trigger}</td>
                      <td className="px-3 py-2">{m.urlCount}</td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            m.ok ? "font-semibold text-green-700" : "font-semibold text-red-700"
                          }
                        >
                          {m.ok ? "OK" : "Failed"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] p-4 text-sm text-[color:var(--color-brand-text-soft)]">
            No IndexNow pings recorded yet.
          </p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
          Google reviews
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          A printable desk poster and the on-receipt QR both point patients to
          our Google review page. Scan counts below show which touchpoint is
          working.
        </p>

        <a
          href="/review-poster"
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
        >
          Print review poster →
        </a>

        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { label: "Receipt", value: scanReceipt },
            { label: "Poster", value: scanPoster },
            { label: "Portal", value: scanPortal },
            { label: "Email", value: scanEmail },
            { label: "Total", value: scanTotal },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white p-3 text-center"
            >
              <dt className="text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                {s.label}
              </dt>
              <dd className="mt-1 font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
        {scanTotal === 0 ? (
          <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
            No review-link scans recorded yet.
          </p>
        ) : null}
      </section>
    </div>
  );
}

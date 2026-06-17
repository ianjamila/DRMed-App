import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { SITE } from "@/lib/marketing/site";
import { allSiteUrls } from "@/lib/seo/indexnow";
import { indexNowEnabled } from "@/lib/seo/indexnow-core";
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
    </div>
  );
}

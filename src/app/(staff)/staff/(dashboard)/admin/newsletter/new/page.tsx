import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ComposeForm } from "./compose-form";

export const metadata = { title: "New campaign — staff" };

export const dynamic = "force-dynamic";

export default async function NewCampaignPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { count } = await admin
    .from("subscribers")
    .select("id", { count: "exact", head: true })
    .is("unsubscribed_at", null);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          <Link
            href="/staff/admin/newsletter"
            className="hover:text-[color:var(--color-brand-navy)]"
          >
            ← Newsletter
          </Link>
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          New campaign
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Will send to <strong>{count ?? 0}</strong> active subscriber
          {(count ?? 0) === 1 ? "" : "s"}. Markdown supported: # ## ###
          headings, **bold**, *italic*, `code`, [links](url), and bullet
          lists with - or *.
        </p>
      </header>

      <ComposeForm activeSubscriberCount={count ?? 0} />
    </div>
  );
}

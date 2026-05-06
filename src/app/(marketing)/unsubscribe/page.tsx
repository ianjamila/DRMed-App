import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ResubscribeButton } from "./resubscribe-button";

export const metadata = {
  title: "Unsubscribed — drmed.ph",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function UnsubscribePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const token = params.token?.trim() ?? "";

  if (!token || token.length < 8) {
    return <Outcome title="Invalid link" body="Your unsubscribe link is missing or malformed. Use the link from the email footer." />;
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("subscribers")
    .select("id, email, unsubscribed_at")
    .eq("unsubscribe_token", token)
    .maybeSingle();

  if (!row) {
    return <Outcome title="Already unsubscribed" body="We couldn't find an active subscription for this link — you may have already been removed." />;
  }

  // Idempotent: only flip when active. Audit-log the first-time transition
  // so the consent trail captures it. Calling the page again won't audit
  // a second time.
  let alreadyDone = row.unsubscribed_at !== null;
  if (!alreadyDone) {
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const { error } = await admin
      .from("subscribers")
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq("id", row.id);

    if (error) {
      return (
        <Outcome
          title="Something went wrong"
          body="We couldn't process the unsubscribe. Please try the link again, or email us."
        />
      );
    }

    await audit({
      actor_id: null,
      actor_type: "anonymous",
      action: "newsletter.unsubscribed",
      resource_type: "subscriber",
      resource_id: row.id,
      metadata: { email: row.email },
      ip_address: ip,
      user_agent: h.get("user-agent"),
    });
    alreadyDone = false;
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-16 sm:px-6 lg:px-8">
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
        Newsletter
      </p>
      <h1 className="mt-2 font-[family-name:var(--font-heading)] text-4xl font-extrabold text-[color:var(--color-brand-navy)]">
        {alreadyDone ? "You were already unsubscribed" : "You are unsubscribed"}
      </h1>
      <p className="mt-4 text-base text-[color:var(--color-brand-text-mid)]">
        We&apos;ve removed{" "}
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          {row.email}
        </span>{" "}
        from the drmed.ph newsletter. You won&apos;t receive any more
        marketing emails from us.
      </p>

      <p className="mt-6 text-sm text-[color:var(--color-brand-text-soft)]">
        Patient transactional emails (lab results, appointment reminders)
        are not part of the newsletter and continue normally.
      </p>

      <div className="mt-10 rounded-2xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <p className="font-semibold text-[color:var(--color-brand-navy)]">
          Changed your mind?
        </p>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          One click puts you back on the list with the same consent record
          you had before.
        </p>
        <div className="mt-4">
          <ResubscribeButton token={token} />
        </div>
      </div>
    </main>
  );
}

function Outcome({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto max-w-xl px-4 py-16 sm:px-6 lg:px-8">
      <h1 className="font-[family-name:var(--font-heading)] text-4xl font-extrabold text-[color:var(--color-brand-navy)]">
        {title}
      </h1>
      <p className="mt-4 text-base text-[color:var(--color-brand-text-mid)]">
        {body}
      </p>
    </main>
  );
}

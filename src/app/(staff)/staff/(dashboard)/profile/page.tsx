import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { ChangePasswordForm } from "./change-password-form";
import { Panel } from "@/components/ui/panel";

export const metadata = {
  title: "My profile — staff",
};

const ROLE_LABEL: Record<string, string> = {
  reception: "Reception",
  medtech: "Medical Tech",
  xray_technician: "X-ray Technician",
  pathologist: "Pathologist",
  admin: "Admin",
};

export default async function ProfilePage() {
  const session = await requireActiveStaff();

  // Mirrors the detection in /staff/mfa itself: a verified TOTP factor means
  // two-step sign-in is already on for this account.
  const supabase = await createClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const hasMfa = !!factors?.totp?.[0];

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        My profile
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        Account settings for your own staff login.
      </p>

      <Panel className="mt-6 p-6">
        <h2 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
          Account
        </h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Name
            </dt>
            <dd className="mt-0.5 text-[color:var(--color-brand-text)]">
              {session.full_name}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Email
            </dt>
            <dd className="mt-0.5 text-[color:var(--color-brand-text)]">
              {session.email}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Role
            </dt>
            <dd className="mt-0.5 text-[color:var(--color-brand-text)]">
              {ROLE_LABEL[session.role] ?? session.role}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
          To change your name, role, or PRC license, ask an Admin.
        </p>
      </Panel>

      <Panel className="mt-6 p-6">
        <h2 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
          Change password
        </h2>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Enter your current password, then a new password of at least 10
          characters.
        </p>
        <div className="mt-4">
          <ChangePasswordForm />
        </div>
      </Panel>

      <Panel className="mt-6 p-6">
        <h2 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
          Two-step sign-in
        </h2>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          {hasMfa
            ? "On — a one-time code from your authenticator app is required at sign-in."
            : "Off — add a one-time code from your phone as a second sign-in step."}
        </p>
        {/* Only the "off" state gets a link. /staff/mfa redirects straight
            back to /staff once the session is aal2, which an enrolled user
            reaching this page normally is (unless the
            FEATURE_STAFF_MFA_REQUIRED escape hatch in require-staff.ts is
            off), so a "manage" link would dead-end. There is no standalone
            management screen and no admin-side reset action yet, so the
            copy above deliberately promises neither. */}
        {hasMfa ? null : (
          <div className="mt-4">
            <Link
              href="/staff/mfa"
              className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
            >
              Set up two-step sign-in
            </Link>
          </div>
        )}
      </Panel>
    </div>
  );
}

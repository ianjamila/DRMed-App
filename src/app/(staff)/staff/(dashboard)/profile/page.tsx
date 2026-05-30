import { requireActiveStaff } from "@/lib/auth/require-staff";
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
    </div>
  );
}

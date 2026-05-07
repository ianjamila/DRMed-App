import Link from "next/link";
import { Button } from "@/components/ui/button";
import { signOutStaff } from "@/app/(staff)/staff/login/actions";
import type { StaffSession } from "@/lib/auth/require-staff";
import { StaffNav } from "./staff-nav";
import { StaffQuoteShortcut } from "./staff-quote-shortcut";
import { NotificationBell } from "./notification-bell";
import { StaffMobileNavTrigger } from "./staff-mobile-nav-trigger";

const QUOTE_ROLES: ReadonlyArray<StaffSession["role"]> = [
  "reception",
  "medtech",
  "admin",
];

interface Props {
  session: StaffSession;
  children: React.ReactNode;
}

const ROLE_LABEL: Record<StaffSession["role"], string> = {
  reception: "Reception",
  medtech: "Medical Tech",
  xray_technician: "X-ray Technician",
  pathologist: "Pathologist",
  admin: "Admin",
};

export function StaffShell({ session, children }: Props) {
  return (
    <div className="flex min-h-screen bg-[color:var(--color-brand-bg)] print:bg-white">
      <StaffQuoteShortcut
        enabledForRole={QUOTE_ROLES.includes(session.role)}
      />
      {/* Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-[color:var(--color-brand-bg-mid)] bg-white md:flex print:hidden">
        <div className="flex items-center justify-between gap-2 px-5 py-5">
          <Link
            href="/staff"
            className="font-[family-name:var(--font-heading)] text-lg font-extrabold tracking-tight text-[color:var(--color-brand-navy)]"
          >
            drmed<span className="text-[color:var(--color-brand-cyan)]">.staff</span>
          </Link>
          <NotificationBell role={session.role} />
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-6">
          <StaffNav role={session.role} />
        </div>

        <div className="border-t border-[color:var(--color-brand-bg-mid)] p-4">
          <p className="truncate text-sm font-semibold text-[color:var(--color-brand-navy)]">
            {session.full_name}
          </p>
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            {ROLE_LABEL[session.role]} · {session.email}
          </p>
          <form action={signOutStaff} className="mt-3">
            <Button
              type="submit"
              variant="outline"
              className="w-full text-xs"
            >
              Sign out
            </Button>
          </form>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile topbar — sidebar is hidden on small screens */}
        <header className="flex items-center justify-between gap-2 border-b border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-3 md:hidden print:hidden">
          <div className="flex items-center gap-2">
            <StaffMobileNavTrigger
              role={session.role}
              email={session.email}
              fullName={session.full_name}
            />
            <Link
              href="/staff"
              className="font-[family-name:var(--font-heading)] text-base font-extrabold text-[color:var(--color-brand-navy)]"
            >
              drmed
              <span className="text-[color:var(--color-brand-cyan)]">.staff</span>
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-[color:var(--color-brand-bg)] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
              {ROLE_LABEL[session.role]}
            </span>
            <NotificationBell role={session.role} />
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-x-auto">{children}</main>
      </div>
    </div>
  );
}

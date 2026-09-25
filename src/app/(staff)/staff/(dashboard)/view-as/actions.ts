"use server";

// Admin "View as role" — Server Actions. Thin: auth → core → invalidate the
// staff layout → go home. The sidebar, footer and banner are rendered by the
// shared (dashboard)/layout.tsx, which Next caches across client navigations;
// without revalidatePath("/staff", "layout") the shell would keep showing the
// previous role while the database already applies the new one (same reason
// messages/actions.ts revalidates the layout for its badge).
//
// A refused switch (non-admin, bad role) just goes home: no staff member who
// is not an admin ever sees the control, so there is nothing to explain.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { exitViewAs, startViewAs } from "@/lib/auth/view-as-switch";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { reportError } from "@/lib/observability/report-error";

export async function startViewAsAction(formData: FormData): Promise<void> {
  const session = await requireActiveStaff();
  const { ip, ua } = await ipAndAgent();
  const result = await startViewAs(session, formData.get("role"), { ip, ua });
  if (!result.ok) {
    // Silent to the admin (they land home unchanged) but never silent to us:
    // a refused or failed switch is worth a Sentry line.
    await reportError({
      scope: "view-as.start",
      error: new Error(result.error),
      metadata: { userId: session.user_id, actual_role: session.actual_role },
    });
  }
  revalidatePath("/staff", "layout");
  redirect("/staff");
}

export async function exitViewAsAction(): Promise<void> {
  const session = await requireActiveStaff();
  const { ip, ua } = await ipAndAgent();
  const result = await exitViewAs(session, { ip, ua });
  if (!result.ok) {
    await reportError({
      scope: "view-as.exit",
      error: new Error(result.error),
      metadata: { userId: session.user_id, actual_role: session.actual_role },
    });
  }
  revalidatePath("/staff", "layout");
  redirect("/staff");
}

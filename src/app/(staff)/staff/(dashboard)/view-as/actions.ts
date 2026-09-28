"use server";

// Admin "View as role" — Server Actions, in the useActionState shape so the
// picker can show a pending state and an inline error (a failed switch used
// to redirect home silently). Success invalidates the staff layout — the
// sidebar, footer and banner live in the shared (dashboard)/layout.tsx that
// Next caches across client navigations — and returns the admin to the page
// they were on when the NEW role's sidebar reaches it (safeReturnTo), else
// /staff. Only types may be exported besides the async actions ("use server").
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { exitViewAs, startViewAs } from "@/lib/auth/view-as-switch";
import { safeReturnTo } from "@/lib/auth/view-as-return";
import type { ViewAsActionState } from "@/lib/auth/view-as";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { reportError } from "@/lib/observability/report-error";

export async function startViewAsAction(
  _prev: ViewAsActionState,
  formData: FormData,
): Promise<ViewAsActionState> {
  const session = await requireActiveStaff();
  const { ip, ua } = await ipAndAgent();
  const result = await startViewAs(session, formData.get("role"), { ip, ua });
  if (!result.ok) {
    await reportError({
      scope: "view-as.start",
      error: new Error(result.error),
      metadata: { userId: session.user_id, actual_role: session.actual_role },
    });
    return { error: result.error };
  }
  revalidatePath("/staff", "layout");
  redirect(safeReturnTo(formData.get("return_to"), result.role ?? session.actual_role));
}

export async function exitViewAsAction(
  _prev: ViewAsActionState,
  formData: FormData,
): Promise<ViewAsActionState> {
  const session = await requireActiveStaff();
  const { ip, ua } = await ipAndAgent();
  const result = await exitViewAs(session, { ip, ua });
  if (!result.ok) {
    await reportError({
      scope: "view-as.exit",
      error: new Error(result.error),
      metadata: { userId: session.user_id, actual_role: session.actual_role },
    });
    return { error: result.error };
  }
  revalidatePath("/staff", "layout");
  redirect(safeReturnTo(formData.get("return_to"), session.actual_role));
}

// src/app/(staff)/staff/(dashboard)/view-as/state/route.ts
// The caller's own View-as state, for the shell-sync check in
// src/lib/auth/view-as-shell-sync.ts. requireActiveStaff() is the same
// session rule every page uses (and runs the lazy expiry cleanup), so this
// answer always matches what a full refresh would render.
import { NextResponse } from "next/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireActiveStaff();
  return NextResponse.json(
    {
      actual_role: session.actual_role,
      role: session.view_as?.role ?? null,
      until: session.view_as?.until ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

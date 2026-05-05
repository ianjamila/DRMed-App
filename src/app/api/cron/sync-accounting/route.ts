import { NextResponse } from "next/server";
import { runAccountingSync } from "@/lib/accounting/sync";

export const dynamic = "force-dynamic";
// Phase 7C cron. Vercel sets `Authorization: Bearer ${CRON_SECRET}` on its
// scheduled invocations; we verify it before doing any work.
export const runtime = "nodejs";
// 5 min budget — three small Sheets appends should finish in seconds, but
// allow headroom for the first run after a backfill rewinds the watermark.
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await runAccountingSync({ trigger: "cron" });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("accounting sync failed", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

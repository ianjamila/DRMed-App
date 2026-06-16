import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { fetchEmailLogForExport } from "@/lib/emails-log/query";
import { emailLogToCsv } from "@/lib/emails-log/csv";
import type { EmailStatus, EmailType } from "@/lib/emails-log/types";

export const dynamic = "force-dynamic";

const VALID_TYPES = new Set<EmailType>([
  "result",
  "booking",
  "reminder",
  "newsletter",
  "registration_new",
  "registration_existing",
]);
const VALID_STATUS = new Set<EmailStatus>(["sent", "failed", "no_email"]);

export async function GET(request: Request) {
  const session = await requireAdminStaff();
  const url = new URL(request.url);
  const get = (k: string) => {
    const v = url.searchParams.get(k);
    return v && v.length > 0 ? v : null;
  };

  const typeRaw = get("type");
  const statusRaw = get("status");
  const filters = {
    type:
      typeRaw && VALID_TYPES.has(typeRaw as EmailType)
        ? (typeRaw as EmailType)
        : null,
    status:
      statusRaw && VALID_STATUS.has(statusRaw as EmailStatus)
        ? (statusRaw as EmailStatus)
        : null,
    drmId: get("drm"),
    since: get("since"),
    until: get("until"),
  };

  const entries = await fetchEmailLogForExport(filters);
  const csv = emailLogToCsv(entries);

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "emails_log.exported",
    resource_type: "audit_log",
    metadata: { ...filters, rows: entries.length },
    ip_address: ip,
    user_agent: ua,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="emails-sent-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

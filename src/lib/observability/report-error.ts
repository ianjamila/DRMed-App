import "server-only";
import * as Sentry from "@sentry/nextjs";
import { audit } from "@/lib/audit/log";

interface ReportErrorInput {
  scope: string;
  error: unknown;
  metadata?: Record<string, unknown>;
}

// Server-side error reporter. Always logs to stdout (visible in Vercel
// runtime logs). In production, also forwards to Sentry (with PII scrubbing
// applied via beforeSend) and writes a low-severity audit_log row so admins
// can grep for crashes from /staff/audit without leaving the app.
export async function reportError({
  scope,
  error,
  metadata,
}: ReportErrorInput): Promise<void> {
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown");
  const stack = error instanceof Error ? error.stack : undefined;

  console.error(`[${scope}] ${message}`, { metadata, stack });

  Sentry.captureException(error, {
    tags: { scope },
    extra: metadata,
  });

  if (process.env.NODE_ENV !== "production") return;

  try {
    await audit({
      actor_id: null,
      actor_type: "system",
      action: "system.error",
      resource_type: scope,
      metadata: {
        message,
        ...(metadata ?? {}),
      },
    });
  } catch (auditErr) {
    console.error("reportError audit failed", auditErr);
  }
}

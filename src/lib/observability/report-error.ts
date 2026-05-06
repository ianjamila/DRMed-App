import "server-only";
import { audit } from "@/lib/audit/log";

interface ReportErrorInput {
  scope: string;
  error: unknown;
  metadata?: Record<string, unknown>;
}

// Minimal error reporter. Logs to server stdout always; in production also
// drops a low-severity row into audit_log so admins can grep for crashes
// from /staff/audit. Designed to be swappable for Sentry without changing
// call sites: when @sentry/nextjs is wired up, replace the body of this
// function with `Sentry.captureException(args.error, ...)`.
export async function reportError({
  scope,
  error,
  metadata,
}: ReportErrorInput): Promise<void> {
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown");
  const stack = error instanceof Error ? error.stack : undefined;

  console.error(`[${scope}] ${message}`, { metadata, stack });

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
    // Don't let observability break the app.
    console.error("reportError audit failed", auditErr);
  }
}

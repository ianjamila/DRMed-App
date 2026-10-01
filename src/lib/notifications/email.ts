import "server-only";
import { PROVIDER_TIMEOUT_MS, emailStatus } from "./channel-status";

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Sent as Resend's `Idempotency-Key`: a retry of the SAME send with the same key
   * inside Resend's 24 h window returns the first response instead of mailing again.
   * Callers that must not double-send claim the send first and never rely on this alone.
   */
  idempotencyKey?: string;
}

export type SendResult =
  | { ok: true; id: string }
  // definite: true ONLY when an HTTP response with a non-2xx status was read —
  // Resend refused the mail. false/absent means the request may have reached
  // Resend (fetch threw, or a 2xx body could not be read): the mail may exist.
  | { ok: false; kind: "error"; error: string; definite?: boolean }
  | { ok: false; kind: "skipped"; reason: string };

// Resend transactional email. We hit the REST API directly — no SDK needed.
// Returns "skipped" when env keys are missing or still the .env.example
// placeholders, so the release flow keeps working before the user wires up
// their Resend account.
export async function sendEmail(input: SendEmailInput): Promise<SendResult> {
  // M6: real keys in .env.local + `npm run dev` must never message real
  // patients. Sends require production, or an explicit local opt-in — the
  // shared check in channel-status.ts, which the Email Alerts page also shows.
  const status = emailStatus();
  if (!status.ready) return { ok: false, kind: "skipped", reason: status.reason };

  const apiKey = process.env.RESEND_API_KEY!;
  const from = process.env.RESEND_FROM_EMAIL!;
  const replyTo = process.env.RESEND_REPLY_TO_EMAIL;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      // A hung provider must not hold a sweep slot. A timeout is an AMBIGUOUS outcome
      // (the mail may have left): the Idempotency-Key makes the retry safe.
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        kind: "error",
        error: `Resend ${res.status}: ${body.slice(0, 200)}`,
        definite: true,
      };
    }
    const data = (await res.json()) as { id?: string };
    return { ok: true, id: data.id ?? "" };
  } catch (err) {
    return {
      ok: false,
      kind: "error",
      error: err instanceof Error ? err.message : "unknown",
      definite: false,
    };
  }
}

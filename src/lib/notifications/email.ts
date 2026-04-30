import "server-only";

interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; kind: "error"; error: string }
  | { ok: false; kind: "skipped"; reason: string };

// Resend transactional email. We hit the REST API directly — no SDK needed.
// Returns "skipped" when env keys are missing or still the .env.example
// placeholders, so the release flow keeps working before the user wires up
// their Resend account.
export async function sendEmail(input: SendEmailInput): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const replyTo = process.env.RESEND_REPLY_TO_EMAIL;

  if (!apiKey || apiKey.includes("your_resend") || !from) {
    return {
      ok: false,
      kind: "skipped",
      reason: "RESEND_API_KEY / RESEND_FROM_EMAIL not configured",
    };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        kind: "error",
        error: `Resend ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as { id?: string };
    return { ok: true, id: data.id ?? "" };
  } catch (err) {
    return {
      ok: false,
      kind: "error",
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

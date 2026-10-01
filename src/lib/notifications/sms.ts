import "server-only";
import { PROVIDER_TIMEOUT_MS, smsStatus } from "./channel-status";

interface SendSmsInput {
  to: string;
  message: string;
}

export type SmsResult =
  | { ok: true; id: string | number }
  | { ok: false; kind: "error"; error: string }
  | { ok: false; kind: "skipped"; reason: string };

// Semaphore — Philippine SMS provider. Skips with reason when keys aren't
// configured so the release flow doesn't break before the user signs up.
// Phone numbers are normalized to local PH format (09XXXXXXXXX) since
// Semaphore expects that, not E.164.
export async function sendSms(input: SendSmsInput): Promise<SmsResult> {
  // M6: real keys in .env.local + `npm run dev` must never message real
  // patients. Sends require production, or an explicit local opt-in — the
  // shared check in channel-status.ts, which the Email Alerts page also shows.
  const status = smsStatus();
  if (!status.ready) return { ok: false, kind: "skipped", reason: status.reason };

  const apiKey = process.env.SEMAPHORE_API_KEY!;
  const sender = process.env.SEMAPHORE_SENDER_NAME!;

  const normalized = normalizePhPhone(input.to);
  if (!normalized) {
    return { ok: false, kind: "error", error: `Invalid PH phone: ${input.to}` };
  }

  try {
    const body = new URLSearchParams({
      apikey: apiKey,
      number: normalized,
      message: input.message,
      sendername: sender,
    });
    const res = await fetch("https://api.semaphore.co/api/v4/messages", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      // A timeout is ambiguous (the text may have left): the release-notice sender
      // keeps sms_state 'unknown' and NEVER resends it.
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        kind: "error",
        error: `Semaphore ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as Array<{ message_id?: number }>;
    return { ok: true, id: data[0]?.message_id ?? "" };
  } catch (err) {
    return {
      ok: false,
      kind: "error",
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

// Accepts +639XXXXXXXXX, 639XXXXXXXXX, 09XXXXXXXXX, with or without spaces.
// Returns 09XXXXXXXXX or null when unparseable.
export function normalizePhPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (/^09\d{9}$/.test(digits)) return digits;
  if (/^639\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
  return null;
}

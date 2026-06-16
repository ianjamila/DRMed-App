import type { EmailLogEntry } from "./types";

const HEADERS = [
  "Sent (ISO)",
  "Type",
  "Status",
  "Recipient",
  "DRM-ID",
  "Email",
  "Resend ID",
  "Detail",
];

function cell(v: string | null | undefined): string {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export function emailLogToCsv(entries: EmailLogEntry[]): string {
  const lines = [HEADERS.map(cell).join(",")];
  for (const e of entries) {
    const status = e.bulk
      ? `${e.statusLabel} (${e.bulk.delivered}/${e.bulk.attempted})`
      : e.statusLabel;
    const recipient =
      e.recipientName ??
      (e.type === "newsletter"
        ? `All subscribers${e.bulk ? ` (${e.bulk.attempted})` : ""}`
        : null);
    lines.push(
      [
        cell(e.sentAt),
        cell(e.typeLabel),
        cell(status),
        cell(recipient),
        cell(e.recipientDrmId),
        cell(e.recipientEmail),
        cell(e.resendId),
        cell(e.detail),
      ].join(","),
    );
  }
  return lines.join("\r\n");
}

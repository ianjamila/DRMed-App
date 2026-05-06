import { SITE } from "@/lib/marketing/site";

interface WrapInput {
  subject: string;
  bodyHtml: string;
  unsubscribeUrl: string;
}

// Wrap rendered campaign HTML in a minimal email template + the mandatory
// unsubscribe footer. Inline styles only — most email clients still strip
// <style> blocks. Designed for narrow widths and dark/light mode legibility.
export function wrapEmailHtml(input: WrapInput): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escape(input.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a2238;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6f8;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:24px 28px 12px;border-bottom:1px solid #e6eaf0;">
                <p style="margin:0;font-weight:800;font-size:20px;color:#1a2238;letter-spacing:-0.01em;">
                  drmed<span style="color:#34c4d3;">.ph</span>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;font-size:15px;line-height:1.6;color:#334155;">
                ${input.bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px;border-top:1px solid #e6eaf0;background:#f9fafb;font-size:12px;color:#64748b;line-height:1.5;">
                <p style="margin:0 0 6px;">
                  ${escape(SITE.name)} sends occasional updates on new tests,
                  promos, and clinic announcements. Patient transactional
                  emails (lab results, appointments) are separate.
                </p>
                <p style="margin:0;">
                  <a href="${escape(input.unsubscribeUrl)}" style="color:#34c4d3;text-decoration:underline;">
                    Unsubscribe
                  </a>
                  &nbsp;·&nbsp;
                  Protected under the Philippine Data Privacy Act (RA 10173)
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

export function plainTextFromMarkdown(md: string): string {
  return md
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

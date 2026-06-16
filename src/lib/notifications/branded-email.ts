// Shared branded HTML shell for every DRMed email — transactional and
// newsletter alike. Inline styles + table layout only (email clients strip
// <style> blocks). Pure (no `server-only`) so it is unit-testable. The plain
// `text` body stays the deliverability/accessibility fallback; this adds the
// branded `html` alternative passed to sendEmail.
//
// Design approved via Email-Templates-Mockup.html: white card, logo header +
// cyan→navy accent bar, navy serif heading, tinted detail boxes, a tappable
// button, and a deep-navy contact footer (tagline, address + map, phones,
// HMO note, socials). Newsletter mode adds the mandatory unsubscribe block.

import { SITE, CONTACT, SOCIAL } from "@/lib/marketing/site";

const NAVY = "#263F91";
const NAVY_DEEP = "#1B2E6E";
const CYAN = "#08A8E2";
const INK = "#1a2537";
const SOFT = "#6b7280";
const TINT = "#f0f6fc";
const FOOT_TEXT = "#cdd8ef";
const FOOT_LINK = "#9BDCF7";
const FOOT_FAINT = "#7f8fc4";
const PAGE = "#e9eef3";

export function escapeHtml(s: string): string {
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
      default:
        return "&#39;";
    }
  });
}

// A styled body paragraph. Pass HTML — escape dynamic values with escapeHtml().
export function emailParagraph(html: string): string {
  return `<p style="margin:14px 0;font-size:15px;line-height:1.6;color:${INK};">${html}</p>`;
}

// Muted fine-print line (under the button). Pass HTML; escape dynamic values.
export function emailFinePrint(html: string): string {
  return `<p style="margin:14px 0;font-size:13px;line-height:1.6;color:${SOFT};">${html}</p>`;
}

// Tinted detail box with a cyan left border. Label/value are escaped (data).
export function emailDetailBox(
  rows: Array<{ label: string; value: string }>,
): string {
  const inner = rows
    .map(
      (r) =>
        `<span style="color:${SOFT};">${escapeHtml(r.label)}</span> &nbsp; <b style="color:${NAVY};">${escapeHtml(r.value)}</b>`,
    )
    .join("<br>");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;background:${TINT};border-left:4px solid ${CYAN};border-radius:0 8px 8px 0;"><tr><td style="padding:16px 18px;font-size:14px;line-height:1.9;color:${INK};">${inner}</td></tr></table>`;
}

// Large dashed callout — used for the DRM-ID on registration emails.
export function emailHighlight(label: string, value: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;"><tr><td align="center" style="padding:22px;background:${TINT};border:1px dashed ${CYAN};border-radius:10px;"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${SOFT};">${escapeHtml(label)}</div><div style="font-size:30px;font-weight:800;color:${NAVY};letter-spacing:.06em;margin-top:4px;">${escapeHtml(value)}</div></td></tr></table>`;
}

// Bulletproof-enough button (table + bgcolor + padded anchor). Outlook shows a
// solid rectangle; modern clients show the rounded brand button.
export function emailButton(
  label: string,
  href: string,
  color: "cyan" | "navy" = "cyan",
): string {
  const bg = color === "navy" ? NAVY : CYAN;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px;"><tr><td align="center" bgcolor="${bg}" style="border-radius:8px;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 30px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;background:${bg};">${label}</a></td></tr></table>`;
}

export interface EmailShellOptions {
  // Optional navy serif heading shown above the content.
  heading?: string;
  // The inner body HTML (build it with the helpers above, or a rendered
  // markdown string for the newsletter).
  contentHtml: string;
  // Transactional "why you received this" line (rendered faint in the footer).
  receivedNote?: string;
  // When present → newsletter footer: adds the marketing note, an unsubscribe
  // link, and the RA 10173 line (legally required for marketing email).
  unsubscribeUrl?: string;
}

function footerHtml(opts: EmailShellOptions): string {
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    CONTACT.address.full,
  )}`;
  const address = `4/F ${CONTACT.address.line2}, ${CONTACT.address.city}`;
  const social = `<a href="${SOCIAL.facebook}" style="color:${FOOT_LINK};text-decoration:none;">Facebook</a> &nbsp;·&nbsp; <a href="${SOCIAL.instagram}" style="color:${FOOT_LINK};text-decoration:none;">Instagram</a> &nbsp;·&nbsp; <a href="${SOCIAL.messenger}" style="color:${FOOT_LINK};text-decoration:none;">Messenger</a>`;

  let extra = "";
  if (opts.unsubscribeUrl) {
    extra = `<p style="margin:14px 0 6px;font-size:11px;line-height:1.5;color:${FOOT_FAINT};">${escapeHtml(
      SITE.name,
    )} sends occasional updates on new tests, promos, and clinic announcements. Patient transactional emails (lab results, appointments) are separate.</p><p style="margin:0;font-size:11px;color:${FOOT_LINK};"><a href="${escapeHtml(
      opts.unsubscribeUrl,
    )}" style="color:${FOOT_LINK};text-decoration:underline;">Unsubscribe</a> &nbsp;·&nbsp; Protected under the Philippine Data Privacy Act (RA 10173)</p>`;
  } else if (opts.receivedNote) {
    extra = `<p style="margin:12px 0 0;font-size:11px;line-height:1.5;color:${FOOT_FAINT};">${escapeHtml(
      opts.receivedNote,
    )} This mailbox is not monitored — reply to ${CONTACT.email} or call us for help.</p>`;
  }

  return `<tr><td style="padding:24px 36px;background:${NAVY_DEEP};">
        <p style="margin:0 0 2px;font-size:14px;font-weight:700;color:#ffffff;">${escapeHtml(SITE.name)}</p>
        <p style="margin:0 0 12px;font-size:12px;font-style:italic;color:${FOOT_LINK};">${escapeHtml(SITE.tagline)}</p>
        <p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:${FOOT_TEXT};">${escapeHtml(address)} &nbsp;·&nbsp; <a href="${mapsUrl}" style="color:${FOOT_LINK};text-decoration:underline;">Get directions</a></p>
        <p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:${FOOT_TEXT};">${escapeHtml(CONTACT.hours)} &nbsp;·&nbsp; ${escapeHtml(CONTACT.phone.mobile)} &nbsp;·&nbsp; ${escapeHtml(CONTACT.phone.landline)}</p>
        <p style="margin:0 0 12px;font-size:12px;line-height:1.6;color:${FOOT_TEXT};">&#10003; We accept 10 major HMO providers — bring your card on your visit.</p>
        <p style="margin:0;font-size:12px;color:${FOOT_LINK};">${social}</p>
        ${extra}
      </td></tr>`;
}

export function renderEmailShell(opts: EmailShellOptions): string {
  const logo = `${SITE.url.replace(/\/$/, "")}/logo.png`;
  const heading = opts.heading
    ? `<h2 style="margin:0 0 4px;font-size:22px;color:${NAVY};font-family:Georgia,'Times New Roman',serif;">${escapeHtml(opts.heading)}</h2>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(opts.heading ?? SITE.name)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(27,46,110,.10);">
    <tr><td align="center" style="padding:28px 24px 18px;background:#ffffff;">
      <img src="${logo}" alt="${escapeHtml(SITE.name)}" width="210" style="display:block;width:210px;max-width:62%;height:auto;" />
    </td></tr>
    <tr><td style="height:4px;background:${CYAN};background:linear-gradient(90deg,${CYAN},${NAVY});font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td style="padding:30px 36px 8px;">
      ${heading}
      ${opts.contentHtml}
    </td></tr>
    ${footerHtml(opts)}
  </table>
</td></tr></table>
</body>
</html>`;
}

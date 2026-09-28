import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Guard: every Messenger link and every tel: link on the public marketing
// site must route through TrackedMessengerLink / TrackedTelLink, so it fires
// its Google Ads + Meta Pixel conversion (see ./tracked-messenger-link.tsx,
// ./tracked-tel-link.tsx, docs/decisions/0004-google-ads-conversion-tracking.md).
// A plain <a href={SOCIAL.messenger}> or <a href="tel:..."> — or a PillLink
// pointed at either — silently drops that visitor's conversion with no error
// anywhere. That's exactly what PromoHero, PromoClosingCta and the contact
// page's "Connect With Us" / "Call now" links did before this test existed.
//
// This is a source scan, not a JSX parser: it finds the raw href patterns,
// then checks whether each occurrence sits inside a <TrackedMessengerLink> or
// <TrackedTelLink> OPENING TAG (safe — that's the component receiving the
// prop it forwards to its own internal <a>) versus anywhere else (a
// violation, however it's spelled — a bare <a>, a PillLink, a helper).

const ROOTS = [
  join(process.cwd(), "src", "app", "(marketing)"),
  join(process.cwd(), "src", "components", "marketing"),
];

const TRACKED_TAGS = ["TrackedMessengerLink", "TrackedTelLink"];

// Deliberate exceptions:
// - tracked-messenger-link.tsx / tracked-tel-link.tsx are the components
//   THEMSELVES — their own doc comments describe the plain <a> they replace
//   ("Drop-in replacement for a plain <a href=\"tel:...\">"), which is prose,
//   not a live link, and their actual <a> forwards the `href` prop rather
//   than writing "tel:"/SOCIAL.messenger literally.
// - booking-paused-notice.tsx renders PLAIN tel:/Messenger links (no tracking
//   at all) for its "portal" and "preview" contexts, because the patient
//   portal and the staff admin preview must never load marketing analytics
//   (RA 10173) — see that file's own top-of-file comment. Its "public"
//   context (used by /schedule and /portal/book's public sibling) still
//   renders the tracked components like every other marketing surface.
const ALLOWLIST = new Set<string>([
  "tracked-messenger-link.tsx",
  "tracked-tel-link.tsx",
  "booking-paused-notice.tsx",
]);

const VIOLATION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'href="tel:', re: /href\s*=\s*"tel:/g },
  { name: "href={`tel:", re: /href\s*=\s*\{`tel:/g },
  { name: "href={telHref(", re: /href\s*=\s*\{telHref\(/g },
  { name: "href={SOCIAL.messenger}", re: /href\s*=\s*\{SOCIAL\.messenger\}/g },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.includes(".test.")
    ) {
      out.push(full);
    }
  }
  return out;
}

// Ranges (char offsets) covered by a <TrackedMessengerLink ...> or
// <TrackedTelLink ...> opening tag — from the `<` to its closing `>`. None of
// this codebase's usages put a literal `>` inside an attribute value, so the
// first `>` after the tag name is that tag's own close.
function safeRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const tag of TRACKED_TAGS) {
    const openRe = new RegExp(`<${tag}\\b`, "g");
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(src))) {
      const end = src.indexOf(">", m.index);
      if (end !== -1) ranges.push([m.index, end]);
    }
  }
  return ranges;
}

function insideSafeRange(idx: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => idx >= s && idx <= e);
}

const files = ROOTS.flatMap((root) => walk(root));

describe("marketing contact-link tracking coverage", () => {
  it("has marketing files to scan (guard against a bad glob)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("routes every Messenger link and tel: link through the tracked components", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const base = file.split(sep).pop()!;
      if (ALLOWLIST.has(base)) continue;
      const src = readFileSync(file, "utf8");
      const ranges = safeRanges(src);
      for (const { name, re } of VIOLATION_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
          if (!insideSafeRange(m.index, ranges)) {
            const line = src.slice(0, m.index).split("\n").length;
            offenders.push(`${relative(process.cwd(), file)}:${line} (${name})`);
          }
        }
      }
    }
    expect(
      offenders,
      "These marketing files have a raw Messenger/tel: link that bypasses " +
        "TrackedMessengerLink/TrackedTelLink, so it fires no Google Ads or " +
        "Meta Pixel conversion. Wrap it in the tracked component (matching " +
        "PillLink's look with pillLinkClassName if it's styled as a pill), " +
        "or add the file to ALLOWLIST above with a comment justifying why it " +
        "must stay plain.",
    ).toEqual([]);
  });
});

// Guards the fix for the single most expensive defect found in the 2026-09-16
// performance audit: realtime WAL filtering was 85.4% of ALL production database
// time — 10.27M ms across 1.3M calls, individual calls peaking at 14.5 seconds.
//
// The cause was one line. `subscriptions` sat in RealtimeRefresher's useEffect
// dependency array while every call site passed an inline array literal:
//
//     subscriptions={[{ table: "visits", event: "UPDATE" }]}   // new object every render
//
// A literal is a new object identity on every render, so every router.refresh()
// tore the channel down and rebuilt it under a fresh random name — and the refresh
// was itself triggered by the subscription it destroyed. It fed itself.
//
// These are source-level assertions rather than a browser check on purpose. The
// real-world symptom (one websocket join instead of one per refresh) can only be
// watched once, by hand, and rots the moment someone edits a call site. The
// invariants below run in `npm test` forever. They are the same shape as the
// repo's other static guards (query-surfaces, date-render-surfaces, manila-usage).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(__dirname, "../../app");
const COMPONENT = join(__dirname, "realtime-refresher.tsx");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const callSites = walk(APP_DIR).filter((f) =>
  readFileSync(f, "utf8").includes("<RealtimeRefresher"),
);

describe("RealtimeRefresher call sites", () => {
  it("finds the expected call sites (fails loudly if the component moved)", () => {
    // If this drops to zero the rest of the suite would pass vacuously.
    expect(callSites.length).toBeGreaterThanOrEqual(6);
  });

  it.each(callSites.map((f) => [f.slice(f.indexOf("src/")), f]))(
    "%s passes a stable reference, not an inline array literal",
    (_label, file) => {
      const src = readFileSync(file, "utf8");
      // `subscriptions={[` — an inline literal — is the whole bug.
      const inline = /subscriptions=\{\s*\[/.test(src);
      expect(
        inline,
        "Hoist the array to a module-level const. An inline literal is a new " +
          "object on every render, which rebuilds the realtime channel on every " +
          "refresh. See src/components/staff/realtime-refresher.tsx.",
      ).toBe(false);
    },
  );
});

/**
 * Strip comments before asserting on code. The component's comments legitimately
 * quote the patterns these tests ban — explaining what was removed and why — and a
 * first draft of this file failed on that prose rather than on any real code.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("RealtimeRefresher component", () => {
  const src = stripComments(readFileSync(COMPONENT, "utf8"));

  it("does not key its effect on the subscriptions array identity", () => {
    // Find the effect's dependency array and assert it names the serialized key
    // rather than the array itself.
    const deps = [...src.matchAll(/\}\s*,\s*\[([^\]]*)\]\s*\)/g)].map((m) => m[1]);
    const subscriptionDeps = deps.filter((d) => /subscription/i.test(d));
    expect(subscriptionDeps.length).toBeGreaterThan(0);
    for (const d of subscriptionDeps) {
      expect(
        /\bsubscriptions\b/.test(d),
        `dependency array [${d.trim()}] names \`subscriptions\` directly. Key on a ` +
          "serialized form so structurally-equal lists compare equal.",
      ).toBe(false);
    }
  });

  it("uses a stable channel name, not a per-mount random suffix", () => {
    expect(
      /Math\.random\(\)/.test(src),
      "The random channel-name suffix was a workaround for the re-mount churn " +
        "this fix removes. A fresh name per mount is a brand-new subscription " +
        "the realtime server must register and RLS-check from scratch.",
    ).toBe(false);
  });

  it("does not refresh a backgrounded tab", () => {
    // A hidden tab re-rendering the whole server page costs a full RSC round-trip
    // and helps nobody. Asserted on comment-stripped source, so a mention in prose
    // cannot satisfy it.
    expect(src).toMatch(/visibilityState/);
  });
});

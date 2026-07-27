/**
 * Sends a single test event to the Meta Conversions API and reports exactly
 * what Meta said back. Use it to prove the server leg is wired up BEFORE
 * hunting through Events Manager, and to check browser/server de-duplication.
 *
 *   npm run verify:meta-capi -- --event Schedule
 *   npm run verify:meta-capi -- --event Schedule --event-id <id-from-the-browser>
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_META_PIXEL_ID   the pixel/dataset id
 *   META_CAPI_ACCESS_TOKEN      Events Manager -> your pixel -> Settings ->
 *                               Conversions API -> Generate access token
 *   META_TEST_EVENT_CODE        Events Manager -> your pixel -> Test Events tab
 *
 * META_TEST_EVENT_CODE is REQUIRED here on purpose: this script must never be
 * able to inject a fake conversion into real campaign reporting.
 *
 * Nothing here touches the database, and it deliberately sends no personal
 * data — see docs/decisions/meta-pixel-data-handling.md.
 */

// No database guard here — this script never touches Supabase. It still goes
// through the shared loader so it picks up META_* from the same env files as
// everything else in scripts/.
import "./lib/load-env";

const GRAPH_API_VERSION = "v21.0";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
const testEventCode = process.env.META_TEST_EVENT_CODE;

const missing = [
  !pixelId && "NEXT_PUBLIC_META_PIXEL_ID",
  !accessToken && "META_CAPI_ACCESS_TOKEN",
  !testEventCode && "META_TEST_EVENT_CODE",
].filter(Boolean);

if (missing.length > 0) {
  console.error(`Missing in .env.local: ${missing.join(", ")}`);
  console.error("See the header of this file for where each value comes from.");
  process.exit(1);
}

const eventName = arg("event") ?? "Schedule";
// Reuse an id from a real browser event to prove de-duplication; otherwise
// mint one so the script is useful standalone.
const eventId = arg("event-id") ?? `verify-${Date.now().toString(36)}`;
const suppliedEventId = arg("event-id") !== undefined;

// Meta rejects an event whose user_data carries no customer-information
// parameter at all (code 100 / subcode 2804050). The app satisfies this with
// the real visitor's _fbp/_fbc cookies plus IP and user agent; this script has
// no browser context, so it sends a SYNTHETIC browser id in Meta's _fbp format
// (fb.1.<ms>.<random>) alongside a placeholder IP and user agent.
//
// Nothing here identifies a real person — that is the point. It exercises the
// transport, not the matching, and keeps the script compliant with
// docs/decisions/0003-meta-pixel-data-handling.md.
const syntheticFbp = `fb.1.${Date.now()}.${Math.floor(Math.random() * 9e9) + 1e9}`;

const body = {
  data: [
    {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      event_source_url: "https://drmed.ph/schedule",
      action_source: "website",
      user_data: {
        fbp: syntheticFbp,
        client_ip_address: "203.0.113.10", // TEST-NET-3, reserved for documentation
        client_user_agent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      },
      custom_data: { content_name: "verification_script", content_category: "booking" },
    },
  ],
  test_event_code: testEventCode,
};

async function main() {
  console.log(`→ ${eventName}  event_id=${eventId}  test_event_code=${testEventCode}`);

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(accessToken!)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  const text = await res.text();
  console.log(`← HTTP ${res.status}`);
  console.log(text);

  if (!res.ok) {
    console.error("\nFAILED. Common causes:");
    console.error("  190 / OAuth        → token expired or wrong pixel");
    console.error("  200 with 0 events  → test_event_code not recognised");
    process.exit(1);
  }

  console.log("\nOK. Now open Events Manager → your pixel → Test Events.");
  if (suppliedEventId) {
    console.log(
      `Look for ONE '${eventName}' row, not two. If the browser event with\n` +
        `event_id=${eventId} also arrived, Meta should show it as de-duplicated\n` +
        `(Server + Browser on a single row). Two separate rows means de-dup failed.`,
    );
  } else {
    console.log(
      `Look for a '${eventName}' row marked Server. To test de-duplication,\n` +
        `re-run with --event-id set to an id taken from a real browser event.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

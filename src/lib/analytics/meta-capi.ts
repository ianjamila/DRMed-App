import "server-only";
import { cookies } from "next/headers";
import { after } from "next/server";
import { reportError } from "@/lib/observability/report-error";
import { hasAdvertisingConsentServer } from "./consent-server";

const GRAPH_API_VERSION = "v21.0";

export interface MetaCapiUserData {
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
}

export interface SendMetaCapiEventInput {
  eventName: string;
  // Pass the SAME id used in the matching browser metaTrack() call for this
  // action so Meta de-dupes the two events instead of double-counting.
  eventId: string;
  eventSourceUrl: string;
  actionSource?: "website";
  customData?: Record<string, unknown>;
  userData?: MetaCapiUserData;
}

// Server-side Meta Conversions API call. No-ops silently if
// META_CAPI_ACCESS_TOKEN isn't configured (Events Manager → Data Sources →
// [pixel] → Settings → Conversions API → Generate access token) — booking,
// contact, and registration flows must never fail because a marketing
// credential is missing. Never throws; failures are logged via reportError.
//
// The Graph API round trip is deferred with next/server's `after()` so a slow
// or unreachable Meta endpoint never delays the patient's booking/contact/
// registration response. Everything that needs request scope (cookies,
// event_time) is captured BEFORE scheduling, so the deferred callback is a
// pure fetch. Callers may still `await` this — it now returns as soon as the
// payload is built.
export async function sendMetaCapiEvent(input: SendMetaCapiEventInput): Promise<void> {
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  if (!pixelId || !accessToken) return;

  // Opt-in consent gate. Without this the server leg would keep reporting
  // conversions for visitors who declined the banner — the browser Pixel is
  // gated in the UI, but a Server Action runs regardless of what mounted.
  if (!(await hasAdvertisingConsentServer())) return;

  const cookieStore = await cookies();
  const fbp = cookieStore.get("_fbp")?.value;
  const fbc = cookieStore.get("_fbc")?.value;
  const testEventCode = process.env.META_TEST_EVENT_CODE;

  const body: Record<string, unknown> = {
    data: [
      {
        event_name: input.eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: input.eventId,
        event_source_url: input.eventSourceUrl,
        action_source: input.actionSource ?? "website",
        user_data: {
          ...(fbp ? { fbp } : {}),
          ...(fbc ? { fbc } : {}),
          ...(input.userData?.clientIpAddress
            ? { client_ip_address: input.userData.clientIpAddress }
            : {}),
          ...(input.userData?.clientUserAgent
            ? { client_user_agent: input.userData.clientUserAgent }
            : {}),
        },
        ...(input.customData ? { custom_data: input.customData } : {}),
      },
    ],
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
  };

  const deliver = async () => {
    try {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        await reportError({
          scope: "meta-capi",
          error: new Error(`Meta CAPI responded ${res.status}`),
          metadata: { eventName: input.eventName, detail: detail.slice(0, 500) },
        });
      }
    } catch (err) {
      await reportError({
        scope: "meta-capi",
        error: err,
        metadata: { eventName: input.eventName },
      });
    }
  };

  // `after()` throws when called outside a request/prerender scope. That should
  // never happen from our Server Actions, but this module's contract is "never
  // throws" — a marketing call must not be able to fail a booking — so fall
  // back to fire-and-forget rather than letting it propagate.
  try {
    after(deliver);
  } catch {
    void deliver();
  }
}

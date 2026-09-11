"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

// Google's four-colour "G". Their brand guidance puts the colour mark on a
// white surface, so on this navy button it sits in a white tile rather than
// straight on the fill. aria-hidden: the button text already says "Google".
function GoogleMark() {
  return (
    <span
      aria-hidden="true"
      className="flex size-5 items-center justify-center rounded-sm bg-white"
    >
      <svg viewBox="0 0 48 48" className="size-3.5">
        <path
          fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        />
        <path
          fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.97-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        />
      </svg>
    </span>
  );
}

export function GoogleSignInButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If the user presses back from Google's account chooser or consent
  // screen, the browser can restore this page from bfcache with React
  // state intact — including `pending: true` from just before the
  // navigation to Google. Without this, the primary sign-in button would
  // render as permanently disabled ("Redirecting to Google…").
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  async function signIn() {
    setPending(true);
    setError(null);
    const supabase = createClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    // On success the browser has already navigated away, so reaching here at
    // all means the redirect never started.
    if (oauthError) {
      setError("Could not reach Google. Try again, or sign in with a password.");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Primary variant on purpose: Google is the main route in and the
          password form below the divider is the fallback. Leaving both as
          "outline" would make the two look interchangeable. */}
      <Button
        type="button"
        onClick={signIn}
        disabled={pending}
        className="w-full gap-2"
      >
        <GoogleMark />
        {pending ? "Redirecting to Google…" : "Continue with Google"}
      </Button>
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

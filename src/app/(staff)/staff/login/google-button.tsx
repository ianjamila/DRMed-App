"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

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
        className="w-full"
      >
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

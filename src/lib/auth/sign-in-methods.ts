export interface SignInSummary {
  google: boolean;
  password: boolean;
}

/** The identity shape this needs — a subset of GoTrue's UserIdentity. */
interface IdentityLike {
  provider?: string | null;
}

// Which routes an auth user can actually sign in through, derived from their
// GoTrue identity rows: `email` is the password identity, `google` the OAuth
// one. Providers we don't model are ignored rather than guessed at, so adding
// a provider later can never silently render as "password".
//
// Pure on purpose: the staff users list reads identities from
// admin.auth.admin.listUsers(), which is awkward to stand up in a test.
export function summarizeSignInMethods(
  identities: ReadonlyArray<IdentityLike> | null | undefined,
): SignInSummary {
  let google = false;
  let password = false;

  for (const identity of identities ?? []) {
    if (identity?.provider === "google") google = true;
    if (identity?.provider === "email") password = true;
  }

  return { google, password };
}

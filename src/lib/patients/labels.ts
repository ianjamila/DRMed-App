/**
 * "Pre-registered" badge — a patient created ahead of their first visit
 * (e.g. via a registration link) whose identity hasn't been verified at the
 * counter yet.
 *
 * The badge was written four different ways across the app, all sharing the
 * same amber styling. The call sites have genuinely different space budgets
 * — a micro-badge in an admin report row, a patients table cell, an inline
 * search-result row inside the new-appointment sheet, and the patient
 * detail header, which has room for the full sentence. Rather than force
 * one string on all four and make some of them wrap, this exports the one
 * bare noun plus its three longer variants, so every call site still points
 * at a single source of truth.
 *
 * `PRE_REGISTERED_LABEL` is the canonical bare noun; the suffixed variants
 * add the call-to-action at increasing length. Call sites keep their own
 * layout classes and share only the colour pair.
 */

/** Canonical bare noun. Use where the surrounding UI supplies the context. */
export const PRE_REGISTERED_LABEL = "Pre-registered";

/** Shortest form, for a badge squeezed in beside a name. */
export const PRE_REGISTERED_LABEL_SHORT = "Pre-reg";

/** Bare noun plus the action, for a list row with room to spare. */
export const PRE_REGISTERED_LABEL_VERIFY = "Pre-registered · verify";

/** Full sentence, for a page header. */
export const PRE_REGISTERED_LABEL_FULL =
  "Pre-registered — verify identity at counter";

/** The amber colour pair every pre-registered badge shares. */
export const PRE_REGISTERED_BADGE_CLASS = "bg-amber-100 text-amber-900";

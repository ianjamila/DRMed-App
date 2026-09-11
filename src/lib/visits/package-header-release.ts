/**
 * Pure predicate for the admin "Release package header" escape hatch.
 *
 * Package headers normally flip from `ready_for_release` to `released`
 * automatically once every component has gone terminal on a money-settled
 * visit — migration 0109's Leg A trigger
 * (`fn_release_header_when_components_done`). When that trigger doesn't fire
 * (the scenario another migration fixes at the DB layer), the header can be
 * stuck at `ready_for_release` forever with no UI path to release it by
 * hand — `ReleaseAllButton` only ever targets components, and headers never
 * reach `TestAction`.
 *
 * This mirrors the trigger's own condition exactly so the manual button only
 * ever appears (and the server action only ever succeeds) in the same state
 * the trigger would have acted on:
 *   - the header itself must be `ready_for_release`
 *   - every component must be terminal (`released` or `cancelled`)
 *   - at least one component must actually be `released` — an
 *     all-cancelled package must NOT release; that's the cascade-cancel
 *     path (migration 0040), not this one.
 *
 * This is UX/authorization-scoping only. The actual write still goes through
 * `enforce_payment_before_release` (migration 0133) like every other
 * release — this predicate never substitutes for that trigger.
 */

export interface PackageHeaderForRelease {
  status: string;
}

export interface PackageComponentForRelease {
  status: string;
}

export function canManuallyReleasePackageHeader(
  header: PackageHeaderForRelease,
  components: readonly PackageComponentForRelease[],
): boolean {
  if (header.status !== "ready_for_release") return false;
  if (components.length === 0) return false;

  const pending = components.filter(
    (c) => c.status !== "released" && c.status !== "cancelled",
  ).length;
  const released = components.filter((c) => c.status === "released").length;

  return pending === 0 && released > 0;
}

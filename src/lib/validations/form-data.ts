// Public Server Actions (booking, registration, contact, newsletter, patient
// login, ID recovery) can be invoked by anyone who lifts the action ID from the
// page bundle. A scanner that posts a body which does not decode to FormData
// reaches the action with `formData` undefined, so the first `formData.get()`
// throws a TypeError. That surfaces as a 500 and a new Sentry event for every
// request. Guard each public action with this check and return an ordinary error
// result instead.

export const MALFORMED_FORM_ERROR = "We couldn't read that form. Please refresh the page and try again.";

export function isFormData(value: unknown): value is FormData {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

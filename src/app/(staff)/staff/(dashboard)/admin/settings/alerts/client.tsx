"use client";

// One card per alert. Client because every control here writes: the on/off
// switch, the per-staff switches, "Reset to defaults", the extra-address
// list + add form, and "Send a test". Props are serializable data only (this
// renders inside a server page).

import { useState, useTransition } from "react";
import { Panel } from "@/components/ui/panel";
import { Switch } from "@/components/ui/switch";
import { manilaDateTime } from "@/lib/dates/manila";
import { roleLabel } from "@/lib/staff/user-filters";
import {
  computeAlertRecipients,
  isStaffSubscribed,
  ALERT_EXTRA_EMAIL_MAX,
  type StaffAlertKey,
  type AlertStaffMember,
} from "@/lib/notifications/staff-alerts";
import { isValidAlertEmail } from "@/lib/notifications/alert-email";
import type { AlertLastSentSummary } from "@/lib/notifications/alert-last-sent";
import {
  setAlertEnabledAction,
  setStaffAlertAction,
  resetStaffAlertDefaultsAction,
  addAlertEmailAction,
  setAlertEmailSubscribedAction,
  removeAlertEmailAction,
  sendTestAlertAction,
} from "./actions";

export interface AlertStaffMemberProp extends AlertStaffMember {
  fullName: string;
}

export interface AlertExtraAddressProp {
  id: string;
  email: string;
  subscribed: boolean;
}

export interface AlertLastSentProp extends AlertLastSentSummary {
  at: string; // ISO timestamptz — formatted client-side with manilaDateTime
}

export interface AlertCardProps {
  alertKey: StaffAlertKey;
  label: string;
  description: string;
  defaultRoles: ReadonlyArray<AlertStaffMember["role"]>;
  initialEnabled: boolean;
  staff: ReadonlyArray<AlertStaffMemberProp>;
  initialOverrides: Record<string, boolean>;
  initialExtras: ReadonlyArray<AlertExtraAddressProp>;
  lastSent: AlertLastSentProp | null;
}

export function AlertCard({
  alertKey,
  label,
  description,
  defaultRoles,
  initialEnabled,
  staff,
  initialOverrides,
  initialExtras,
  lastSent,
}: AlertCardProps) {
  const [, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [overrides, setOverrides] = useState<Record<string, boolean>>(initialOverrides);
  const [extras, setExtras] = useState<AlertExtraAddressProp[]>([...initialExtras]);
  const [savingRow, setSavingRow] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [emailDraft, setEmailDraft] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [addingEmail, setAddingEmail] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const overridesMap = new Map(Object.entries(overrides));
  const recipients = computeAlertRecipients({
    enabled,
    defaultRoles,
    staff,
    overrides: overridesMap,
    extras,
  });
  const busy = savingRow !== null;

  function toggleEnabled(next: boolean) {
    setError(null);
    const prev = enabled;
    setEnabled(next);
    setSavingRow("__enabled__");
    startTransition(async () => {
      const res = await setAlertEnabledAction(alertKey, next);
      setSavingRow(null);
      if (!res.ok) {
        setEnabled(prev);
        setError(res.error);
      }
    });
  }

  function toggleStaff(staffId: string, next: boolean) {
    setError(null);
    const hadOverride = Object.prototype.hasOwnProperty.call(overrides, staffId);
    const prevValue = overrides[staffId];
    setOverrides((o) => ({ ...o, [staffId]: next }));
    setSavingRow(staffId);
    startTransition(async () => {
      const res = await setStaffAlertAction(alertKey, staffId, next);
      setSavingRow(null);
      if (!res.ok) {
        setOverrides((o) => {
          const copy = { ...o };
          if (hadOverride) copy[staffId] = prevValue;
          else delete copy[staffId];
          return copy;
        });
        setError(res.error);
      }
    });
  }

  function resetDefaults() {
    setError(null);
    setSavingRow("__reset__");
    startTransition(async () => {
      const res = await resetStaffAlertDefaultsAction(alertKey);
      setSavingRow(null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOverrides({});
      setResetting(false);
    });
  }

  function addEmail() {
    setEmailError(null);
    const trimmed = emailDraft.trim();
    if (!isValidAlertEmail(trimmed)) {
      setEmailError("Enter a valid email address.");
      return;
    }
    if (extras.some((x) => x.email.toLowerCase() === trimmed.toLowerCase())) {
      setEmailError("That address is already on this alert.");
      return;
    }
    setAddingEmail(true);
    startTransition(async () => {
      const res = await addAlertEmailAction(alertKey, trimmed);
      setAddingEmail(false);
      if (!res.ok) {
        setEmailError(res.error);
        return;
      }
      setExtras((prev) => [...prev, { id: res.data.id, email: trimmed, subscribed: true }]);
      setEmailDraft("");
    });
  }

  function toggleExtra(id: string, next: boolean) {
    setError(null);
    const prev = extras;
    setExtras((list) => list.map((x) => (x.id === id ? { ...x, subscribed: next } : x)));
    setSavingRow(id);
    startTransition(async () => {
      const res = await setAlertEmailSubscribedAction(id, next);
      setSavingRow(null);
      if (!res.ok) {
        setExtras(prev);
        setError(res.error);
      }
    });
  }

  function removeExtra(id: string) {
    setError(null);
    const prev = extras;
    setExtras((list) => list.filter((x) => x.id !== id));
    setSavingRow(id);
    startTransition(async () => {
      const res = await removeAlertEmailAction(id);
      setSavingRow(null);
      if (!res.ok) {
        setExtras(prev);
        setError(res.error);
      }
    });
  }

  function sendTest() {
    setTestError(null);
    setTestResult(null);
    setTesting(true);
    startTransition(async () => {
      const res = await sendTestAlertAction(alertKey);
      setTesting(false);
      if (!res.ok) {
        setTestError(res.error);
        return;
      }
      if (res.data.sent > 0) {
        setTestResult(
          `Sent to ${res.data.sent} address${res.data.sent === 1 ? "" : "es"}.${
            res.data.failed > 0 ? ` ${res.data.failed} failed.` : ""
          }`,
        );
      } else if (res.data.skipped) {
        setTestResult("Not sent — notifications are off in this environment.");
      } else {
        setTestError(`Could not send the test (${res.data.failed} failed).`);
      }
    });
  }

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-bold text-[color:var(--color-brand-navy)]">{label}</p>
          <p className="mt-0.5 text-sm text-[color:var(--color-brand-text-soft)]">{description}</p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={toggleEnabled}
          disabled={savingRow === "__enabled__"}
          aria-label={`Turn the ${label} alert ${enabled ? "off" : "on"}`}
        />
      </div>

      <div className="mt-3 text-sm" role="status">
        {!enabled ? (
          <span className="text-[color:var(--color-brand-text-soft)]">Off — nobody is emailed</span>
        ) : recipients.emails.length === 0 ? (
          <span className="font-semibold text-red-600">
            On, but nobody will get this — switch on a staff member or add an address below.
          </span>
        ) : (
          <span className="text-green-700">
            {recipients.emails.length} {recipients.emails.length === 1 ? "person" : "people"} will get this.
          </span>
        )}
      </div>
      {recipients.staffWithoutEmail.length > 0 && (
        <p className="mt-1 text-xs text-amber-700">
          {recipients.staffWithoutEmail.length} switched-on staff member
          {recipients.staffWithoutEmail.length === 1 ? " has" : "s have"} no email on file and won&rsquo;t
          actually receive this.
        </p>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {/* Who gets it */}
      <div className="mt-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Who gets it
          </p>
          {!resetting && (
            <button
              type="button"
              onClick={() => setResetting(true)}
              className="text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
            >
              Reset to defaults
            </button>
          )}
        </div>

        {resetting && (
          <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="text-amber-900">
              This removes every individual switch below and goes back to the role default. Extra
              addresses are not affected.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={resetDefaults}
                className="min-h-8 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
              >
                {savingRow === "__reset__" ? "Resetting…" : "Yes, reset"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setResetting(false)}
                className="min-h-8 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-1.5 text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <ul className="mt-2 divide-y divide-[color:var(--color-brand-bg-mid)]">
          {staff.map((member) => {
            const hasOverride = Object.prototype.hasOwnProperty.call(overrides, member.id);
            const subscribed = isStaffSubscribed(member, defaultRoles, overridesMap);
            return (
              <li key={member.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[color:var(--color-brand-navy)]">
                    {member.fullName}{" "}
                    <span className="font-normal text-[color:var(--color-brand-text-soft)]">
                      · {roleLabel(member.role)}
                    </span>
                  </p>
                  <p className="truncate text-xs text-[color:var(--color-brand-text-soft)]">
                    {member.email ?? "No email on file"}
                    {!hasOverride ? ` · Default for ${roleLabel(member.role)}` : ""}
                  </p>
                </div>
                <Switch
                  checked={subscribed}
                  onCheckedChange={(next) => toggleStaff(member.id, next)}
                  disabled={savingRow === member.id}
                  aria-label={`${label} for ${member.fullName}`}
                  size="sm"
                />
              </li>
            );
          })}
          {staff.length === 0 && (
            <li className="py-2 text-sm text-[color:var(--color-brand-text-soft)]">No active staff.</li>
          )}
        </ul>
      </div>

      {/* Extra addresses */}
      <div className="mt-5">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Extra addresses
        </p>
        {extras.length === 0 ? (
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            None yet — add a shared inbox or an address outside the staff list.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-[color:var(--color-brand-bg-mid)]">
            {extras.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate text-sm text-[color:var(--color-brand-navy)]">{x.email}</span>
                <div className="flex shrink-0 items-center gap-3">
                  <Switch
                    checked={x.subscribed}
                    onCheckedChange={(next) => toggleExtra(x.id, next)}
                    disabled={savingRow === x.id}
                    aria-label={`${x.email} for ${label}`}
                    size="sm"
                  />
                  <button
                    type="button"
                    onClick={() => removeExtra(x.id)}
                    disabled={savingRow === x.id}
                    className="text-xs font-semibold text-red-600 hover:underline disabled:opacity-60"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            type="email"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            placeholder="name@example.com"
            maxLength={ALERT_EXTRA_EMAIL_MAX}
            aria-label={`Add an extra address for ${label}`}
            className="min-h-9 min-w-[200px] flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)]"
          />
          <button
            type="button"
            onClick={addEmail}
            disabled={addingEmail || !emailDraft.trim()}
            className="min-h-9 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {addingEmail ? "Adding…" : "Add address"}
          </button>
        </div>
        {emailError && <p className="mt-1 text-xs text-red-600">{emailError}</p>}
      </div>

      {/* Last sent */}
      <div className="mt-5 border-t border-[color:var(--color-brand-bg-mid)] pt-4">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Last sent
        </p>
        {lastSent ? (
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            {manilaDateTime(lastSent.at)} — sent to {lastSent.sent} of {lastSent.recipients}
            {lastSent.failed > 0 ? `, ${lastSent.failed} failed` : ""}
            {lastSent.skipped ? ` (${lastSent.skipped})` : ""}
          </p>
        ) : (
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">Never sent yet.</p>
        )}
      </div>

      {/* Send a test */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={sendTest}
          disabled={testing || !enabled}
          title={!enabled ? "Turn this alert on to send a test" : undefined}
          className="min-h-9 rounded-md border border-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-navy)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {testing ? "Sending…" : "Send a test"}
        </button>
        {!enabled && (
          <span className="text-xs text-[color:var(--color-brand-text-soft)]">
            This alert is off — turn it on to send a test.
          </span>
        )}
        {testResult && <span className="text-xs text-green-700">{testResult}</span>}
        {testError && <span className="text-xs text-red-600">{testError}</span>}
      </div>
    </Panel>
  );
}

"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Panel } from "@/components/ui/panel";
import { manilaDate } from "@/lib/dates/manila";
import {
  CASH_KIND_HELP,
  FIXED_CASH_KINDS,
  FIXED_PAYMENT_METHODS,
  SUSPENSE_CODE,
  accountChoicesFor,
  cashKindLabel,
  cashRoutingGroup,
  groupAccounts,
  paymentMethodLabel,
  type CashRoutingGroup,
  type RoutingAccount,
} from "@/lib/accounting/money-routing";
import {
  updateCashRoutingAction,
  updateDefaultChangeFundAction,
  updatePaymentRoutingAction,
} from "./actions";

export type LastChange = { by: string; at: string };
type PaymentRule = { id: string; payment_method: string; account_id: string; notes: string | null };
type CashRule = { id: string; kind: string; account_id: string; requires_user_choice: boolean; notes: string | null };

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

const PAYMENT_ORDER = ["cash", "card", "gcash", "maya", "bpi", "maybank", "bank_transfer", "hmo", "gift_code"];
const CASH_ORDER = [
  "petty_cash", "courier", "other_payout", "float_topup", "float_pullout",
  "salary_advance", "salary_payout", "gift_code_sale",
];
const byOrder = (order: string[]) => (a: string, b: string) => {
  const ia = order.indexOf(a), ib = order.indexOf(b);
  return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.localeCompare(b);
};

const CASH_GROUPS: { group: CashRoutingGroup; heading: string; intro: string }[] = [
  {
    group: "staff_picks",
    heading: "Staff choose each time",
    intro: "Reception picks the account on the Cash Drawer. It starts on the account shown here, and a skipped pick goes to 9999 Suspense for the bookkeeper to sort out.",
  },
  {
    group: "always",
    heading: "Always the same account",
    intro: "Reception doesn't choose — these always go to the account shown.",
  },
  {
    group: "fixed",
    heading: "Fixed by the system",
    intro: "Another part of the books depends on these, so they can't be changed.",
  },
];

export function MoneyRoutingClient(props: {
  payments: PaymentRule[];
  cash: CashRule[];
  accounts: RoutingAccount[];
  defaultChangeFund: number;
  cashDrawerInUse: boolean;
  lastChanges: Record<string, LastChange>;
}) {
  const accountById = new Map(props.accounts.map((a) => [a.id, a]));
  const payments = [...props.payments].sort((a, b) => byOrder(PAYMENT_ORDER)(a.payment_method, b.payment_method));
  const editablePayments = payments.filter((p) => !(p.payment_method in FIXED_PAYMENT_METHODS));
  const fixedPayments = payments.filter((p) => p.payment_method in FIXED_PAYMENT_METHODS);
  const cash = [...props.cash].sort((a, b) => byOrder(CASH_ORDER)(a.kind, b.kind));

  const cashRules = (
    <div className="space-y-5">
      {CASH_GROUPS.map(({ group, heading, intro }) => {
        const rows = cash.filter((c) => cashRoutingGroup(c.kind, c.requires_user_choice) === group);
        if (rows.length === 0) return null;
        return (
          <RowGroup key={group} heading={heading} intro={intro}>
            {rows.map((c) => (
              <CashRow
                key={c.kind}
                rule={c}
                group={group}
                accounts={props.accounts}
                account={accountById.get(c.account_id)}
                lastChange={props.lastChanges[`cash:${c.kind}`]}
              />
            ))}
          </RowGroup>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-6">
      <Panel className="p-4 sm:p-5" id="payments">
        <SectionHeading
          title="Patient payments"
          intro="Which cash or bank account each way of paying lands in."
        />
        <div className="mt-4 space-y-5">
          <RowGroup>
            {editablePayments.map((p) => (
              <PaymentRow
                key={p.id}
                rule={p}
                accounts={props.accounts}
                account={accountById.get(p.account_id)}
                lastChange={props.lastChanges[`payment:${p.id}`]}
              />
            ))}
          </RowGroup>
          {fixedPayments.length > 0 && (
            <RowGroup heading="Fixed by the system" intro="Another part of the books depends on these, so they can't be changed.">
              {fixedPayments.map((p) => (
                <PaymentRow
                  key={p.id}
                  rule={p}
                  accounts={props.accounts}
                  account={accountById.get(p.account_id)}
                  lastChange={props.lastChanges[`payment:${p.id}`]}
                />
              ))}
            </RowGroup>
          )}
        </div>
      </Panel>

      <Panel className="p-4 sm:p-5" id="cash">
        <SectionHeading
          title="Cash drawer"
          intro="The drawer's starting cash, and where each cash-drawer entry is recorded."
        />
        <div className="mt-4">
          <StartingCash amount={props.defaultChangeFund} lastChange={props.lastChanges.fund} />
        </div>
        <div className="mt-5">
          {props.cashDrawerInUse ? (
            cashRules
          ) : (
            <details className="rounded-lg border border-[color:var(--color-brand-bg-mid)]">
              <summary className="flex min-h-[44px] cursor-pointer items-center px-4 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)]">
                Show the cash-drawer entry rules ({cash.length})
              </summary>
              <div className="border-t border-[color:var(--color-brand-bg-mid)] p-4">
                <p className="mb-4 text-sm text-[color:var(--color-brand-text-soft)]">
                  No payouts, top-ups or pull-outs have been recorded on the Cash Drawer yet, so
                  these rules haven&apos;t been used. They take effect once reception starts
                  recording them.
                </p>
                {cashRules}
              </div>
            </details>
          )}
        </div>
      </Panel>
    </div>
  );
}

// ---- Layout pieces -----------------------------------------------------------

function SectionHeading(props: { title: string; intro: string }) {
  return (
    <div>
      <h2 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">{props.title}</h2>
      <p className="text-sm text-[color:var(--color-brand-text-soft)]">{props.intro}</p>
    </div>
  );
}

function RowGroup(props: { heading?: string; intro?: string; children: ReactNode }) {
  return (
    <section>
      {props.heading && (
        <h3 className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          {props.heading}
        </h3>
      )}
      {props.intro && <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">{props.intro}</p>}
      <ul className="mt-2 divide-y divide-[color:var(--color-brand-bg-mid)] rounded-lg border border-[color:var(--color-brand-bg-mid)]">
        {props.children}
      </ul>
    </section>
  );
}

/** One routing row: name + help on the left, the account (or its editor) in the
 *  middle, the Edit button or a Fixed tag on the right. Stacks on a phone. */
function RowShell(props: {
  label: string;
  help?: string;
  fixedReason?: string;
  body: ReactNode;
  lastChange?: LastChange;
  editing: boolean;
  onEdit: () => void;
}) {
  return (
    <li className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto] sm:items-start sm:gap-4">
      <div className="min-w-0">
        <p className="font-semibold text-[color:var(--color-brand-navy)]">{props.label}</p>
        {props.help && <p className="text-xs text-[color:var(--color-brand-text-soft)]">{props.help}</p>}
      </div>
      <div className="min-w-0 text-sm">
        {props.body}
        {props.fixedReason && (
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">{props.fixedReason}</p>
        )}
        {!props.editing && <LastChangedLine change={props.lastChange} />}
      </div>
      <div className="sm:text-right">
        {props.fixedReason ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-brand-bg)] px-2 py-1 text-xs font-semibold text-[color:var(--color-brand-text-soft)]">
            <LockIcon /> Fixed
          </span>
        ) : props.editing ? null : (
          <button
            type="button"
            onClick={props.onEdit}
            className="min-h-[44px] text-sm font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            Edit
          </button>
        )}
      </div>
    </li>
  );
}

function LastChangedLine({ change }: { change?: LastChange }) {
  return (
    <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
      {change ? `Last changed by ${change.by} · ${manilaDate(change.at)}` : "Not changed since setup"}
    </p>
  );
}

function AccountName({ account }: { account?: RoutingAccount }) {
  if (!account) return <span className="text-red-600">Account not found or no longer active</span>;
  return (
    <span>
      <span className="font-mono text-xs">{account.code}</span> {account.name}
    </span>
  );
}

function AccountSelect(props: {
  id: string;
  label: string;
  value: string;
  choices: RoutingAccount[];
  onChange: (id: string) => void;
}) {
  return (
    <label htmlFor={props.id} className="block text-xs font-semibold text-[color:var(--color-brand-text-soft)]">
      {props.label}
      <select
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1 block min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm font-normal text-[color:var(--color-brand-text)]"
      >
        {groupAccounts(props.choices).map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function NoteInput(props: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <label htmlFor={props.id} className="mt-3 block text-xs font-semibold text-[color:var(--color-brand-text-soft)]">
      Note for the bookkeeper (optional)
      <input
        id={props.id}
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        maxLength={500}
        className="mt-1 block min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm font-normal text-[color:var(--color-brand-text)]"
      />
    </label>
  );
}

function EditButtons(props: { pending: boolean; onSave: () => void; onCancel: () => void; err: string | null }) {
  return (
    <>
      {props.err && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {props.err}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={props.onSave}
          disabled={props.pending}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
        >
          {props.pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          disabled={props.pending}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 text-xs font-semibold"
        >
          Cancel
        </button>
      </div>
    </>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor">
      <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 6H6V4.5a2 2 0 1 1 4 0V7Z" />
    </svg>
  );
}

// ---- Rows ----------------------------------------------------------------------

function PaymentRow(props: {
  rule: PaymentRule;
  accounts: RoutingAccount[];
  account?: RoutingAccount;
  lastChange?: LastChange;
}) {
  const { rule } = props;
  const [editing, setEditing] = useState(false);
  const [accountId, setAccountId] = useState(rule.account_id);
  const [notes, setNotes] = useState(rule.notes ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fixedReason = FIXED_PAYMENT_METHODS[rule.payment_method];

  const open = () => {
    setAccountId(rule.account_id);
    setNotes(rule.notes ?? "");
    setErr(null);
    setEditing(true);
  };
  const save = () =>
    start(async () => {
      setErr(null);
      const r = await updatePaymentRoutingAction(rule.id, accountId, notes.trim() || null);
      if (!r.ok) setErr(r.error);
      else setEditing(false);
    });

  const idBase = `payment-${rule.payment_method}`;
  return (
    <RowShell
      label={paymentMethodLabel(rule.payment_method)}
      fixedReason={fixedReason}
      lastChange={props.lastChange}
      editing={editing}
      onEdit={open}
      body={
        editing ? (
          <div>
            <AccountSelect
              id={`${idBase}-account`}
              label="Record to"
              value={accountId}
              choices={accountChoicesFor({ side: "payment", key: rule.payment_method }, props.accounts, rule.account_id)}
              onChange={setAccountId}
            />
            <NoteInput id={`${idBase}-note`} value={notes} onChange={setNotes} />
            <EditButtons pending={pending} onSave={save} onCancel={() => setEditing(false)} err={err} />
          </div>
        ) : (
          <AccountName account={props.account} />
        )
      }
    />
  );
}

function CashRow(props: {
  rule: CashRule;
  group: CashRoutingGroup;
  accounts: RoutingAccount[];
  account?: RoutingAccount;
  lastChange?: LastChange;
}) {
  const { rule } = props;
  const [editing, setEditing] = useState(false);
  const [staffPicks, setStaffPicks] = useState(rule.requires_user_choice);
  const [accountId, setAccountId] = useState(rule.account_id);
  const [notes, setNotes] = useState(rule.notes ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fixedReason = FIXED_CASH_KINDS[rule.kind];

  const open = () => {
    setStaffPicks(rule.requires_user_choice);
    setAccountId(rule.account_id);
    setNotes(rule.notes ?? "");
    setErr(null);
    setEditing(true);
  };
  const save = () =>
    start(async () => {
      setErr(null);
      const r = await updateCashRoutingAction({
        kind: rule.kind,
        account_id: accountId,
        requires_user_choice: staffPicks,
        notes: notes.trim() || null,
      });
      if (!r.ok) setErr(r.error);
      else setEditing(false);
    });

  const choices = accountChoicesFor({ side: "cash", key: rule.kind }, props.accounts, rule.account_id);
  const offersSuspense = choices.some((a) => a.code === SUSPENSE_CODE);
  const idBase = `cash-${rule.kind}`;

  let readView: ReactNode = <AccountName account={props.account} />;
  if (props.group === "staff_picks") {
    readView = (
      <>
        <p>Staff choose on the Cash Drawer</p>
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          {props.account && props.account.code !== SUSPENSE_CODE ? (
            <>Starts on <AccountName account={props.account} /></>
          ) : props.account ? (
            "Starts empty — a skipped pick goes to 9999 Suspense"
          ) : (
            <AccountName />
          )}
        </p>
      </>
    );
  }

  return (
    <RowShell
      label={cashKindLabel(rule.kind)}
      help={CASH_KIND_HELP[rule.kind]}
      fixedReason={fixedReason}
      lastChange={props.lastChange}
      editing={editing}
      onEdit={open}
      body={
        editing ? (
          <div>
            <fieldset>
              <legend className="text-xs font-semibold text-[color:var(--color-brand-text-soft)]">
                Who picks the account?
              </legend>
              <div className="mt-1 space-y-1">
                <label className="flex min-h-[44px] items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${idBase}-mode`}
                    checked={staffPicks}
                    onChange={() => setStaffPicks(true)}
                  />
                  Staff choose on the Cash Drawer each time
                </label>
                <label className="flex min-h-[44px] items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${idBase}-mode`}
                    checked={!staffPicks}
                    onChange={() => setStaffPicks(false)}
                  />
                  Always use one account
                </label>
              </div>
            </fieldset>
            <div className="mt-2">
              <AccountSelect
                id={`${idBase}-account`}
                label={staffPicks ? "Starting pick on the Cash Drawer" : "Always record to"}
                value={accountId}
                choices={choices}
                onChange={setAccountId}
              />
              {staffPicks && offersSuspense && (
                <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                  Choose 9999 Suspense to start with no pick.
                </p>
              )}
            </div>
            <NoteInput id={`${idBase}-note`} value={notes} onChange={setNotes} />
            <EditButtons pending={pending} onSave={save} onCancel={() => setEditing(false)} err={err} />
          </div>
        ) : (
          readView
        )
      }
    />
  );
}

function StartingCash(props: { amount: number; lastChange?: LastChange }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(props.amount));
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const open = () => {
    setValue(String(props.amount));
    setErr(null);
    setEditing(true);
  };
  const save = () => {
    const amount = Number(value.replace(/,/g, ""));
    if (value.trim() === "" || !Number.isFinite(amount)) {
      setErr("Enter an amount in pesos, e.g. 2000.");
      return;
    }
    start(async () => {
      setErr(null);
      const r = await updateDefaultChangeFundAction(amount);
      if (!r.ok) setErr(r.error);
      else setEditing(false);
    });
  };

  return (
    <div
      id="starting-cash"
      className="grid scroll-mt-24 gap-2 rounded-lg border border-[color:var(--color-brand-bg-mid)] px-4 py-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto] sm:items-start sm:gap-4"
    >
      <div className="min-w-0">
        <p className="font-semibold text-[color:var(--color-brand-navy)]">Starting cash</p>
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          What the drawer starts each day with, before payments, top-ups and pull-outs. Applies to
          every day, not just today.
        </p>
      </div>
      <div className="min-w-0 text-sm">
        {editing ? (
          <div>
            <label htmlFor="starting-cash-amount" className="block text-xs font-semibold text-[color:var(--color-brand-text-soft)]">
              Amount (₱)
              <input
                id="starting-cash-amount"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                inputMode="decimal"
                className="mt-1 block min-h-[44px] w-40 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-sm font-normal text-[color:var(--color-brand-text)]"
              />
            </label>
            <EditButtons pending={pending} onSave={save} onCancel={() => setEditing(false)} err={err} />
          </div>
        ) : (
          <>
            <p className="font-mono text-base font-semibold">{PESO(props.amount)}</p>
            <LastChangedLine change={props.lastChange} />
          </>
        )}
      </div>
      <div className="sm:text-right">
        {!editing && (
          <button
            type="button"
            onClick={open}
            className="min-h-[44px] text-sm font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            Edit
          </button>
        )}
      </div>
    </div>
  );
}

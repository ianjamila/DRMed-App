"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatPhp } from "@/lib/marketing/format";
import { manilaDate } from "@/lib/dates/manila";
import { findVisitForMoveAction, movePaymentAction, type MoveTarget } from "./actions";

const SELECT_CLASS =
  "h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none";

export interface SamePatientVisit {
  id: string;
  visitNumber: string;
  visitDate: string;
  totalPhp: number;
  paidPhp: number;
}

export function MovePaymentDialog({
  paymentId,
  amount,
  methodLabel,
  currentVisitNumber,
  patientName,
  patientDrmId,
  otherVisits,
}: {
  paymentId: string;
  amount: number;
  methodLabel: string;
  currentVisitNumber: string;
  patientName: string;
  patientDrmId: string;
  /** This patient's other live visits, newest first. */
  otherVisits: SamePatientVisit[];
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string>("");
  const [lookup, setLookup] = useState("");
  const [found, setFound] = useState<MoveTarget | null>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [finding, startFind] = useTransition();
  const [pending, startMove] = useTransition();

  function reset() {
    setPicked("");
    setLookup("");
    setFound(null);
    setReason("");
    setErr(null);
  }

  const samePatient = otherVisits.find((v) => v.id === picked) ?? null;
  const target: (SamePatientVisit & { patientName: string; drmId: string }) | null = samePatient
    ? { ...samePatient, patientName, drmId: patientDrmId }
    : found
      ? found
      : null;
  const otherPatient = target !== null && target.drmId !== patientDrmId;
  const targetBalanceAfter = target ? target.totalPhp - target.paidPhp - amount : null;

  function onFind() {
    startFind(async () => {
      setErr(null);
      setPicked("");
      const r = await findVisitForMoveAction(lookup);
      if (!r.ok) {
        setFound(null);
        setErr(r.error);
        return;
      }
      if (r.visit.visitNumber === currentVisitNumber) {
        setFound(null);
        setErr("The payment is already on this visit.");
        return;
      }
      setFound(r.visit);
    });
  }

  function onMove() {
    if (!target) return;
    startMove(async () => {
      setErr(null);
      const r = await movePaymentAction({ paymentId, targetVisitId: target.id, reason: reason.trim() });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      setOpen(false);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          reset();
          setOpen(true);
        }}
        className="min-h-[44px] text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
      >
        Move
      </button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !pending) setOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move payment to another visit</DialogTitle>
            <DialogDescription>
              {formatPhp(amount)} · {methodLabel} · now on visit #{currentVisitNumber}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            {otherVisits.length > 0 ? (
              <div className="grid gap-1.5">
                <Label htmlFor={`move-pick-${paymentId}`}>Another visit for {patientName}</Label>
                <select
                  id={`move-pick-${paymentId}`}
                  value={picked}
                  onChange={(e) => {
                    setPicked(e.target.value);
                    setFound(null);
                    setErr(null);
                  }}
                  className={SELECT_CLASS}
                >
                  <option value="">Choose a visit…</option>
                  {otherVisits.map((v) => (
                    <option key={v.id} value={v.id}>
                      #{v.visitNumber} · {manilaDate(v.visitDate)} · balance{" "}
                      {formatPhp(Math.max(v.totalPhp - v.paidPhp, 0))}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="grid gap-1.5">
              <Label htmlFor={`move-find-${paymentId}`}>
                {otherVisits.length > 0 ? "…or any visit by number" : "Visit number"}
              </Label>
              <div className="flex gap-2">
                <Input
                  id={`move-find-${paymentId}`}
                  value={lookup}
                  onChange={(e) => setLookup(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onFind();
                    }
                  }}
                  placeholder="e.g. 0044"
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  onClick={onFind}
                  disabled={finding || !lookup.trim()}
                >
                  {finding ? "Finding…" : "Find"}
                </Button>
              </div>
            </div>

            {target ? (
              <div
                className={`rounded-md p-3 text-xs ${
                  otherPatient
                    ? "border border-amber-300 bg-amber-50 text-amber-900"
                    : "bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-mid)]"
                }`}
                aria-live="polite"
              >
                <p className="font-semibold">
                  Visit #{target.visitNumber} · {manilaDate(target.visitDate)} · {target.patientName}{" "}
                  <span className="font-mono">{target.drmId}</span>
                </p>
                {otherPatient ? (
                  <p className="mt-1 font-semibold">This visit belongs to a different patient.</p>
                ) : null}
                <p className="mt-1">
                  The {formatPhp(amount)} {methodLabel} payment leaves visit #{currentVisitNumber}{" "}
                  and is recorded on #{target.visitNumber} with the same date and cashier.
                  Both visits&apos; balances update, and the books follow.
                </p>
                {targetBalanceAfter !== null && targetBalanceAfter < 0 ? (
                  <p className="mt-1 font-semibold text-amber-800">
                    That is {formatPhp(-targetBalanceAfter)} more than visit #{target.visitNumber} still owes.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="grid gap-1.5">
              <Label htmlFor={`move-reason-${paymentId}`}>Why are you moving it? *</Label>
              <Textarea
                id={`move-reason-${paymentId}`}
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Recorded on yesterday's visit by mistake"
              />
            </div>

            {err ? (
              <p className="text-sm text-red-600" role="alert">
                {err}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="touch" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="touch"
              onClick={onMove}
              disabled={pending || !target || !reason.trim()}
              className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
            >
              {pending ? "Moving…" : "Move payment"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// The payload for create_visit_encounter (0184): one visit's header fields and
// every test_requests row it will hold, with client-minted ids so package
// components can point at their header before anything is inserted. Pure —
// the DB reads (services, package components, physician compensation) happen
// in the action; the RPC re-checks totals and shape and writes it all in one
// transaction. Components are ₱0 rows: the header carries the package price.

export interface EncounterLineInput {
  service_id: string;
  base_price_php: number;
  discount_kind: string | null;
  discount_amount_php: number;
  final_price_php: number;
  clinic_fee_php: number | null;
  doctor_pf_php: number | null;
  procedure_description: string | null;
  hmo_approved_amount_php: number | null;
}

export interface EncounterHmo {
  hmo_provider_id: string | null;
  hmo_approval_date: string | null;
  hmo_authorization_no: string | null;
}

export interface EncounterDecomposition {
  headerLine: { service_id: string };
  componentServiceIds: string[];
}

export interface EncounterLine extends EncounterLineInput, EncounterHmo {
  id: string;
  receptionist_remarks: string | null;
  parent_id: string | null;
  is_package_header: boolean;
  status: "requested" | "in_progress";
}

export interface EncounterVisitPayload {
  visit: EncounterHmo & {
    total_php: number;
    notes: string | null;
    attending_physician_id: string | null;
    is_sample: boolean;
  };
  lines: EncounterLine[];
}

export interface EncounterVisitInput {
  lines: EncounterLineInput[];
  decompositions: EncounterDecomposition[];
  hmo: EncounterHmo;
  attendingPhysicianId: string | null;
  receptionistRemarks: string | null;
  notes: string | null;
  isSample: boolean;
}

/** Integer centavos. create_visit_encounter (0184) compares totals in centavos,
 *  and JS sums drift (100.10 + 200.20 = 300.29999999999995). */
export const toCentavos = (php: number): number => Math.round(php * 100);
const fromCentavos = (centavos: number): number => centavos / 100;
const money = (php: number): number => fromCentavos(toCentavos(php));
const moneyOrNull = (php: number | null): number | null => (php === null ? null : money(php));

export function buildEncounterVisit(
  input: EncounterVisitInput,
  newId: () => string,
): { ok: true; payload: EncounterVisitPayload } | { ok: false; error: string } {
  const packageServiceIds = new Set(input.decompositions.map((d) => d.headerLine.service_id));
  // Every amount leaves here rounded to centavos (numeric(10,2) in the DB).
  const base = (l: EncounterLineInput) => ({
    service_id: l.service_id,
    base_price_php: money(l.base_price_php),
    discount_kind: l.discount_kind,
    discount_amount_php: money(l.discount_amount_php),
    final_price_php: money(l.final_price_php),
    hmo_provider_id: input.hmo.hmo_provider_id,
    hmo_approval_date: input.hmo.hmo_approval_date,
    hmo_authorization_no: input.hmo.hmo_authorization_no,
    receptionist_remarks: input.receptionistRemarks,
    clinic_fee_php: moneyOrNull(l.clinic_fee_php),
    doctor_pf_php: moneyOrNull(l.doctor_pf_php),
    procedure_description: l.procedure_description,
    hmo_approved_amount_php: moneyOrNull(l.hmo_approved_amount_php),
  });

  // Duplicate package lines pair up with their decompositions in order.
  const packageLinesBySvc = new Map<string, EncounterLineInput[]>();
  for (const l of input.lines) {
    if (!packageServiceIds.has(l.service_id)) continue;
    const queue = packageLinesBySvc.get(l.service_id) ?? [];
    queue.push(l);
    packageLinesBySvc.set(l.service_id, queue);
  }

  const headers: EncounterLine[] = [];
  const components: EncounterLine[] = [];
  for (const d of input.decompositions) {
    const line = packageLinesBySvc.get(d.headerLine.service_id)?.shift();
    if (!line) return { ok: false, error: `Internal error: missing package line for service ${d.headerLine.service_id}` };
    const headerId = newId();
    headers.push({ ...base(line), id: headerId, parent_id: null, is_package_header: true, status: "in_progress" });
    for (const componentServiceId of d.componentServiceIds) {
      components.push({
        ...base(line),
        id: newId(),
        service_id: componentServiceId,
        base_price_php: 0,
        discount_kind: null,
        discount_amount_php: 0,
        final_price_php: 0,
        receptionist_remarks: null,
        clinic_fee_php: null,
        doctor_pf_php: null,
        procedure_description: null,
        hmo_approved_amount_php: null,
        parent_id: headerId,
        is_package_header: false,
        status: "requested",
      });
    }
  }
  const standalone: EncounterLine[] = input.lines
    .filter((l) => !packageServiceIds.has(l.service_id))
    .map((l) => ({ ...base(l), id: newId(), parent_id: null, is_package_header: false, status: "requested" as const }));

  return {
    ok: true,
    payload: {
      visit: {
        // Summed in integer centavos, so it equals the RPC's own sum exactly.
        total_php: fromCentavos(input.lines.reduce((sum, l) => sum + toCentavos(l.final_price_php), 0)),
        notes: input.notes,
        ...input.hmo,
        attending_physician_id: input.attendingPhysicianId,
        is_sample: input.isSample,
      },
      lines: [...headers, ...standalone, ...components],
    },
  };
}

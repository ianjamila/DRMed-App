// scripts/smoke-legacy-parsers.ts
//
// Run with: npm run smoke:legacy-parsers
// Exits 0 if all assertions pass, 1 on first failure. No deps.

import { parseName } from "../src/lib/legacy-import/name-parser";
import { normalizePhone } from "../src/lib/legacy-import/phone-normalizer";
import {
  mapReferralSource,
  mapReleaseMedium,
  mapSeniorPwdKind,
  mapSex,
  parseBirthdate,
} from "../src/lib/legacy-import/vocabulary-mapper";

let failed = 0;
let passed = 0;

function eq<T>(label: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  }
}

// --- name parser ----------------------------------------------------------

eq("name: 'Gabuat, Princess'",
  parseName("Gabuat, Princess", "", "", ""),
  { first_name: "Princess", last_name: "Gabuat", middle_name: null, unparseable: false },
);

eq("name: 'Dela Cruz, Juan Miguel'",
  parseName("Dela Cruz, Juan Miguel", "", "", ""),
  { first_name: "Juan", last_name: "Dela Cruz", middle_name: "Miguel", unparseable: false },
);

eq("name: empty full, dedicated columns",
  parseName("", "Cruz", "Juan", "P."),
  { first_name: "Juan", last_name: "Cruz", middle_name: "P.", unparseable: false },
);

eq("name: nothing at all",
  parseName("", "", "", ""),
  { first_name: null, last_name: null, middle_name: null, unparseable: true },
);

eq("name: 'Jane Doe' (no comma)",
  parseName("Jane Doe", "", "", ""),
  { first_name: "Jane", last_name: "Doe", middle_name: null, unparseable: false },
);

eq("name: 'Santos, Maria Clara Reyes' (multi-word middle)",
  parseName("Santos, Maria Clara Reyes", "", "", ""),
  { first_name: "Maria", last_name: "Santos", middle_name: "Clara Reyes", unparseable: false },
);

eq("name: 'REYES, ANNA' (uppercase — title-cased)",
  parseName("REYES, ANNA", "", "", ""),
  { first_name: "Anna", last_name: "Reyes", middle_name: null, unparseable: false },
);

eq("name: single-word full name (no comma, no fallback)",
  parseName("Jamila", "", "", ""),
  { first_name: "Jamila", last_name: null, middle_name: null, unparseable: false },
);

eq("name: null full, non-null fallbacks",
  parseName(null, "Garcia", "Ana", ""),
  { first_name: "Ana", last_name: "Garcia", middle_name: null, unparseable: false },
);

// --- phone normalizer -----------------------------------------------------

eq("phone: 09095534228",
  normalizePhone("09095534228"),
  { e164: "+639095534228", unparseable: false });

eq("phone: 639095534228",
  normalizePhone("639095534228"),
  { e164: "+639095534228", unparseable: false });

eq("phone: 9095534228",
  normalizePhone("9095534228"),
  { e164: "+639095534228", unparseable: false });

eq("phone: '0909 553 4228'",
  normalizePhone("0909 553 4228"),
  { e164: "+639095534228", unparseable: false });

eq("phone: '+63 909 553 4228'",
  normalizePhone("+63 909 553 4228"),
  { e164: "+639095534228", unparseable: false });

eq("phone: '(0909) 553-4228'",
  normalizePhone("(0909) 553-4228"),
  { e164: "+639095534228", unparseable: false });

eq("phone: garbage",
  normalizePhone("not a number"),
  { e164: null, unparseable: true });

eq("phone: empty string",
  normalizePhone(""),
  { e164: null, unparseable: false });

eq("phone: null",
  normalizePhone(null),
  { e164: null, unparseable: false });

eq("phone: '0639095534228' (13-digit 0639 prefix)",
  normalizePhone("0639095534228"),
  { e164: "+639095534228", unparseable: false });

eq("phone: '+639095534228' (already E.164)",
  normalizePhone("+639095534228"),
  { e164: "+639095534228", unparseable: false });

// --- referral source mapper -----------------------------------------------

eq("ref: 'Doctor Referral'",
  mapReferralSource("Doctor Referral"),
  { id: "doctor_referral" });

eq("ref: 'Facebook'",
  mapReferralSource("Facebook"),
  { id: "online_facebook" });

eq("ref: 'FB'",
  mapReferralSource("FB"),
  { id: "online_facebook" });

eq("ref: 'Instagram'",
  mapReferralSource("Instagram"),
  { id: "online_instagram" });

eq("ref: 'TikTok'",
  mapReferralSource("TikTok"),
  { id: "online_tiktok" });

eq("ref: 'Walk-in'",
  mapReferralSource("Walk-in"),
  { id: "walk_in" });

eq("ref: 'Friend'",
  mapReferralSource("Friend"),
  { id: "customer_referral" });

eq("ref: 'Returning'",
  mapReferralSource("Returning"),
  { id: "returning_patient" });

eq("ref: 'Gift code'",
  mapReferralSource("Gift code"),
  { id: "gift_code" });

eq("ref: gibberish",
  mapReferralSource("zzznope"),
  { id: "other", unmapped_raw: "zzznope" });

eq("ref: empty",
  mapReferralSource(""),
  { id: "other", unmapped_raw: "" });

eq("ref: 'DR. Santos' (name, not a channel — falls through to other)",
  mapReferralSource("DR. Santos"),
  { id: "other", unmapped_raw: "DR. Santos" });

eq("ref: 'Word of Mouth'",
  mapReferralSource("Word of Mouth"),
  { id: "customer_referral" });

eq("ref: 'Northridge employee'",
  mapReferralSource("Northridge employee"),
  { id: "tenant_employee_northridge" });

// --- release medium mapper ------------------------------------------------

eq("rel: 'Physical'",
  mapReleaseMedium("Physical"),
  { id: "physical" });

eq("rel: 'Email'",
  mapReleaseMedium("Email"),
  { id: "email" });

eq("rel: 'Viber'",
  mapReleaseMedium("Viber"),
  { id: "viber" });

eq("rel: 'GCash'",
  mapReleaseMedium("GCash"),
  { id: "gcash" });

eq("rel: empty",
  mapReleaseMedium(""),
  { id: null });

eq("rel: unmapped",
  mapReleaseMedium("smoke signals"),
  { id: null, unmapped_raw: "smoke signals" });

eq("rel: 'Pick-up'",
  mapReleaseMedium("Pick-up"),
  { id: "pickup" });

// --- senior/PWD kind mapper -----------------------------------------------

eq("senior: 'Senior'",
  mapSeniorPwdKind("Senior"),
  "senior");

eq("senior: 'PWD'",
  mapSeniorPwdKind("PWD"),
  "pwd");

eq("senior: blank",
  mapSeniorPwdKind(""),
  null);

eq("senior: 'SC'",
  mapSeniorPwdKind("SC"),
  "senior");

eq("senior: unmapped value",
  mapSeniorPwdKind("minor"),
  null);

// --- sex mapper -----------------------------------------------------------

eq("sex: 'F'",
  mapSex("F"),
  "female");

eq("sex: 'Male'",
  mapSex("Male"),
  "male");

eq("sex: blank",
  mapSex(""),
  null);

eq("sex: 'female' (lowercase)",
  mapSex("female"),
  "female");

eq("sex: 'M'",
  mapSex("M"),
  "male");

// --- birthdate parser -----------------------------------------------------

eq("dob: '12/1/1980'",
  parseBirthdate("12/1/1980"),
  { iso: "1980-12-01", unparseable: false });

eq("dob: '1980-12-01'",
  parseBirthdate("1980-12-01"),
  { iso: "1980-12-01", unparseable: false });

eq("dob: '12/1/2080'",
  parseBirthdate("12/1/2080"),
  { iso: "2080-12-01", unparseable: false });

eq("dob: 'invalid'",
  parseBirthdate("invalid"),
  { iso: null, unparseable: true });

eq("dob: blank",
  parseBirthdate(""),
  { iso: null, unparseable: false });

eq("dob: '01/31/1990' (MM/DD/YYYY)",
  parseBirthdate("01/31/1990"),
  { iso: "1990-01-31", unparseable: false });

eq("dob: '1975/06/15' (ISO with slashes)",
  parseBirthdate("1975/06/15"),
  { iso: "1975-06-15", unparseable: false });

// --- summary --------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

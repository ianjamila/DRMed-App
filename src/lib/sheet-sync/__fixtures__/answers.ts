/** Live "How did you know about DR Med?" spellings (2026-09-24) → expected channel. No personal names. */
export const ANSWER_CASES: ReadonlyArray<[answer: string, expected: string | null]> = [
  ["", null], ["  ", null],
  ["Walk-In", "walk_in"], ["WALK IN", "walk_in"], ["walk in", "walk_in"], ["WALK IN ", "walk_in"],
  ["WALKIN ", "walk_in"], ["WALK IN - APPOINTMENT", "walk_in"], ["WALK IN- THE OTHER DAY", "walk_in"],
  ["WALK IN - NAILS GLOW", "walk_in"],
  ["Walk-in (Saw Poster / Signage)", "walk_in_signage"],
  ["Facebook (Online)", "online_facebook"], ["FACEBOOK", "online_facebook"], ["Facebook", "online_facebook"],
  ["FACEBOK", "online_facebook"],
  ["Google (Online)", "online_google"], ["GOOGLE", "online_google"],
  ["Website (Online)", "online_website"], ["WEBSITE", "online_website"],
  ["Doctor Referral", "doctor_referral"], ["DOCTOR'S REFFERAL", "doctor_referral"],
  ["DOCTOR'S REFERRAL", "doctor_referral"], ["DOCTOR'REFFERAL", "doctor_referral"],
  ["DOCTO'S REFFERAL", "doctor_referral"], ["DOCTOR' REFFERAL", "doctor_referral"],
  ["DOCTOR'S REFFERAL ", "doctor_referral"],
  ["Customer Referral", "customer_referral"], ["CUSTOMER REFFERAL", "customer_referral"],
  ["CUSTOMER REFERRAL", "customer_referral"], ["CUSTOMER'S REFFERAL", "customer_referral"],
  ["CUSTOMER' REFFERAL", "customer_referral"], ["customer referral", "customer_referral"],
  ["Family / Friends", "family_friends"], ["FAMILY/FRIENDS", "family_friends"], ["FAMILY/ FRIENDS", "family_friends"],
  ["Family/Friends", "family_friends"], ["FRIENDS/FAMILY", "family_friends"], ["FAMIL/FRIENDS", "family_friends"],
  ["FAMILY/ FRIENDS ", "family_friends"], ["FAMILY/FRIENS", "family_friends"], ["FAMILY FRIENDS", "family_friends"],
  ["family/friends", "family_friends"], ["FAMILY/FIRIENDS", "family_friends"], ["family/ friends", "family_friends"],
  ["FAMIL.FRIENDS", "family_friends"], ["FAMILY REFERRAL", "family_friends"], ["FAMILY/FRINEDS", "family_friends"],
  ["DAMILY/ FRIENDS", "family_friends"], ["FAMILY/FRIEND", "family_friends"], ["FAMLIY/FRIENDS", "family_friends"],
  ["Family and Friends", "family_friends"], ["FAMILY / FRIENDS", "family_friends"],
  ["PHONE CALL", "phone_text_viber"], ["Phone Call", "phone_text_viber"], ["phone call", "phone_text_viber"],
  ["VIBER", "phone_text_viber"], ["CALL/TEXT", "phone_text_viber"], ["PHONE", "phone_text_viber"],
  ["PHONE TEXT", "phone_text_viber"], ["TEXT", "phone_text_viber"], ["PHONECALL", "phone_text_viber"],
  ["CALL", "phone_text_viber"], [" CALL", "phone_text_viber"],
  ["Prefer Not To Say", "prefer_not_to_say"],
  ["Flyers", "flyers"],
  ["WOMEN'S", "partner_corporate"], ["WOMENS", "partner_corporate"], ["WOMEN'S ULTASOUND", "partner_corporate"],
  ["WALK IN/ WOMEN'S UTZ", "partner_corporate"], ["LIKHAAN", "partner_corporate"], ["SAFEMOMS", "partner_corporate"],
  ["NORTHRIDGE ", "tenant_employee_northridge"], ["NORTHRIDGE TENANT", "tenant_employee_northridge"],
  ["NORTHRIDGE", "tenant_employee_northridge"], ["ADMIN - NORTHRIDGE", "tenant_employee_northridge"],
  ["RETURNING PX", "returning_patient"], ["OLD PATIENT", "returning_patient"], ["OLD PX", "returning_patient"],
  ["OLD PATIENT/WALK IN", "returning_patient"], ["REGULAR PX", "returning_patient"],
  ["REPEAT PATIENT", "returning_patient"],
  ["GIFT CODE", "gift_code"],
  // Deliberately unmapped → "other". Note: normalizeAnswer drops a lone "S" token
  // produced by an apostrophe split (see DOCTOR'S → DOCTOR, CUSTOMER'S → CUSTOMER
  // above), so "MAX'S" normalises to "MAX", not "MAXS".
  ["CUSTOMER LIST", "other"], ["PHYSICAL COPY", "other"], ["alam", "other"], ["METAL ", "other"], ["MAX'S", "other"],
];

/** Answers that must stay "other" (the admin maps them via an alias). */
export const KNOWN_UNMAPPED = new Set(["CUSTOMER LIST", "PHYSICAL COPY", "ALAM", "METAL", "MAX"]);

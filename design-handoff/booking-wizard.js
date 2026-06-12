/* DRMed booking wizard — state, ECG progress, branching, validation, success. */
(function () {
  "use strict";

  // ---------- Data ----------
  var SPECIALTIES = {
    "OB-GYN": ["Dr. Maria Cecilia Castelo-Brojas", "Dr. Nadia Mariano"],
    "Family Medicine": ["Dr. Julie Ann Pacis-Caling", "Dr. Armelle Keisha Mendoza", "Dr. Jaemari Elleazar"],
    "Pediatrics": ["Dr. Katherine Gayo", "Dr. Dominique Antonio", "Dr. Aurora Vicencio"],
    "Internal Medicine": ["Dr. Robert Vicencio", "Dr. Archangel Manuel", "Dr. Ferdinand Dantes", "Dr. Angelle Dantes", "Dr. Lei Baldeviso", "Dr. Gideon Libiran"],
    "ENT": ["Dr. Angelica Lorenzo", "Dr. Claudette Anglo"],
    "Ophthalmology": ["Dr. Alain Arcega"],
    "Radiology": ["Dr. Daniel John Mariano"],
    "Surgery": ["Dr. Mary Rose Alvarez"]
  };
  var PACKAGES = [
    { n: "Basic Package", p: "₱950" },
    { n: "Routine Package", p: "₱1,499", pop: true },
    { n: "Annual Physical Exam", p: "₱1,999" },
    { n: "Thyroid Function Package", p: "₱699" },
    { n: "Standard Executive", p: "₱5,888" },
    { n: "Comprehensive Executive", p: "Inquire" }
  ];
  var TESTS = ["CBC", "Urinalysis", "Fecalysis", "FBS", "Lipid Profile", "HbA1c",
    "Thyroid Panel (TSH, FT3, FT4)", "BUN / Creatinine", "SGPT / SGOT",
    "Ultrasound — Whole Abdomen", "Ultrasound — Pelvic", "Ultrasound — Thyroid"];
  var SLOTS = ["8:00 AM", "9:00 AM", "10:00 AM", "11:00 AM", "1:00 PM", "2:00 PM", "3:00 PM", "4:00 PM"];
  var SLOTS_OFF = { "10:00 AM": true, "2:00 PM": true };
  var TYPE_LABEL = { package: "Diagnostic Package", lab: "Laboratory Request", doctor: "Doctor Appointment", home: "Home Service" };

  // ---------- State ----------
  var KEY = "drmed-booking-wizard-v1";
  var S = { step: 0, patientType: "new", drmId: "", bookingType: "", pkg: "", tests: [], usDate: "", usSlot: "",
    specialty: "", doctor: "", date: "", slot: "", addr: "", brgy: "", city: "Quezon City", lmk: "",
    first: "", middle: "", last: "", bday: "", sex: "", mobile: "", email: "" };
  try { var saved = JSON.parse(localStorage.getItem(KEY) || "null"); if (saved && typeof saved === "object") { for (var k in S) if (k in saved) S[k] = saved[k]; } } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  function refreshIcons() { try { if (window.lucide) window.lucide.createIcons(); } catch (e) {} }

  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  // ---------- ECG progress ----------
  var NX = [60, 280, 500, 720, 940];
  function seg(x) { return " L" + (x - 26) + ",23 L" + (x - 14) + ",23 L" + (x - 9) + ",10 L" + (x - 3) + ",34 L" + (x + 3) + ",6 L" + (x + 8) + ",36 L" + (x + 13) + ",23 L" + (x + 26) + ",23"; }
  var D = "M0,23" + NX.map(seg).join("") + " L1000,23";
  $("#ptbase").setAttribute("d", D);
  $("#ptlive").setAttribute("d", D);
  var ng = $("#nodes");
  NX.forEach(function (x, i) {
    ng.innerHTML += '<circle class="node" data-n="' + i + '" cx="' + x + '" cy="23" r="4.5"/><circle class="nodering" cx="' + x + '" cy="23" r="7"/>';
  });
  var PCT = NX.map(function (x) { return (x + 26) / 1000 * 100; });
  var pT = null;
  function setProgress(idx, full) {
    var pct = full ? 100 : PCT[Math.min(idx, 4)];
    var live = $("#ptlive");
    live.style.transition = "stroke-dashoffset .9s cubic-bezier(.2,.7,.3,1)";
    live.style.strokeDashoffset = (100 - pct);
    clearTimeout(pT);
    pT = setTimeout(function () { live.style.transition = "none"; }, 980);
    $$(".node").forEach(function (n, i) {
      n.classList.toggle("done", i < idx || full);
      n.classList.toggle("now", i === idx && !full);
    });
    $$("#plabels span").forEach(function (l, i) { l.classList.toggle("on", i === idx && !full); });
  }

  // ---------- Steps ----------
  var wizard = $("#wizard");
  var steps = $$(".step");
  var finT = null;
  function showStep(i, goingBack) {
    S.step = Math.min(i, 4); save();
    wizard.classList.toggle("back", !!goingBack);
    steps.forEach(function (st) {
      st.classList.remove("active", "shown");
      var inner = $(".step-inner", st);
      if (inner) { inner.style.transition = ""; inner.style.opacity = ""; inner.style.transform = ""; }
    });
    var st = steps[i];
    st.classList.add("active");
    if (i === 2) showBranch();
    setTimeout(function () { st.classList.add("shown"); }, 30);
    clearTimeout(finT);
    finT = setTimeout(function () {
      var inner = $(".step-inner", st);
      if (inner) { inner.style.transition = "none"; inner.style.opacity = "1"; inner.style.transform = "none"; }
    }, 700);
    setProgress(i, i === 5);
    window.scrollTo({ top: 0 });
    if (i === 4) buildReview();
    if (i === 5) runSuccess();
  }
  function showBranch() {
    $$(".branch").forEach(function (b) { b.style.display = (b.dataset.branch === S.bookingType) ? "block" : "none"; });
    $("#walkinDone").style.display = (S.bookingType === "package") ? "inline-flex" : "none";
    $("#step3Next").innerHTML = (S.bookingType === "package") ? 'Pre-register my details <i data-lucide="arrow-right"></i>' : 'Continue <i data-lucide="arrow-right"></i>';
    refreshIcons();
  }

  // ---------- Selection cards ----------
  function syncPicks() {
    $$(".bcard").forEach(function (b) {
      b.classList.toggle("sel", S[b.dataset.pick] === b.dataset.val);
    });
    $("#drmWrap").style.display = (S.patientType === "existing") ? "grid" : "none";
  }
  $$(".bcard").forEach(function (b) {
    b.addEventListener("click", function () {
      S[b.dataset.pick] = b.dataset.val; save(); syncPicks();
    });
  });

  // ---------- Chips ----------
  function chipRow(elId, items, isSel, onPick, disabled) {
    var el = $("#" + elId); el.innerHTML = "";
    items.forEach(function (it) {
      var label = typeof it === "string" ? it : it.n;
      var c = document.createElement("button");
      c.type = "button"; c.className = "chip";
      c.innerHTML = label + (it.p ? ' <span class="pr">' + it.p + "</span>" : "") + (it.pop ? ' <span class="pr">· Most popular</span>' : "") + '<span class="ring"></span>';
      c.dataset.label = label;
      if (disabled && disabled[label]) c.disabled = true;
      if (isSel(label)) c.classList.add("sel");
      c.addEventListener("click", function () {
        onPick(label); chipRow(elId, items, isSel, onPick, disabled);
        if (isSel(label)) { var nc = document.querySelector("#" + elId + ' .chip[data-label="' + label.replace(/"/g, '\\"') + '"]'); if (nc) { nc.classList.add("rippling"); } }
      });
      el.appendChild(c);
    });
  }
  function buildChips() {
    chipRow("pkgChips", PACKAGES, function (l) { return S.pkg === l; }, function (l) { S.pkg = l; save(); });
    chipRow("testChips", TESTS, function (l) { return S.tests.indexOf(l) >= 0; }, function (l) {
      var i = S.tests.indexOf(l); if (i >= 0) S.tests.splice(i, 1); else S.tests.push(l); save(); syncUS();
    });
    chipRow("usSlots", SLOTS, function (l) { return S.usSlot === l; }, function (l) { S.usSlot = l; save(); }, SLOTS_OFF);
    chipRow("dSlots", SLOTS, function (l) { return S.slot === l; }, function (l) { S.slot = l; save(); }, SLOTS_OFF);
  }
  function syncUS() {
    var hasUS = S.tests.some(function (t) { return t.indexOf("Ultrasound") === 0; });
    $("#usWrap").style.display = hasUS ? "block" : "none";
  }

  // Sex chips
  $$("[data-sex]").forEach(function (c) {
    if (!c.querySelector(".ring")) c.innerHTML += '<span class="ring"></span>';
    c.addEventListener("click", function () {
      S.sex = c.dataset.sex; save();
      c.classList.remove("rippling"); void c.offsetWidth; c.classList.add("rippling");
      $$("[data-sex]").forEach(function (x) { x.classList.toggle("sel", x.dataset.sex === S.sex); });
      fieldOf("sex").classList.remove("bad");
    });
  });

  // ---------- Doctor cascade ----------
  var spec = $("#spec"), doc = $("#doc");
  Object.keys(SPECIALTIES).forEach(function (s) { spec.innerHTML += '<option value="' + s + '">' + s + "</option>"; });
  function syncDocs() {
    doc.innerHTML = '<option value="">Choose a doctor</option>';
    if (S.specialty && SPECIALTIES[S.specialty]) {
      SPECIALTIES[S.specialty].forEach(function (d) { doc.innerHTML += '<option value="' + d + '">' + d + "</option>"; });
      doc.disabled = false; doc.value = S.doctor || "";
    } else { doc.disabled = true; }
  }
  spec.addEventListener("change", function () { S.specialty = spec.value; S.doctor = ""; save(); syncDocs(); });
  doc.addEventListener("change", function () { S.doctor = doc.value; save(); });

  // ---------- Field binding + validation ----------
  function fieldOf(name) { return $('.field[data-f="' + name + '"]'); }
  function bindInput(id, key, validate) {
    var el = $("#" + id); if (!el) return;
    el.value = S[key] || el.value || "";
    if (el.value && key === "city") S.city = el.value;
    el.addEventListener("input", function () { S[key] = el.value; save(); var f = el.closest(".field"); if (f) f.classList.remove("bad"); });
    el.addEventListener("blur", function () {
      var f = el.closest(".field"); if (!f || !validate) return;
      var v = validate(el.value);
      f.classList.toggle("ok", v && el.value.length > 0);
      if (!v && el.value.length > 0) flagBad(f);
    });
  }
  function flagBad(f) {
    f.classList.add("bad"); f.classList.remove("shake");
    void f.offsetWidth; f.classList.add("shake");
    f.classList.remove("ok");
  }
  var vName = function (v) { return v.trim().length >= 2; };
  var vDrm = function (v) { return /^DRM-?\d{3,6}$/i.test(v.trim()); };
  var vMobile = function (v) { return /^09\d{9}$/.test(v.replace(/[\s-]/g, "")); };
  var vEmail = function (v) { return v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()); };
  var vAny = function (v) { return v.trim().length > 0; };

  bindInput("drm", "drmId", vDrm);
  bindInput("usDate", "usDate");
  bindInput("dDate", "date");
  bindInput("addr", "addr", vAny);
  bindInput("brgy", "brgy", vAny);
  bindInput("city", "city", vAny);
  bindInput("lmk", "lmk");
  bindInput("fn", "first", vName);
  bindInput("mn", "middle");
  bindInput("ln", "last", vName);
  bindInput("bd", "bday");
  bindInput("mob", "mobile", vMobile);
  bindInput("em", "email", vEmail);

  function need(name, ok) {
    var f = fieldOf(name); if (!f) return ok;
    if (!ok) flagBad(f); else f.classList.remove("bad");
    return ok;
  }
  function validateStep(i) {
    var ok = true;
    if (i === 0) {
      if (S.patientType === "existing") ok = need("drmId", vDrm(S.drmId)) && ok;
    }
    if (i === 1) {
      if (!S.bookingType) {
        ok = false;
        $$('[data-pick="bookingType"]').forEach(function (b) { b.style.animation = "none"; void b.offsetWidth; b.style.animation = "shake .4s"; });
      }
    }
    if (i === 2) {
      if (S.bookingType === "package") {
        if (!S.pkg) { ok = false; var pc = $("#pkgChips"); pc.style.animation = "none"; void pc.offsetWidth; pc.style.animation = "shake .4s"; }
      }
      if (S.bookingType === "lab") {
        var msg = $("#testsMsg");
        if (!S.tests.length) { ok = false; msg.style.display = "block"; } else { msg.style.display = "none"; }
        if (S.tests.some(function (t) { return t.indexOf("Ultrasound") === 0; })) {
          ok = need("usDate", vAny(S.usDate)) && ok;
          ok = need("usSlot", !!S.usSlot) && ok;
        }
      }
      if (S.bookingType === "doctor") {
        ok = need("specialty", !!S.specialty) && ok;
        ok = need("doctor", !!S.doctor) && ok;
        ok = need("date", vAny(S.date)) && ok;
        ok = need("slot", !!S.slot) && ok;
      }
      if (S.bookingType === "home") {
        ok = need("addr", vAny(S.addr)) && ok;
        ok = need("brgy", vAny(S.brgy)) && ok;
        ok = need("city", vAny(S.city)) && ok;
      }
    }
    if (i === 3) {
      ok = need("first", vName(S.first)) && ok;
      ok = need("last", vName(S.last)) && ok;
      ok = need("bday", vAny(S.bday)) && ok;
      ok = need("sex", !!S.sex) && ok;
      ok = need("mobile", vMobile(S.mobile)) && ok;
      ok = need("email", vEmail(S.email)) && ok;
    }
    return ok;
  }

  // ---------- Review ----------
  function fmtDate(d) { if (!d) return ""; try { return new Date(d + "T00:00:00").toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }); } catch (e) { return d; } }
  function rows() {
    var r = [];
    r.push({ k: "Patient", v: S.patientType === "existing" ? "Returning · " + S.drmId.toUpperCase() : "New patient — DRM-ID issued at the counter", s: 0 });
    r.push({ k: "Booking", v: TYPE_LABEL[S.bookingType] || "—", s: 1 });
    if (S.bookingType === "package") r.push({ k: "Package", v: S.pkg + "<small>Walk-in · Mon–Sat, 8:00 AM – 5:00 PM</small>", s: 2 });
    if (S.bookingType === "lab") {
      r.push({ k: "Tests", v: S.tests.join(", "), s: 2 });
      if (S.usSlot) r.push({ k: "Ultrasound", v: fmtDate(S.usDate) + " · " + S.usSlot, s: 2 });
      else r.push({ k: "When", v: "Walk-in any time<small>Mon–Sat, 8:00 AM – 5:00 PM</small>", s: 2 });
    }
    if (S.bookingType === "doctor") {
      r.push({ k: "Doctor", v: S.doctor + "<small>" + S.specialty + "</small>", s: 2 });
      r.push({ k: "When", v: fmtDate(S.date) + " · " + S.slot + "<small>Reception will text to confirm</small>", s: 2 });
    }
    if (S.bookingType === "home") {
      r.push({ k: "Address", v: S.addr + ", Brgy. " + S.brgy + ", " + S.city + (S.lmk ? "<small>" + S.lmk + "</small>" : ""), s: 2 });
      r.push({ k: "When", v: "Reception will call to confirm schedule", s: 2 });
    }
    if (S.first || S.last) {
      r.push({ k: "Name", v: (S.first + " " + (S.middle ? S.middle + " " : "") + S.last).trim(), s: 3 });
      r.push({ k: "Details", v: fmtDate(S.bday) + " · " + S.sex, s: 3 });
      r.push({ k: "Contact", v: S.mobile + (S.email ? "<small>" + S.email + "</small>" : ""), s: 3 });
    }
    return r;
  }
  function reviewHTML(editable) {
    return rows().map(function (r) {
      return '<div class="rrow"><span class="k">' + r.k + '</span><span class="v">' + r.v + "</span>" +
        (editable ? '<button type="button" data-edit="' + r.s + '">Edit</button>' : "") + "</div>";
    }).join("");
  }
  function cascade(el) {
    el.classList.add("casc"); el.classList.remove("go");
    setTimeout(function () { el.classList.add("go"); }, 60);
    setTimeout(function () { $$(".rrow", el).forEach(function (r) { r.style.transition = "none"; r.style.opacity = "1"; r.style.transform = "none"; }); }, 1400);
  }
  function buildReview() {
    $("#reviewBox").innerHTML = reviewHTML(true);
    cascade($("#reviewBox"));
    $$("#reviewBox [data-edit]").forEach(function (b) {
      b.addEventListener("click", function () { showStep(+b.dataset.edit, true); });
    });
  }

  // ---------- Success ----------
  var sucMode = "booked";
  function runSuccess() {
    var box = $("#successBox");
    var ref = { walkin: "WK", prereg: "PR", home: "HS" }[sucMode] || "BK";
    ref += "-" + String(Math.floor(1000 + Math.random() * 9000));
    var title, sub, next = [];
    if (sucMode === "walkin") {
      title = "See you at the <em>clinic.</em>";
      sub = "No booking needed for diagnostic packages — just walk in.";
      next = ["<b>Walk in any time</b>, Monday – Saturday, 8:00 AM – 5:00 PM.",
        "Bring a valid ID, and your HMO card or LOA if covered.",
        "Fast 8–10 hours beforehand if your package includes blood sugar or lipid tests."];
    } else if (sucMode === "prereg") {
      title = "You're <em>pre-registered.</em>";
      sub = "Show this reference at the counter and we'll have everything ready.";
      next = ["<b>Walk in any time</b>, Monday – Saturday, 8:00 AM – 5:00 PM.",
        "Reception will verify your identity — bring a valid ID.",
        "Fast 8–10 hours beforehand if your package includes blood sugar or lipid tests."];
    } else if (sucMode === "home") {
      title = "Request <em>received.</em>";
      sub = "Our reception team will call you to confirm availability, schedule, and the home-service fee.";
      next = ["Expect a call from reception within the day (Mon–Sat, 8 AM – 5 PM).",
        "Keep your mobile line open — we'll confirm everything before the visit.",
        "Have your doctor's request ready if the collection needs one."];
    } else {
      title = "You're <em>booked.</em>";
      sub = "Reception will text you to confirm your slot. See you soon!";
      next = ["Watch for a confirmation text from reception.",
        "Arrive 10 minutes early and bring a valid ID.",
        "Bring your HMO card or LOA if your visit is covered."];
    }
    $("#sucTitle").innerHTML = title;
    $("#sucSub").textContent = sub;
    $("#refCode").textContent = "Reference · " + ref;
    $("#sucReview").innerHTML = reviewHTML(false);
    cascade($("#sucReview"));
    $("#sucNext").innerHTML = next.map(function (t) { return '<li><i data-lucide="check"></i><span>' + t + "</span></li>"; }).join("");
    refreshIcons();
    box.classList.remove("go");
    setTimeout(function () { box.classList.add("go"); }, 60);
    setTimeout(function () {
      $$(".suc-ecg, .suc-ring, .suc-check").forEach(function (p) { p.style.transition = "none"; p.style.strokeDashoffset = "0"; });
    }, 2300);
    try { localStorage.removeItem(KEY); } catch (e) {}
  }

  // ---------- Wiring ----------
  function scrollToError() {
    var el = document.querySelector(".step.active .field.bad") || document.querySelector(".step.active #testsMsg[style*=block]");
    if (!el) return;
    var y = el.getBoundingClientRect().top + window.scrollY - 160;
    window.scrollTo({ top: Math.max(0, y), behavior: matchMedia("(prefers-reduced-motion: no-preference)").matches ? "smooth" : "auto" });
  }
  $$("[data-next]").forEach(function (b) {
    b.addEventListener("click", function () {
      var cur = S.step;
      if (!validateStep(cur)) { setTimeout(scrollToError, 60); return; }
      if (cur === 2 && S.bookingType === "package") sucMode = "prereg";
      showStep(cur + 1, false);
    });
  });
  $$("[data-back]").forEach(function (b) {
    b.addEventListener("click", function () { showStep(Math.max(0, S.step - 1), true); });
  });
  $("#walkinDone").addEventListener("click", function () {
    if (!validateStep(2)) { setTimeout(scrollToError, 60); return; }
    sucMode = "walkin";
    showStep(5, false);
  });
  $("#confirmBtn").addEventListener("click", function () {
    sucMode = (S.bookingType === "home") ? "home" : (S.bookingType === "package" ? "prereg" : "booked");
    showStep(5, false);
  });
  $("#startOver").addEventListener("click", function () {
    try { localStorage.removeItem(KEY); } catch (e) {}
    location.reload();
  });

  // Min dates = today
  var today = new Date().toISOString().slice(0, 10);
  ["usDate", "dDate", "bd"].forEach(function (id) { var el = $("#" + id); if (el && id !== "bd") el.min = today; });

  // ---------- Init ----------
  buildChips(); syncPicks(); syncDocs(); syncUS();
  spec.value = S.specialty || "";
  syncDocs();
  $$("[data-sex]").forEach(function (x) { x.classList.toggle("sel", x.dataset.sex === S.sex); });
  showStep(Math.min(S.step, 4), false);
})();

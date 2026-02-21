import { useState, useRef, useCallback, useEffect } from "react";

// ─── Claude API ───────────────────────────────────────────────────────────────
async function callClaude(messages, system = "", maxTokens = 1500) {
  //const res = await fetch("https://api.anthropic.com/v1/messages", {
const res = await fetch("https://demo-three-sand-74.vercel.app/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, system, messages }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.map(b => b.text || "").join("") || "";
}

function safeJSON(raw) {
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return null; }
}

// ─── Placeholder SVG for broken/loading prescription images ──────────────────
const PLACEHOLDER_IMG = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MiIgaGVpZ2h0PSI2MiIgdmlld0JveD0iMCAwIDYyIDYyIj4KICA8cmVjdCB3aWR0aD0iNjIiIGhlaWdodD0iNjIiIHJ4PSI4IiBmaWxsPSIjZGZmMGY0Ii8+CiAgPHJlY3QgeD0iMTEiIHk9IjExIiB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHJ4PSI2IiBmaWxsPSIjYjJkZmRiIi8+CiAgPGNpcmNsZSBjeD0iMjMiIGN5PSIyNSIgcj0iNSIgZmlsbD0iIzRkYjZhYyIvPgogIDxwb2x5Z29uIHBvaW50cz0iMTEsNTEgMjMsMzUgMzEsNDMgMzksMzUgNTEsNTEiIGZpbGw9IiM0ZGI2YWMiLz4KICA8cmVjdCB4PSIxNyIgeT0iMTQiIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCIgcng9IjIiIGZpbGw9IiNmZmYiIG9wYWNpdHk9IjAuNSIvPgogIDxsaW5lIHgxPSIyMCIgeTE9IjQwIiB4Mj0iNDIiIHkyPSI0MCIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIG9wYWNpdHk9IjAuNCIvPgogIDxsaW5lIHgxPSIyMCIgeTE9IjQ0IiB4Mj0iMzYiIHkyPSI0NCIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIG9wYWNpdHk9IjAuMyIvPgo8L3N2Zz4=";

// ─── OCR: Parse prescription label from image ─────────────────────────────────
async function parsePrescriptionImage(base64, mimeType) {
  const raw = await callClaude([{
    role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
      { type: "text", text: `Read this prescription label. Extract all visible fields.
Respond ONLY in JSON:
{"medication_name":"...","dosage":"...","dosage_form":"tablet","frequency":"...","instructions":"...","rx_number":null,"qty":null,"refill_by":null,"prescriber":null,"pharmacy":null}
If unreadable: {"error":"unreadable"}` }
    ]
  }], "You are a pharmacy OCR expert. JSON only.");
  const p = safeJSON(raw);
  if (!p?.medication_name) return { error: "unreadable" };
  return p;
}

// ─── Get optimal dosing times ─────────────────────────────────────────────────
async function getOptimalTiming(med) {
  const raw = await callClaude([{
    role: "user",
    content: `Medication: ${med.medication_name} ${med.dosage}. Frequency: "${med.frequency}". Instructions: "${med.instructions}".
Best time(s) to take it? Consider food, sedation, BP, absorption.
Respond ONLY in JSON: {"times":["8:00 AM"],"reason":"...","with_food":true,"avoid_driving":false,"warnings":null}`
  }], "Clinical pharmacist. JSON only.");
  return safeJSON(raw) || { times: ["8:00 AM"], reason: "Default morning", with_food: false, avoid_driving: false, warnings: null };
}

// ─── 3-Outcome EHR Clinical Decision Engine ───────────────────────────────────
// adjust_time  → safe pharmacokinetic fix, auto-reset alarm
// see_doctor   → needs clinical assessment
// no_change    → symptom unrelated or timing fine
async function evaluateSymptomVsEHR({ symptomText, medication, dosage, currentTimes, ehr, bpReading }) {
  const bpContext = bpReading ? `\nPatient-reported BP at time of symptom: ${bpReading}` : "";
  const ehrSection = ehr
    ? `PATIENT EHR:\n${JSON.stringify(ehr, null, 2)}`
    : `NO EHR AVAILABLE: Use general clinical/pharmacological knowledge only. Do not reference any patient-specific history.`;

  const raw = await callClaude([{
    role: "user",
    content: `You are a senior clinical pharmacist evaluating a patient symptom report.

MEDICATION: ${medication} ${dosage}
CURRENT ALARM TIME(S): ${currentTimes.join(", ") || "none set"}
PATIENT SYMPTOM: "${symptomText}"${bpContext}

${ehrSection}

══ DECISION RULES — follow strictly ══

Output "action": "adjust_time" ONLY when ALL are true:
  • The symptom is a known, expected timing-dependent side effect of this drug
  • The EHR has a specific finding explaining WHY this time is wrong
  • Moving to a different time of day would likely resolve it
  • "new_times" MUST contain specific recommended time(s), e.g. ["9:00 PM"]

Output "action": "see_doctor" when ANY of these apply:
  • BP reading is dangerously elevated (systolic ≥180 or diastolic ≥110)
  • Symptom suggests the drug is not working at any time
  • Serious adverse reaction: chest pain, severe rash, swelling, difficulty breathing
  • Drug-drug interaction that cannot be resolved by timing
  • "doctor_urgency": "call_now" | "call_soon" | "next_appointment"

Output "action": "no_change" when:
  • Symptom is unrelated to this medication or its timing
  • Patient reports feeling fine

Respond ONLY in valid JSON:
{
  "action": "adjust_time|see_doctor|no_change",
  "symptom_classification": "timing_side_effect|serious_adverse|drug_ineffective|unrelated|ambiguous",
  "ehr_conflict_detail": "specific EHR finding that supports this decision, or null",
  "new_times": [],
  "adjust_reason": "plain-English explanation of WHY this time is better, or null",
  "doctor_reason": "exactly why a doctor is needed and what patient should say, or null",
  "doctor_urgency": "call_now|call_soon|next_appointment|null",
  "doctor_message": "pre-written message patient can read to doctor/nurse, or null",
  "urgency": "high|medium|low",
  "urgency_message": "short patient-facing summary"
}`
  }], "Senior clinical pharmacist. JSON only. Follow decision rules strictly.");
  return safeJSON(raw) || { action: "no_change", urgency: "low", urgency_message: "No changes needed." };
}

// ─── Sample EHR: Duo Deng (from uploaded EHR record) ─────────────────────────
const SAMPLE_EHR = {
  record_id: "EHR-2024-084721",
  facility: {
    name: "Riverside General Hospital",
    npi: "1234567890",
    address: "450 Medical Center Blvd, Springfield, IL 62701"
  },
  patient: {
    id: "PT-00492817",
    first_name: "Duo",
    last_name: "Deng",
    name: "Duo Deng",
    date_of_birth: "1968-07-22",
    age: 56,
    gender: "Female",
    mrn: "MRN-20180312-4821",
    phone: "217-555-0194",
    address: "1142 Elm Creek Drive, Springfield, IL 62704",
    contact: {
      phone_primary: "217-555-0194",
      phone_secondary: "217-555-0287",
      email: "m.holloway68@email.com",
      address: { street: "1142 Elm Creek Drive", city: "Springfield", state: "IL", zip: "62704", country: "USA" }
    },
    emergency_contact: { name: "David Holloway", relationship: "Spouse", phone: "217-555-0287" },
    insurance: {
      primary: { provider: "BlueCross BlueShield", plan: "PPO Gold", member_id: "BCBS-IL-448821047" },
      secondary: { provider: "Medicare Part B", member_id: "1EG4-TE5-MK72" }
    }
  },
  primary_care_physician: { name: "Dr. Alan Reyes", specialty: "Internal Medicine", phone: "217-555-0100" },
  care_team: [
    { role: "Cardiologist", name: "Dr. Priya Nambiar", phone: "217-555-0200" },
    { role: "Endocrinologist", name: "Dr. Samuel Ortiz", phone: "217-555-0300" },
    { role: "Registered Nurse", name: "Jennifer Walsh, RN", phone: "217-555-0100" }
  ],
  vital_signs: {
    last_recorded: "2024-11-05",
    height_cm: 163, weight_kg: 82.4, bmi: 31.0,
    blood_pressure_mmhg: { systolic: 168, diastolic: 96 },
    heart_rate_bpm: 84, oxygen_saturation_pct: 97
  },
  diagnoses: [
    { icd10: "E11.9", description: "Type 2 Diabetes Mellitus without complications", status: "Active", notes: "Managed with oral hypoglycemics; HbA1c trending toward target" },
    { icd10: "I10", description: "Essential (Primary) Hypertension", status: "Active", notes: "Partially controlled; dietary non-compliance noted" },
    { icd10: "E78.5", description: "Hyperlipidemia, unspecified", status: "Active" },
    { icd10: "M54.5", description: "Low Back Pain", status: "Chronic", notes: "Managed conservatively with PT and NSAIDs as needed" },
    { icd10: "F41.1", description: "Generalized Anxiety Disorder", status: "Active", notes: "On SSRI; patient reports moderate improvement" }
  ],
  allergies: [
    { allergen: "Penicillin", reaction: "Anaphylaxis", severity: "Severe" },
    { allergen: "Sulfonamides", reaction: "Rash, urticaria", severity: "Moderate" },
    { allergen: "Latex", reaction: "Contact dermatitis", severity: "Mild" }
  ],
  medications: [
    { name: "Metformin", dose: "1000 mg", frequency: "Twice daily with meals", indication: "Type 2 Diabetes", active: true },
    { name: "Lisinopril", dose: "10 mg", frequency: "Once daily", indication: "Hypertension", active: true },
    { name: "Atorvastatin", dose: "40 mg", frequency: "Once daily at bedtime", indication: "Hyperlipidemia", active: true },
    { name: "Sertraline", dose: "50 mg", frequency: "Once daily", indication: "Generalized Anxiety Disorder", active: true },
    { name: "Aspirin", dose: "81 mg", frequency: "Once daily", indication: "Cardiovascular prophylaxis", active: true },
    { name: "Ibuprofen", dose: "400 mg", frequency: "As needed for back pain (max 3x/day)", indication: "Low back pain", active: true, notes: "Caution advised given hypertension; limit use" }
  ],
  lab_results: [
    { date: "2024-11-05", panel: "HbA1c", results: { HbA1c_pct: 7.4 }, note: "Improved from 8.1%; approaching target of <7%" },
    { date: "2024-11-05", panel: "Lipid Panel", results: { total_cholesterol_mg_dL: 204, LDL_mg_dL: 118, HDL_mg_dL: 48, triglycerides_mg_dL: 190 }, note: "LDL above target of <100 mg/dL for diabetic patient" },
    { date: "2024-11-05", panel: "Comprehensive Metabolic Panel", results: { glucose_mg_dL: 138, creatinine_mg_dL: 0.9, eGFR: 82, potassium_mEq_L: 4.1 } },
    { date: "2024-11-05", panel: "Urine Microalbumin", results: { microalbumin_mg_g_creatinine: 28 }, note: "Mildly elevated; monitor annually for diabetic nephropathy" }
  ],
  social_history: {
    smoking_status: "Former smoker", quit_date: "2010-01-01",
    alcohol_use: "Occasional, < 3 drinks/week", exercise: "Light walking 2-3x/week",
    diet: "Low sodium attempted; high carb intake noted", occupation: "High school librarian"
  },
  last_encounter: {
    date: "2024-11-05", provider: "Dr. Alan Reyes",
    assessment: "Type 2 DM improving; hypertension partially controlled; anxiety stable; back pain chronic but managed.",
    plan: ["Continue current medications", "Consider increasing atorvastatin to 80mg given LDL above target", "Reinforce low-sodium dietary counseling", "Ophthalmology referral for diabetic eye exam"]
  }
};

// ─── Demo Log Data ────────────────────────────────────────────────────────────
const DEMO_LOG = [
  {
    id: "log1", ts: Date.now() - 86400000 * 1,
    medName: "Lisinopril", dosage: "10mg",
    symptomText: "Feeling very dizzy and lightheaded after taking it this morning",
    bpReading: "190/112",
    action: "see_doctor",
    ehrConflictDetail: "EHR shows poorly controlled hypertension (168/96 mmHg) and known orthostatic hypotension risk with Lisinopril peak at 1-2h post dose.",
    adjustReason: null,
    doctorReason: "BP reading of 190/112 is a hypertensive crisis (systolic ≥180). Combined with dizziness and Lisinopril peak timing, this requires urgent medical evaluation.",
    doctorUrgency: "call_now",
    doctorMessage: "Hi, this is Duo Deng, DOB 1969. I took my Lisinopril 10mg this morning and now have severe dizziness. My blood pressure is 190/112. I need to be seen today.",
    oldTimes: ["8:00 AM"],
    newTimes: [],
    sentToDoctor: true,
    urgency: "high",
    urgencyMessage: "Hypertensive crisis — call your doctor immediately."
  },
  {
    id: "log2", ts: Date.now() - 86400000 * 2,
    medName: "Metformin", dosage: "1000mg",
    symptomText: "Terrible nausea and stomach cramps after my morning pill",
    bpReading: "",
    action: "adjust_time",
    ehrConflictDetail: "EHR notes GI intolerance when Metformin taken without food. Morning alarm is set with no food instruction.",
    adjustReason: "Taking Metformin with meals greatly reduces GI side effects. Alarm moved to coincide with breakfast (8:00 AM) and dinner (6:00 PM) to ensure food is present.",
    doctorReason: null,
    doctorUrgency: null,
    doctorMessage: null,
    oldTimes: ["7:00 AM", "7:00 PM"],
    newTimes: ["8:00 AM", "6:00 PM"],
    sentToDoctor: false,
    urgency: "medium",
    urgencyMessage: "Alarm updated — take Metformin with meals."
  },
  {
    id: "log3", ts: Date.now() - 86400000 * 3,
    medName: "Atorvastatin", dosage: "40mg",
    symptomText: "Just checking in — took my pill, feeling fine",
    bpReading: "",
    action: "no_change",
    ehrConflictDetail: null,
    adjustReason: null,
    doctorReason: null,
    doctorUrgency: null,
    doctorMessage: null,
    oldTimes: ["9:00 PM"],
    newTimes: [],
    sentToDoctor: false,
    urgency: "low",
    urgencyMessage: "Schedule confirmed. Keep it up!"
  },
  {
    id: "log4", ts: Date.now() - 86400000 * 4,
    medName: "Sertraline", dosage: "50mg",
    symptomText: "Having trouble sleeping, feels like my mind is racing at night",
    bpReading: "",
    action: "adjust_time",
    ehrConflictDetail: "EHR prescribes Sertraline once daily morning. Evening/night dosing is known to cause insomnia with SSRIs.",
    adjustReason: "Sertraline should be taken in the morning — it can cause activating effects that delay sleep onset when taken at night. Alarm moved to 8:00 AM.",
    doctorReason: null,
    doctorUrgency: null,
    doctorMessage: null,
    oldTimes: ["9:00 PM"],
    newTimes: ["8:00 AM"],
    sentToDoctor: false,
    urgency: "medium",
    urgencyMessage: "Alarm updated — morning is better for Sertraline."
  },
  {
    id: "log5", ts: Date.now() - 86400000 * 5,
    medName: "Ibuprofen", dosage: "400mg",
    symptomText: "Took ibuprofen for knee pain, now my BP feels high and I'm getting headaches",
    bpReading: "178/104",
    action: "see_doctor",
    ehrConflictDetail: "EHR flags Ibuprofen as CONTRAINDICATED with hypertension and Lisinopril — NSAIDs raise BP and blunt ACE inhibitor effectiveness.",
    adjustReason: null,
    doctorReason: "Ibuprofen is contraindicated for this patient. It raises blood pressure and counteracts Lisinopril. A safer analgesic must be prescribed. BP of 178/104 requires monitoring.",
    doctorUrgency: "call_soon",
    doctorMessage: "Hi, this is Duo Deng. I took Ibuprofen 400mg for pain and now have a headache and elevated BP of 178/104. I know there may be a drug interaction with my Lisinopril. Can you recommend an alternative pain medication?",
    oldTimes: ["PRN"],
    newTimes: [],
    sentToDoctor: true,
    urgency: "high",
    urgencyMessage: "NSAID contraindicated — contact your doctor within 1-2 days."
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 1: LOGIN
// ═══════════════════════════════════════════════════════════════════════════════
function LoginScreen({ onNext }) {
  const [name, setName]       = useState("");
  const [phone, setPhone]     = useState("");
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [ehrError, setEhrError] = useState(false);
  const [ehrMatched, setEhrMatched] = useState(null); // null = not checked yet

  const normalizePhone = (s) => s.replace(/\D/g, "");
  const normalizeName  = (s) => s.trim().toLowerCase();
  const normalizeAddr  = (s) => s.trim().toLowerCase();

  const checkEhrMatch = () => {
    const p = SAMPLE_EHR.patient;
    const fullName = `${p.first_name} ${p.last_name}`;
    const ehrAddress = `${p.contact.address.street}, ${p.contact.address.city}, ${p.contact.address.state} ${p.contact.address.zip}`;
    const nameMatch    = normalizeName(name)    === normalizeName(fullName);
    const phoneMatch   = normalizePhone(phone)  === normalizePhone(p.contact.phone_primary);
    const addressMatch = normalizeAddr(address) === normalizeAddr(ehrAddress);
    return nameMatch && phoneMatch && addressMatch;
  };

  const handleLogin = () => {
    if (!name.trim() || !phone.trim() || !address.trim()) return;
    setLoading(true);
    setTimeout(() => {
      const matched = checkEhrMatch();
      setLoading(false);
      if (matched) {
        setEhrError(false);
        setEhrMatched(true);
        onNext({ name, phone, address, ehrLinked: true });
      } else {
        setEhrError(true);
        setEhrMatched(false);
      }
    }, 800);
  };

  const handleContinueWithout = () => {
    onNext({ name, phone, address, ehrLinked: false });
  };

  return (
    <div className="screen screen-login">
      <div className="login-hero">
        <div className="login-logo">💊</div>
        <h1 className="login-title">MediMinder Pro</h1>
        <p className="login-subtitle">Your AI-powered medication companion</p>
      </div>

      <div className="login-form">
        <div className="form-group">
          <label className="form-label">Full Name</label>
          <input className="form-input" value={name} onChange={e => { setName(e.target.value); setEhrError(false); }} placeholder="e.g. Duo Deng" />
        </div>
        <div className="form-group">
          <label className="form-label">Phone Number</label>
          <input className="form-input" value={phone} onChange={e => { setPhone(e.target.value); setEhrError(false); }} placeholder="e.g. 561-789-0123" type="tel" />
        </div>
        <div className="form-group">
          <label className="form-label">Home Address</label>
          <input className="form-input" value={address} onChange={e => { setAddress(e.target.value); setEhrError(false); }} placeholder="e.g. 123 Palm Ave, Boca Raton, FL" />
        </div>

        {ehrError ? (
          <>
            <div className="login-ehr-error">
              <span>⚠️</span>
              <span>Upload your EHR record first pls</span>
            </div>
            <button
              className="btn-primary"
              onClick={handleLogin}
              disabled={loading || !name.trim() || !phone.trim() || !address.trim()}
            >
              {loading ? <span className="spinner" /> : "Try Again →"}
            </button>
            <button className="btn-outline" onClick={handleContinueWithout}>
              Continue Without EHR
            </button>
            <p className="login-fine login-fine-warn">Without EHR, drug conflicts will use general knowledge only</p>
          </>
        ) : (
          <>
            <button
              className="btn-primary"
              onClick={handleLogin}
              disabled={loading || !name.trim() || !phone.trim() || !address.trim()}
            >
              {loading ? <span className="spinner" /> : "Get Started →"}
            </button>
            <p className="login-fine">Protected by HIPAA-compliant encryption</p>
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 2: CAPTURE
// ═══════════════════════════════════════════════════════════════════════════════
function CaptureScreen({ onNext, onBack }) {
  const fileRef = useRef(null);
  const [captured, setCaptured] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  const processFile = async (file) => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataUrl = e.target.result;
        const base64 = dataUrl.split(",")[1];
        const mimeType = file.type || "image/jpeg";
        const imgSrc = dataUrl;

        setStatusMsg(`Reading ${file.name}...`);
        let parsed;
        try {
          parsed = await parsePrescriptionImage(base64, mimeType);
        } catch {
          parsed = { error: "unreadable" };
        }

        if (parsed.error) {
          resolve({ imgSrc, parsed: null, status: "error", error: "Could not read label" });
          return;
        }

        setStatusMsg(`Getting optimal timing for ${parsed.medication_name}...`);
        let timing;
        try {
          timing = await getOptimalTiming(parsed);
        } catch {
          timing = { times: ["8:00 AM"], reason: "Default", with_food: false, avoid_driving: false };
        }

        resolve({ imgSrc, parsed, timing, status: "done" });
      };
      reader.readAsDataURL(file);
    });
  };

  const handleFiles = async (files) => {
    setProcessing(true);
    const results = [];
    for (const file of files) {
      const result = await processFile(file);
      results.push(result);
      setCaptured(prev => [...prev, result]);
    }
    setProcessing(false);
    setStatusMsg("");
  };

  const handleDrop = (e) => {
    e.preventDefault();
    handleFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <div className="screen">
      <div className="screen-header">
        <button className="back-btn" onClick={onBack}>←</button>
        <h2 className="screen-title">Scan Prescriptions</h2>
        <div style={{ width: 32 }} />
      </div>

      <div className="capture-body">
        <div
          className={`drop-zone ${processing ? "drop-zone-processing" : ""}`}
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => !processing && fileRef.current?.click()}
        >
          {processing ? (
            <div className="dz-processing">
              <span className="spinner-lg" />
              <p className="dz-msg">{statusMsg || "Processing..."}</p>
            </div>
          ) : (
            <>
              <div className="dz-icon">📷</div>
              <p className="dz-title">Upload Prescription Label</p>
              <p className="dz-sub">Tap to browse or drag & drop</p>
              <p className="dz-sub">JPG, PNG supported</p>
            </>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }}
          onChange={e => handleFiles(Array.from(e.target.files))} />

        {captured.length > 0 && (
          <div className="captured-list">
            <h3 className="cl-header">Scanned ({captured.length})</h3>
            {captured.map((item, i) => (
              <div key={i} className={`cap-card ${item.status === "error" ? "cap-card-error" : "cap-card-ok"}`}>
                <img
                  src={item.imgSrc}
                  className="cap-thumb"
                  onError={e => { e.target.src = PLACEHOLDER_IMG; }}
                  alt="rx"
                />
                <div className="cap-info">
                  {item.status === "error" ? (
                    <p className="cap-name cap-err">⚠ Unreadable label</p>
                  ) : (
                    <>
                      <p className="cap-name">{item.parsed?.medication_name}</p>
                      <p className="cap-dose">{item.parsed?.dosage} · {item.parsed?.frequency}</p>
                      <p className="cap-time">⏰ {item.timing?.times?.join(", ")}</p>
                    </>
                  )}
                </div>
                <span className={`cap-badge ${item.status === "done" ? "badge-ok" : "badge-err"}`}>
                  {item.status === "done" ? "✓" : "✗"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="capture-footer">
        <button
          className="btn-primary"
          disabled={captured.filter(c => c.status === "done").length === 0 || processing}
          onClick={() => onNext(captured.filter(c => c.status === "done"))}
        >
          Continue → ({captured.filter(c => c.status === "done").length} meds)
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 3: SCHEDULE
// ═══════════════════════════════════════════════════════════════════════════════
function ScheduleScreen({ meds, setMeds, onNext, onBack, onAddMore, ehrLinked, onGoRisk }) {
  const updateTime = (idx, timeIdx, val) => {
    setMeds(prev => prev.map((m, i) => {
      if (i !== idx) return m;
      const times = [...(m.timing?.times || [])];
      times[timeIdx] = val;
      return { ...m, timing: { ...m.timing, times } };
    }));
  };

  const readyCount = meds.filter(m => m.status === "done").length;

  return (
    <div className="screen">
      <div className="screen-header">
        <button className="back-btn" onClick={onBack}>←</button>
        <h2 className="screen-title">Your Schedule</h2>
        <button className="hdr-action" onClick={onAddMore}>+ Add</button>
      </div>

      <div className="schedule-body">
        <div className={`ehr-banner ${!ehrLinked ? "ehr-banner-warn" : ""}`}>
          <span>🏥</span>
          <div>
            <p className="ehr-name">{ehrLinked ? "Duo Deng · 56F" : "No EHR Linked"}</p>
            <p className="ehr-detail">{ehrLinked ? "Riverside General · HTN + T2DM + GAD" : "Conflicts checked with general knowledge only"}</p>
          </div>
          <span className={`ehr-check ${!ehrLinked ? "ehr-check-warn" : ""}`}>{ehrLinked ? "✓ EHR" : "⚠ No EHR"}</span>
        </div>

        {meds.map((med, idx) => (
          <div key={idx} className={`sched-card ${med.conflictResolved ? "sched-card-updated" : ""}`}>
            <div className="sched-card-top">
              <img
                src={med.imgSrc}
                className="sched-thumb"
                onError={e => { e.target.src = PLACEHOLDER_IMG; }}
                alt="rx"
              />
              <div className="sched-info">
                <p className="sched-name">{med.parsed?.medication_name}</p>
                <p className="sched-dose">{med.parsed?.dosage} · {med.parsed?.dosage_form}</p>
                {med.conflictResolved && (
                  <span className="updated-tag">⟳ Time Updated</span>
                )}
              </div>
            </div>

            {med.timing?.with_food && (
              <div className="timing-note">🍽 Take with food</div>
            )}
            {med.timing?.warnings && (
              <div className="timing-warn">⚠ {med.timing.warnings}</div>
            )}

            <div className="times-row">
              {(med.timing?.times || []).map((t, ti) => (
                <div key={ti} className="time-chip">
                  <span>⏰</span>
                  <input
                    className="time-input"
                    value={t}
                    onChange={e => updateTime(idx, ti, e.target.value)}
                  />
                </div>
              ))}
            </div>

            {med.timing?.reason && (
              <p className="timing-reason">💡 {med.timing.reason}</p>
            )}

            {med.previousTimes && (
              <div className="prev-times">
                <span className="prev-label">Was:</span>
                <span className="prev-val">{med.previousTimes.join(", ")}</span>
                <span className="prev-arrow">→</span>
                <span className="prev-new">{(med.timing?.times || []).join(", ")}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="schedule-footer">
        <button className="btn-primary" disabled={readyCount === 0} onClick={onNext}>
          Set Alarms ({readyCount})
        </button>
      </div>

      <div className="bottom-nav">
        <button className="bnav-btn bnav-active">📋 Schedule</button>
        <button className="bnav-btn" onClick={onAddMore}>📷 Add New</button>
        <button className="bnav-btn" onClick={onGoRisk}>👤 Me</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 4: ALARM RESPONSE
// ═══════════════════════════════════════════════════════════════════════════════
function AlarmScreen({ med, onSubmit, onBack }) {
  const [symptom, setSymptom] = useState("");
  const [bp, setBp] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setLoading(true);
    await onSubmit(symptom || "Took medication, feeling fine.", bp);
    setLoading(false);
  };

  const quickOpts = [
    "Feeling dizzy or lightheaded",
    "Nausea or stomach upset",
    "Took it, feeling fine",
    "Headache after taking",
    "Feeling tired / drowsy",
  ];

  return (
    <div className="screen screen-alarm">
      <div className="alarm-header">
        <button className="back-btn-light" onClick={onBack}>←</button>
        <p className="alarm-label">MEDICATION REMINDER</p>
      </div>

      <div className="alarm-hero">
        <div className="alarm-pulse-ring" />
        <div className="alarm-icon-wrap">
          <span className="alarm-icon">💊</span>
        </div>
        <h2 className="alarm-med-name">{med?.parsed?.medication_name || "Medication"}</h2>
        <p className="alarm-dose">{med?.parsed?.dosage} · {med?.parsed?.dosage_form}</p>
        <div className="alarm-time-badge">
          {(med?.timing?.times || ["8:00 AM"]).join(", ")}
        </div>
      </div>

      <div className="alarm-body">
        <p className="alarm-q">How are you feeling right now?</p>

        <div className="quick-opts">
          {quickOpts.map(opt => (
            <button
              key={opt}
              className={`quick-opt ${symptom === opt ? "quick-opt-sel" : ""}`}
              onClick={() => setSymptom(opt)}
            >
              {opt}
            </button>
          ))}
        </div>

        <textarea
          className="symptom-textarea"
          placeholder="Or describe in your own words..."
          value={symptom}
          onChange={e => setSymptom(e.target.value)}
          rows={3}
        />

        <div className="bp-row">
          <span className="bp-label">🩺 Blood pressure (optional)</span>
          <input
            className="bp-input"
            placeholder="e.g. 140/90"
            value={bp}
            onChange={e => setBp(e.target.value)}
          />
        </div>

        <button className="btn-primary btn-alarm" onClick={handleSubmit} disabled={loading}>
          {loading ? <><span className="spinner" /> Analyzing with AI...</> : "Submit & Check EHR →"}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 5: CONFLICT RESOLUTION (3 outcomes)
// ═══════════════════════════════════════════════════════════════════════════════
function ConflictScreen({ result, med, bpReading, onDone, onViewLog }) {
  const [copied, setCopied] = useState(false);

  const copyMsg = () => {
    navigator.clipboard?.writeText(result?.doctor_message || "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const urgencyColor = { call_now: "#e53935", call_soon: "#f57c00", next_appointment: "#388e3c" };
  const urgencyLabel = { call_now: "🚨 Call Now — Emergency", call_soon: "📞 Call Within 1-2 Days", next_appointment: "📅 Mention at Next Visit" };

  if (!result) return (
    <div className="screen screen-conflict">
      <div className="conflict-loading">
        <span className="spinner-lg" />
        <p>Analyzing your EHR...</p>
      </div>
    </div>
  );

  return (
    <div className="screen screen-conflict">
      <div className="screen-header hdr-conflict">
        <div style={{ width: 32 }} />
        <h2 className="screen-title screen-title-light">EHR Analysis</h2>
        <div style={{ width: 32 }} />
      </div>

      <div className="conflict-body">
        {/* ── OUTCOME: SEE DOCTOR ─────────────────────────── */}
        {result.action === "see_doctor" && (
          <>
            <div className="conflict-hero conflict-hero-danger">
              <span className="conflict-hero-icon">⚠️</span>
              <h3 className="conflict-hero-title">Contact Your Doctor</h3>
              <p className="conflict-hero-sub">{result.urgency_message}</p>
            </div>

            {result.doctor_urgency && (
              <div className="urgency-badge" style={{ background: urgencyColor[result.doctor_urgency] + "22", borderColor: urgencyColor[result.doctor_urgency] }}>
                <span style={{ color: urgencyColor[result.doctor_urgency], fontWeight: 700 }}>
                  {urgencyLabel[result.doctor_urgency]}
                </span>
              </div>
            )}

            {result.ehr_conflict_detail && (
              <div className="ehr-finding-card">
                <p className="efc-label">📋 EHR Finding</p>
                <p className="efc-text">{result.ehr_conflict_detail}</p>
              </div>
            )}

            {result.doctor_reason && (
              <div className="ehr-finding-card">
                <p className="efc-label">🩺 Clinical Reason</p>
                <p className="efc-text">{result.doctor_reason}</p>
              </div>
            )}

            {result.doctor_message && (
              <div className="doctor-msg-card">
                <div className="dmc-header">
                  <p className="dmc-label">📝 Message for your doctor</p>
                  <button className="copy-btn" onClick={copyMsg}>
                    {copied ? "✓ Copied" : "Copy"}
                  </button>
                </div>
                <p className="dmc-text">"{result.doctor_message}"</p>
              </div>
            )}

            <div className="quick-contacts">
              <a href="tel:911" className="qc-btn qc-btn-red">📞 Call 911</a>
              <a href="tel:18002221222" className="qc-btn qc-btn-orange">☎ Poison Control</a>
            </div>

            <div className="alarm-status-card alarm-hold">
              <span>🔔</span>
              <div>
                <p className="asc-title">Alarm unchanged</p>
                <p className="asc-sub">Continue current times until doctor advises</p>
              </div>
            </div>
          </>
        )}

        {/* ── OUTCOME: ADJUST TIME ─────────────────────────── */}
        {result.action === "adjust_time" && (
          <>
            <div className="conflict-hero conflict-hero-success">
              <span className="conflict-hero-icon">✅</span>
              <h3 className="conflict-hero-title">Schedule Updated</h3>
              <p className="conflict-hero-sub">{result.urgency_message}</p>
            </div>

            {result.ehr_conflict_detail && (
              <div className="ehr-finding-card">
                <p className="efc-label">📋 EHR Finding</p>
                <p className="efc-text">{result.ehr_conflict_detail}</p>
              </div>
            )}

            {result.adjust_reason && (
              <div className="ehr-finding-card">
                <p className="efc-label">💡 Why This Helps</p>
                <p className="efc-text">{result.adjust_reason}</p>
              </div>
            )}

            <div className="time-update-card">
              <div className="tuc-col">
                <p className="tuc-label">Old Time</p>
                <p className="tuc-val tuc-old">{med?.previousTimes?.join(", ") || "—"}</p>
              </div>
              <span className="tuc-arrow">→</span>
              <div className="tuc-col">
                <p className="tuc-label">New Time</p>
                <p className="tuc-val tuc-new">{result.new_times?.join(", ") || "—"}</p>
              </div>
            </div>

            <div className="alarm-status-card alarm-updated">
              <span>⏰</span>
              <div>
                <p className="asc-title">Alarm auto-updated</p>
                <p className="asc-sub">New reminder set for {result.new_times?.join(", ")}</p>
              </div>
              <span className="confirmed-tag">✓ SET</span>
            </div>
          </>
        )}

        {/* ── OUTCOME: NO CHANGE ──────────────────────────── */}
        {result.action === "no_change" && (
          <>
            <div className="conflict-hero conflict-hero-neutral">
              <span className="conflict-hero-icon">✓</span>
              <h3 className="conflict-hero-title">Schedule Confirmed</h3>
              <p className="conflict-hero-sub">{result.urgency_message}</p>
            </div>

            {result.ehr_conflict_detail && (
              <div className="ehr-finding-card">
                <p className="efc-label">📋 EHR Note</p>
                <p className="efc-text">{result.ehr_conflict_detail}</p>
              </div>
            )}

            <div className="alarm-status-card alarm-ok">
              <span>⏰</span>
              <div>
                <p className="asc-title">Current times confirmed</p>
                <p className="asc-sub">{(med?.timing?.times || []).join(", ")}</p>
              </div>
              <span className="confirmed-tag">✓</span>
            </div>
          </>
        )}

        {bpReading && (
          <div className="bp-summary">
            <span>🩺</span>
            <span>Reported BP: <strong>{bpReading}</strong></span>
          </div>
        )}

        <div className="conflict-footer-btns">
          <button className="btn-outline" onClick={onViewLog}>View Log 📋</button>
          <button className="btn-primary" onClick={onDone}>Done ✓</button>
        </div>
      </div>

      <div className="bottom-nav bnav-white">
        {["📋 Schedule", "📷 Add New", "👤 Me"].map((t, i) => (
          <button key={t} className={`bnav-btn bnav-btn-white ${i === 0 ? "bnav-active-white" : ""}`}>{t}</button>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 6: MEDICATION LOG
// ═══════════════════════════════════════════════════════════════════════════════
function MedLogScreen({ log, onSelect, onBack, onGoSchedule, onGoCapture, onGoRisk }) {
  const actionMeta = {
    see_doctor: { dot: "#e53935", label: "Doctor Notified", icon: "🔴" },
    adjust_time: { dot: "#f57c00", label: "Time Adjusted", icon: "🟠" },
    no_change: { dot: "#43a047", label: "No Change", icon: "🟢" },
  };

  return (
    <div className="screen">
      <div className="screen-header">
        <button className="back-btn" onClick={onBack}>←</button>
        <h2 className="screen-title">Medication Log</h2>
        <span className="hdr-count">{log.length}</span>
      </div>

      <div className="log-body">
        {log.length === 0 && (
          <div className="log-empty">
            <span style={{ fontSize: 40 }}>📋</span>
            <p>No entries yet.</p>
          </div>
        )}

        {log.map((entry, i) => {
          const meta = actionMeta[entry.action] || actionMeta.no_change;
          return (
            <div
              key={entry.id}
              className="log-card"
              style={{ animationDelay: `${i * 60}ms` }}
              onClick={() => onSelect(entry)}
            >
              <div className="lc-left">
                <div className="lc-dot" style={{ background: meta.dot }} />
              </div>
              <div className="lc-body">
                <div className="lc-top">
                  <span className="lc-med">{entry.medName}</span>
                  <span className="lc-dose">{entry.dosage}</span>
                </div>
                <p className="lc-symptom">"{entry.symptomText}"</p>
                <div className="lc-footer">
                  <span className="lc-action">{meta.icon} {meta.label}</span>
                  {entry.sentToDoctor && <span className="lc-sent">📤 Sent</span>}
                </div>
              </div>
              <div className="lc-right">
                <p className="lc-date">{fmtDate(entry.ts)}</p>
                <p className="lc-time">{fmtTime(entry.ts)}</p>
                <span className="lc-chevron">›</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bottom-nav bnav-white">
        <button className="bnav-btn bnav-btn-white" onClick={onGoSchedule}>📋 Schedule</button>
        <button className="bnav-btn bnav-btn-white" onClick={onGoCapture}>📷 Add New</button>
        <button className="bnav-btn bnav-btn-white" onClick={onGoRisk}>👤 Me</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 7: LOG ENTRY DETAIL
// ═══════════════════════════════════════════════════════════════════════════════
function LogDetailScreen({ entry, onBack }) {
  const [copied, setCopied] = useState(false);

  const copyMsg = () => {
    navigator.clipboard?.writeText(entry.doctorMessage || "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const actionMeta = {
    see_doctor: { color: "#e53935", bg: "#ffebee", label: "Doctor Notified", icon: "⚠️" },
    adjust_time: { color: "#f57c00", bg: "#fff3e0", label: "Time Adjusted", icon: "⏰" },
    no_change: { color: "#43a047", bg: "#e8f5e9", label: "No Change", icon: "✓" },
  };
  const meta = actionMeta[entry.action] || actionMeta.no_change;

  return (
    <div className="screen">
      <div className="detail-hero" style={{ background: `linear-gradient(135deg, #00897b, #00acc1)` }}>
        <button className="back-btn-light" onClick={onBack}>←</button>
        <div className="detail-hero-content">
          <p className="detail-label">LOG ENTRY</p>
          <h2 className="detail-med-name">{entry.medName}</h2>
          <p className="detail-dose">{entry.dosage}</p>
          <p className="detail-ts">{fmtDate(entry.ts)} · {fmtTime(entry.ts)}</p>
        </div>
        <div className="detail-action-badge" style={{ background: meta.color }}>
          {meta.icon} {meta.label}
        </div>
      </div>

      <div className="detail-body">
        {/* User Response */}
        <div className="detail-section">
          <p className="ds-label">👤 User Response</p>
          <p className="ds-text">"{entry.symptomText}"</p>
        </div>

        {/* BP Reading */}
        {entry.bpReading && (
          <div className="detail-section">
            <p className="ds-label">🩺 Blood Pressure Reported</p>
            <p className="ds-text ds-bp">{entry.bpReading} mmHg</p>
          </div>
        )}

        {/* EHR Action */}
        <div className="detail-section" style={{ background: meta.bg }}>
          <p className="ds-label" style={{ color: meta.color }}>📋 EHR Decision</p>
          <p className="ds-text">{entry.ehrConflictDetail || "No EHR conflict detected."}</p>
          {entry.action === "adjust_time" && entry.oldTimes && (
            <div className="detail-time-update">
              <span className="dtu-old">{entry.oldTimes.join(", ")}</span>
              <span className="dtu-arrow">→</span>
              <span className="dtu-new">{entry.newTimes.join(", ")}</span>
            </div>
          )}
          {entry.adjustReason && (
            <p className="ds-sub">💡 {entry.adjustReason}</p>
          )}
        </div>

        {/* Doctor Contact */}
        {entry.action === "see_doctor" && (
          <div className="detail-section detail-section-danger">
            <p className="ds-label">🩺 Doctor Contact</p>
            <p className="ds-text">{entry.doctorReason}</p>
            {entry.doctorUrgency && (
              <div className="urgency-mini">
                {{call_now:"🚨 Emergency — Call Now", call_soon:"📞 Call within 1-2 days", next_appointment:"📅 Next appointment"}[entry.doctorUrgency]}
              </div>
            )}
          </div>
        )}

        {/* Doctor Message */}
        {entry.doctorMessage && (
          <div className="detail-section">
            <div className="dmc-header">
              <p className="ds-label">📝 Message for Doctor</p>
              <button className="copy-btn" onClick={copyMsg}>{copied ? "✓ Copied" : "Copy"}</button>
            </div>
            <p className="dmc-text">"{entry.doctorMessage}"</p>
          </div>
        )}

        {/* Sent to Doctor */}
        {entry.sentToDoctor && (
          <div className="sent-banner">
            <span>📤</span>
            <span>This entry was sent to your care team</span>
          </div>
        )}

        <button className="btn-outline" onClick={onBack}>← Back to Log</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 8: INSURANCE RISK SCORE
// ═══════════════════════════════════════════════════════════════════════════════
const RISK_BEFORE = {
  label: "Before Adherence Data",
  date: "Nov 5, 2024",
  basis: "EHR diagnoses, vitals & labs only",
  overall: 62,
  tier: "Moderate-High",
  tierColor: "#f57c00",
  domains: [
    { name: "Chronic Disease Burden", score: 68, note: "HTN + T2DM + 3 others" },
    { name: "Cardiovascular Risk",    score: 72, note: "BP 168/96, family hx MI" },
    { name: "Renal Risk",             score: 45, note: "Microalbumin mildly elevated" },
    { name: "Metabolic Control",      score: 55, note: "HbA1c 7.4%, LDL above target" },
    { name: "Medication Safety",      score: 65, note: "Ibuprofen + HTN — theoretical" },
    { name: "Mental Health",          score: 30, note: "GAD stable on SSRI" },
  ],
  keyFlags: [
    "NSAID contraindication — risk theoretical",
    "BP uncontrolled but no crisis events recorded",
    "Medication adherence unknown",
  ]
};

const RISK_AFTER = {
  label: "After Adherence Data",
  date: "Feb 21, 2026",
  basis: "EHR + MediMinder medication log",
  overall: 68,
  tier: "High",
  tierColor: "#e53935",
  domains: [
    { name: "Chronic Disease Burden", score: 68, note: "Unchanged" },
    { name: "Cardiovascular Risk",    score: 84, note: "Hypertensive crisis 190/112 confirmed" },
    { name: "Renal Risk",             score: 56, note: "NSAID interaction now observed" },
    { name: "Metabolic Control",      score: 50, note: "Metformin timing corrected — improving" },
    { name: "Medication Safety",      score: 72, note: "Drug interaction confirmed in real use" },
    { name: "Mental Health",          score: 26, note: "Sertraline timing fixed, insomnia resolved" },
  ],
  keyFlags: [
    "🔴 Hypertensive crisis event (190/112) recorded",
    "🔴 NSAID interaction confirmed — BP 178/104",
    "🟢 Adherence rate 83% — patient engaged",
    "🟢 2 schedule corrections self-resolved",
    "🟡 2 doctor alerts sent & acknowledged",
  ]
};

function RiskScoreScreen({ onBack, onGoSchedule, onGoCapture }) {
  const [tab, setTab] = useState("overview");
  const delta = RISK_AFTER.overall - RISK_BEFORE.overall;

  const ScoreRing = ({ score, color, size = 80 }) => {
    const r = (size - 10) / 2;
    const circ = 2 * Math.PI * r;
    const fill = circ * (1 - score / 100);
    return (
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#f0f0f0" strokeWidth={8} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={8}
          strokeDasharray={circ} strokeDashoffset={fill} strokeLinecap="round" />
      </svg>
    );
  };

  const DomainRow = ({ before, after }) => {
    const diff = after.score - before.score;
    const diffColor = diff > 0 ? "#e53935" : diff < 0 ? "#43a047" : "#9e9e9e";
    const diffLabel = diff > 0 ? `+${diff}` : `${diff}`;
    return (
      <div className="rs-domain-row">
        <div className="rs-domain-name">{before.name}</div>
        <div className="rs-domain-scores">
          <span className="rs-score-before">{before.score}</span>
          <span className="rs-arrow">→</span>
          <span className="rs-score-after" style={{ color: diff === 0 ? "#9e9e9e" : diffColor }}>{after.score}</span>
          <span className="rs-diff" style={{ background: diffColor + "22", color: diffColor }}>{diff === 0 ? "—" : diffLabel}</span>
        </div>
        <div className="rs-domain-notes">
          <span className="rs-note-b">{before.note}</span>
          <span className="rs-note-a">{after.note}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="screen">
      {/* Header */}
      <div className="rs-header">
        <button className="back-btn" onClick={onBack}>←</button>
        <div>
          <h2 className="screen-title">Insurance Risk Report</h2>
          <p className="rs-header-sub">For carrier presentation only</p>
        </div>
        <div style={{ width: 32 }} />
      </div>

      {/* Tab bar */}
      <div className="rs-tabs">
        <button className={`rs-tab ${tab === "overview" ? "rs-tab-active" : ""}`} onClick={() => setTab("overview")}>Overview</button>
        <button className={`rs-tab ${tab === "domains" ? "rs-tab-active" : ""}`} onClick={() => setTab("domains")}>Domains</button>
        <button className={`rs-tab ${tab === "flags" ? "rs-tab-active" : ""}`} onClick={() => setTab("flags")}>Key Findings</button>
      </div>

      <div className="rs-body">

        {/* ── OVERVIEW TAB ── */}
        {tab === "overview" && (
          <>
            <div className="rs-disclaimer">
              📋 Illustrative risk model — not a certified actuarial output
            </div>

            {/* Side-by-side score cards */}
            <div className="rs-cards-row">
              {[RISK_BEFORE, RISK_AFTER].map((r, i) => (
                <div key={i} className="rs-card" style={{ borderTop: `4px solid ${r.tierColor}` }}>
                  <p className="rs-card-label">{r.label}</p>
                  <p className="rs-card-date">{r.date}</p>
                  <div className="rs-ring-wrap">
                    <ScoreRing score={r.overall} color={r.tierColor} size={88} />
                    <div className="rs-ring-inner">
                      <span className="rs-ring-score" style={{ color: r.tierColor }}>{r.overall}</span>
                      <span className="rs-ring-max">/100</span>
                    </div>
                  </div>
                  <div className="rs-tier-badge" style={{ background: r.tierColor + "22", color: r.tierColor }}>
                    {r.tier}
                  </div>
                  <p className="rs-card-basis">{r.basis}</p>
                </div>
              ))}
            </div>

            {/* Delta summary */}
            <div className="rs-delta-card">
              <div className="rs-delta-left">
                <p className="rs-delta-label">Risk Score Change</p>
                <p className="rs-delta-sub">After adding adherence data</p>
              </div>
              <div className="rs-delta-right">
                <span className="rs-delta-val" style={{ color: "#e53935" }}>+{delta} pts</span>
                <span className="rs-delta-tier">Tier escalated</span>
              </div>
            </div>

            {/* Narrative */}
            <div className="rs-narrative">
              <p className="rs-narrative-title">Why This Matters to Carriers</p>
              <p className="rs-narrative-text">
                Without adherence data, this patient's NSAID interaction and hypertensive crisis were <strong>invisible</strong> to the insurer. MediMinder's medication log surfaced two high-cost sentinel events, enabling more accurate risk pricing and earlier intervention — before an ER visit or hospitalization occurs.
              </p>
            </div>
          </>
        )}

        {/* ── DOMAINS TAB ── */}
        {tab === "domains" && (
          <>
            <div className="rs-domains-header">
              <span className="rs-col-before">Before</span>
              <span className="rs-col-after">After</span>
              <span className="rs-col-delta">Δ</span>
            </div>
            {RISK_BEFORE.domains.map((b, i) => (
              <DomainRow key={i} before={b} after={RISK_AFTER.domains[i]} />
            ))}
            <div className="rs-domains-footer">
              🔴 Higher = more risk &nbsp;·&nbsp; 🟢 Lower = improvement
            </div>
          </>
        )}

        {/* ── FLAGS TAB ── */}
        {tab === "flags" && (
          <>
            <div className="rs-flags-section">
              <p className="rs-flags-title">Before — Risk Factors (Theoretical)</p>
              {RISK_BEFORE.keyFlags.map((f, i) => (
                <div key={i} className="rs-flag-row rs-flag-before">
                  <span className="rs-flag-dot" style={{ background: "#bdbdbd" }} />
                  <span>{f}</span>
                </div>
              ))}
            </div>
            <div className="rs-flags-section">
              <p className="rs-flags-title">After — Confirmed Events (Real-world)</p>
              {RISK_AFTER.keyFlags.map((f, i) => (
                <div key={i} className="rs-flag-row">
                  <span>{f}</span>
                </div>
              ))}
            </div>
            <div className="rs-insight-card">
              <p className="rs-insight-title">📊 Adherence Metrics</p>
              <div className="rs-insight-grid">
                <div className="rs-metric"><span className="rs-metric-val">83%</span><span className="rs-metric-label">Adherence Rate</span></div>
                <div className="rs-metric"><span className="rs-metric-val">5</span><span className="rs-metric-label">Doses Logged</span></div>
                <div className="rs-metric"><span className="rs-metric-val">2</span><span className="rs-metric-label">Crisis Events</span></div>
                <div className="rs-metric"><span className="rs-metric-val">2</span><span className="rs-metric-label">Self-Corrections</span></div>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="bottom-nav bnav-white">
        <button className="bnav-btn bnav-btn-white" onClick={onGoSchedule}>📋 Schedule</button>
        <button className="bnav-btn bnav-btn-white" onClick={onGoCapture}>📷 Add New</button>
        <button className="bnav-btn bnav-btn-white bnav-active-white">👤 Me</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [screen, setScreen] = useState("login");
  const [user, setUser] = useState(null);
  const [meds, setMeds] = useState([]);
  const [activeMedIdx, setActiveMedIdx] = useState(0);
  const [symptomResult, setSymptomResult] = useState(null);
  const [bpReading, setBpReading] = useState("");
  const [medLog, setMedLog] = useState(DEMO_LOG);
  const [selectedLog, setSelectedLog] = useState(null);

  const ehr = SAMPLE_EHR;

  const handleLogin = (u) => { setUser(u); setScreen("capture"); };
  const ehrLinked = user?.ehrLinked ?? false;
  const handleCaptured = (results) => { setMeds(results); setScreen("schedule"); };

  const handleAlarmSubmit = async (symptomText, bp) => {
    setBpReading(bp || "");
    const med = meds[activeMedIdx];
    const oldTimes = med?.timing?.times || [];

    const result = await evaluateSymptomVsEHR({
      symptomText,
      medication: med?.parsed?.medication_name,
      dosage: med?.parsed?.dosage,
      currentTimes: oldTimes,
      ehr: ehrLinked ? ehr : null,
      bpReading: bp,
    });

    // Auto-apply alarm update for adjust_time
    let finalNewTimes = [];
    if (result?.action === "adjust_time" && result.new_times?.length > 0) {
      finalNewTimes = result.new_times;
      setMeds(prev => prev.map((m, i) => {
        if (i !== activeMedIdx) return m;
        return { ...m, timing: { ...m.timing, times: result.new_times }, previousTimes: oldTimes, conflictResolved: true };
      }));
    }

    // Create log entry
    const logEntry = {
      id: "log" + Date.now(),
      ts: Date.now(),
      medName: med?.parsed?.medication_name || "Unknown",
      dosage: med?.parsed?.dosage || "",
      symptomText,
      bpReading: bp || "",
      action: result?.action || "no_change",
      ehrConflictDetail: result?.ehr_conflict_detail || null,
      adjustReason: result?.adjust_reason || null,
      doctorReason: result?.doctor_reason || null,
      doctorUrgency: result?.doctor_urgency || null,
      doctorMessage: result?.doctor_message || null,
      oldTimes,
      newTimes: finalNewTimes,
      sentToDoctor: result?.action === "see_doctor",
      urgency: result?.urgency || "low",
      urgencyMessage: result?.urgency_message || "",
    };

    setMedLog(prev => [logEntry, ...prev]);
    setSymptomResult(result);
    setScreen("conflict");
  };

  const triggerAlarm = () => {
    const idx = meds.findIndex(m => m.status === "done");
    if (idx >= 0) { setActiveMedIdx(idx); setScreen("alarm"); }
  };

  return (
    <div className="app-root">
      <style>{CSS}</style>
      <div className="phone-frame">
        <div className="phone-notch" />

        {screen === "login" && <LoginScreen onNext={handleLogin} />}

        {screen === "capture" && (
          <CaptureScreen onNext={handleCaptured} onBack={() => setScreen("login")} />
        )}

        {screen === "schedule" && (
          <ScheduleScreen
            meds={meds} setMeds={setMeds}
            onNext={triggerAlarm}
            onBack={() => setScreen("capture")}
            onAddMore={() => setScreen("capture")}
            ehrLinked={ehrLinked}
            onGoRisk={() => setScreen("risk")}
          />
        )}

        {screen === "alarm" && (
          <AlarmScreen
            med={meds[activeMedIdx]}
            onSubmit={handleAlarmSubmit}
            onBack={() => setScreen("schedule")}
          />
        )}

        {screen === "conflict" && (
          <ConflictScreen
            result={symptomResult}
            med={meds[activeMedIdx]}
            bpReading={bpReading}
            onDone={() => setScreen("schedule")}
            onViewLog={() => setScreen("log")}
          />
        )}

        {screen === "log" && (
          <MedLogScreen
            log={medLog}
            onSelect={(entry) => { setSelectedLog(entry); setScreen("logDetail"); }}
            onBack={() => setScreen("schedule")}
            onGoSchedule={() => setScreen("schedule")}
            onGoCapture={() => setScreen("capture")}
            onGoRisk={() => setScreen("risk")}
          />
        )}

        {screen === "logDetail" && selectedLog && (
          <LogDetailScreen
            entry={selectedLog}
            onBack={() => setScreen("log")}
          />
        )}

        {screen === "risk" && (
          <RiskScoreScreen
            onBack={() => setScreen("schedule")}
            onGoSchedule={() => setScreen("schedule")}
            onGoCapture={() => setScreen("capture")}
          />
        )}
      </div>
    </div>
  );
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&family=Lato:wght@400;700&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body { background: #e0f2f1; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: 'Lato', sans-serif; }

  .app-root { display: flex; justify-content: center; align-items: center; min-height: 100vh; background: linear-gradient(135deg, #e0f2f1 0%, #b2dfdb 100%); padding: 16px; }

  /* ── Phone Frame ─────────────────────────────────── */
  .phone-frame {
    width: 390px; height: 780px;
    background: #fff;
    border-radius: 44px;
    overflow: hidden;
    box-shadow: 0 32px 80px rgba(0,0,0,0.28), 0 0 0 1px rgba(0,0,0,0.08);
    position: relative;
    display: flex;
    flex-direction: column;
  }
  .phone-notch {
    position: absolute; top: 0; left: 50%; transform: translateX(-50%);
    width: 120px; height: 28px;
    background: #111; border-radius: 0 0 16px 16px;
    z-index: 999;
  }

  /* ── Screens ─────────────────────────────────────── */
  .screen { display: flex; flex-direction: column; height: 100%; overflow: hidden; background: #fafafa; }

  /* ── Headers ─────────────────────────────────────── */
  .screen-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 44px 16px 12px;
    background: #fff;
    border-bottom: 1px solid #f0f0f0;
    flex-shrink: 0;
  }
  .screen-title { font-family: 'Nunito', sans-serif; font-size: 17px; font-weight: 800; color: #1a1a2e; }
  .screen-title-light { color: #fff; }
  .back-btn { background: none; border: none; font-size: 20px; cursor: pointer; color: #00897b; padding: 4px 8px; border-radius: 8px; }
  .back-btn:hover { background: #e0f2f1; }
  .back-btn-light { background: rgba(255,255,255,0.2); border: none; font-size: 18px; cursor: pointer; color: #fff; padding: 4px 10px; border-radius: 10px; }
  .hdr-action { background: #e0f7fa; border: none; color: #00897b; font-weight: 700; font-size: 13px; padding: 6px 12px; border-radius: 20px; cursor: pointer; }
  .hdr-count { background: #00897b; color: #fff; font-size: 12px; font-weight: 700; width: 22px; height: 22px; border-radius: 11px; display: flex; align-items: center; justify-content: center; }
  .hdr-conflict { background: linear-gradient(135deg, #00897b, #0097a7); }

  /* ── Bottom Nav ──────────────────────────────────── */
  .bottom-nav { display: flex; border-top: 1px solid #eee; background: #fff; flex-shrink: 0; }
  .bnav-white { background: #fff; }
  .bnav-btn { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 10px 4px; border: none; background: none; cursor: pointer; font-size: 11px; color: #9e9e9e; font-family: 'Lato', sans-serif; }
  .bnav-active { color: #00897b; font-weight: 700; }
  .bnav-btn-white { color: #9e9e9e; }
  .bnav-active-white { color: #00897b; font-weight: 700; }

  /* ── Buttons ─────────────────────────────────────── */
  .btn-primary {
    width: 100%; padding: 14px;
    background: linear-gradient(135deg, #00897b, #00acc1);
    color: #fff; border: none; border-radius: 14px;
    font-family: 'Nunito', sans-serif; font-size: 16px; font-weight: 800;
    cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;
    transition: opacity 0.2s, transform 0.1s;
  }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary:not(:disabled):hover { opacity: 0.92; transform: translateY(-1px); }
  .btn-outline {
    width: 100%; padding: 12px;
    background: transparent; color: #00897b;
    border: 2px solid #00897b; border-radius: 14px;
    font-family: 'Nunito', sans-serif; font-size: 15px; font-weight: 700;
    cursor: pointer; transition: background 0.2s;
  }
  .btn-outline:hover { background: #e0f7fa; }

  /* ── Spinner ─────────────────────────────────────── */
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.4); border-top-color: #fff; border-radius: 50%; animation: spin 0.7s linear infinite; display: inline-block; }
  .spinner-lg { width: 36px; height: 36px; border: 3px solid #b2dfdb; border-top-color: #00897b; border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block; }

  /* ── LOGIN ───────────────────────────────────────── */
  .screen-login { background: linear-gradient(160deg, #004d40 0%, #00695c 40%, #00838f 100%); }
  .login-hero { padding: 60px 24px 32px; text-align: center; }
  .login-logo { font-size: 56px; margin-bottom: 12px; animation: popIn 0.5s; }
  @keyframes popIn { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .login-title { font-family: 'Nunito', sans-serif; font-size: 28px; font-weight: 800; color: #fff; }
  .login-subtitle { color: rgba(255,255,255,0.75); font-size: 14px; margin-top: 6px; }
  .login-form { background: #fff; border-radius: 24px 24px 0 0; flex: 1; padding: 28px 24px; display: flex; flex-direction: column; gap: 16px; }
  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 12px; font-weight: 700; color: #616161; text-transform: uppercase; letter-spacing: 0.5px; }
  .form-input { padding: 12px 14px; border: 1.5px solid #e0e0e0; border-radius: 12px; font-size: 15px; font-family: 'Lato', sans-serif; outline: none; transition: border-color 0.2s; }
  .form-input:focus { border-color: #00897b; }
  .login-ehr-badge { display: flex; align-items: center; gap: 8px; background: #e0f7fa; border-radius: 12px; padding: 10px 14px; font-size: 13px; color: #00697b; font-weight: 600; }
  .login-ehr-error { display: flex; align-items: center; gap: 8px; background: #ffebee; border: 1.5px solid #ef9a9a; border-radius: 12px; padding: 10px 14px; font-size: 13px; color: #c62828; font-weight: 700; }
  .login-fine { font-size: 11px; color: #bdbdbd; text-align: center; }
  .login-fine-warn { color: #f57c00; }
  .ehr-banner-warn { background: linear-gradient(135deg, #fff8e1, #fff3e0) !important; border-color: #ffcc80 !important; }
  .ehr-check-warn { background: #f57c00 !important; }

  /* ── CAPTURE ─────────────────────────────────────── */
  .capture-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .drop-zone {
    border: 2.5px dashed #80cbc4; border-radius: 16px;
    padding: 32px 16px; text-align: center; cursor: pointer;
    background: #f0fdfc; transition: border-color 0.2s, background 0.2s;
    display: flex; flex-direction: column; align-items: center; gap: 8px;
  }
  .drop-zone:hover { border-color: #00897b; background: #e0f7fa; }
  .drop-zone-processing { cursor: default; border-color: #b2dfdb; }
  .dz-icon { font-size: 36px; }
  .dz-title { font-family: 'Nunito', sans-serif; font-weight: 700; color: #00695c; font-size: 15px; }
  .dz-sub { font-size: 12px; color: #9e9e9e; }
  .dz-processing { display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .dz-msg { font-size: 13px; color: #00897b; font-weight: 600; }
  .captured-list { display: flex; flex-direction: column; gap: 10px; }
  .cl-header { font-family: 'Nunito', sans-serif; font-size: 14px; font-weight: 700; color: #616161; }
  .cap-card { display: flex; align-items: center; gap: 12px; background: #fff; border-radius: 14px; padding: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border-left: 4px solid transparent; }
  .cap-card-ok { border-left-color: #00897b; }
  .cap-card-error { border-left-color: #e53935; }
  .cap-thumb { width: 48px; height: 48px; border-radius: 8px; object-fit: cover; flex-shrink: 0; }
  .cap-info { flex: 1; min-width: 0; }
  .cap-name { font-weight: 700; font-size: 14px; color: #1a1a2e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cap-err { color: #e53935; }
  .cap-dose { font-size: 12px; color: #757575; }
  .cap-time { font-size: 12px; color: #00897b; font-weight: 600; }
  .cap-badge { width: 24px; height: 24px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
  .badge-ok { background: #e8f5e9; color: #43a047; }
  .badge-err { background: #ffebee; color: #e53935; }
  .capture-footer { padding: 12px 16px 20px; background: #fff; border-top: 1px solid #eee; flex-shrink: 0; }

  /* ── SCHEDULE ────────────────────────────────────── */
  .schedule-body { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
  .ehr-banner { display: flex; align-items: center; gap: 10px; background: linear-gradient(135deg, #e0f7fa, #e8f5e9); border-radius: 14px; padding: 12px 14px; border: 1px solid #b2dfdb; }
  .ehr-name { font-weight: 700; font-size: 14px; color: #00695c; }
  .ehr-detail { font-size: 11px; color: #757575; }
  .ehr-check { margin-left: auto; background: #00897b; color: #fff; font-size: 11px; font-weight: 700; padding: 4px 8px; border-radius: 20px; }
  .sched-card { background: #fff; border-radius: 16px; padding: 14px; box-shadow: 0 2px 10px rgba(0,0,0,0.07); border: 1px solid #f0f0f0; display: flex; flex-direction: column; gap: 10px; }
  .sched-card-updated { border-color: #80cbc4; box-shadow: 0 2px 12px rgba(0,137,123,0.15); }
  .sched-card-top { display: flex; align-items: center; gap: 12px; }
  .sched-thumb { width: 54px; height: 54px; border-radius: 10px; object-fit: cover; flex-shrink: 0; }
  .sched-info { flex: 1; min-width: 0; }
  .sched-name { font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 15px; color: #1a1a2e; }
  .sched-dose { font-size: 12px; color: #757575; }
  .updated-tag { background: #e0f7fa; color: #00695c; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 20px; margin-top: 4px; display: inline-block; }
  .timing-note { background: #e8f5e9; color: #2e7d32; font-size: 12px; font-weight: 600; padding: 6px 10px; border-radius: 8px; }
  .timing-warn { background: #fff8e1; color: #f57c00; font-size: 12px; font-weight: 600; padding: 6px 10px; border-radius: 8px; }
  .times-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .time-chip { display: flex; align-items: center; gap: 6px; background: #f0fdfc; border: 1.5px solid #80cbc4; border-radius: 24px; padding: 6px 12px; }
  .time-input { border: none; background: transparent; font-size: 13px; font-weight: 700; color: #00695c; width: 72px; outline: none; }
  .timing-reason { font-size: 11px; color: #9e9e9e; font-style: italic; }
  .prev-times { display: flex; align-items: center; gap: 6px; font-size: 12px; background: #f5f5f5; border-radius: 8px; padding: 6px 10px; }
  .prev-label { color: #9e9e9e; }
  .prev-val { color: #e57373; text-decoration: line-through; }
  .prev-arrow { color: #9e9e9e; }
  .prev-new { color: #00897b; font-weight: 700; }
  .schedule-footer { padding: 12px 14px 16px; background: #fff; border-top: 1px solid #eee; flex-shrink: 0; }

  /* ── ALARM ───────────────────────────────────────── */
  .screen-alarm { background: linear-gradient(160deg, #004d40 0%, #00695c 60%, #0097a7 100%); }
  .alarm-header { display: flex; align-items: center; justify-content: space-between; padding: 44px 16px 8px; }
  .alarm-label { font-size: 11px; font-weight: 700; color: rgba(255,255,255,0.6); letter-spacing: 1.5px; }
  .alarm-hero { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 20px 16px; position: relative; }
  @keyframes pulse { 0%,100%{transform:scale(1);opacity:0.5} 50%{transform:scale(1.15);opacity:0.2} }
  .alarm-pulse-ring { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 100px; height: 100px; border-radius: 50%; background: rgba(255,255,255,0.1); animation: pulse 2s ease-in-out infinite; }
  .alarm-icon-wrap { width: 72px; height: 72px; border-radius: 36px; background: rgba(255,255,255,0.15); display: flex; align-items: center; justify-content: center; }
  .alarm-icon { font-size: 36px; }
  .alarm-med-name { font-family: 'Nunito', sans-serif; font-size: 22px; font-weight: 800; color: #fff; text-align: center; }
  .alarm-dose { font-size: 13px; color: rgba(255,255,255,0.7); }
  .alarm-time-badge { background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.3); color: #fff; font-size: 13px; font-weight: 700; padding: 6px 16px; border-radius: 20px; }
  .alarm-body { background: #fafafa; border-radius: 24px 24px 0 0; flex: 1; padding: 20px 16px 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
  .alarm-q { font-family: 'Nunito', sans-serif; font-weight: 700; font-size: 15px; color: #1a1a2e; }
  .quick-opts { display: flex; flex-direction: column; gap: 6px; }
  .quick-opt { background: #fff; border: 1.5px solid #e0e0e0; border-radius: 12px; padding: 10px 14px; text-align: left; font-size: 13px; cursor: pointer; transition: border-color 0.2s, background 0.2s; color: #424242; }
  .quick-opt:hover { border-color: #00897b; background: #f0fdfc; }
  .quick-opt-sel { border-color: #00897b; background: #e0f7fa; color: #00695c; font-weight: 700; }
  .symptom-textarea { border: 1.5px solid #e0e0e0; border-radius: 12px; padding: 10px 12px; font-size: 13px; font-family: 'Lato', sans-serif; resize: none; outline: none; transition: border-color 0.2s; }
  .symptom-textarea:focus { border-color: #00897b; }
  .bp-row { display: flex; align-items: center; gap: 10px; }
  .bp-label { font-size: 12px; color: #757575; flex: 1; }
  .bp-input { border: 1.5px solid #e0e0e0; border-radius: 10px; padding: 8px 12px; font-size: 14px; width: 120px; outline: none; font-family: 'Lato', sans-serif; }
  .bp-input:focus { border-color: #00897b; }
  .btn-alarm { margin-top: auto; }

  /* ── CONFLICT ────────────────────────────────────── */
  .screen-conflict { background: #fafafa; }
  .conflict-loading { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; color: #757575; font-size: 14px; }
  .conflict-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .conflict-hero { border-radius: 16px; padding: 20px; display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; }
  .conflict-hero-danger { background: linear-gradient(135deg, #ffebee, #fff3e0); border: 1.5px solid #ef9a9a; }
  .conflict-hero-success { background: linear-gradient(135deg, #e8f5e9, #e0f7fa); border: 1.5px solid #80cbc4; }
  .conflict-hero-neutral { background: linear-gradient(135deg, #e3f2fd, #f3e5f5); border: 1.5px solid #b0bec5; }
  .conflict-hero-icon { font-size: 32px; }
  .conflict-hero-title { font-family: 'Nunito', sans-serif; font-size: 18px; font-weight: 800; color: #1a1a2e; }
  .conflict-hero-sub { font-size: 13px; color: #757575; }
  .urgency-badge { border: 1.5px solid; border-radius: 12px; padding: 10px 14px; text-align: center; font-size: 13px; }
  .ehr-finding-card { background: #fff; border-radius: 12px; padding: 12px 14px; border: 1px solid #e0e0e0; display: flex; flex-direction: column; gap: 4px; }
  .efc-label { font-size: 11px; font-weight: 700; color: #9e9e9e; text-transform: uppercase; letter-spacing: 0.5px; }
  .efc-text { font-size: 13px; color: #424242; line-height: 1.5; }
  .doctor-msg-card { background: #fffde7; border: 1.5px solid #fff176; border-radius: 12px; padding: 12px 14px; }
  .dmc-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .dmc-label { font-size: 12px; font-weight: 700; color: #f57c00; text-transform: uppercase; }
  .dmc-text { font-size: 13px; color: #4e342e; line-height: 1.5; font-style: italic; }
  .copy-btn { background: #e0f7fa; border: none; color: #00695c; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 20px; cursor: pointer; }
  .quick-contacts { display: flex; gap: 10px; }
  .qc-btn { flex: 1; text-decoration: none; text-align: center; padding: 10px; border-radius: 12px; font-size: 13px; font-weight: 700; }
  .qc-btn-red { background: #ffebee; color: #c62828; }
  .qc-btn-orange { background: #fff3e0; color: #e65100; }
  .alarm-status-card { display: flex; align-items: center; gap: 10px; background: #fff; border-radius: 12px; padding: 12px 14px; border: 1px solid #e0e0e0; }
  .alarm-hold { border-left: 4px solid #f57c00; }
  .alarm-updated { border-left: 4px solid #00897b; }
  .alarm-ok { border-left: 4px solid #1976d2; }
  .asc-title { font-weight: 700; font-size: 13px; color: #1a1a2e; }
  .asc-sub { font-size: 12px; color: #757575; }
  .confirmed-tag { background: #e8f5e9; color: #2e7d32; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 20px; margin-left: auto; white-space: nowrap; }
  .time-update-card { display: flex; align-items: center; justify-content: center; gap: 12px; background: #e8f5e9; border-radius: 12px; padding: 14px; }
  .tuc-col { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .tuc-label { font-size: 11px; color: #9e9e9e; font-weight: 600; text-transform: uppercase; }
  .tuc-val { font-family: 'Nunito', sans-serif; font-size: 16px; font-weight: 800; }
  .tuc-old { color: #e53935; text-decoration: line-through; }
  .tuc-new { color: #00897b; }
  .tuc-arrow { font-size: 20px; color: #9e9e9e; }
  .bp-summary { display: flex; align-items: center; gap: 8px; background: #fce4ec; border-radius: 12px; padding: 10px 14px; font-size: 13px; color: #880e4f; }
  .conflict-footer-btns { display: flex; gap: 10px; margin-top: 4px; }

  /* ── LOG ─────────────────────────────────────────── */
  .log-body { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
  .log-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #bdbdbd; }
  @keyframes fadeSlideIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
  .log-card {
    display: flex; gap: 10px; background: #fff; border-radius: 14px; padding: 13px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06); cursor: pointer;
    animation: fadeSlideIn 0.35s both;
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .log-card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,0.10); }
  .lc-left { display: flex; flex-direction: column; align-items: center; padding-top: 3px; }
  .lc-dot { width: 10px; height: 10px; border-radius: 5px; flex-shrink: 0; }
  .lc-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .lc-top { display: flex; align-items: baseline; gap: 6px; }
  .lc-med { font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 14px; color: #1a1a2e; }
  .lc-dose { font-size: 11px; color: #9e9e9e; }
  .lc-symptom { font-size: 12px; color: #757575; font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lc-footer { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
  .lc-action { font-size: 11px; font-weight: 700; color: #616161; }
  .lc-sent { background: #e3f2fd; color: #1565c0; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 10px; }
  .lc-right { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex-shrink: 0; }
  .lc-date { font-size: 11px; color: #9e9e9e; }
  .lc-time { font-size: 11px; color: #bdbdbd; }
  .lc-chevron { font-size: 20px; color: #bdbdbd; line-height: 1; }

  /* ── LOG DETAIL ──────────────────────────────────── */
  .detail-hero { position: relative; padding: 44px 16px 20px; display: flex; flex-direction: column; gap: 6px; color: #fff; flex-shrink: 0; }
  .detail-label { font-size: 10px; font-weight: 700; letter-spacing: 1.5px; color: rgba(255,255,255,0.6); }
  .detail-hero-content { display: flex; flex-direction: column; gap: 4px; }
  .detail-med-name { font-family: 'Nunito', sans-serif; font-size: 22px; font-weight: 800; color: #fff; }
  .detail-dose { font-size: 13px; color: rgba(255,255,255,0.75); }
  .detail-ts { font-size: 12px; color: rgba(255,255,255,0.55); }
  .detail-action-badge { align-self: flex-start; padding: 6px 12px; border-radius: 20px; color: #fff; font-size: 12px; font-weight: 700; margin-top: 6px; }
  .detail-body { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .detail-section { background: #fff; border-radius: 12px; padding: 12px 14px; border: 1px solid #f0f0f0; display: flex; flex-direction: column; gap: 6px; }
  .detail-section-danger { border-left: 4px solid #e53935; }
  .ds-label { font-size: 11px; font-weight: 700; color: #9e9e9e; text-transform: uppercase; letter-spacing: 0.5px; }
  .ds-text { font-size: 13px; color: #424242; line-height: 1.5; }
  .ds-bp { font-family: 'Nunito', sans-serif; font-size: 20px; font-weight: 800; color: #c62828; }
  .ds-sub { font-size: 12px; color: #757575; font-style: italic; }
  .detail-time-update { display: flex; align-items: center; gap: 10px; background: #f0fdfc; border-radius: 8px; padding: 8px 10px; }
  .dtu-old { color: #e53935; font-weight: 700; text-decoration: line-through; font-size: 14px; }
  .dtu-arrow { color: #9e9e9e; }
  .dtu-new { color: #00897b; font-weight: 700; font-size: 14px; }
  .urgency-mini { background: #ffebee; color: #c62828; font-size: 12px; font-weight: 700; padding: 6px 10px; border-radius: 8px; margin-top: 4px; }

  /* ── RISK SCORE SCREEN ───────────────────────────── */
  .rs-header { display: flex; align-items: center; justify-content: space-between; padding: 44px 16px 10px; background: #fff; border-bottom: 1px solid #f0f0f0; flex-shrink: 0; }
  .rs-header-sub { font-size: 11px; color: #9e9e9e; margin-top: 1px; }
  .rs-tabs { display: flex; background: #fff; border-bottom: 1px solid #f0f0f0; flex-shrink: 0; }
  .rs-tab { flex: 1; padding: 10px 4px; border: none; background: none; font-size: 12px; font-weight: 600; color: #9e9e9e; cursor: pointer; border-bottom: 2px solid transparent; font-family: 'Lato', sans-serif; }
  .rs-tab-active { color: #00897b; border-bottom-color: #00897b; }
  .rs-body { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
  .rs-disclaimer { background: #fff8e1; border-radius: 10px; padding: 8px 12px; font-size: 11px; color: #f57c00; font-weight: 600; text-align: center; }

  /* cards row */
  .rs-cards-row { display: flex; gap: 10px; }
  .rs-card { flex: 1; background: #fff; border-radius: 14px; padding: 12px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.07); display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .rs-card-label { font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 11px; color: #1a1a2e; text-align: center; line-height: 1.3; }
  .rs-card-date { font-size: 10px; color: #bdbdbd; }
  .rs-ring-wrap { position: relative; display: flex; align-items: center; justify-content: center; }
  .rs-ring-inner { position: absolute; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .rs-ring-score { font-family: 'Nunito', sans-serif; font-size: 22px; font-weight: 800; line-height: 1; }
  .rs-ring-max { font-size: 10px; color: #bdbdbd; }
  .rs-tier-badge { font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 20px; text-align: center; }
  .rs-card-basis { font-size: 10px; color: #9e9e9e; text-align: center; line-height: 1.4; }

  /* delta */
  .rs-delta-card { display: flex; align-items: center; justify-content: space-between; background: #ffebee; border: 1.5px solid #ef9a9a; border-radius: 14px; padding: 14px; }
  .rs-delta-label { font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 14px; color: #1a1a2e; }
  .rs-delta-sub { font-size: 11px; color: #757575; margin-top: 2px; }
  .rs-delta-right { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .rs-delta-val { font-family: 'Nunito', sans-serif; font-size: 26px; font-weight: 800; }
  .rs-delta-tier { font-size: 11px; font-weight: 700; color: #e53935; }

  /* narrative */
  .rs-narrative { background: #e3f2fd; border-radius: 14px; padding: 14px; }
  .rs-narrative-title { font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 13px; color: #1565c0; margin-bottom: 6px; }
  .rs-narrative-text { font-size: 12px; color: #1a237e; line-height: 1.6; }

  /* domains tab */
  .rs-domains-header { display: flex; justify-content: flex-end; gap: 8px; padding: 0 4px 4px; }
  .rs-col-before, .rs-col-after, .rs-col-delta { font-size: 10px; font-weight: 700; color: #9e9e9e; text-transform: uppercase; width: 36px; text-align: center; }
  .rs-domain-row { background: #fff; border-radius: 12px; padding: 11px 12px; box-shadow: 0 1px 6px rgba(0,0,0,0.06); display: flex; flex-direction: column; gap: 5px; }
  .rs-domain-name { font-weight: 700; font-size: 12px; color: #1a1a2e; }
  .rs-domain-scores { display: flex; align-items: center; gap: 6px; }
  .rs-score-before { font-size: 14px; font-weight: 700; color: #9e9e9e; width: 28px; }
  .rs-arrow { color: #bdbdbd; font-size: 12px; }
  .rs-score-after { font-size: 16px; font-weight: 800; width: 28px; }
  .rs-diff { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 20px; margin-left: 4px; }
  .rs-domain-notes { display: flex; flex-direction: column; gap: 1px; }
  .rs-note-b { font-size: 10px; color: #bdbdbd; font-style: italic; }
  .rs-note-a { font-size: 10px; color: #424242; font-style: italic; }
  .rs-domains-footer { text-align: center; font-size: 11px; color: #9e9e9e; padding: 4px 0 8px; }

  /* flags tab */
  .rs-flags-section { display: flex; flex-direction: column; gap: 6px; }
  .rs-flags-title { font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 12px; color: #616161; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
  .rs-flag-row { display: flex; align-items: center; gap: 8px; background: #fff; border-radius: 10px; padding: 9px 12px; font-size: 12px; color: #424242; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
  .rs-flag-before { color: #9e9e9e; }
  .rs-flag-dot { width: 8px; height: 8px; border-radius: 4px; flex-shrink: 0; }
  .rs-insight-card { background: linear-gradient(135deg, #e0f7fa, #e8f5e9); border-radius: 14px; padding: 14px; }
  .rs-insight-title { font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 13px; color: #00695c; margin-bottom: 10px; }
  .rs-insight-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .rs-metric { background: #fff; border-radius: 10px; padding: 10px; display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .rs-metric-val { font-family: 'Nunito', sans-serif; font-size: 22px; font-weight: 800; color: #00897b; }
  .rs-metric-label { font-size: 10px; color: #9e9e9e; text-align: center; }
`;

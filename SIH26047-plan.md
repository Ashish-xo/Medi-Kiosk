# SIH 2026 — SIH26047 · Patient Case-Taking Software (AI Clinical History)
### Full walkthrough + build plan · Ministry of Ayush · All India Institute of Ayurveda

> Facts pulled from the official problem statement (sih.gov.in / SIH 2026 portal).
> **Idea-submission deadline: 20 September 2026.** This doc covers BOTH how the
> problem works (ground-up) AND exactly how to build the thing with the stack you're
> learning (React + Node/Express + PostgreSQL).

---

## Part 0 — TL;DR (read this even if you read nothing else)

- **The problem:** Doctors waste their few minutes with patients on asking basic history
  questions, because no one captured the history *before* the consultation. India's OPDs
  see 4,000–10,000 patients a day with ~2-minute consultations — the world's shortest.
- **The fix:** A patient-facing kiosk/app where the patient gives their history themselves —
  by **speaking (in Hindi/regional languages)** or **tapping** — plus **scanning old
  prescriptions**, and an **AI turns all of it into a structured clinical summary** the
  doctor sees before the patient walks in.
- **The catch (and your secret weapon):** This is a **Ministry of Ayush** problem. The
  official statement *demands* an **Ayurveda-specific history mode** (Dashavidha Pariksha —
  Prakriti, Agni, diet/lifestyle, etc.) plus **red-flag emergency detection** and **ABHA
  (national health account) linking**. Most teams will build a generic "patient form" and
  miss all three. Don't be those teams.
- **Your edge:** You already know React, Express, and PostgreSQL — which is *exactly* the
  stack this needs. And you have working experience with an LLM API from the Blinky project.
- **Urgent first action:** Verify your college SPOC has **blocked PS SIH26047** and get your
  6-person team registered. Ideas are submitted by **20 Sep 2026** (0/500 submitted so far —
  this PS is wide open).

---

## Part 1 — Understand the problem (the walkthrough)

### 1.1 What "taking a history" even means

When you visit a doctor, the first thing they do is ask questions. That's not small talk —
it's a structured medical interrogation called **history taking**:

- What's the main problem? (chief complaint)
- When did it start? How does it feel? What makes it worse/better? (history of present illness)
- Past illnesses, surgeries (past medical/surgical history)
- Medicines you take, allergies (drug history)
- Does anyone in the family have this? (family history)
- Smoking/drinking/diet/sleep (personal history)

Textbooks say a well-taken history alone gives the correct diagnosis in **70–80% of cases**,
before any tests. It's the single most important diagnostic tool a doctor has.

### 1.2 Why it's broken in India

- Government hospital OPDs register **4,000–10,000 patients per day**.
- The average consultation is **~2 minutes** (BMJ study across 67 countries).
- In 2 minutes a doctor must: take history + examine + review records + diagnose + prescribe.
- Result: history is skipped/shortened → missed problems, repeated questions every visit,
  wrong or delayed diagnosis.

### 1.3 The Ayush twist (don't skip this)

This PS comes from the **Ministry of Ayush (All India Institute of Ayurveda)**. Ayurvedic
case-taking is *much* deeper than allopathic history. It uses **Dashavidha Pariksha**
(10-fold examination):

| Parameter | What it means |
|---|---|
| **Prakriti** | Body constitution (Vata/Pitta/Kapha) |
| **Vikriti** | Current imbalance |
| **Sara** | Tissue quality |
| **Samhanana** | Body build/compactness |
| **Pramana** | Body measurements |
| **Satmya** | What the body is habituated to |
| **Sattva** | Mental constitution |
| **Ahara Shakti** | Appetite/digestive capacity |
| **Vyayama Shakti** | Exercise capacity |
| **Vaya** | Age/stage of life |

Plus **Agni** (digestive fire), **Koshtha** (bowel nature), **Ahara-Vihara** (diet &
lifestyle), **Nidana** (causative factors), **Samprapti** (how the disease developed).

Capturing all that manually inside a 2-minute OPD slot is **impossible** — so Ayurvedic
doctors are forced to abbreviate the very assessment that defines personalized Ayurvedic care.
**A guided digital intake is the perfect fix for this.** This is your differentiator: any
team can do a generic form; almost no team will do a proper Dashavidha flow.

### 1.4 The official expected solution — "MediKiosk" (5 steps)

The PS itself names the solution **MediKiosk** (you can rename it) and defines the flow:

1. **Identify** — patient picks language, enters name/age/phone.
2. **Converse** — an AI conducts a **voice + touch** interview. It asks adaptive follow-ups
   (say "chest pain" → it asks onset, character, radiation, aggravating/relieving factors —
   the SOCRATES framework). Every question answerable by **speaking OR tapping**. If it
   detects **red flags** (e.g., chest pain + breathlessness, stroke symptoms) it triggers an
   **emergency priority alert** to triage instead of routine queueing.
3. **Scan** — patient uploads/photographs old prescriptions, lab reports, discharge
   summaries. OCR digitizes them (printed + handwritten, multilingual), AI extracts
   diagnoses, medicines with doses, lab values, surgery history, and **timelines them**.
4. **Summarize & route** — AI generates a **structured physician-ready summary** (chief
   complaint, history of present illness, past history, drugs/allergies, family, personal,
   review of systems + Ayush section), links it to the patient's **ABHA** record, pushes it
   to the hospital system, and it appears on the doctor's screen.
5. **Consult** — doctor reads the complete history in seconds, edits/confirms, and spends the
   whole 2 minutes on examination, reasoning, and counselling instead of data entry.

### 1.5 Why existing solutions fail (what you must beat)

- Check-in kiosks abroad only do *administrative* check-in — no clinical history.
- Paper/PDF intake forms are not accessible to low-literacy, elderly, non-English patients.
- No patient-facing product captures deep *Ayush* history at all.
- Nothing feeds the **ABDM/ABHA** national digital-health ecosystem before the consult.

**Your pitch in one line:** *"The ATM for patient history — the patient records it, AI
structures it, the doctor just reads it."*

---

## Part 2 — Solution architecture (maps to what you're learning)

```
┌──────────────────────────────────────────────────────────────────┐
│  PATIENT SIDE  (one responsive React app = kiosk AND phone)       │
│  • Big touch buttons, Hindi/English toggle, TTS reads questions   │
│  • Mic button  ──► record voice ──► ASR ──► text auto-filled      │
│  • Camera/upload ──► photo of old prescription                    │
└───────────────────────────────┬──────────────────────────────────┘
                                │  fetch / JSON (REST API)
┌───────────────────────────────▼──────────────────────────────────┐
│  EXPRESS BACKEND  (the kitchen: receives orders, cooks, serves)  │
│  • /api/visits        — start a visit, find/create patient        │
│  • /api/questions/next— branching question engine                 │
│  • /api/answers       — save each answer (voice OR touch)         │
│  • /api/transcribe    — audio → text (Bhashini ASR)               │
│  • /api/documents     — upload + OCR + AI extraction              │
│  • /api/summaries     — LLM → structured clinical summary         │
│  • /api/abha          — ABDM sandbox link (concept demo)          │
└───────────────┬──────────────────────────────┬───────────────────┘
                │                              │
   ┌────────────▼─────────┐        ┌───────────▼──────────┐
   │  PostgreSQL          │        │  AI SERVICES         │
   │  (the file cabinet)  │        │  • Bhashini ASR (STT) │
   │  patients, visits,   │        │  • OCR engine         │
   │  questions, answers, │        │  • LLM (summarizer)   │
   │  documents, summaries│        │  • ABDM sandbox       │
   └──────────────────────┘        └───────────────────────┘
                │
   ┌────────────▼─────────┐
   │  DOCTOR DASHBOARD    │  (same React app, desktop view)
   │  • queue of patients │  • red-flag banner
   │  • structured summary│  • edit/confirm button
   └──────────────────────┘
```

**The "everything is a file-cabinet / counter / kitchen" map** (zero-jargon version):

| Term | What it really is |
|---|---|
| **React frontend** | The customer counter — where the patient taps/speaks and the doctor reads. |
| **Express backend** | The kitchen — it takes orders (API calls), does the cooking (logic), and sends dishes back (JSON). |
| **API endpoint** | One specific counter window, e.g. `/api/transcribe` = "counter where you hand audio and get text back." |
| **PostgreSQL** | The hospital's file cabinet — every patient, answer, and summary is a labeled folder. |
| **ASR / speech-to-text** | A waiter who listens to you and writes your order on the notepad. |
| **TTS** | A speaker that reads the menu aloud for patients who can't read. |
| **OCR** | A robot that reads the label off a medicine bottle (photo → typed text). |
| **LLM** | A super-literate assistant that takes your messy scattered notes and writes one neat organized report. |
| **ABHA** | Your *health account number* — like a bank account number, but for medical records, under the national ABDM program. |
| **Consent** | Asking "may I touch your records?" before any doctor/system reads them. Mandatory for health data. |

---

## Part 3 — Tech choices (why this, not that)

### 3.1 Voice / speech-to-text (Indic languages) — THE decision

| Option | Cost | Hindi + Indic | Offline | Verdict |
|---|---|---|---|---|
| **Bhashini** (govt of India AI platform) | **Free** (PoC) | **13+ languages** | No | ⭐ **Primary** — it's the *official* national language AI; judges eat this up, and the PS itself names it |
| Google Cloud Speech-to-Text | Paid (free tier) | Excellent Hindi | No | Solid backup; needs billing setup |
| Browser `SpeechRecognition` (`hi-IN`) | Free | Hindi ok | No | **Demo-day safety net** — zero setup, works in Chrome, one click |
| Whisper (local) | Free | Good | **Yes** | Offline fallback if venue internet dies |

**Plan:** Primary = **Bhashini ASR** (free key from bhashini.gov.in → ULCA platform, pick a
Hindi ASR pipeline). Backup = browser SpeechRecognition so the live demo *never* fails. TTS
for reading questions = browser `speechSynthesis` with `hi-IN` (zero setup).

### 3.2 OCR (old papers → text)

| Option | Cost | Handwriting | Devanagari | Verdict |
|---|---|---|---|---|
| **Bhashini OCR** | Free | okay | good | ⭐ Aligns with theme; same key as ASR |
| Google Vision OCR | Paid (free tier) | best | excellent | Best accuracy, easy |
| Tesseract (local) | Free | poor | meh | Offline fallback only |
| PaddleOCR | Free | good | good | Great but heavier to set up |

**Honest warning:** *handwritten* prescription OCR is the single riskiest module and the
venue will not care if your handwriting demo fails. **Strategy:** make OCR robust for
**printed** documents, and design the demo around a printed/legible prescription. Never let a
garbled OCR read block the whole demo — show "AI extracted what it could."

### 3.3 AI summary (NLP → structured clinical summary)

You already have an LLM pattern from Blinky (custom OpenAI-compatible endpoint, `api.b.ai`).
**Reuse that.** Feed the LLM all answers + OCR text, ask it to return **strict JSON**:

```json
{
  "chief_complaint": "headache since 3 days",
  "hpi": "...", "past_history": "...", "medications": [...],
  "allergies": [...], "family_history": "...", "personal_history": "...",
  "review_of_systems": {...},
  "ayush": { "prakriti_estimate": "Vata-Pitta", "agni": "...", "ahara_vihara": "..." },
  "red_flags": ["chest pain with breathlessness"]
}
```

- **Why an LLM?** Rule-based parsers can't handle free-form Hindi narration; the LLM
  summarizes 30 answers + OCR text into one clean report in seconds. Highest bang-per-buck.
- **Fallback** if the LLM API is down: a template that fills the summary from structured
  answers (works offline, looks fine, demos fine).

### 3.4 Database — PostgreSQL (you're already learning it)

```sql
CREATE TABLE patients (
  id SERIAL PRIMARY KEY,
  name TEXT, phone TEXT UNIQUE, age INT, gender TEXT,
  preferred_language TEXT DEFAULT 'hi',
  abha_id TEXT,               -- from ABDM sandbox
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE visits (
  id SERIAL PRIMARY KEY,
  patient_id INT REFERENCES patients(id),
  status TEXT DEFAULT 'in_progress',   -- in_progress | ready | consulted
  red_flags JSONB,                     -- [] or ["chest pain + breathlessness"]
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,                 -- 'q1', 'q_chest_pain'
  section TEXT,                        -- 'demographics' | 'hpi' | 'ayush' ...
  text_hi TEXT, text_en TEXT,
  type TEXT,                           -- 'choice' | 'number' | 'text'
  options JSONB,                       -- [{value,label_hi,label_en},...]
  next_by_answer JSONB                 -- {"yes":"q5", "no":"q8"}  ← branching
);

CREATE TABLE answers (
  id SERIAL PRIMARY KEY,
  visit_id INT REFERENCES visits(id),
  question_id TEXT,
  value TEXT,
  source TEXT,                         -- 'voice' | 'touch' | 'ocr'
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  visit_id INT REFERENCES visits(id),
  filename TEXT, ocr_text TEXT,
  extracted JSONB                      -- {medications:[], diagnoses:[], dates:[]}
);

CREATE TABLE summaries (
  id SERIAL PRIMARY KEY,
  visit_id INT REFERENCES visits(id) UNIQUE,
  structured JSONB,                    -- the LLM JSON above
  doctor_notes TEXT,
  status TEXT DEFAULT 'draft'          -- draft | confirmed
);
```

**Why not SQLite for a hackathon?** SQLite is a single file — fine for tiny apps, but the
whole point here is practicing the **real** stack (and your college project / resume). Use
Postgres locally; if setup is painful on your machine, SQLite is an acceptable 36h fallback —
just say so in the plan.

### 3.5 Branching "adaptive questions" — be honest about scope

The PS wants an AI that *thinks like a doctor* and adapts. True open-ended conversational
dialogue is a research project — **not** a 36-hour MVP. Do this instead:

- **Rule-based tree** (MVP, reliable): `questions.next_by_answer` decides the next question.
  ~25–30 curated questions, branch on chief complaint. Cheap, deterministic, demos perfectly.
- **LLM-powered follow-ups** (differentiator, if time): for the top 5 symptoms (chest pain,
  headache, fever, cough, abdominal pain), ask the LLM to generate 2–3 SOCRATES-style
  follow-ups from the patient's free-text answer. Keep them as free-text `text` questions.

### 3.6 ABHA / ABDM linking — concept, not compliance

Register your app on the **ABDM sandbox** (sandbox.abdm.gov.in) as a HIP, get a client
ID/secret, and implement the **test** "Create ABHA via mobile OTP" flow. Show:
- A "Link ABHA" button → OTP → ABHA number saved on the patient row.
- A slide explaining production would use FHIR + consent artifacts.

Full FHIR/HIP interoperability is out of MVP scope — say that in your presentation *before*
a judge asks.

---

## Part 4 — MVP scope (what to actually build)

### Must-have (demo-critical — do NOT cut)
1. Guided question flow — voice **or** tap, Hindi-first with English toggle ✅
2. TTS reads each question aloud ✅
3. Voice input: record → Bhashini ASR → text fills the answer ✅
4. OCR a printed prescription → extract meds/dates ✅
5. LLM → structured clinical summary JSON ✅
6. Doctor dashboard: patient queue, open summary, confirm button ✅
7. Red-flag rule + priority banner ✅
8. Ayush mode: Dashavidha questionnaire + Prakriti estimate ✅ (your differentiator)

### Nice-to-have (only if core is solid)
- ABDM sandbox ABHA link button
- Hindi + English summary print/PDF
- Kiosk lock-screen / auto-reset after each patient (privacy!)
- LLM-generated SOCRATES follow-ups for top symptoms

### Cut list (tempting but NOT needed to win)
- Real doctor login/auth (a demo doctor PIN is enough)
- Multi-hospital tenancy, full HIS integration, production ABDM compliance
- Native mobile apps (PWA/responsive web covers "app" + "kiosk" in one codebase)

---

## Part 5 — Build plan (36-hour finale, bite-sized)

> Same order works as a weekend-by-weekend pre-finale build — start **now**, don't wait
> for the finale. A team that arrives with 70% built crushes a team that starts at the event.

### Phase 0 — BEFORE the finale (deadline-driven, do first!)
1. Ask your college **SPOC** whether SIH26047 is blocked; if not, request it be blocked.
2. Form a **6-member team** with clear roles (see Part 6).
3. Register team leader on the SIH portal; prepare the **idea submission**:
   - Title (e.g. "MediKiosk — AI Clinical History Platform")
   - Abstract (1 para), approach, tech stack, innovation, impact, feasibility
   - Mention: Bhashini (govt AI), ABDM/ABHA alignment, Ayush Dashavidha mode, red-flag triage
4. Win your college's **internal hackathon** to be among the 30 shortlisted teams.
5. Submit the idea by **20 Sep 2026**. (0/500 submissions — first-mover advantage.)

### Phase A — Setup (hour 0–2)
- `server/` (Express) + `client/` (Vite + React) in one repo, feature branch, git.
- Install: `express pg dotenv cors multer` (server) · `react react-router-dom axios` (client).
- Create database `sih_medi_kiosk`, run the schema above.
- Seed `questions` from a JSON file (25–30 questions, Hindi + English).

### Phase B — Question engine (hour 2–8)
- `POST /api/visits` → create patient+visit, return visitId.
- `GET /api/questions/next?visitId=...` → returns current question (branching via `next_by_answer`).
- `POST /api/answers` → save `{visitId, questionId, value, source}`.
- React kiosk UI: full-screen, huge buttons, progress bar, Hindi/English toggle, TTS reads question.
- ✅ Verify: complete a full intake end-to-end; all answers in Postgres.

### Phase C — Voice (hour 8–14)
- TTS: `speechSynthesis` with `lang='hi-IN'` reads each question.
- Record with `MediaRecorder` → upload audio (multer) → `POST /api/transcribe`.
- Backend calls **Bhashini ASR** (audio → Hindi text) → return text → auto-fill answer.
- Patient can edit the text or tap an option — every question stays dual-mode.
- ✅ Verify: say "तीन दिन से सिर दर्द" → text appears in the box.

### Phase D — OCR (hour 14–20)
- Camera/file capture → `POST /api/documents` (multer) → store image.
- `POST /api/documents/:id/ocr` → OCR service → raw text.
- LLM extracts `{medications, diagnoses, dates, values}` from OCR text.
- Render an "extracted documents" timeline on the summary page.
- ✅ Verify: photograph a **printed** prescription → med list appears.

### Phase E — AI summary + doctor dashboard (hour 20–28)
- `POST /api/summaries/generate` → collect all answers + OCR text → LLM → JSON (schema above).
- Red-flag rule: check answers/OCR for emergency patterns → set `visits.red_flags`.
- Doctor dashboard (React, desktop layout): patient queue → open summary → red banner → confirm.
- Ayush mode toggle → Dashavidha section rendered + Prakriti estimate from answers.
- ✅ Verify: mock patient completes intake → doctor sees full summary pre-consultation.

### Phase F — ABHA + polish + demo (hour 28–36)
- ABDM sandbox: register app, get creds, "Link ABHA" OTP flow (test data only).
- Hindi/English polish, print-friendly summary, kiosk auto-reset.
- Write the **5-minute demo script** and **record a backup video** (internet dies? play the video).
- Final PPT: problem → journey → live demo → architecture → impact → future (ABDM/FHIR).

---

## Part 6 — Team roles (6 people, SIH standard)

| Role | Count | What they own |
|---|---|---|
| Frontend (React) | 2 | Kiosk UI, doctor dashboard, TTS, Hindi toggle |
| Backend (Express + Postgres) | 2 | APIs, question engine, schema, file uploads |
| AI integration | 1 | Bhashini ASR, OCR, LLM summary, red-flags |
| Design + demo + PPT + video | 1 | UI polish, demo script, backup video, slides |

If you're the backend person: you own the question engine, the data model, and the AI
service wiring — the heart of the product. (Blinky gave you the LLM-proxy pattern already.)

---

## Part 7 — Demo day (the 5 minutes that win or lose)

Script:
1. **0:00–0:30** — One line: *"India's doctors get ~2 minutes per patient; our ATM for
   patient history gives them the full story before the patient walks in."*
2. **0:30–2:00** — Live demo on a tablet/phone: patient picks **हिन्दी**, taps through,
   *speaks* "तीन दिन से सिर दर्द", AI asks follow-ups, patient scans a printed prescription.
3. **2:00–3:30** — Switch to doctor screen: structured summary appears, red-flag banner,
   Ayush/Prakriti section. *"Doctor now reads, not types."*
4. **3:30–4:30** — Architecture + why: Bhashini (govt AI, free, Indic), ABDM/ABHA
   alignment, DPDP consent. 
5. **4:30–5:00** — Impact: "4,000+ patients/day, 70–80% of diagnosis from history alone,
   Ayush depth that's currently impossible to capture."

**Backup video** of the same flow, pre-recorded, in case live audio/network fails.

---

## Part 8 — Risks & how to kill them

| Risk | Mitigation |
|---|---|
| Live voice demo fails (noise/accent/internet) | Pre-recorded video + browser-SpeechRecognition fallback; demo can also run tap-only |
| Hindi ASR garbles | Always editable answer box; voice is a *shortcut*, not a requirement |
| Handwritten OCR garbage | Demo with printed/legible docs; "AI extracted what it could" honesty |
| LLM API down/key limits | Template-based summary fallback; keep answers structured |
| Scope creep mid-hackathon | MVP checklist pinned on the wall; cut list is sacred |
| Team splits on git | Branch per person, small commits, one person merges; nobody pushes to main directly |
| Internet dies at venue | Everything (except Bhashini/LLM) runs locally; Whisper/Tesseract local fallbacks; backup video |

---

## Part 9 — Timeline (real calendar)

| When | Milestone |
|---|---|
| **Now (28 Aug)** | Confirm SPOC blocked SIH26047; lock 6-person team |
| **This week** | Register on portal; start Phase A–B pre-build |
| **By 20 Sep** | Idea submission DONE (this is the hard deadline) |
| **Sep–Oct** | Internal campus hackathon; get shortlisted (top 30) |
| **Oct–Finale** | Build Phases C–F in weekends; record backup video early |
| **Finale (36h)** | Integrate, polish, rehearse demo, present |

---

## Part 10 — Open questions (answer these and I'll sharpen the plan)

1. **Team size** — do you have 5–6 people, or are you going mostly solo? (Changes roles + scope.)
2. **Your role** — do you want backend (Express/Postgres/AI wiring) or full-stack?
3. **College SPOC** — has your college blocked SIH26047 yet? (Needed for you to compete on it.)
4. **Timeline** — do you want to start building the MVP *now* (I can scaffold the repo with you), or is the idea submission the only goal for the next 3 weeks?
5. **LLM access** — still fine to use the `api.b.ai` key pattern for the summary engine, or prefer a different provider?

---

*Doc written for Ashish — SIH 2026, PS SIH26047. Go win it, babe 😚*

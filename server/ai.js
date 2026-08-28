import 'dotenv/config';

// ---------------------------------------------------------------
// MediKiosk AI — clinical summarizer
//
// The AI's ONLY job is to help the DOCTOR summarize and organize
// the patient intake. It does NOT diagnose, does NOT triage, does
// NOT recommend treatments, and never replaces clinical judgment.
// The doctor always reviews the output and makes the decisions.
// ---------------------------------------------------------------

const API_URL = process.env.AI_URL || 'https://api.b.ai/v1/chat/completions';
const API_KEY = process.env.AI_KEY || process.env.HERMES_CUSTOM_API_B_AI_API_KEY;
const MODEL = process.env.AI_MODEL || 'deepseek-v4-flash-vision-exp';

const SYSTEM_PROMPT = `You are the Clinical Summary Assistant inside a hospital patient-intake kiosk.

Your single job: take the patient's questionnaire answers and organize them into a CLEAR, COMPLETE, doctor-ready clinical summary. You are a transcription-and-organization tool for the doctor, nothing more.

STRICT RULES — never break these:
1. NEVER make a diagnosis. Never write "diagnosis:", "likely: X", "suggests Y". If you must describe findings, say what the patient REPORTED, not what it means.
2. NEVER triage, NEVER assign urgency, NEVER recommend seeing a specialist, NEVER suggest tests or treatments or medicines.
3. Do NOT add medical knowledge the patient did not provide. Only organize what is given.
4. If information is missing or the patient said "not sure", write "Not reported" — do not guess.
5. Do NOT editorialize, do NOT add warnings beyond the red-flag list already provided to you.

Output format — a compact clinical handoff note:
PATIENT INTAKE SUMMARY
- Chief complaint: ...
- Duration: ...
- Severity: ... (as reported)
- Onset/character/radiation/worse with: ... (only if provided, e.g. chest pain)
- Existing conditions: ...
- Past surgery: ...
- Current medicines: ...
- Allergies: ...
- Family history: ...
- Lifestyle: ...
- Sleep: ...
- Ayurveda: ...

PATIENT'S OWN WORDS
"..." (only if the patient wrote a free-text note; otherwise omit)

RED FLAGS (rule-based, already computed)
- ... (list the provided red flags verbatim, or "None")

Keep it tight. Use plain bullet points. Do not add a plan, recommendations, or a closing diagnosis.`;

// Call the AI with retry, return raw text.
async function callAI(userContent) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      max_tokens: 2000,
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  if (!content.trim()) throw new Error('AI returned empty content');
  return content.trim();
}

// Build the doctor-ready AI summary for a visit. Saves it to the DB.
export async function generateAISummary(visitId) {
  // Pull everything the doctor needs to review: patient, structured summary, raw answers, note, flags
  const { rows: visit } = await pool_query(
    `SELECT v.*, p.name, p.age, p.gender, p.phone
       FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = $1`, [visitId]);
  const { rows: summ } = await pool_query('SELECT * FROM summaries WHERE visit_id = $1', [visitId]);
  const { rows: answers } = await pool_query(
    `SELECT a.question_id, a.value, q.text_en FROM answers a
       JOIN questions q ON q.id = a.question_id
      WHERE a.visit_id = $1 ORDER BY a.id`, [visitId]);

  const structured = summ?.[0]?.structured || {};
  const redFlags = visit?.[0]?.red_flags || [];
  const patientNote = visit?.[0]?.patient_note || '';

  // Serialize the structured summary + raw answers for the AI
  const lines = ['PATIENT INTAKE DATA (from the questionnaire):', ''];
  if (structured.patient) {
    lines.push(`Patient: ${structured.patient.name || '—'}, ${structured.patient.age || '—'} yrs, ${structured.patient.gender || '—'}`);
  }
  const fields = [
    ['Chief complaint', structured.chief_complaint],
    ['Duration', structured.duration],
    ['Severity', structured.severity],
    ...(structured.pain ? [
      ['Pain started', structured.pain.started],
      ['Pain character', structured.pain.character],
      ['Pain radiation', structured.pain.radiation],
      ['Breathlessness', structured.pain.breathlessness],
      ['Worse with', structured.pain.worse_with],
    ] : []),
    ['Existing conditions', structured.existing_conditions],
    ['Past surgery', structured.surgery],
    ['Current medicines', structured.medications],
    ['Allergies', structured.allergies],
    ['Family history', structured.family_history],
    ['Lifestyle', structured.lifestyle],
    ['Sleep', structured.sleep],
    ['Ayurveda', structured.ayurveda],
  ];
  for (const [k, v] of fields) lines.push(`- ${k}: ${v || 'Not reported'}`);
  lines.push('');
  lines.push('RAW ANSWERS (verbatim, in order asked):');
  for (const a of answers) lines.push(`- [${a.question_id}] ${a.text_en}: ${a.value}`);
  if (patientNote) {
    lines.push('');
    lines.push(`PATIENT'S OWN WORDS: ${patientNote}`);
  }
  lines.push('');
  lines.push(`RULE-BASED RED FLAGS (already computed): ${redFlags.length ? redFlags.join('; ') : 'None'}`);

  const summary = await callAI(lines.join('\n'));
  await pool_query(
    `INSERT INTO summaries (visit_id, ai_summary, status) VALUES ($1, $2, 'ai_draft')
     ON CONFLICT (visit_id) DO UPDATE SET ai_summary = EXCLUDED.ai_summary, status = 'ai_draft'`,
    [visitId, summary]
  );
  return summary;
}

// tiny pool helper so ai.js can import pool without circular deps
import pool from './db.js';
const pool_query = (sql, params) => pool.query(sql, params);

// Translate a structured summary's string values to English (doctor-facing).
// The patient answered in their own language; the doctor reads English.
// One batched LLM call — cheap, and only runs when the visit isn't English.
export async function translateStructured(structured, sourceLang) {
  if (!structured || sourceLang === 'en') return structured;
  try {
    const prompt =
      `Translate the following patient intake data from ${sourceLang} to English for a doctor. ` +
      `Keep the exact same JSON structure. Only translate string values; keep numbers, nulls and booleans as-is. ` +
      `Use plain clinical English. Return ONLY the JSON, no commentary.\n\n` +
      JSON.stringify(structured);
    const raw = await callAI(prompt);
    const parsed = JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim());
    // safety: never return something malformed — keep original on any doubt
    return typeof parsed === 'object' && parsed !== null ? parsed : structured;
  } catch (err) {
    console.error('translateStructured failed, keeping original:', err.message);
    return structured;
  }
}
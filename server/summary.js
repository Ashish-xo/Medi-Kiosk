import pool from './db.js';

// Map each question id to a summary "field" + a plain-English label prefix.
const FIELD = {
  cc:            { field: 'chief_complaint', label: 'Chief complaint' },
  cc_start:      { field: 'duration',        label: 'Duration' },
  cc_severity:   { field: 'severity',        label: 'Severity' },
  cp_start:      { field: 'pain_start',      label: 'Pain started' },
  cp_character:  { field: 'pain_character',  label: 'Pain feels' },
  cp_radiation:  { field: 'pain_radiation',  label: 'Pain spreads to' },
  cp_breath:     { field: 'pain_breath',     label: 'Breathlessness' },
  cp_severity:   { field: 'pain_severity',   label: 'Pain severity' },
  cp_dizziness:  { field: 'pain_dizziness',  label: 'Dizziness' },
  cp_worse:      { field: 'pain_worse',      label: 'Pain worse with' },
  past_illness:  { field: 'existing',        label: 'Existing conditions' },
  past_surgery:  { field: 'surgery',         label: 'Past surgery' },
  medications:   { field: 'medications',     label: 'Current medicines' },
  allergies:     { field: 'allergies',       label: 'Allergies' },
  family_history:{ field: 'family_history',  label: 'Family history' },
  smoking:       { field: 'smoking',         label: 'Smoking' },
  alcohol:       { field: 'alcohol',         label: 'Alcohol' },
  sleep:         { field: 'sleep',           label: 'Sleep' },
  ayush_prakriti:{ field: 'ayush_prakriti',  label: 'Body nature (Prakriti)' },
  ayush_agni:    { field: 'ayush_agni',      label: 'Appetite (Agni)' },
  ayush_koshtha: { field: 'ayush_koshtha',   label: 'Bowel habit (Koshtha)' },
  ayush_sattva:  { field: 'ayush_sattva',    label: 'Temperament (Sattva)' },
};

// Nicer display text for raw answer values.
const PRETTY = {
  // common
  none: 'None', no: 'No', yes: 'Yes', other: 'Other',
  // severity
  mild: 'Mild', moderate: 'Moderate', severe: 'Severe',
  // smoking / alcohol
  quit: 'Quit', occasionally: 'Occasional',
  // ayush prakriti
  vata: 'Vata (slim, quick)', pitta: 'Pitta (warm, sharp)', kapha: 'Kapha (heavy, calm)',
  'vata-pitta': 'Vata-Pitta (quick, fiery)', 'pitta-kapha': 'Pitta-Kapha (strong, steady)', 'vata-kapha': 'Vata-Kapha (creative, calm)',
  'not sure': 'Not sure',
  // pain
  sharp: 'Sharp', squeezing: 'Squeezing / pressure', burning: 'Burning', dull: 'Dull',
  exertion: 'Exertion', rest: 'At rest', 'lying down': 'Lying down', eating: 'Eating',
  'left arm': 'Left arm', jaw: 'Jaw', back: 'Back', neck: 'Neck',
};

// Question-specific display (same raw value can mean different things per question).
const QID_PRETTY = {
  sleep: { good: 'Good (6–8 hr)', disturbed: 'Disturbed', less: 'Less than 6 hr' },
  ayush_agni: { good: 'Normal', irregular: 'Irregular', low: 'Low', high: 'High', 'not sure': 'Not sure' },
  ayush_koshtha: { normal: 'Regular', constipated: 'Constipated', loose: 'Loose', 'not sure': 'Not sure' },
  ayush_sattva: { calm: 'Calm', anxious: 'Anxious', moody: 'Moody', 'not sure': 'Not sure' },
  ayush_prakriti: { 'not sure': 'Not sure' },
};

// Turn an answer value into display text.
export function prettyValue(qid, value) {
  if (!value) return 'Not reported';
  const qmap = QID_PRETTY[qid];
  if (qmap && qmap[value]) return qmap[value];
  if (PRETTY[value]) return PRETTY[value];
  return value; // text answers (medications) pass through
}

// Build the structured, doctor-ready summary for a visit.
export async function buildSummary(visitId) {
  const { rows: answers } = await pool.query(
    `SELECT a.question_id, a.value, a.source, q.text_en, q.options
       FROM answers a JOIN questions q ON q.id = a.question_id
      WHERE a.visit_id = $1 ORDER BY a.id`, [visitId]
  );
  const { rows: patient } = await pool.query(
    `SELECT p.name, p.age, p.gender, p.phone, p.preferred_language
       FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = $1`, [visitId]
  );

  const sections = [];       // ordered list of {label, value, raw} for the doctor
  const byField = {};
  for (const a of answers) {
    const meta = FIELD[a.question_id];
    if (!meta) continue;
    const value = prettyValue(a.question_id, a.value);
    if (meta.field === 'chief_complaint' && a.value === 'other') {
      // "other" needs the free text — but cc is a choice, so just label it
    }
    byField[meta.field] = value;
  }

  const p = patient[0] || {};
  const cap = (s) => s && s.charAt(0).toUpperCase() + s.slice(1);
  const structured = {
    patient: {
      name: p.name || '—',
      age: p.age || '—',
      gender: p.gender || '—',
      phone: p.phone || '—',
    },
    chief_complaint: cap(byField.chief_complaint) || 'Not reported',
    duration: byField.duration || byField.pain_start || 'Not reported',
    severity: byField.severity || (byField.pain_start ? '—' : 'Not reported'),
    pain: byField.pain_start ? {
      started: byField.pain_start,
      severity: byField.pain_severity,
      character: byField.pain_character,
      radiation: byField.pain_radiation,
      breathlessness: byField.pain_breath,
      dizziness: byField.pain_dizziness,
      worse_with: byField.pain_worse,
    } : null,
    existing_conditions: byField.existing || 'None reported',
    surgery: byField.surgery || 'None reported',
    medications: byField.medications || 'None reported',
    allergies: byField.allergies === 'No' ? 'No known drug allergies' : (byField.allergies || 'None reported'),
    family_history: byField.family_history === 'No' ? 'None reported' : (byField.family_history || 'None reported'),
    lifestyle: [
      byField.smoking ? `${byField.smoking === 'No' ? 'non-smoker' : byField.smoking === 'Quit' ? 'quit smoking' : 'smoker'}` : null,
      byField.alcohol ? `${byField.alcohol === 'No' ? 'no alcohol' : byField.alcohol === 'Occasional' ? 'occasional alcohol' : 'drinks'}` : null,
    ].filter(Boolean).join(' + ') || 'Not reported',
    sleep: byField.sleep || 'Not reported',
    ayurveda: [
      byField.ayush_prakriti ? `Prakriti: ${byField.ayush_prakriti}` : null,
      byField.ayush_agni ? `appetite ${byField.ayush_agni.toLowerCase()}` : null,
      byField.ayush_koshtha ? (byField.ayush_koshtha === 'Regular' ? 'regular bowel' : `occasional ${byField.ayush_koshtha.toLowerCase() === 'constipated' ? 'constipation' : byField.ayush_koshtha.toLowerCase()}`) : null,
      byField.ayush_sattva ? `nature: ${byField.ayush_sattva.toLowerCase()}` : null,
    ].filter(Boolean).join(', ') || 'Not reported',
  };

  return structured;
}

// One-line summary used by the dashboard list.
export async function summaryLine(structured) {
  return `${structured.chief_complaint} · ${structured.duration} · ${structured.severity}`;
}
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pool from './db.js';
import { buildSummary, prettyValue, quickLine } from './summary.js';
import { generateAISummary, generateOneLiner, translateStructured } from './ai.js';
import { visitPDF } from './pdf.js';
import { transcribeAudio, warmWhisper } from './stt.js';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { securityHeaders, rateLimit, doctorAuth, sendError } from './security.js';
import { initDb } from './init-db.js';

const app = express();
app.set('trust proxy', 1); // Railway/Heroku sit behind a proxy — needed for req.secure + real client IPs
app.use(securityHeaders);

// CORS: only known origins (dev + your deployed URL). Same-origin requests need none.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5174,http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Doctor-Pin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 4000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Short QR-friendly token for a visit (e.g. "K7X2-Q4MN")
function makeToken() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  let t = '';
  for (let i = 0; i < 9; i++) {
    t += alphabet[randomBytes(1)[0] % alphabet.length];
    if (i === 3 || i === 6) t += '-';
  }
  return t;
}

// ---------- helpers ----------

async function getQuestion(id) {
  if (!id) return null;
  const { rows } = await pool.query('SELECT * FROM questions WHERE id = $1', [id]);
  return rows[0] || null;
}

function decideNext(q, value) {
  if (!q) return null;
  if (q.next_by_answer && q.next_by_answer[value]) return q.next_by_answer[value];
  return q.next || null;
}

async function currentQuestion(visitId) {
  const { rows } = await pool.query(
    `SELECT a.value AS last_value, q.*
       FROM answers a JOIN questions q ON q.id = a.question_id
      WHERE a.visit_id = $1 ORDER BY a.id DESC LIMIT 1`,
    [visitId]
  );
  if (rows.length === 0) return getQuestion('cc');
  const last = rows[0];
  const nextId = decideNext(last, last.last_value);
  if (!nextId) return null;
  return getQuestion(nextId);
}

async function updateRedFlags(visitId) {
  const { rows } = await pool.query('SELECT question_id, value FROM answers WHERE visit_id = $1', [visitId]);
  const ans = {};
  for (const r of rows) ans[r.question_id] = r.value;

  const flags = [];
  if (ans.cc === 'chest pain' && ans.cp_breath === 'yes')
    flags.push('Chest pain with breathlessness — possible emergency');
  if (ans.cc === 'chest pain' && ans.cp_severity === 'severe')
    flags.push('Severe chest pain — immediate review');
  if (ans.cc === 'dizziness')
    flags.push('Dizziness reported — fall risk');

  // Rule-based urgency alert (an ALERT, not a diagnosis):
  // severe chest pain + dizziness together = urgent
  if (ans.cc === 'chest pain' && ans.cp_severity === 'severe' && ans.cp_dizziness === 'yes')
    flags.push('Severe chest pain WITH dizziness — URGENT');

  await pool.query('UPDATE visits SET red_flags = $2, has_urgency = $3 WHERE id = $1',
    [visitId, JSON.stringify(flags), flags.length > 0]);
  return flags;
}

async function progress(visitId) {
  const { rows: cnt } = await pool.query(
    'SELECT count(*)::int AS n FROM answers WHERE visit_id = $1', [visitId]);
  const { rows: total } = await pool.query('SELECT count(*)::int AS n FROM questions');
  return { answered: cnt[0].n, total: total[0].n };
}

// Finalize a visit: build + store summary, mark as waiting for the doctor.
async function finalizeVisit(visitId) {
  const structured = await buildSummary(visitId);

  // Doctor-facing English copy. The patient answers in their own language;
  // the doctor reads English. Choice values are already English; free text
  // (medications, "other", note) gets translated in one LLM call.
  const { rows: langRows } = await pool.query(
    `SELECT p.preferred_language FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = $1`,
    [visitId]
  );
  const patientLang = langRows[0]?.preferred_language || 'en';
  let structured_en = structured;
  if (patientLang !== 'en') {
    structured_en = await translateStructured(structured, patientLang);
  }

  await pool.query(
    `INSERT INTO summaries (visit_id, structured, structured_en) VALUES ($1,$2,$3)
     ON CONFLICT (visit_id) DO UPDATE SET structured = EXCLUDED.structured, structured_en = EXCLUDED.structured_en`,
    [visitId, JSON.stringify(structured), JSON.stringify(structured_en)]
  );
  await pool.query(`UPDATE visits SET status = 'waiting' WHERE id = $1`, [visitId]);

  // Killer feature: 60s intake -> 10s doctor-ready summary.
  // Fire the AI summary generation in the background so the kiosk isn't blocked.
  generateAISummary(visitId, patientLang).catch((err) => console.error('AI summary failed:', err.message));
  // One-line clinical snapshot for the doctor queue.
  generateOneLiner(visitId).catch((err) => console.error('one-liner failed:', err.message));

  return structured;
}

// ---------- kiosk routes ----------

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Returning-patient lookup — prefill the kiosk form when a known phone is entered
app.get('/api/patients/lookup', async (req, res) => {
  try {
    const raw = String(req.query.phone || '').replace(/\s/g, '');
    const phone = raw.startsWith('+91') ? raw : `+91${raw}`;
    if (!/^\+91\d{10}$/.test(phone)) return res.json({ found: false });
    const { rows } = await pool.query(
      'SELECT name, age, gender, abha_id FROM patients WHERE phone = $1', [phone]);
    if (rows.length === 0) return res.json({ found: false });
    res.json({ found: true, patient: rows[0] });
  } catch (err) {
    sendError(res, err);
  }
});

// Start a visit
app.post('/api/visits', rateLimit({ max: 30, windowMs: 10 * 60_000, name: 'visits' }), async (req, res) => {
  try {
    // Server-side validation — never trust the client
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim().replace(/\s/g, '');
    const age = req.body.age;
    const gender = req.body.gender ? String(req.body.gender).trim().slice(0, 20) : null;
    const abha_id = req.body.abha_id ? String(req.body.abha_id).trim().slice(0, 30) : null;
    const SUPPORTED_LANGS = ['hi', 'en', 'pa', 'mr', 'gu', 'te', 'kn', 'ta', 'bn', 'ml', 'ur', 'bho', 'pah', 'as', 'or'];
    const language = SUPPORTED_LANGS.includes(req.body.language) ? req.body.language : 'en';
    const ayush_mode = req.body.ayush_mode !== false;

    if (name.length < 2 || name.length > 80)
      return res.status(400).json({ error: 'Name must be 2–80 characters' });
    if (/[<>]/.test(name))
      return res.status(400).json({ error: 'Name contains invalid characters' });
    if (!/^(\+91)?\d{10}$/.test(phone))
      return res.status(400).json({ error: 'Phone must be a 10-digit Indian number' });
    if (age !== undefined && age !== null && age !== '') {
      const n = Number(age);
      if (!Number.isInteger(n) || n < 1 || n > 150)
        return res.status(400).json({ error: 'Age must be a whole number from 1–150' });
    }

    let { rows } = await pool.query('SELECT * FROM patients WHERE phone = $1', [phone]);
    let patient;
    let returning = null;
    if (rows.length === 0) {
      ({ rows } = await pool.query(
        `INSERT INTO patients (name, phone, age, gender, preferred_language, abha_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [name, phone, age || null, gender, language, abha_id]
      ));
      patient = rows[0];
    } else {
      patient = rows[0];
      // Returning patient — capture prior details for prefill on the kiosk
      returning = {
        name: patient.name, age: patient.age, gender: patient.gender, abha_id: patient.abha_id,
      };
      // update any new/changed fields
      const upd = [];
      if (abha_id && patient.abha_id !== abha_id) upd.push(`abha_id='${abha_id.replace(/'/g, "''")}'`);
      if (gender && patient.gender !== gender) upd.push(`gender='${gender.replace(/'/g, "''")}'`);
      if (upd.length) await pool.query(`UPDATE patients SET ${upd.join(',')} WHERE id=$1`, [patient.id]);
    }

    // Duplicate / resubmit guard: if this patient already has an active visit
    // (in_progress or waiting), don't stack a second one — return the existing.
    const { rows: active } = await pool.query(
      `SELECT id, token, status FROM visits
        WHERE patient_id=$1 AND status IN ('in_progress','waiting')
        ORDER BY id DESC LIMIT 1`,
      [patient.id]
    );
    if (active.length > 0) {
      const existing = active[0];
      const payload = {
        visitId: existing.id, patientId: patient.id, token: existing.token,
        returning, resumed: true,
      };
      if (existing.status === 'in_progress') {
        payload.currentQuestion = await currentQuestion(existing.id);
      } else {
        // waiting: they already finished — let the kiosk go straight to the queue screen
        payload.status = 'waiting';
        payload.done = true;
      }
      return res.status(200).json(payload);
    }

    const { rows: v } = await pool.query(
      `INSERT INTO visits (patient_id, ayush_mode, token) VALUES ($1,$2,$3) RETURNING *`,
      [patient.id, ayush_mode, makeToken()]
    );
    const question = await currentQuestion(v[0].id);
    res.status(201).json({
      visitId: v[0].id, patientId: patient.id, token: v[0].token,
      currentQuestion: question, returning,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Queue position for a visit — how many people are ahead in the waiting room
app.get('/api/visits/:id/position', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, status FROM visits WHERE id=$1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'visit not found' });
    const visit = rows[0];
    if (visit.status === 'consulted') return res.json({ position: null, status: 'consulted', ahead: 0 });
    const { rows: ahead } = await pool.query(
      `SELECT count(*)::int AS n FROM visits
        WHERE status IN ('in_progress','waiting')
          AND id < $1
          AND (red_flags = '[]'::jsonb OR NOT has_urgency)`,
      [req.params.id]
    );
    const { rows: urgentAhead } = await pool.query(
      `SELECT count(*)::int AS n FROM visits
        WHERE status IN ('in_progress','waiting') AND id < $1 AND has_urgency`,
      [req.params.id]
    );
    // urgent patients jump the queue — a non-urgent patient waits behind them
    const position = 1 + ahead[0].n + urgentAhead[0].n;
    res.json({ position, status: visit.status, ahead: position - 1, urgentAhead: urgentAhead[0].n });
  } catch (err) {
    sendError(res, err);
  }
});

// Save an answer (UPSERT: edit replaces, branch changes prune downstream)
app.post('/api/visits/:id/answers', rateLimit({ max: 120, windowMs: 60_000, name: 'answers' }), async (req, res) => {
  try {
    const { questionId, value, source = 'touch' } = req.body;
    const visitId = req.params.id;
    if (!questionId || value === undefined || value === null)
      return res.status(400).json({ error: 'questionId and value are required' });

    // If this question was already answered (an edit), prune answers downstream of the edit
    const prev = await pool.query(
      'SELECT id FROM answers WHERE visit_id = $1 AND question_id = $2', [visitId, questionId]);
    if (prev.rows.length > 0) {
      await pool.query('DELETE FROM answers WHERE visit_id = $1 AND id > $2', [visitId, prev.rows[0].id]);
    }

    await pool.query(
      `INSERT INTO answers (visit_id, question_id, value, source)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (visit_id, question_id) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, created_at = now()`,
      [visitId, questionId, String(value).slice(0, 500), source]
    );

    const flags = await updateRedFlags(visitId);
    const nextQuestion = await currentQuestion(visitId);

    if (!nextQuestion) {
      const structured = await finalizeVisit(visitId);
      return res.json({
        saved: true, done: true, red_flags: flags,
        summary: structured, progress: await progress(visitId),
      });
    }
    res.json({ saved: true, done: false, red_flags: flags, nextQuestion, progress: await progress(visitId) });
  } catch (err) {
    sendError(res, err);
  }
});

// Back / undo: remove the last answer, recompute current question
app.delete('/api/visits/:id/answers/last', async (req, res) => {
  try {
    const visitId = req.params.id;
    const last = await pool.query(
      'SELECT id FROM answers WHERE visit_id = $1 ORDER BY id DESC LIMIT 1', [visitId]);
    if (last.rows.length > 0) {
      await pool.query('DELETE FROM answers WHERE id = $1', [last.rows[0].id]);
    }
    const flags = await updateRedFlags(visitId);
    const question = await currentQuestion(visitId);
    res.json({ deleted: last.rows.length > 0, question, red_flags: flags, progress: await progress(visitId) });
  } catch (err) {
    sendError(res, err);
  }
});

// Patient free-text note ("what's wrong with them + what they're feeling")
app.put('/api/visits/:id/note', async (req, res) => {
  try {
    const note = String(req.body.note || '').slice(0, 2000);
    await pool.query('UPDATE visits SET patient_note = $2 WHERE id = $1', [req.params.id, note]);
    // The note is written after intake completes — regenerate the AI summary so
    // the patient's own words are included for the doctor.
    const { rows } = await pool.query('SELECT status FROM visits WHERE id = $1', [req.params.id]);
    if (rows[0]?.status === 'waiting' && note.trim()) {
      generateAISummary(req.params.id).catch((err) => console.error('AI re-summary failed:', err.message));
    }
    res.json({ saved: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Doctor dashboard base URL — where the QR points. Configurable for LAN/hosting.
const DOCTOR_URL = process.env.DOCTOR_URL || 'http://localhost:4000/doctor';

// QR code for a visit: encodes a link the doctor scans to open the case instantly.
app.get('/api/visits/:id/qr', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT token FROM visits WHERE id = $1', [req.params.id]);
    if (rows.length === 0 || !rows[0].token) return res.status(404).json({ error: 'no token' });
    const url = `${DOCTOR_URL}?token=${encodeURIComponent(rows[0].token)}`;
    const dataUrl = await QRCode.toDataURL(url, { width: 240, margin: 1 });
    res.json({ qr: dataUrl, token: rows[0].token, url });
  } catch (err) {
    sendError(res, err);
  }
});

// Full question set — used by the kiosk to run offline when the network drops
app.get('/api/questions', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, section, sort_order, type, text_hi, text_en, options, next, next_by_answer, translations FROM questions ORDER BY sort_order, id'
    );
    res.json({ questions: rows });
  } catch (err) {
    sendError(res, err);
  }
});

// Speech-to-text: accept recorded audio (raw body), transcribe, return text.
// Enables voice input in Firefox, which lacks the browser SpeechRecognition API.
app.post('/api/stt', rateLimit({ max: 15, windowMs: 60_000, name: 'stt' }),
  express.raw({ type: ['audio/webm', 'audio/ogg', 'audio/wav', 'application/octet-stream'], limit: '15mb' }), async (req, res) => {
    try {
      const buffer = req.body;
      const lang = req.query.lang || 'hi';
      if (!buffer || !buffer.length) return res.status(400).json({ error: 'no audio' });
      const text = await transcribeAudio(buffer, lang);
      res.json({ text });
    } catch (err) {
      sendError(res, err);
    }
  });

// Text-to-speech proxy: forwards to Google TTS (no Referer issues, same-origin).
// The kiosk plays audio from this endpoint instead of calling Google directly.
const GOOGLE_TTS_URL = 'https://translate.google.com/translate_tts';
app.get('/api/tts', async (req, res) => {
  try {
    const { lang = 'hi', text } = req.query;
    if (!text) return res.status(400).end('?text= required');
    // Map our lang codes to Google's 2-letter codes (bho/pah → hi)
    const T = { hi:'hi', en:'en', pa:'pa', mr:'mr', gu:'gu', te:'te', kn:'kn', ta:'ta', bn:'bn', ml:'ml', ur:'ur', bho:'hi', pah:'hi', as:'as', or:'or' };
    const tl = T[lang] || 'hi';
    const url = `${GOOGLE_TTS_URL}?ie=UTF-8&client=tw-ob&tl=${tl}&ttsspeed=0.82&q=${encodeURIComponent(text.slice(0, 200))}`;
    // Fetch without Referer (Google blocks with Referer)
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return res.status(502).end('TTS upstream failed');
    const buf = Buffer.from(await r.arrayBuffer());
    res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=3600' });
    res.end(buf);
  } catch (err) {
    sendError(res, err);
  }
});

// Current question
app.get('/api/visits/:id/question', async (req, res) => {
  try {
    const question = await currentQuestion(req.params.id);
    res.json({ question, progress: await progress(req.params.id) });
  } catch (err) {
    sendError(res, err);
  }
});

// Full visit view (doctor dashboard source)
app.get('/api/visits/:id', async (req, res) => {
  try {
    const { rows: visit } = await pool.query(
      `SELECT v.*, p.name, p.age, p.gender, p.phone, p.abha_id
         FROM visits v JOIN patients p ON p.id = v.patient_id
        WHERE v.id = $1`, [req.params.id]);
    if (visit.length === 0) return res.status(404).json({ error: 'visit not found' });
    const { rows: answers } = await pool.query(
      `SELECT a.question_id, a.value, a.source, q.text_en, q.text_hi, q.section, q.options
         FROM answers a JOIN questions q ON q.id = a.question_id
        WHERE a.visit_id = $1 ORDER BY a.id`, [req.params.id]);
    const { rows: summ } = await pool.query(
      'SELECT * FROM summaries WHERE visit_id = $1', [req.params.id]);
    res.json({ visit: visit[0], answers, summary: summ[0] || null });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- doctor routes ----------
// Every doctor endpoint requires the doctor PIN (header X-Doctor-Pin).
app.use('/api/doctor', doctorAuth);
app.get('/api/doctor/auth', (_req, res) => res.json({ ok: true }));

// Waiting list / dashboard
app.get('/api/doctor/visits', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.id, v.status, v.red_flags, v.has_urgency, v.patient_note, v.one_liner, v.created_at,
              p.name, p.age, p.gender, p.phone,
              (SELECT count(*)::int FROM answers a WHERE a.visit_id = v.id) AS answered,
              (SELECT count(*)::int FROM questions) AS total
         FROM visits v JOIN patients p ON p.id = v.patient_id
        ORDER BY CASE v.status WHEN 'waiting' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, v.created_at ASC`
    );
    // Fallback clinical one-liner for visits the AI hasn't finished yet
    const missing = rows.filter(v => !v.one_liner);
    if (missing.length > 0) {
      const { rows: answers } = await pool.query(
        `SELECT a.visit_id, a.question_id, a.value FROM answers a WHERE a.visit_id = ANY($1) ORDER BY a.id`,
        [missing.map(v => v.id)]
      );
      const byVisit = {};
      for (const a of answers) (byVisit[a.visit_id] = byVisit[a.visit_id] || []).push(a);
      for (const v of missing) {
        v.one_liner = quickLine(
          { age: v.age, gender: v.gender },
          byVisit[v.id] || [],
          v.red_flags
        );
      }
    }
    res.json({ visits: rows });
  } catch (err) {
    sendError(res, err);
  }
});

// Look up a visit by QR token — doctor scans QR, case opens instantly
app.get('/api/doctor/token/:token', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM visits WHERE token = $1', [req.params.token]);
    if (rows.length === 0) return res.status(404).json({ error: 'visit not found' });
    res.json({ visitId: rows[0].id });
  } catch (err) {
    sendError(res, err);
  }
});

// Doctor detail: visit + answers + summary + consultation
app.get('/api/doctor/visits/:id', async (req, res) => {
  try {
    const { rows: visit } = await pool.query(
      `SELECT v.*, p.name, p.age, p.gender, p.phone
         FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = $1`, [req.params.id]);
    if (visit.length === 0) return res.status(404).json({ error: 'visit not found' });
    const { rows: answers } = await pool.query(
      `SELECT a.question_id, a.value, a.source, q.text_en, q.text_hi, q.section, q.options
         FROM answers a JOIN questions q ON q.id = a.question_id
        WHERE a.visit_id = $1 ORDER BY a.id`, [req.params.id]);
    const { rows: summ } = await pool.query(
      'SELECT * FROM summaries WHERE visit_id = $1', [req.params.id]);

    const pretty = answers.map(a => ({
      question: a.text_en,
      section: a.section,
      value: prettyValue(a.question_id, a.value),
      source: a.source,
    }));

    // Doctor reads the ENGLISH structured summary when available
    const summary = summ[0]
      ? { ...summ[0], structured: summ[0].structured_en || summ[0].structured }
      : null;

    res.json({ visit: visit[0], answers: pretty, summary });
  } catch (err) {
    sendError(res, err);
  }
});

// Doctor saves consultation: prescription/notes + status
app.put('/api/doctor/visits/:id', async (req, res) => {
  try {
    const prescription = String(req.body.prescription || '').slice(0, 5000);
    const doctor_notes = String(req.body.doctor_notes || '').slice(0, 5000);
    const status = ['consulted', 'waiting', 'in_progress'].includes(req.body.status) ? req.body.status : 'consulted';
    await pool.query(
      `INSERT INTO summaries (visit_id, doctor_notes, prescription)
       VALUES ($1,$2,$3)
       ON CONFLICT (visit_id) DO UPDATE SET doctor_notes = EXCLUDED.doctor_notes, prescription = EXCLUDED.prescription`,
      [req.params.id, doctor_notes, prescription]
    );
    await pool.query(`UPDATE visits SET status = $2 WHERE id = $1`, [req.params.id, status]);
    res.json({ saved: true });
  } catch (err) {
    sendError(res, err);
  }
});

// (Re)generate the AI clinical summary for a visit — doctor-triggered
app.post('/api/doctor/visits/:id/ai-summary', async (req, res) => {
  try {
    const { rows: langRows } = await pool.query(
      `SELECT p.preferred_language FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = $1`,
      [req.params.id]
    );
    const lang = langRows[0]?.preferred_language || 'en';
    const summary = await generateAISummary(req.params.id, lang);
    res.json({ saved: true, ai_summary: summary });
  } catch (err) {
    sendError(res, err);
  }
});

// PDF export of the full visit summary + prescription
app.get('/api/doctor/visits/:id/pdf', async (req, res) => {
  try {
    const doc = await visitPDF(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="visit-${req.params.id}-summary.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    sendError(res, err);
  }
});

// Static doctor dashboard
app.get('/doctor', (_req, res) => res.sendFile(path.join(__dirname, 'doctor.html')));
app.get('/doctor/', (_req, res) => res.sendFile(path.join(__dirname, 'doctor.html')));
app.get('/doctor.js', (_req, res) => res.sendFile(path.join(__dirname, 'doctor.js')));
app.get('/doctor.css', (_req, res) => res.sendFile(path.join(__dirname, 'doctor.css')));

// Waiting-area queue screen (TV mode — no PIN, public display)
app.get('/queue', (_req, res) => res.sendFile(path.join(__dirname, 'queue.html')));
app.get('/queue/', (_req, res) => res.sendFile(path.join(__dirname, 'queue.html')));

// Serve the built React kiosk (client/dist) — same origin as the API.
const DIST = path.join(__dirname, '..', 'client', 'dist');
if (existsSync(DIST)) {
  app.use(express.static(DIST));
  // SPA fallback: anything that isn't an API or doctor route → the kiosk
  app.get(/^(?!\/api|\/doctor).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
  console.log(`Serving kiosk from ${DIST}`);
} else {
  console.log('client/dist not found — run `cd client && npm run build` to serve the kiosk from this server');
}

// Make sure the DB is ready (schema + seed) before accepting traffic.
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MediKiosk API on http://localhost:${PORT}`);
      // Pre-load the Whisper model in the background so voice is instant.
      try { warmWhisper(); } catch (_) {}
    });
  })
  .catch((err) => {
    console.error('Database init failed:', err);
    process.exit(1);
  });

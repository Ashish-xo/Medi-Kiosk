import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pool from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// ---------- helpers ----------

async function getQuestion(id) {
  if (!id) return null;
  const { rows } = await pool.query('SELECT * FROM questions WHERE id = $1', [id]);
  return rows[0] || null;
}

// Given the last answered question + its value, what's the next question id?
function decideNext(q, value) {
  if (!q) return null;
  if (q.next_by_answer && q.next_by_answer[value]) return q.next_by_answer[value];
  return q.next || null; // null => flow finished
}

// Find the current question for a visit (no answers yet => first question ever)
async function currentQuestion(visitId) {
  const { rows } = await pool.query(
    `SELECT a.value AS last_value, q.*
       FROM answers a JOIN questions q ON q.id = a.question_id
      WHERE a.visit_id = $1 ORDER BY a.id DESC LIMIT 1`,
    [visitId]
  );
  if (rows.length === 0) {
    return getQuestion('cc'); // first question in the tree
  }
  const last = rows[0];
  const nextId = decideNext(last, last.last_value);
  if (!nextId) return null; // done
  return getQuestion(nextId);
}

async function updateRedFlags(visitId) {
  const { rows } = await pool.query('SELECT question_id, value FROM answers WHERE visit_id = $1', [visitId]);
  const ans = {};
  for (const r of rows) ans[r.question_id] = r.value;

  const flags = [];
  if (ans.cc === 'chest pain' && ans.cp_breath === 'yes')
    flags.push('Chest pain with breathlessness — possible emergency');
  if (ans.cc === 'chest pain' && ans.cc_severity === 'severe')
    flags.push('Severe chest pain — immediate review');
  if (ans.cc === 'dizziness')
    flags.push('Dizziness reported — fall risk');

  await pool.query('UPDATE visits SET red_flags = $2 WHERE id = $1', [visitId, JSON.stringify(flags)]);
  return flags;
}

// ---------- routes ----------

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Start a visit: find-or-create patient, open a visit, return first question
app.post('/api/visits', async (req, res) => {
  try {
    const { name, age, gender, phone, language = 'hi', ayush_mode = true } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'name and phone are required' });
    }
    // find-or-create patient (phone is the key)
    let { rows } = await pool.query('SELECT * FROM patients WHERE phone = $1', [phone]);
    let patient;
    if (rows.length === 0) {
      ({ rows } = await pool.query(
        `INSERT INTO patients (name, phone, age, gender, preferred_language)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [name, phone, age, gender, language]
      ));
      patient = rows[0];
    } else {
      patient = rows[0];
    }
    const { rows: v } = await pool.query(
      `INSERT INTO visits (patient_id, ayush_mode) VALUES ($1,$2) RETURNING *`,
      [patient.id, ayush_mode]
    );
    const question = await currentQuestion(v[0].id);
    res.status(201).json({
      visitId: v[0].id, patientId: patient.id,
      currentQuestion: question,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Current question for a visit
app.get('/api/visits/:id/question', async (req, res) => {
  try {
    const question = await currentQuestion(req.params.id);
    const { rows: cnt } = await pool.query(
      'SELECT count(*)::int AS n FROM answers WHERE visit_id = $1', [req.params.id]);
    const { rows: total } = await pool.query('SELECT count(*)::int AS n FROM questions');
    res.json({ question, progress: { answered: cnt[0].n, total: total[0].n } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save an answer, recompute red flags, return the next question
app.post('/api/visits/:id/answers', async (req, res) => {
  try {
    const { questionId, value, source = 'touch' } = req.body;
    await pool.query(
      `INSERT INTO answers (visit_id, question_id, value, source)
       VALUES ($1,$2,$3,$4)`,
      [req.params.id, questionId, value, source]
    );
    const flags = await updateRedFlags(req.params.id);
    const nextQuestion = await currentQuestion(req.params.id);

    if (!nextQuestion) {
      await pool.query('UPDATE visits SET status = $2 WHERE id = $1', [req.params.id, 'ready']);
      return res.json({ saved: true, done: true, red_flags: flags });
    }
    res.json({ saved: true, done: false, red_flags: flags, nextQuestion });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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
      `SELECT a.question_id, a.value, a.source, q.text_en, q.text_hi, q.section
         FROM answers a JOIN questions q ON q.id = a.question_id
        WHERE a.visit_id = $1 ORDER BY a.id`, [req.params.id]);
    res.json({ visit: visit[0], answers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`MediKiosk API on http://localhost:${PORT}`));

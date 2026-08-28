// Idempotent DB bootstrap for fresh deployments:
//  - creates all tables if missing
//  - runs column migrations if missing
//  - upserts the question bank (never wipes visits/patients/answers)
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pool from './db.js';

export async function initDb() {
  // ---- tables (CREATE IF NOT EXISTS) ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS patients (
      id SERIAL PRIMARY KEY,
      name TEXT,
      phone TEXT UNIQUE,
      age INT,
      gender TEXT,
      preferred_language TEXT DEFAULT 'hi',
      abha_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS visits (
      id SERIAL PRIMARY KEY,
      patient_id INT REFERENCES patients(id),
      status TEXT DEFAULT 'in_progress',
      red_flags JSONB DEFAULT '[]',
      ayush_mode BOOLEAN DEFAULT true,
      patient_note TEXT DEFAULT '',
      has_urgency BOOLEAN DEFAULT false,
      token TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      section TEXT,
      sort_order INT,
      type TEXT,
      text_hi TEXT,
      text_en TEXT,
      options JSONB DEFAULT '[]',
      next TEXT,
      next_by_answer JSONB DEFAULT '{}',
      translations JSONB DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS answers (
      id SERIAL PRIMARY KEY,
      visit_id INT REFERENCES visits(id),
      question_id TEXT REFERENCES questions(id),
      value TEXT,
      source TEXT DEFAULT 'touch',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      visit_id INT REFERENCES visits(id),
      filename TEXT,
      ocr_text TEXT,
      extracted JSONB DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS summaries (
      id SERIAL PRIMARY KEY,
      visit_id INT REFERENCES visits(id) UNIQUE,
      structured JSONB DEFAULT '{}',
      ai_summary TEXT DEFAULT '',
      doctor_notes TEXT,
      prescription TEXT DEFAULT '',
      status TEXT DEFAULT 'draft'
    );
  `);

  // ---- column migrations (idempotent) ----
  const cols = [
    ["visits", "patient_note", "TEXT DEFAULT ''"],
    ["visits", "has_urgency", "BOOLEAN DEFAULT false"],
    ["visits", "token", "TEXT"],
    ["questions", "translations", "JSONB DEFAULT '{}'"],
    ["summaries", "ai_summary", "TEXT DEFAULT ''"],
    ["summaries", "prescription", "TEXT DEFAULT ''"],
  ];
  for (const [table, col, ddl] of cols) {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
      [table, col]
    );
    if (rows.length === 0) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
      console.log(`  ✅ added ${table}.${col}`);
    }
  }
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='answers_visit_question_unique') THEN
        ALTER TABLE answers ADD CONSTRAINT answers_visit_question_unique UNIQUE (visit_id, question_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='visits_token_idx') THEN
        CREATE UNIQUE INDEX visits_token_idx ON visits(token);
      END IF;
    END $$;
  `);

  // ---- upsert question bank (never destructive) ----
  const questions = JSON.parse(
    readFileSync(new URL('./questions.json', import.meta.url), 'utf8')
  );
  let inserted = 0;
  for (const q of questions) {
    const { rows } = await pool.query(
      `INSERT INTO questions (id, section, sort_order, type, text_hi, text_en, options, next, next_by_answer, translations)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         section=EXCLUDED.section, sort_order=EXCLUDED.sort_order, type=EXCLUDED.type,
         text_hi=EXCLUDED.text_hi, text_en=EXCLUDED.text_en, options=EXCLUDED.options,
         next=EXCLUDED.next, next_by_answer=EXCLUDED.next_by_answer,
         translations=COALESCE(questions.translations, EXCLUDED.translations)
       RETURNING (xmax = 0) AS is_new`,
      [q.id, q.section, q.sort_order, q.type, q.text_hi, q.text_en,
       JSON.stringify(q.options || []), q.next || null,
       JSON.stringify(q.next_by_answer || {}), JSON.stringify(q.translations || {})]
    );
    if (rows[0].is_new) inserted++;
  }
  console.log(`  ✅ questions upserted (${inserted} new, ${questions.length} total)`);

  return true;
}
-- MediKiosk schema (run once: psql -d sih_medi_kiosk -f schema.sql)

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
  status TEXT DEFAULT 'in_progress',        -- in_progress | ready | consulted
  red_flags JSONB DEFAULT '[]',
  ayush_mode BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  section TEXT,
  sort_order INT,
  type TEXT,                                -- 'choice' | 'text' | 'number'
  text_hi TEXT,
  text_en TEXT,
  options JSONB DEFAULT '[]',               -- [{value,label_hi,label_en},...]
  next TEXT,                                -- default next question id
  next_by_answer JSONB DEFAULT '{}'         -- {"chest pain": "cp_start", ...}
);

CREATE TABLE IF NOT EXISTS answers (
  id SERIAL PRIMARY KEY,
  visit_id INT REFERENCES visits(id),
  question_id TEXT REFERENCES questions(id),
  value TEXT,
  source TEXT DEFAULT 'touch',              -- 'voice' | 'touch' | 'ocr'
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
  doctor_notes TEXT,
  status TEXT DEFAULT 'draft'
);

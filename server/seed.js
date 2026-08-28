import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pool from './db.js';

const questions = JSON.parse(
  readFileSync(new URL('./questions.json', import.meta.url), 'utf8')
);

// reset (dev only)
await pool.query('DELETE FROM answers');
await pool.query('DELETE FROM questions');
await pool.query('TRUNCATE visits, patients RESTART IDENTITY CASCADE');

for (const q of questions) {
  await pool.query(
    `INSERT INTO questions (id, section, sort_order, type, text_hi, text_en, options, next, next_by_answer)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      q.id, q.section, q.sort_order, q.type,
      q.text_hi, q.text_en,
      JSON.stringify(q.options || []),
      q.next || null,
      JSON.stringify(q.next_by_answer || {}),
    ]
  );
}

console.log(`Seeded ${questions.length} questions ✅`);
await pool.end();

// Generate translations for all questions into Indian languages using the AI.
import 'dotenv/config';
import pool from './db.js';

const API_URL = process.env.AI_URL || 'https://api.b.ai/v1/chat/completions';
const API_KEY = process.env.AI_KEY || process.env.HERMES_CUSTOM_API_B_AI_API_KEY;
const MODEL = process.env.AI_MODEL || 'deepseek-v4-flash-vision-exp';

const LANGUAGES = {
  pa: { name: 'Punjabi', script: 'Gurmukhi' },
  mr: { name: 'Marathi', script: 'Devanagari' },
  gu: { name: 'Gujarati', script: 'Gujarati' },
  te: { name: 'Telugu', script: 'Telugu' },
  kn: { name: 'Kannada', script: 'Kannada' },
  ta: { name: 'Tamil', script: 'Tamil' },
  bn: { name: 'Bengali', script: 'Bengali' },
  ml: { name: 'Malayalam', script: 'Malayalam' },
  ur: { name: 'Urdu', script: 'Urdu (Perso-Arabic)' },
  bho: { name: 'Bhojpuri', script: 'Devanagari' },
  pah: { name: 'Pahari (Himachali)', script: 'Devanagari' },
  as: { name: 'Assamese', script: 'Assamese' },
  or: { name: 'Odia', script: 'Odia' },
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function translateQuestions(questions, langCode, langInfo) {
  const source = JSON.stringify(questions.map(q => ({
    id: q.id,
    text: q.text_en,
    options: q.options?.map(o => ({ value: o.value, label: o.label_en })) || [],
    next: q.next,
    next_by_answer: q.next_by_answer,
  })), null, 1);

  const prompt = `You are a medical translator for a hospital intake kiosk in India.
Translate the following medical questionnaire from English into ${langInfo.name} (${langInfo.script}).
Return ONLY valid JSON — no explanation, no markdown, no code fences. The JSON must be an array of objects, each with:
  {"id": "...", "text": "translated question text", "options": [{"value": "...", "label": "translated option label"}, ...]}
Preserve the "id", "value", "next", and "next_by_answer" fields exactly as given.
Use natural, locally-understood medical terminology. If a medical term has no direct equivalent, use the closest common term.

Input JSON:
${source}`;

  // Retry with exponential backoff on 429/5xx
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'system', content: prompt }],
          max_tokens: 20000,
          temperature: 0.1,
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`AI ${res.status} for ${langCode}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      const raw = data?.choices?.[0]?.message?.content || '';
      if (!raw.trim()) {
        lastErr = new Error('empty content');
        await sleep(5000 * (attempt + 1));
        continue;
      }
      // Extract JSON from the response (handle possible code fences)
      let json = raw.trim();
      if (json.startsWith('```')) json = json.replace(/^```(?:\w+)?\n?/, '').replace(/```$/, '').trim();
      return JSON.parse(json);
    } catch (err) {
      lastErr = err;
      if (err.message.includes('AI 4') || err.message.includes('Unexpected') || err.message.includes('Unterminated')) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      await sleep(3000 * (attempt + 1));
    }
  }
  throw lastErr || new Error('translation failed');
}

const { rows: questions } = await pool.query('SELECT * FROM questions ORDER BY id');
console.log(`Loaded ${questions.length} questions.\n`);

// Build the full translations map in memory: { qid: { langCode: {text, options} } }
const translationsByQuestion = {};
for (const q of questions) translationsByQuestion[q.id] = {};

for (const [code, info] of Object.entries(LANGUAGES)) {
  try {
    console.log(`Translating to ${info.name} (${code})...`);
    const translated = await translateQuestions(questions, code, info);
    console.log(`  Got ${translated.length} translations`);
    for (const t of translated) {
      if (!translationsByQuestion[t.id]) continue;
      const opts = {};
      for (const o of t.options || []) opts[o.value] = o.label;
      translationsByQuestion[t.id][code] = { text: t.text, options: opts };
    }
    console.log(`  ✅ Prepared ${code}\n`);
    await sleep(2000); // gentle pacing between languages to avoid 429
  } catch (err) {
    console.error(`  ❌ ${code} failed: ${err.message}\n`);
  }
}

// Store in ONE update per question (jsonb_set can't create nested keys,
// so build the complete object here instead).
console.log('Storing translations...');
let stored = 0;
for (const q of questions) {
  const tmap = translationsByQuestion[q.id];
  if (!Object.keys(tmap).length) continue;
  await pool.query('UPDATE questions SET translations = $2 WHERE id = $1', [q.id, JSON.stringify(tmap)]);
  stored++;
}
console.log(`Stored translations for ${stored} questions ✅`);

console.log('All done!');
await pool.end();
// Generate UI chrome translations (client/src/ui_strings.js) for all languages.
// One AI call per language with retry + backoff.
import 'dotenv/config';
import { writeFileSync } from 'node:fs';

const API_URL = process.env.AI_URL || 'https://api.b.ai/v1/chat/completions';
const API_KEY = process.env.AI_KEY || process.env.HERMES_CUSTOM_API_B_AI_API_KEY;
const MODEL = process.env.AI_MODEL || 'deepseek-v4-flash-vision-exp';

const LANGS = {
  hi: 'Hindi', en: 'English', pa: 'Punjabi', mr: 'Marathi', gu: 'Gujarati',
  te: 'Telugu', kn: 'Kannada', ta: 'Tamil', bn: 'Bengali', ml: 'Malayalam',
  ur: 'Urdu', bho: 'Bhojpuri', pah: 'Pahari (Himachali)', as: 'Assamese', or: 'Odia',
};

const STRINGS = {
  name: 'Name *',
  phone: 'Mobile number',
  age: 'Age',
  start: 'Start',
  back: 'Back',
  next: 'Next',
  speak: 'Speak',
  hear: 'Hear',
  typeHere: 'Type here…',
  enterDetails: "Enter your details, then let's begin your history",
  offlineBanner: 'Offline mode — data saves locally & syncs when online',
  nameInvalid: 'Please enter a valid name (letters only)',
  phoneInvalid: 'Enter your mobile number (Indian mobile number)',
  ageInvalid: 'Enter a valid age (a positive whole number)',
  noCache: 'No network and no cached questions — connect once to enable offline mode',
  done: 'History complete!',
  sentToDoctor: 'Your information has been sent to the doctor.',
  offlineNoNetwork: 'No network — your data is saved safely on this device and will be sent automatically when internet returns.',
  urgentStaff: 'Please see staff immediately — emergency signs detected!',
  urgentAlerted: 'Emergency signs — staff alerted',
  anythingElse: 'Anything else to tell the doctor?',
  ownWords: "Write in your own words what's wrong and how you're feeling.",
  sendToDoctor: 'Send to doctor',
  noteSent: 'Your message reached the doctor. Thank you!',
  waitingSync: 'Waiting to sync…',
  syncing: 'Syncing…',
  synced: 'Synced!',
  qrHint: 'Doctor can scan this QR to open your case instantly',
  viewSummary: 'View summary sent to doctor',
  chiefComplaint: 'Chief complaint',
  duration: 'Duration',
  severity: 'Severity',
  painStart: 'Pain started',
  painFeel: 'Pain feels',
  existing: 'Existing conditions',
  allergies: 'Allergies',
  familyHistory: 'Family history',
  lifestyle: 'Lifestyle',
  sleep: 'Sleep',
  ayurveda: 'Ayurveda',
  skip: 'Skip',
  tellUsMore: "Tell us in your own words what happened and how you feel",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function translateOne(langCode, langName) {
  const prompt = `You are a translator for a hospital intake kiosk in India.
Translate the following UI strings from English into ${langName}. Use natural, everyday, locally-understood wording (informal where appropriate). Keep the "*" asterisks as-is and keep "…" as-is.

Return ONLY valid JSON — a single object mapping each key (exactly as given) to its translation. No markdown, no code fences, no extra text.

${JSON.stringify(STRINGS, null, 1)}`;

  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'system', content: prompt }],
          max_tokens: 6000,
          temperature: 0.1,
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(6000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`AI ${res.status}`);
      const data = await res.json();
      const raw = (data?.choices?.[0]?.message?.content || '').trim();
      if (!raw) { lastErr = new Error('empty'); await sleep(6000 * (attempt + 1)); continue; }
      let json = raw;
      if (json.startsWith('```')) json = json.replace(/^```(?:\w+)?\n?/, '').replace(/```$/, '').trim();
      const obj = JSON.parse(json);
      // sanity: must contain most keys
      const missing = Object.keys(STRINGS).filter(k => !(k in obj));
      if (missing.length > Object.keys(STRINGS).length / 2) throw new Error('too few keys: ' + missing.join(','));
      return obj;
    } catch (err) {
      lastErr = err;
      await sleep(4000 * (attempt + 1));
    }
  }
  throw lastErr || new Error('ui translation failed');
}

const out = { hi: { ...STRINGS }, en: { ...STRINGS } };
for (const [code, name] of Object.entries(LANGS)) {
  if (code === 'hi' || code === 'en') continue;
  try {
    console.log(`Translating UI -> ${name} (${code})...`);
    out[code] = await translateOne(code, name);
    console.log(`  ✅ ${code}`);
    await sleep(1500); // gentle pacing to avoid 429
  } catch (err) {
    console.error(`  ❌ ${code} failed: ${err.message}`);
  }
}

writeFileSync(new URL('../client/src/ui_strings.js', import.meta.url),
  `// Auto-generated UI translations — regenerate with node translate-ui.mjs\n// prettier-ignore\nexport const UI_STRINGS = ${JSON.stringify(out, null, 1)}\n`);
console.log('Wrote client/src/ui_strings.js for', Object.keys(out).length, 'languages');
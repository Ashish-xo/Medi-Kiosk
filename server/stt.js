// Speech-to-text proxy: receives recorded audio from the kiosk, converts to
// 16kHz mono PCM WAV, then transcribes with the configured provider.
//
// Providers (STT_PROVIDER env):
//   whisper  → local faster-whisper (offline, great for hospital/demo; model in whisper-venv)
//   google   → Google's free speech endpoint (needs GOOGLE_STT_KEY)
//   auto     → whisper if the local venv exists, else google  (DEFAULT)
//
// Why whisper: no internet needed, open-source, strong Hindi + Indian-language
// support. Why google fallback: no ~460MB model download on a server deploy.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const exec = promisify(execFile);
const TMP = os.tmpdir();
const __dirname = path.dirname(new URL(import.meta.url).pathname);

const WHISPER_PY = path.join(__dirname, 'whisper-venv', 'bin', 'python');
const WHISPER_SCRIPT = path.join(__dirname, 'whisper_server.py');

// Google's free speech recognition endpoint (same one Chromium uses for
// webkitSpeechRecognition — no paid key required, supports Indian languages).
function getSttUrl(langCode) {
  const key = process.env.GOOGLE_STT_KEY;
  if (!key) return '';
  // lang=auto: Google can't auto-detect — default to English (most common fallback)
  const lang = langCode === 'auto' ? 'en-IN' : (LANG_MAP[langCode] || 'hi-IN');
  return `https://www.google.com/speech-api/v2/recognize?client=chromium&key=${key}&lang=${lang}`;
}

const LANG_MAP = {
  hi: 'hi-IN', en: 'en-IN', pa: 'pa-IN', mr: 'mr-IN', gu: 'gu-IN',
  te: 'te-IN', kn: 'kn-IN', ta: 'ta-IN', bn: 'bn-IN', ml: 'ml-IN',
  ur: 'ur-IN', bho: 'hi-IN', pah: 'hi-IN', as: 'as-IN', or: 'or-IN',
};

// Convert any input audio (webm/ogg/wav) to 16kHz mono WAV for the STT engines.
async function toWav16k(inputPath, outPath) {
  await exec('ffmpeg', [
    '-y', '-i', inputPath,
    '-ac', '1', '-ar', '16000', '-sample_fmt', 's16',
    outPath,
  ], { timeout: 30000 });
}

// ---------- local faster-whisper worker (persistent) ----------

let whisperProc = null;
const whisperPending = []; // {resolve, reject} — one per in-flight request

function ensureWhisper() {
  if (whisperProc) return whisperProc;
  whisperProc = spawn(WHISPER_PY, [WHISPER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'], // pipe stderr too — 'inherit' makes child.stderr null!
    env: process.env,
  });
  let buf = '';
  whisperProc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      const cb = whisperPending.shift();
      if (!cb) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.error) cb.reject(new Error(msg.error));
        else cb.resolve(msg.text);
      } catch (e) { cb.reject(new Error('whisper: bad response')); }
    }
  });
  whisperProc.stderr.on('data', (d) => {
    if (process.env.DEBUG_STT) process.stderr.write(`[whisper] ${d}`);
  });
  whisperProc.on('exit', (code) => {
    whisperProc = null;
    const err = new Error(`whisper worker exited (${code})`);
    while (whisperPending.length) whisperPending.shift().reject(err);
  });
  return whisperProc;
}

function whisperTranscribe(wavPath, langCode) {
  return new Promise((resolve, reject) => {
    const p = ensureWhisper();
    whisperPending.push({ resolve, reject });
    // lang=auto → null → Whisper auto-detects the spoken language
    const code = (langCode === 'auto' || !langCode) ? null : (LANG_MAP[langCode] || 'hi-IN').slice(0, 2);
    p.stdin.write(JSON.stringify({ audio: wavPath, lang: code }) + '\n');
    setTimeout(() => reject(new Error('whisper: timeout')), 120000).unref();
  });
}

function pickProvider() {
  const want = process.env.STT_PROVIDER || 'auto';
  if (want === 'whisper') return 'whisper';
  if (want === 'google') return 'google';
  // auto: local whisper wins when it's installed (offline-capable)
  return existsSync(WHISPER_PY) ? 'whisper' : 'google';
}

// Spawn the worker at boot so the model is already in memory by the time the
// first patient speaks — kills the 5-7s cold-start delay on the very first clip.
export function warmWhisper() {
  if (pickProvider() !== 'whisper') return;
  try {
    ensureWhisper(); // loading the model happens in the worker's main()
  } catch (err) {
    console.error('whisper warm-up failed:', err.message);
  }
}

// Transcribe a buffer of recorded audio. Returns the recognized text or ''.
export async function transcribeAudio(buffer, langCode = 'hi') {
  const id = randomBytes(6).toString('hex');
  const inPath = path.join(TMP, `stt-in-${id}.webm`);
  const wavPath = path.join(TMP, `stt-${id}.wav`);
  try {
    await writeFile(inPath, buffer);
    await toWav16k(inPath, wavPath);

    if (pickProvider() === 'whisper') {
      return await whisperTranscribe(wavPath, langCode);
    }

    const url = getSttUrl(langCode);
    if (!url) throw new Error('Speech-to-text not configured (set GOOGLE_STT_KEY or STT_PROVIDER=whisper)');

    const wav = await readFile(wavPath);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/l16; rate=16000' },
      body: wav,
    });
    if (!res.ok) throw new Error(`STT HTTP ${res.status}`);

    const text = await res.text();
    // Response is a stream of JSON lines; find the one with results
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const results = data?.result?.[0]?.alternative;
        if (results?.length) {
          const best = results.find((r) => r.confidence) || results[0];
          if (best?.transcript) return best.transcript.trim();
        }
      } catch (_) { /* keep scanning */ }
    }
    return '';
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(wavPath).catch(() => {});
  }
}

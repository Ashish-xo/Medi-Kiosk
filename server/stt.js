// Speech-to-text proxy: receives recorded audio from the kiosk, converts to
// 16kHz mono PCM WAV, and transcribes via the free Google speech endpoint.
// This lets Firefox (which has no SpeechRecognition API) do voice input.
// The Google key is NOT hardcoded — set GOOGLE_STT_KEY in .env / Railway vars.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const exec = promisify(execFile);
const TMP = os.tmpdir();

// Google's free speech recognition endpoint (same one Chromium uses for
// webkitSpeechRecognition — no paid key required, supports Indian languages).
function getSttUrl(langCode) {
  const key = process.env.GOOGLE_STT_KEY;
  if (!key) return '';
  const lang = LANG_MAP[langCode] || 'hi-IN';
  return `https://www.google.com/speech-api/v2/recognize?client=chromium&key=${key}&lang=${lang}`;
}

const LANG_MAP = {
  hi: 'hi-IN', en: 'en-IN', pa: 'pa-IN', mr: 'mr-IN', gu: 'gu-IN',
  te: 'te-IN', kn: 'kn-IN', ta: 'ta-IN', bn: 'bn-IN', ml: 'ml-IN',
  ur: 'ur-IN', bho: 'hi-IN', pah: 'hi-IN', as: 'as-IN', or: 'or-IN',
};

// Convert any input audio (webm/ogg/wav) to 16kHz mono WAV for the STT API.
async function toWav16k(inputPath, outPath) {
  await exec('ffmpeg', [
    '-y', '-i', inputPath,
    '-ac', '1', '-ar', '16000', '-sample_fmt', 's16',
    outPath,
  ], { timeout: 30000 });
}

// Transcribe a buffer of recorded audio. Returns the recognized text or ''.
export async function transcribeAudio(buffer, langCode = 'hi') {
  const id = randomBytes(6).toString('hex');
  const inPath = path.join(TMP, `stt-in-${id}.webm`);
  const wavPath = path.join(TMP, `stt-${id}.wav`);
  try {
    await writeFile(inPath, buffer);
    await toWav16k(inPath, wavPath);
    const wav = await readFile(wavPath);
    const url = getSttUrl(langCode);
    if (!url) throw new Error('Speech-to-text not configured (set GOOGLE_STT_KEY)');

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

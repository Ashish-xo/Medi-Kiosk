// ---------------------------------------------------------------
// MediKiosk — Indian language registry + speech helpers
//
// Each language carries:
//   code     — short key used for translations lookup
//   name     — English name
//   native   — name written in its own script (for the picker)
//   speech   — BCP-47 code used by Web Speech API (recognition + synthesis)
// ---------------------------------------------------------------

export const LANGUAGES = [
  { code: 'hi',  name: 'Hindi',     native: 'हिन्दी',      speech: 'hi-IN' },
  { code: 'en',  name: 'English',   native: 'English',     speech: 'en-IN' },
  { code: 'pa',  name: 'Punjabi',   native: 'ਪੰਜਾਬੀ',       speech: 'pa-IN' },
  { code: 'mr',  name: 'Marathi',   native: 'मराठी',        speech: 'mr-IN' },
  { code: 'gu',  name: 'Gujarati',  native: 'ગુજરાતી',      speech: 'gu-IN' },
  { code: 'te',  name: 'Telugu',    native: 'తెలుగు',       speech: 'te-IN' },
  { code: 'kn',  name: 'Kannada',   native: 'ಕನ್ನಡ',        speech: 'kn-IN' },
  { code: 'ta',  name: 'Tamil',     native: 'தமிழ்',        speech: 'ta-IN' },
  { code: 'bn',  name: 'Bengali',   native: 'বাংলা',        speech: 'bn-IN' },
  { code: 'ml',  name: 'Malayalam', native: 'മലയാളം',       speech: 'ml-IN' },
  { code: 'ur',  name: 'Urdu',      native: 'اردو',         speech: 'ur-IN' },
  { code: 'bho', name: 'Bhojpuri',  native: 'भोजपुरी',      speech: 'hi-IN' }, // no native Bhojpuri ASR/TTS — falls back to Hindi
  { code: 'pah', name: 'Pahari',    native: 'पहाड़ी',       speech: 'hi-IN' }, // no native Pahari ASR/TTS — falls back to Hindi
  { code: 'as',  name: 'Assamese',  native: 'অসমীয়া',      speech: 'as-IN' },
  { code: 'or',  name: 'Odia',      native: 'ଓଡ଼ିଆ',        speech: 'or-IN' },
]

export const languageByCode = (code) => LANGUAGES.find((l) => l.code === code) || LANGUAGES[0]

// ---- speech recognition ----
// ALWAYS prefer the server path (MediaRecorder → /api/stt → Whisper):
//  - mobile Chrome/Android SpeechRecognition is unreliable (drops words,
//    dies after one utterance, can't be restarted cleanly)
//  - Whisper auto-detects the SPOKEN language (lang=auto), so what the user
//    says wins over what UI language they picked
// Browser Web Speech API is only a last resort when getUserMedia is missing.
export function recognizeSpeech(langCode, onPartial) {
  if (navigator.mediaDevices?.getUserMedia) return recognizeServer(langCode, onPartial)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (SR) return recognizeBrowser(langCode, onPartial)
  return Promise.reject(new Error('No microphone support on this device'))
}

// Native path: Chrome/Edge/Safari
function recognizeBrowser(langCode, onPartial) {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    const lang = languageByCode(langCode)
    rec.lang = lang.speech
    rec.continuous = false
    rec.interimResults = true
    rec.maxAlternatives = 1
    let finalText = ''
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript
        if (e.results[i].isFinal) finalText += t
        else interim += t
      }
      if (onPartial) onPartial(finalText + interim)
    }
    rec.onerror = (e) => reject(new Error('Mic error: ' + e.error))
    rec.onend = () => resolve(finalText.trim())
    rec.start()
  })
}

// Firefox path: record audio, send to our server, get text back.
// Includes silence detection with a minimum-talk floor + max duration.
function recognizeServer(langCode, onPartial) {
  return new Promise((resolve, reject) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      return reject(new Error('Microphone not available'))
    }
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(async (stream) => {
        const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
        const rec = new MediaRecorder(stream, { mimeType: mime })
        const chunks = []
        let timeout = null
        let done = false

        // Silence detection using AudioContext. CRITICAL: browsers start the
        // context suspended until a user gesture, so resume() it first or the
        // analyser reads all-zeros and we'd "hear" silence instantly.
        const actx = new (window.AudioContext || window.webkitAudioContext)()
        try { await actx.resume() } catch (_) {}
        const src = actx.createMediaStreamSource(stream)
        const analyser = actx.createAnalyser()
        analyser.fftSize = 256
        src.connect(analyser)
        const data = new Uint8Array(analyser.frequencyBinCount)

        const SILENCE_MS = 2500   // stop 2.5s after speech ends (tolerant of natural pauses)
        const MIN_TALK_MS = 1200  // don't auto-stop before this much recording
        const MAX_MS = 20000      // hard backstop
        const NO_SPEECH_MS = 6000 // if the patient never spoke, stop early instead of 20s of silence
        const SILENCE_THRESHOLD = 8
        let silentSince = null
        let startedAt = Date.now()
        let sawAudio = false

        function checkSilence() {
          if (done) return
          analyser.getByteFrequencyData(data)
          const avg = data.reduce((a, b) => a + b, 0) / data.length
          if (avg > SILENCE_THRESHOLD) {
            sawAudio = true
            silentSince = null
          } else if (!sawAudio && Date.now() - startedAt > NO_SPEECH_MS) {
            // nothing was ever said — stop so we don't record 20s of silence
            if (rec.state !== 'inactive') rec.stop()
            return
          } else if (sawAudio && Date.now() - startedAt > MIN_TALK_MS) {
            if (!silentSince) silentSince = Date.now()
            else if (Date.now() - silentSince >= SILENCE_MS) {
              if (rec.state !== 'inactive') rec.stop()
              return
            }
          }
          timeout = setTimeout(checkSilence, 300)
        }
        // hard backstop
        const hardStop = setTimeout(() => { if (rec.state !== 'inactive') rec.stop() }, MAX_MS)

        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
        rec.onstop = async () => {
          done = true
          clearTimeout(timeout)
          clearTimeout(hardStop)
          actx.close().catch(() => {})
          stream.getTracks().forEach((t) => t.stop())
          if (chunks.length === 0) { resolve(''); return }
          const blob = new Blob(chunks, { type: mime })
          try {
            // lang=auto → the STT engine detects the SPOKEN language itself.
            // The patient's words win over the UI language they picked.
            const r = await fetch('/api/stt?lang=auto', {
              method: 'POST',
              headers: { 'Content-Type': mime },
              body: blob,
            })
            const data = await r.json()
            if (!r.ok) throw new Error(data.error || 'transcription failed')
            resolve((data.text || '').trim())
          } catch (err) {
            reject(err)
          }
        }
        rec.onstart = () => {
          checkSilence()
        }
        rec.start()
        const stop = () => { clearTimeout(timeout); clearTimeout(hardStop); done = true; if (rec.state !== 'inactive') rec.stop() }
        _activeServerRec = stop
      })
      .catch((err) => reject(new Error('Mic error: ' + (err.name || err.message))))
  })
}

// Keep a reference so the UI can stop early on a second tap.
let _activeServerRec = null
export function stopListeningEarly() {
  if (_activeServerRec) { _activeServerRec(); _activeServerRec = null }
}

// Normalize text for fuzzy matching: lowercase, strip punctuation/diacritics-ish
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{M}\s]/gu, '').replace(/\s+/g, ' ').trim()
}

// Best fuzzy match of a spoken transcript against option labels.
// Returns { value, label, score } or null if nothing is close enough.
export function matchOption(transcript, options) {
  if (!transcript || !options?.length) return null
  const t = norm(transcript)
  if (!t) return null
  let best = null, bestScore = 0
  for (const opt of options) {
    const labels = [opt.label_en, opt.label_hi, opt.value, opt.label_hi || opt.label_en]
      .filter(Boolean).map(norm)
    for (const label of labels) {
      let score = 0
      if (label === t) score = 1
      else if (label.includes(t) || t.includes(label)) score = 0.8   // substring either way
      else {
        // token overlap: how many of the spoken words appear in this option
        const tw = t.split(' '), lw = label.split(' ')
        const hit = tw.filter(w => w.length > 2 && lw.some(x => x === w || x.includes(w) || w.includes(x)))
        score = tw.length ? (hit.length / tw.length) * 0.6 : 0
      }
      if (score > bestScore) { bestScore = score; best = { value: opt.value, label: opt.label_en, score } }
    }
  }
  return bestScore >= 0.6 ? best : null
}

// ---- text to speech ----
// Plays through our server's /api/tts proxy (Google TTS). Why a proxy?
//  - Linux/Firefox often has NO working speechSynthesis voices at all, so the
//    native API silently does nothing.
//  - Google TTS blocks requests that carry a browser Referer, so the browser
//    can't call it directly — our server fetches it (no Referer) and streams
//    the audio back same-origin. Reliable everywhere.
let _audio = null
export function speakText(text, langCode, opts = {}) {
  if (!text) return
  if (_audio) { _audio.pause(); _audio = null }
  const a = new Audio(`/api/tts?lang=${encodeURIComponent(langCode)}&text=${encodeURIComponent(text.slice(0, 200))}`)
  _audio = a
  a.volume = 1
  a.play().catch(() => { /* network — nothing more we can do */ })
}

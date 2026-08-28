import { useState, useEffect } from 'react'
import './App.css'
import {
  loadQuestions, cachedQuestions, nextQuestionId, questionById,
  savePendingVisit, getPendingVisit, syncPendingVisit,
} from './offline.js'
import { LANGUAGES, languageByCode, recognizeSpeech, speakText, stopListeningEarly } from './languages.js'
import { UI_STRINGS } from './ui_strings.js'

const API = '/api' // proxied to localhost:4000 by Vite

// ChatGPT/Gemini-style mic icon (SVG, matches the device's icon look)
const MicIcon = ({ listening }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
    <path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
    <path d="M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
    {listening && <circle cx="12" cy="21" r="1.6" fill="currentColor" />}
  </svg>
)

// pick a question's text in the current language (fallback hi → en)
const qText = (q, lang) => {
  if (q?.translations?.[lang]?.text) return q.translations[lang].text
  if (lang === 'hi' && q?.text_hi) return q.text_hi
  return q?.text_en || q?.text_hi || ''
}
// pick an option label in the current language (fallback hi → en)
const optText = (q, opt, lang) => {
  const tr = q?.translations?.[lang]?.options
  if (tr && tr[opt.value]) return tr[opt.value]
  if (lang === 'hi' && opt.label_hi) return opt.label_hi
  return opt.label_en || opt.label_hi || opt.value
}
// pick a UI string in the current language (fallback hi → en)
const ui = (lang, key) => {
  const s = UI_STRINGS?.[lang]?.[key] || UI_STRINGS?.hi?.[key] || UI_STRINGS?.en?.[key]
  return s || key
}

export default function App() {
  const [lang, setLang] = useState('en')
  const [langOpen, setLangOpen] = useState(false)
  const [patient, setPatient] = useState({ name: '', phone: '', age: '' })
  const [visitId, setVisitId] = useState(null)
  const [question, setQuestion] = useState(null)
  const [progress, setProgress] = useState({ answered: 0, total: 0 })
  const [redFlags, setRedFlags] = useState([])
  const [done, setDone] = useState(false)
  const [summary, setSummary] = useState(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [noteSent, setNoteSent] = useState(false)
  const [backing, setBacking] = useState(false)
  const [qr, setQr] = useState(null)
  const [visitToken, setVisitToken] = useState(null)
  const [offline, setOffline] = useState(!navigator.onLine)
  const [questions, setQuestions] = useState(() => cachedQuestions())
  const [offlineAnswers, setOfflineAnswers] = useState([])
  const [syncing, setSyncing] = useState(false)
  const [synced, setSynced] = useState(false)
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [otherPanel, setOtherPanel] = useState(false)
  const [otherText, setOtherText] = useState('')

  // -------- offline awareness --------
  useEffect(() => {
    loadQuestions().then(setQuestions).catch(() => {})
    const goOnline = () => { setOffline(false); syncNow() }
    const goOffline = () => setOffline(true)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  const syncNow = async () => {
    if (syncing || !getPendingVisit()) return
    setSyncing(true); setError('')
    try {
      const res = await syncPendingVisit()
      if (res) {
        setVisitId(res.visitId)
        setVisitToken(res.token || null)
        setSynced(true)
        fetchQR(res.visitId)
      }
    } catch (err) { setError(`Sync failed: ${err.message}`) } finally { setSyncing(false) }
  }

  const speak = (text) => speakText(text, lang)

  const cleanName = (v) => v.replace(/[^\p{L}\p{M}\s]/gu, '')
  const cleanPhone = (v) => v.replace(/\D/g, '').slice(0, 10)
  const cleanAge = (v) => v.replace(/\D/g, '').slice(0, 3)

  // Rule-based red flags, mirrored client-side for offline kiosks.
  const computeLocalFlags = (answers) => {
    const ans = {}
    for (const a of answers) ans[a.questionId] = a.value
    const flags = []
    if (ans.cc === 'chest pain' && ans.cp_breath === 'yes') flags.push('Chest pain with breathlessness — possible emergency')
    if (ans.cc === 'chest pain' && ans.cp_severity === 'severe') flags.push('Severe chest pain — immediate review')
    if (ans.cc === 'dizziness') flags.push('Dizziness reported — fall risk')
    if (ans.cc === 'chest pain' && ans.cp_severity === 'severe' && ans.cp_dizziness === 'yes')
      flags.push('Severe chest pain WITH dizziness — URGENT')
    return flags
  }

  const startVisit = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    const name = patient.name.trim()
    const phone = patient.phone
    const age = patient.age
    if (name.length < 2) {
      setBusy(false)
      return setError(ui(lang, 'nameInvalid'))
    }
    if (!/^\d{10}$/.test(phone)) {
      setBusy(false)
      return setError(ui(lang, 'phoneInvalid'))
    }
    const ageNum = Number(age)
    if (age && (!Number.isInteger(ageNum) || ageNum < 1 || ageNum > 150)) {
      setBusy(false)
      return setError(ui(lang, 'ageInvalid'))
    }
    try {
      // send cleaned + validated fields (age optional, empty string → skip)
      const payload = { name, phone: `+91${phone}`, language: lang }
      if (ageNum) payload.age = ageNum
      const r = await fetch(`${API}/visits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      setVisitId(data.visitId)
      setVisitToken(data.token || null)
      setQuestion(data.currentQuestion)
      setTimeout(() => speak(qText(data.currentQuestion, lang)), 300)
    } catch (err) {
      if (questions.length) {
        setOfflineAnswers([])
        setQuestion(questionById(questions, 'cc'))
        setRedFlags([])
        setOffline(true)
      } else {
        setError(ui(lang, 'noCache'))
      }
    } finally { setBusy(false) }
  }

  const answer = async (value) => {
    if (busy) return

    if (offline) {
      const nextAnswers = [...offlineAnswers, { questionId: question.id, value }]
      setOfflineAnswers(nextAnswers)
      const nextId = nextQuestionId(question, value)
      if (nextId) {
        setQuestion(questionById(questions, nextId))
        setProgress({ answered: nextAnswers.length, total: questions.length })
        setTimeout(() => speak(qText(questionById(questions, nextId), lang)), 200)
      } else {
        setDone(true)
        setRedFlags(computeLocalFlags(nextAnswers))
        savePendingVisit({ patient: { ...patient, age: patient.age || null }, language: lang, answers: nextAnswers })
      }
      return
    }

    setBusy(true); setError('')
    try {
      const r = await fetch(`${API}/visits/${visitId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: question.id, value, source: 'touch' }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      setRedFlags(data.red_flags || [])
      setProgress(data.progress || {})
      if (data.done) { setDone(true); setSummary(data.summary); fetchQR(); return }
      setQuestion(data.nextQuestion)
      setText('')
      setTimeout(() => speak(qText(data.nextQuestion, lang)), 300)
    } catch (err) {
      if (questions.length) {
        setOffline(true)
        setOfflineAnswers([{ questionId: question.id, value }])
        const nextId = nextQuestionId(question, value)
        setQuestion(nextId ? questionById(questions, nextId) : question)
        if (!nextId) {
          setDone(true)
          setRedFlags(computeLocalFlags([{ questionId: question.id, value }]))
          savePendingVisit({ patient: { ...patient, age: patient.age || null }, language: lang, answers: [{ questionId: question.id, value }] })
        }
      } else {
        setError(err.message)
      }
    } finally { setBusy(false) }
  }

  const goBack = async () => {
    if (backing || busy) return
    setBacking(true); setError('')
    try {
      const r = await fetch(`${API}/visits/${visitId}/answers/last`, { method: 'DELETE' })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      setRedFlags(data.red_flags || [])
      setProgress(data.progress || {})
      setQuestion(data.question)
      setText('')
      if (data.question) setTimeout(() => speak(qText(data.question, lang)), 200)
    } catch (err) { setError(err.message) } finally { setBacking(false) }
  }

  const sendNote = async () => {
    if (offline) {
      const pending = getPendingVisit()
      if (pending) {
        savePendingVisit({ ...pending, note })
        setNoteSent(true)
        return
      }
    }
    setBusy(true); setError('')
    try {
      const r = await fetch(`${API}/visits/${visitId}/note`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      })
      if (!r.ok) throw new Error('save failed')
      setNoteSent(true)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  // "Anything else" is optional — skip without saving anything.
  const skipNote = () => {
    setNoteSent(true)
  }

  // Submit the "Other" writing panel (first question) as the chief complaint.
  const submitOther = () => {
    const value = otherText.trim()
    if (!value || busy) return
    setOtherPanel(false)
    setOtherText('')
    answer(value)
  }

  const fetchQR = async (vid) => {
    try {
      const r = await fetch(`${API}/visits/${vid || visitId}/qr`)
      const data = await r.json()
      if (r.ok && data.qr) setQr(data.qr)
    } catch (_) {}
  }

  // Voice input → text. First tap STARTS recording, second tap STOPS it.
  // Toggle gives instant feedback: recording (pulsing) → transcribing (spinner)
  // → done. Taps during "transcribing" are ignored so nothing can double-fire.
  const startListening = async (onText) => {
    if (transcribing) return
    if (listening) {
      // second tap: stop the recorder immediately, show "transcribing"
      stopListeningEarly()
      setListening(false)
      setTranscribing(true)
      return
    }
    setListening(true); setError('')
    try {
      const transcript = await recognizeSpeech(lang, (partial) => onText(partial))
      if (transcript) onText(transcript)
    } catch (err) {
      setError(err.message)
    } finally {
      setListening(false)
      setTranscribing(false)
      stopListeningEarly()
    }
  }

  // Mic button label follows the recording state machine
  const micHint = transcribing ? ui(lang, 'transcribing') : listening ? ui(lang, 'tapToStop') : ui(lang, 'tapToSpeak')

  // Append transcript to existing text instead of replacing it — typed words survive
  const appendTo = (setter) => (t) => setter(prev => (prev ? prev + ' ' : '') + t)

  // language picker
  const LangPicker = ({ small }) => (
    <div className={small ? 'lang-picker small' : 'lang-picker'}>
      <button className="lang-current" onClick={() => setLangOpen(o => !o)}>
        {languageByCode(lang).native} ▾
      </button>
      {langOpen && (
        <>
          <div className="lang-overlay" onClick={() => setLangOpen(false)} />
          <div className="lang-menu">
            {LANGUAGES.map(l => (
              <button key={l.code} className={l.code === lang ? 'active' : ''} onClick={() => { setLang(l.code); setLangOpen(false) }}>
                <span className="lang-native">{l.native}</span>
                <span className="lang-name">{l.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )

  // -------- screens ----------
  if (!visitId && !done) {
    return (
      <div className="kiosk start-screen">
        <h1>🩺 MediKiosk</h1>
        <p className="sub">{ui(lang, 'enterDetails')}</p>
        {offline && <div className="offline-banner">📡 {ui(lang, 'offlineBanner')}</div>}
        <div className="lang-row"><LangPicker /></div>
        <form onSubmit={startVisit} className="form">
          <input placeholder={ui(lang, 'name')} value={patient.name}
            onChange={e => setPatient({...patient, name: cleanName(e.target.value)})} required />
          <div className="phone-field">
            <span className="phone-prefix">IN +91</span>
            <input placeholder={ui(lang, 'phone')} type="tel" inputMode="numeric"
              value={patient.phone} maxLength={10}
              onChange={e => setPatient({...patient, phone: cleanPhone(e.target.value)})} required />
          </div>
          <input placeholder={ui(lang, 'age')} type="text" inputMode="numeric" maxLength={3}
            value={patient.age}
            onChange={e => setPatient({...patient, age: cleanAge(e.target.value)})} />
          <button className="primary big" disabled={busy}>
            {ui(lang, 'start')}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  if (done) {
    const pending = getPendingVisit()
    return (
      <div className="kiosk done-screen">
        <div className="check">✅</div>
        <h1>{ui(lang, 'done')}</h1>
        {offline ? (
          <p>{ui(lang, 'offlineNoNetwork')}</p>
        ) : (
          <p>{ui(lang, 'sentToDoctor')}</p>
        )}
        {redFlags.length > 0 && (
          <div className="red-banner">
            ⚠️ {ui(lang, 'urgentStaff')}
          </div>
        )}

        {!noteSent ? (
          <div className="note-panel">
            <h3>{ui(lang, 'anythingElse')}</h3>
            <p className="sub2">{ui(lang, 'ownWords')}</p>
            <div className="voice-input">
              <textarea rows={4} value={note} placeholder={ui(lang, 'typeHere')}
                onChange={e => setNote(e.target.value)} />
              <button className={'mic' + (listening ? ' listening' : '') + (transcribing ? ' transcribing' : '')}
                onClick={() => startListening(appendTo(setNote))}
                title={micHint} aria-label={micHint}>
                <MicIcon listening={listening} />
                <span className="mic-hint">{micHint}</span>
              </button>
            </div>
            <div className="note-actions">
              <button className="primary" disabled={busy || !note.trim()} onClick={sendNote}>
                {ui(lang, 'sendToDoctor')}
              </button>
              <button className="secondary" disabled={busy} onClick={skipNote}>
                {ui(lang, 'skip')}
              </button>
            </div>
          </div>
        ) : (
          <p className="ok-line">✅ {ui(lang, 'noteSent')}</p>
        )}

        {offline && pending && (
          <div className="sync-box">
            <p>📡 {ui(lang, 'waitingSync')}</p>
            {syncing && <p className="ok-line">{ui(lang, 'syncing')}</p>}
            {synced && <p className="ok-line">✅ {ui(lang, 'synced')}</p>}
            {error && <p className="error">{error}</p>}
          </div>
        )}

        {qr && (
          <div className="qr-box">
            <p className="sub2">{ui(lang, 'qrHint')}</p>
            <img src={qr} alt="QR code" className="qr-img" />
            {visitToken && <p className="token-text">#{visitToken}</p>}
          </div>
        )}

        {summary && (
          <details className="summary-preview">
            <summary>{ui(lang, 'viewSummary')}</summary>
            <div className="summary-box">
              <div className="row"><span>{ui(lang, 'chiefComplaint')}</span><b>{summary.chief_complaint}</b></div>
              <div className="row"><span>{ui(lang, 'duration')}</span><b>{summary.duration}</b></div>
              <div className="row"><span>{ui(lang, 'severity')}</span><b>{summary.severity}</b></div>
              {summary.pain && (
                <>
                  <div className="row"><span>{ui(lang, 'painStart')}</span><b>{summary.pain.started}</b></div>
                  <div className="row"><span>{ui(lang, 'painFeel')}</span><b>{summary.pain.character}</b></div>
                </>
              )}
              <div className="row"><span>{ui(lang, 'existing')}</span><b>{summary.existing_conditions}</b></div>
              <div className="row"><span>{ui(lang, 'allergies')}</span><b>{summary.allergies}</b></div>
              <div className="row"><span>{ui(lang, 'familyHistory')}</span><b>{summary.family_history}</b></div>
              <div className="row"><span>{ui(lang, 'lifestyle')}</span><b>{summary.lifestyle}</b></div>
              <div className="row"><span>{ui(lang, 'sleep')}</span><b>{summary.sleep}</b></div>
              <div className="row"><span>{ui(lang, 'ayurveda')}</span><b>{summary.ayurveda}</b></div>
            </div>
          </details>
        )}
        {error && !offline && <p className="error">{error}</p>}
      </div>
    )
  }

  return (
    <div className="kiosk">
      <div className="topbar">
        <button className="back-btn" onClick={goBack} disabled={backing || progress.answered === 0} title={ui(lang, 'back')}>
          ← {ui(lang, 'back')}
        </button>
        <div className="progress">
          <div className="bar" style={{ width: `${(progress.answered / progress.total) * 100}%` }} />
        </div>
        <span className="count">{progress.answered}/{progress.total}</span>
        <div className="lang-row small"><LangPicker small /></div>
      </div>

      {offline && <div className="offline-banner">📡 {ui(lang, 'offlineBanner')}</div>}

      {redFlags.length > 0 && (
        <div className="red-banner">⚠️ {ui(lang, 'urgentAlerted')}</div>
      )}

      <div className="question-area">
        <h2>{qText(question, lang)}</h2>

        {otherPanel ? (
          <div className="text-input other-panel">
            <p className="sub2">{ui(lang, 'tellUsMore')}</p>
            <div className="voice-input">
              <textarea rows={4} value={otherText}
                placeholder={ui(lang, 'typeHere')}
                onChange={e => setOtherText(e.target.value)} autoFocus />
              <button className={'mic' + (listening ? ' listening' : '') + (transcribing ? ' transcribing' : '')}
                onClick={() => startListening(appendTo(setOtherText))}
                title={micHint} aria-label={micHint}>
                <MicIcon listening={listening} />
                <span className="mic-hint">{micHint}</span>
              </button>
            </div>
            <button className="primary big" disabled={!otherText.trim() || busy} onClick={submitOther}>
              {ui(lang, 'next')}
            </button>
          </div>
        ) : question.type === 'choice' ? (
          <div className="options">
            {question.options.map(opt => (
              <button key={opt.value} className="option"
                onClick={() => {
                  // "Other" on the first question opens a writing panel
                  if (question.id === 'cc' && opt.value === 'other') {
                    setOtherPanel(true)
                    setOtherText('')
                  } else {
                    answer(opt.value)
                  }
                }} disabled={busy}>
                {optText(question, opt, lang)}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-input">
            <div className="voice-input">
              <textarea rows={3} value={text}
                placeholder={ui(lang, 'typeHere')}
                onChange={e => setText(e.target.value)} />
              <button className={'mic' + (listening ? ' listening' : '') + (transcribing ? ' transcribing' : '')}
                onClick={() => startListening(appendTo(setText))}
                title={micHint} aria-label={micHint}>
                <MicIcon listening={listening} />
                <span className="mic-hint">{micHint}</span>
              </button>
            </div>
            <button className="primary big" disabled={!text.trim() || busy} onClick={() => answer(text.trim())}>
              {ui(lang, 'next')}
            </button>
          </div>
        )}
      </div>

      <div className="voice-row">
        <button className="speaker" onClick={() => speak(qText(question, lang))}>
          🔊 {ui(lang, 'hear')}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
    </div>
  )
}
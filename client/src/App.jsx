import { useState } from 'react'
import './App.css'

const API = '/api' // proxied to localhost:4000 by Vite

export default function App() {
  const [lang, setLang] = useState('hi')
  const [patient, setPatient] = useState({ name: '', phone: '', age: '' })
  const [visitId, setVisitId] = useState(null)
  const [question, setQuestion] = useState(null)
  const [progress, setProgress] = useState({ answered: 0, total: 0 })
  const [redFlags, setRedFlags] = useState([])
  const [done, setDone] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const t = (hi, en) => (lang === 'hi' ? hi : en)
  const speak = (text) => {
    if (!('speechSynthesis' in window)) return
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang === 'hi' ? 'hi-IN' : 'en-IN'
    u.rate = 0.9
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  }

  const startVisit = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const r = await fetch(`${API}/visits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patient, language: lang }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      setVisitId(data.visitId)
      setQuestion(data.currentQuestion)
      setTimeout(() => speak(data.currentQuestion?.text_hi), 300)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const answer = async (value) => {
    setBusy(true); setError('')
    try {
      const r = await fetch(`${API}/visits/${visitId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: question.id, value, source: 'touch' }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      if (data.red_flags.length) setRedFlags(data.red_flags)
      if (data.done) { setDone(true); return }
      setQuestion(data.nextQuestion)
      setProgress(p => ({ ...p, answered: p.answered + 1 }))
      setText('')
      setTimeout(() => speak(data.nextQuestion?.text_hi), 300)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  // -------- screens ----------
  if (!visitId) {
    return (
      <div className="kiosk start-screen">
        <h1>🩺 MediKiosk</h1>
        <p className="sub">{t('अपना विवरण भरें — फिर इतिहास बताना शुरू करें', 'Enter your details, then let\'s begin your history')}</p>
        <div className="lang-row">
          <button className={lang==='hi'?'active':''} onClick={() => setLang('hi')}>हिन्दी</button>
          <button className={lang==='en'?'active':''} onClick={() => setLang('en')}>English</button>
        </div>
        <form onSubmit={startVisit} className="form">
          <input placeholder={t('नाम *', 'Name *')} value={patient.name}
            onChange={e => setPatient({...patient, name: e.target.value})} required />
          <input placeholder={t('मोबाइल नंबर *', 'Phone *')} type="tel" value={patient.phone}
            onChange={e => setPatient({...patient, phone: e.target.value})} required />
          <input placeholder={t('उम्र', 'Age')} type="number" value={patient.age}
            onChange={e => setPatient({...patient, age: e.target.value})} />
          <button className="primary big" disabled={busy}>
            {t('शुरू करें', 'Start')}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  if (done) {
    return (
      <div className="kiosk done-screen">
        <div className="check">✅</div>
        <h1>{t('इतिहास पूरा हुआ!', 'History complete!')}</h1>
        <p>{t('धन्यवाद। आपकी जानकारी डॉक्टर को भेज दी गई है।', 'Thank you. Your information has been sent to the doctor.')}</p>
        {redFlags.length > 0 && (
          <div className="red-banner">
            ⚠️ {t('स्टाफ से तुरंत मिलें — आपातकालीन संकेत मिले!', 'Please see staff immediately — emergency signs detected!')}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="kiosk">
      <div className="topbar">
        <div className="progress">
          <div className="bar" style={{ width: `${(progress.answered / progress.total) * 100}%` }} />
        </div>
        <span className="count">{progress.answered}/{progress.total}</span>
        <div className="lang-row small">
          <button className={lang==='hi'?'active':''} onClick={() => setLang('hi')}>हिन्दी</button>
          <button className={lang==='en'?'active':''} onClick={() => setLang('en')}>EN</button>
        </div>
      </div>

      {redFlags.length > 0 && (
        <div className="red-banner">⚠️ {t('आपातकालीन संकेत — स्टाफ सूचित किया गया', 'Emergency signs — staff alerted')}</div>
      )}

      <div className="question-area">
        <h2>{lang === 'hi' ? question.text_hi : question.text_en}</h2>

        {question.type === 'choice' ? (
          <div className="options">
            {question.options.map(opt => (
              <button key={opt.value} className="option"
                onClick={() => answer(opt.value)} disabled={busy}>
                {lang === 'hi' ? opt.label_hi : opt.label_en}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-input">
            <textarea rows={3} value={text}
              placeholder={t('यहाँ टाइप करें…', 'Type here…')}
              onChange={e => setText(e.target.value)} />
            <button className="primary big" disabled={!text || busy} onClick={() => answer(text)}>
              {t('आगे बढ़ें', 'Next')}
            </button>
          </div>
        )}
      </div>

      <div className="voice-row">
        <button className="mic" disabled title={t('वॉइस जल्द आ रहा है (Bhashini)', 'Voice coming soon (Bhashini)')}>
          🎤 {t('बोलें', 'Speak')}
        </button>
        <button className="speaker" onClick={() => speak(lang === 'hi' ? question.text_hi : question.text_en)}>
          🔊 {t('सुनें', 'Hear')}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------
// MediKiosk offline mode:
//  - questions are cached in localStorage when online
//  - if the network drops mid-intake, the questionnaire keeps
//    running locally, answers are queued
//  - when the network returns, the pending visit is synced to
//    the server automatically
// ---------------------------------------------------------------

const QS_KEY = 'medikiosk_questions_v1'
const PENDING_KEY = 'medikiosk_pending_v1'

export async function loadQuestions() {
  // Always refresh from server when online; fall back to cache offline.
  try {
    const r = await fetch('/api/questions')
    if (r.ok) {
      const data = await r.json()
      if (data.questions?.length) {
        localStorage.setItem(QS_KEY, JSON.stringify(data.questions))
        return data.questions
      }
    }
  } catch (_) { /* offline */ }
  return cachedQuestions()
}

export function cachedQuestions() {
  try { return JSON.parse(localStorage.getItem(QS_KEY) || 'null') || [] }
  catch { return [] }
}

// Mirror of the server's decideNext
export function nextQuestionId(q, value) {
  if (!q) return null
  if (q.next_by_answer && q.next_by_answer[value]) return q.next_by_answer[value]
  return q.next || null
}

export function questionById(questions, id) {
  return questions.find((x) => x.id === id) || null
}

// Queue a pending visit (patient + answers + note)
export function savePendingVisit(payload) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(payload))
}

export function getPendingVisit() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null') }
  catch { return null }
}

export function clearPendingVisit() {
  localStorage.removeItem(PENDING_KEY)
}

// Push the queued visit to the server. Returns {visitId, token} or throws.
export async function syncPendingVisit() {
  const pending = getPendingVisit()
  if (!pending) return null

  // 1. create the visit
  const vr = await fetch('/api/visits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...pending.patient, language: pending.language || 'hi' }),
  })
  const vdata = await vr.json()
  if (!vr.ok) throw new Error(vdata.error || 'sync failed')
  const visitId = vdata.visitId

  // 2. replay answers in order
  for (const a of pending.answers || []) {
    const ar = await fetch(`/api/visits/${visitId}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: a.questionId, value: a.value, source: 'touch' }),
    })
    if (!ar.ok) {
      const ad = await ar.json().catch(() => ({}))
      throw new Error(ad.error || 'answer sync failed')
    }
  }

  // 3. patient note if any
  if (pending.note?.trim()) {
    await fetch(`/api/visits/${visitId}/note`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: pending.note }),
    })
  }

  clearPendingVisit()
  return { visitId, token: vdata.token }
}

// doctor.js — MediKiosk Doctor Console
// No inline handlers (CSP: script-src 'self'). PIN-gated via X-Doctor-Pin.
const API = '';
let visits = [];
let current = null;

const $ = (s) => document.querySelector(s);

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

// ---------- PIN gate ----------
let PIN = sessionStorage.getItem('mk_pin') || '';
function fetchA(url, opts = {}) {
  return fetch(url, { ...opts, headers: { ...(opts.headers || {}), 'X-Doctor-Pin': PIN } });
}
function showPin(msg) {
  $('#pinError').textContent = msg || '';
  $('#pinInput').value = '';
  $('#pinOverlay').classList.remove('hidden');
  $('#pinInput').focus();
}
function hidePin() { $('#pinOverlay').classList.add('hidden'); }

async function verifyPin(pin) {
  const r = await fetchA('/api/doctor/auth');
  return r.ok;
}
// Called after a 401 during normal use: drop the stored pin and re-ask.
function handleUnauthorized() {
  sessionStorage.removeItem('mk_pin');
  PIN = '';
  showPin('Session expired — enter PIN again');
}

$('#pinBtn').addEventListener('click', async () => {
  const pin = $('#pinInput').value.trim();
  if (!pin) return showPin('Enter the PIN');
  PIN = pin;
  const r = await fetchA('/api/doctor/auth');
  if (r.ok) {
    sessionStorage.setItem('mk_pin', pin);
    hidePin();
    await refresh();
  } else {
    PIN = '';
    showPin('Wrong PIN');
  }
});
$('#pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pinBtn').click(); });

// ---------- data ----------
async function refresh() {
  try {
    const r = await fetchA(API + '/api/doctor/visits');
    if (r.status === 401) return handleUnauthorized();
    const d = await r.json();
    visits = d.visits;
    $('#liveBadge').textContent = visits.filter(v => v.status !== 'consulted').length + ' in queue';
    renderQueue();
    if (current) { const v = visits.find(x => x.id === current); if (v) loadDetail(v.id); }
  } catch (e) { $('#liveBadge').textContent = 'offline'; }
}

function renderQueue() {
  const q = $('#queue');
  if (!visits.length) { q.innerHTML = '<div class="empty">No patients yet.</div>'; return; }
  q.innerHTML = visits.map(v => {
    const flags = (v.red_flags || []).length;
    const statusClass = v.status === 'waiting' ? 'waiting' : v.status === 'in_progress' ? 'inprogress' : v.status === 'consulted' ? 'consulted' : 'plain';
    const statusLabel = v.status === 'waiting' ? 'WAITING' : v.status === 'in_progress' ? 'INTAKE' : v.status === 'consulted' ? 'DONE' : esc(v.status).toUpperCase();
    const priority = v.one_liner && v.one_liner.includes('HIGH') ? 'urgent' : v.one_liner && v.one_liner.includes('MEDIUM') ? 'medium' : '';
    return `<div class="visit ${v.id === current ? 'active' : ''} ${priority}" data-id="${v.id}">
      <div class="row1">
        <span class="name">${esc(v.name)}</span>
        <span class="time">${timeAgo(v.created_at)}</span>
      </div>
      <div class="clinical-line">${esc(v.one_liner || '…')}</div>
      <div class="sub-meta">${esc(v.phone)}</div>
      <div class="flags">
        ${flags ? '<span class="flag urgent">🚨 URGENT</span>' : ''}
        ${(v.red_flags||[]).map(f => `<span class="flag plain">${esc(f)}</span>`).join('')}
        <span class="flag ${statusClass}">${statusLabel}</span>
      </div>
    </div>`;
  }).join('');
}

// Event delegation on the queue (CSP-safe: no inline onclick)
$('#queue').addEventListener('click', (e) => {
  const el = e.target.closest('.visit');
  if (el) selectVisit(Number(el.dataset.id));
});

async function selectVisit(id) {
  current = id;
  renderQueue();
  await loadDetail(id);
}

async function loadDetail(id) {
  const r = await fetchA(API + '/api/doctor/visits/' + id);
  if (r.status === 401) return handleUnauthorized();
  const d = await r.json();
  const v = d.visit;
  $('#dEmpty').classList.add('hidden');
  $('#detailPanel').classList.remove('hidden');

  $('#dName').textContent = `${v.name} — Intake`;
  $('#dMeta').textContent = `${v.age || '—'} yrs · ${v.gender || '—'} · ${v.phone || '—'} · joined ${timeAgo(v.created_at)} · status: ${v.status}`;

  $('#dPills').innerHTML = [
    v.status === 'waiting' ? '<span class="pill" style="color:var(--ok)">Waiting for doctor</span>' : `<span class="pill">${esc(v.status)}</span>`,
    (v.red_flags||[]).length ? '<span class="pill" style="color:var(--danger)">⚠ Rule-based flags only — no AI diagnosis</span>' : '',
  ].join('');

  if (v.patient_note) {
    $('#dNoteBox').classList.remove('hidden');
    $('#dNote').textContent = v.patient_note;
  } else { $('#dNoteBox').classList.add('hidden'); }

  if (d.summary && d.summary.ai_summary) {
    $('#dAI').innerHTML = `<pre>${esc(d.summary.ai_summary)}</pre>`;
  } else {
    $('#dAI').innerHTML = '<div class="empty" style="padding:8px 0">AI summary will appear here automatically (~10s after intake).</div>';
  }

  if (d.summary && d.summary.structured) {
    const s = d.summary.structured;
    const rows = [
      ['Chief complaint', s.chief_complaint],
      ['Duration', s.duration],
      ['Severity', s.severity],
      ...(s.pain ? [
        ['Pain started', s.pain.started], ['Pain feels', s.pain.character],
        ['Spreads to', s.pain.radiation], ['Breathlessness', s.pain.breathlessness],
        ['Worse with', s.pain.worse_with],
      ] : []),
      ['Existing conditions', s.existing_conditions],
      ['Past surgery', s.surgery],
      ['Current medicines', s.medications],
      ['Allergies', s.allergies],
      ['Family history', s.family_history],
      ['Lifestyle', s.lifestyle],
      ['Sleep', s.sleep],
      ['Ayurveda', s.ayurveda],
    ];
    $('#dSummary').innerHTML = '<h4>📋 Patient Intake Summary</h4>' + rows.map(([k, val]) =>
      `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(val)}</span></div>`).join('');
  } else {
    $('#dSummary').innerHTML = '<h4>📋 Summary</h4><div class="empty" style="padding:10px 0">Summary not generated yet.</div>';
  }

  const groups = {};
  for (const a of d.answers) {
    const sec = a.section === 'ayush' ? 'Ayurveda' : a.section === 'general' ? 'General' : (a.section || 'General');
    (groups[sec] = groups[sec] || []).push(a);
  }
  $('#dAnswers').innerHTML = Object.entries(groups).map(([sec, ans]) =>
    `<h4 style="color:var(--muted);text-transform:uppercase;font-size:.8rem;margin:14px 0 8px">${esc(sec)}</h4>` +
    ans.map(a => `<div class="qa"><span class="q">${esc(a.question)}</span><span class="a">${esc(a.value)}</span></div>`).join('')
  ).join('');

  $('#fPrescription').value = (d.summary && d.summary.prescription) || '';
  $('#fNotes').value = (d.summary && d.summary.doctor_notes) || '';
}

async function saveConsultation(status) {
  const id = current; if (!id) return;
  const r = await fetchA(API + '/api/doctor/visits/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prescription: $('#fPrescription').value, doctor_notes: $('#fNotes').value, status }),
  });
  if (r.status === 401) return handleUnauthorized();
  showToast();
  await refresh();
}

async function regenerateAI() {
  const id = current; if (!id) return;
  const btn = $('#btnAI');
  btn.disabled = true; btn.textContent = 'Generating…';
  $('#dAI').innerHTML = '<div class="empty" style="padding:8px 0">Generating AI summary…</div>';
  try {
    const r = await fetchA(API + '/api/doctor/visits/' + id + '/ai-summary', { method: 'POST' });
    if (r.status === 401) return handleUnauthorized();
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'failed');
    $('#dAI').innerHTML = `<pre>${esc(d.ai_summary)}</pre>`;
    showToast();
  } catch (e) {
    $('#dAI').innerHTML = `<div class="empty" style="padding:8px 0;color:var(--danger)">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Regenerate';
  }
}

function downloadPDF() {
  if (!current) return;
  window.open(API + '/api/doctor/visits/' + current + '/pdf', '_blank');
}

function showToast() {
  const t = $('#toast'); t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

// wire buttons
$('#btnSave').addEventListener('click', () => saveConsultation('consulted'));
$('#btnHold').addEventListener('click', () => saveConsultation('waiting'));
$('#btnPDF').addEventListener('click', downloadPDF);

setInterval(refresh, 8000);

// If a QR token was scanned (?token=K7X2-Q4MN), open that case instantly
(async function openFromQR() {
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  if (token) {
    try {
      const r = await fetchA(API + '/api/doctor/token/' + encodeURIComponent(token));
      if (r.status === 401) return handleUnauthorized();
      const d = await r.json();
      if (d.visitId) {
        current = d.visitId;
        await loadDetail(d.visitId);
        history.replaceState(null, '', location.pathname);
      }
    } catch (e) { /* fall through */ }
  }
  // Gate: if we don't have a PIN yet, ask; otherwise refresh.
  if (!PIN) { showPin(); } else { await refresh(); }
})();

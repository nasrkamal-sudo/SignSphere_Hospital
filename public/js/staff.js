/* Staff dashboard: live queue | case | conversation, with a real speech-to-text composer (Web Speech API). */
import { S, render, esc, bl, ic, api, getS, upsertSession, fmtT, fmtDT, dayStart, toast } from './core.js';
import { QUESTIONS, DOCTORS, DEPT_UR, doctorStatus, isNotified, notifEntry, ackAt } from './logic.js';

const ST = () => S.staff;
const STATUS = { intake: ['Intake in progress', 'info'], awaiting: ['Awaiting doctor', 'warn'], 'in-consult': ['In consultation', 'ok'], closed: ['Closed', 'plain'] };
const docOf = s => s && s.doctorId ? DOCTORS.find(d => d.id === s.doctorId) : null;

/* ---------- real microphone: browser speech recognition ---------- */
const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
let rec = null, wantStop = false, startTimer = null;

function micError(code) {
  return ({
    'not-allowed': 'Microphone permission was denied. Click the lock icon in the address bar, allow the microphone, then try again.',
    'service-not-allowed': 'The browser blocked speech recognition. Allow the microphone for this site and try again.',
    'audio-capture': 'No microphone was found. Plug one in or choose one in your system sound settings.',
    'no-speech': 'No speech was heard. Move closer to the microphone and try again.',
    'network': 'Speech recognition could not reach its online service. Chrome and Edge send the audio to the browser vendor, so this needs an internet connection.',
    'language-not-supported': 'This browser does not support recognition for the selected language.',
    'aborted': '',
  })[code] ?? `Speech recognition error: ${code}`;
}

export function stopMic() {
  wantStop = true; clearTimeout(startTimer);
  if (rec) {
    const st = ST();
    if (st.speech === 'starting') { try { rec.abort(); } catch { /* ignore */ } rec = null; st.speech = 'idle'; render(); return; }
    try { rec.stop(); } catch { /* already stopped */ }
  }
}

function startMic() {
  const st = ST();
  if (st.speech === 'listening' || st.speech === 'starting') return;
  if (!SR) { st.micNote = 'This browser has no built-in speech recognition. Use Google Chrome or Microsoft Edge, or type the message below.'; render(); return; }
  if (!window.isSecureContext) { st.micNote = 'The microphone needs a secure page. Open this app at http://localhost:3000 (or over HTTPS).'; render(); return; }
  st.micNote = ''; st.interim = ''; st.speech = 'starting'; wantStop = false;
  rec = new SR();
  rec.lang = st.lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  let gotAny = false, errCode = '';
  clearTimeout(startTimer);
  startTimer = setTimeout(() => {
    if (st.speech === 'starting') {
      errCode = 'timeout'; wantStop = true;
      try { rec && rec.abort(); } catch { /* ignore */ }
      st.speech = 'idle'; rec = null;
      st.micNote = 'Speech recognition did not start. Check that the microphone is allowed for this site and that this computer is online (Chrome and Edge use an online speech service). You can type the message instead.';
      render();
    }
  }, 8000);
  rec.onstart = () => { clearTimeout(startTimer); st.speech = 'listening'; render(); };
  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i], t = r[0].transcript;
      if (r.isFinal) { gotAny = true; st.lastVia = 'speech'; st.draft = (st.draft ? st.draft.replace(/\s+$/, '') + ' ' : '') + t.trim(); }
      else interim += t;
    }
    st.interim = interim;
    const ta = document.getElementById('draft'); if (ta && ta.value !== st.draft) ta.value = st.draft;
    const b = document.getElementById('sendBtn'); if (b) b.disabled = !st.draft.trim();
    const it = document.getElementById('interim'); if (it) { it.textContent = interim; it.hidden = !interim; }
  };
  rec.onerror = e => { errCode = e.error; };
  rec.onend = () => {
    clearTimeout(startTimer);
    if (st.speech === 'idle') return;
    st.speech = 'idle'; st.interim = ''; rec = null;
    const msg = micError(errCode);
    if (msg) st.micNote = msg;
    else if (!gotAny && !wantStop) st.micNote = 'No speech was heard. Try again.';
    render();
  };
  try { rec.start(); } catch (e) { st.speech = 'idle'; st.micNote = 'Could not start the microphone: ' + e.message; render(); }
}

/* ---------- actions ---------- */
async function sendDoctor() {
  const st = ST(), s = getS(st.selectedId);
  const text = st.draft.trim();
  if (!s || s.status === 'closed' || !text || st.sending) return;
  st.sending = true;
  try {
    stopMic();
    const isUr = /[؀-ۿ]/.test(text);
    upsertSession(await api(`/api/sessions/${s.id}/exchange`, 'POST', { from: 'doctor', ur: text, lang: isUr ? 'ur' : 'en', via: st.lastVia || 'typed' }));
    if (s.status === 'awaiting') upsertSession(await api(`/api/sessions/${s.id}/patch`, 'POST', { status: 'in-consult' }));
    st.draft = ''; st.interim = ''; st.micNote = ''; st.lastVia = '';
  } finally { st.sending = false; render(); }
}

export const staffActions = {
  tab: d => { ST().tab = d.v; ST().open = false; render(); },
  select: d => { const st = ST(); st.selectedId = d.id; if (st.tab === 'history') st.open = true; st.sumOpen = false; stopMic(); render(); },
  back: () => { ST().open = false; render(); },
  toggleSum: () => { ST().sumOpen = !ST().sumOpen; render(); },
  speak: () => startMic(),
  stopSpeak: () => { stopMic(); },
  lang: d => { if (ST().speech === 'idle') { ST().lang = d.v; try { localStorage.setItem('signsphere.micLang', d.v); } catch { /* ignore */ } render(); } },
  send: () => sendDoctor(),
  clearDraft: () => { ST().draft = ''; ST().micNote = ''; render(); },
  notify: async d => {
    const s = getS(ST().selectedId), doc = DOCTORS.find(x => x.id === (d.id || (s && s.doctorId))); if (!s || !doc || isNotified(s, doc.id)) return;
    await api(`/api/sessions/${s.id}/exchange`, 'POST', { from: 'system', text: `${doc.name} (${doc.dept}) was notified${s.triage && s.triage.level === 'critical' || s.emergency ? ' — CRITICAL case' : ''}.` });
    const list = [...(s.notifiedDoctors || []), { id: doc.id, at: Date.now() }];
    upsertSession(await api(`/api/sessions/${s.id}/patch`, 'POST', { notifiedDoctors: list, notified: true })); render();
  },
  close: async () => {
    const s = getS(ST().selectedId); if (!s) return;
    stopMic();
    await api(`/api/sessions/${s.id}/exchange`, 'POST', { from: 'system', text: 'Session closed by staff.' });
    upsertSession(await api(`/api/sessions/${s.id}/patch`, 'POST', { status: 'closed', closedAt: Date.now() }));
    render();
  },
  modal: () => { ST().modal = true; render(); },
  closeModal: () => { ST().modal = false; render(); },
  urg: d => { ST().urg = d.v; ST().page = 0; render(); },
  page: d => { ST().page += Number(d.v); render(); },
};
export function staffInput(e, kind) {
  const k = e.target.dataset && e.target.dataset.input, st = ST();
  if (kind === 'input') {
    if (k === 'draft') { st.draft = e.target.value; st.lastVia = 'typed'; const b = document.getElementById('sendBtn'); if (b) b.disabled = !e.target.value.trim(); }
    else if (k === 'q') { st.q = e.target.value; st.page = 0; render(); }
  } else if (kind === 'change') {
    if (k === 'dept') { st.dept = e.target.value; st.page = 0; render(); }
    else if (k === 'name') {
      const s = getS(st.selectedId), v = e.target.value.trim();
      if (s && v && v !== s.name) api(`/api/sessions/${s.id}/patch`, 'POST', { name: v }).then(x => { upsertSession(x); render(); }).catch(() => {});
    }
  }
}
export function staffKey(e) {
  if (e.target && e.target.id === 'draft' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendDoctor(); }
}

/* ---------- views ---------- */
function urgPill(s) {
  if (s.emergency) return `<span class="pill crit">${ic('alert', 13)} Emergency</span>`;
  if (!s.triage) return `<span class="pill info">In progress</span>`;
  return s.triage.level === 'critical' ? `<span class="pill crit">${ic('alert', 13)} Critical</span>` : `<span class="pill calm">Non-urgent</span>`;
}
const isCrit = s => s.emergency || (s.triage && s.triage.level === 'critical');
function queueOrder() {
  const rank = s => isCrit(s) && s.status !== 'closed' ? 0 : s.status !== 'closed' ? 1 : isCrit(s) ? 2 : 3;
  return S.sessions.filter(s => s.startedAt >= dayStart()).sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
}
function signChips(list, confKey) {
  const arr = (list || []).map(x => typeof x === 'string' ? x : x.gloss);
  return arr.map(g => `<span class="chip">${esc((S.glossById[g] && S.glossById[g].en) || g)}</span>`).join('');
}
function timeline(s) {
  const items = [];
  s.qa.forEach(a => {
    items.push({ ts: a.ts - 4000, html: `<div class="b sysmsg"><div class="who">Question asked · ${esc(a.qid)}</div><div>${esc(a.q_en)}</div><div class="ur-i" lang="ur" dir="rtl">${esc(a.q_ur)}</div></div>` });
    items.push({ ts: a.ts, html: `<div class="b patient"><div class="who">Patient · signed (${esc(a.source || 'sign')})</div><div><b>${esc(a.a_en)}</b></div><div class="ur-i" lang="ur" dir="rtl">${esc(a.a_ur)}</div><div class="chips">${signChips(a.signs || a.gloss)}<span class="muted small">confidence ${Math.round((a.conf || 0) * 100)}%</span></div></div>` });
  });
  s.exchange.forEach(e => {
    if (e.from === 'system') items.push({ ts: e.ts, html: `<div class="b event small">${esc(e.text)}</div>` });
    else if (e.from === 'doctor') items.push({ ts: e.ts, html: `<div class="b doctor"><div class="who">Doctor · ${e.via === 'speech' ? 'speech to text' : 'typed'}</div><div class="ur-i" lang="ur" dir="rtl">${esc(e.ur)}</div></div>` });
    else items.push({ ts: e.ts, html: `<div class="b patient"><div class="who">Patient reply · signed</div><div><b>${esc(e.en)}</b></div><div class="ur-i" lang="ur" dir="rtl">${esc(e.ur)}</div><div class="chips">${signChips(e.signs || e.gloss)}<span class="muted small">confidence ${Math.round((e.conf || 0) * 100)}%</span></div></div>` });
  });
  items.sort((a, b) => a.ts - b.ts);
  return `<ol class="tl">${items.map(i => `<li><span class="t">${fmtT(i.ts)}</span>${i.html}</li>`).join('')}</ol>`;
}

function qitem(s) {
  const crit = isCrit(s), cls = crit ? 'crit' : s.triage ? 'calm' : 'prog';
  return `<button class="qi ${crit && s.status !== 'closed' ? 'crit' : ''} ${ST().selectedId === s.id ? 'sel' : ''}" data-act="select" data-id="${s.id}">
    <span class="qdot ${cls}" title="${crit ? 'Critical' : s.triage ? 'Non-urgent' : 'Intake in progress'}"></span>
    <span class="qt"><b>${esc(s.name)}</b><small>${s.emergency && !s.summary ? 'Emergency button pressed' : s.summary ? esc(s.summary.chief) : `Intake · ${s.qa.length}/${QUESTIONS.length}`} · ${fmtT(s.startedAt)}</small></span></button>`;
}
function queuePanel() {
  const all = queueOrder(), crit = all.filter(s => isCrit(s) && s.status !== 'closed').length;
  let list = all.slice(0, 9); const sel = getS(ST().selectedId);
  if (sel && all.includes(sel) && !list.includes(sel)) list[list.length - 1] = sel;
  return `<aside class="queue" aria-label="Today's cases"><div class="qhead"><h3>Today</h3><span class="small ${crit ? 'critnum' : 'muted'}">${crit ? crit + ' critical' : all.length + ' case' + (all.length === 1 ? '' : 's')}</span></div>
    <div class="qscroll">${list.length ? list.map(qitem).join('') : '<div class="muted small" style="padding:8px">No patients yet today. Cases appear here the moment a patient starts on the patient screen.</div>'}${all.length > list.length ? `<div class="qmore">+${all.length - list.length} more in History</div>` : ''}</div></aside>`;
}

function docRow(s, d, rec, open) {
  const x = doctorStatus(d), n = notifEntry(s, d.id), a = ackAt(s, d.id);
  const state = a ? `<span class="pill ok">Acknowledged ${fmtT(a)}</span>` : n ? `<span class="pill warn">Notified${n.at ? ' ' + fmtT(n.at) : ''}</span>` : '';
  return `<div class="rdoc ${rec ? '' : 'alt'}"><span class="dot ${x.state === 'now' ? '' : x.state}"></span><div><b>${esc(d.name)}</b> ${rec ? '<span class="tagrec">Recommended</span>' : ''} ${state}<div class="muted small">${esc(d.specialty)}${rec && d.qual ? ` · ${esc(d.qual)}` : ''}</div><div class="muted small">${bl(x.en, x.ur)}</div></div>${open && !n ? `<button class="btn" data-act="notify" data-id="${d.id}">Notify</button>` : ''}</div>`;
}
function caseCard(s) {
  const d = docOf(s), t = s.triage, open = s.status !== 'closed', st = STATUS[s.status] || STATUS.intake, sm = s.summary;
  const nameEl = open ? `<input class="nameinput" id="nameInput" data-input="name" value="${esc(s.name)}" aria-label="Patient name">` : `<b class="nm">${esc(s.name)}</b>`;
  const strip = s.emergency && !t ? `<div class="tstrip crit" role="alert">${ic('alert', 22)}<div><b>EMERGENCY BUTTON PRESSED</b></div></div>`
    : !t ? `<div class="tstrip pend">${ic('clock', 20)}<div><b>Triage pending</b> <span>${s.qa.length} of ${QUESTIONS.length} questions answered</span></div></div>`
    : t.level === 'critical' ? `<div class="tstrip crit" role="alert">${ic('alert', 22)}<div><b>CRITICAL / EMERGENCY</b> <span class="rs">${t.reasons.map(r => `<span class="r">${esc(r)}</span>`).join('')}</span></div></div>`
    : `<div class="tstrip calm">${ic('check', 20)}<div><b>NON-URGENT</b> <span>${esc(t.reasons[0])}</span></div></div>`;
  const facts = sm ? `<div class="facts"><div><small>Complaint</small><b>${esc(sm.chief)}</b></div><div><small>Duration</small><b>${esc(sm.duration)}</b></div><div><small>Severity</small><b>${esc(sm.severity)}</b></div><div><small>Associated</small><b>${esc(sm.associated)}</b></div></div>
    <button class="linkbtn tog" data-act="toggleSum" aria-expanded="${!!ST().sumOpen}">${ST().sumOpen ? 'Hide' : 'Show'} clinical narrative</button>
    ${ST().sumOpen ? `<p class="narr">${esc(sm.narrative)}${sm.confidence != null ? ` <span class="muted">Mean sign confidence ${Math.round(sm.confidence * 100)}%.</span>` : ''}</p>` : ''}`
    : `<p class="muted small">${s.qa.length ? `Answers so far: ${s.qa.map(a => `<b>${esc(a.a_en)}</b>`).join(' · ')}. ` : ''}The summary is generated when all ${QUESTIONS.length} questions are answered.</p>`;
  const others = s.department ? DOCTORS.filter(x => x.dept === s.department && x.id !== s.doctorId) : [];
  const route = s.department ? `<div class="route"><div class="rdept"><b>${esc(s.department)}</b> <span class="ur" lang="ur" dir="rtl">${DEPT_UR[s.department] || ''}</span>${t ? `<span class="muted small"> · seen within ${esc(t.wait)}</span>` : ''}</div>
    ${d ? docRow(s, d, true, open) : ''}
    ${others.map(x => docRow(s, x, false, open)).join('')}
    <div class="muted small" style="opacity:.75">Doctors and clinic hours come from a public hospital directory; availability is computed from the published hours, not from a live hospital system.</div></div>`
    : `<p class="muted small">Department and doctor are assigned once intake finishes.</p>`;
  return `<section class="card case"><div class="chead"><div>${nameEl}<div class="muted small mono">${s.id} · ${fmtDT(s.startedAt)}</div></div><div class="chr"><span class="pill ${st[1]}">${st[0]}</span>${open ? `<button class="btn" data-act="close">Close session</button>` : ''}</div></div>
    ${strip}<div class="cbody"><div><h3>Summary</h3>${facts}</div><div><h3>Routing</h3>${route}</div></div></section>`;
}

function chatItems(s) {
  const it = [];
  s.qa.forEach(a => {
    it.push({ ts: a.ts - 4000, h: `<div class="bub q"><span class="lbl">Question</span>${esc(a.q_en)}</div>` });
    it.push({ ts: a.ts, h: `<div class="bub pt"><span class="lbl">Patient · signed</span><b>${esc(a.a_en)}</b><div class="u" lang="ur" dir="rtl">${esc(a.a_ur)}</div></div>` });
  });
  s.exchange.forEach(e => it.push(e.from === 'system' ? { ts: e.ts, h: `<div class="bub ev">${esc(e.text)}</div>` }
    : e.from === 'doctor' ? { ts: e.ts, h: `<div class="bub dr"><span class="lbl">Doctor · ${e.via === 'speech' ? 'speech' : 'typed'}</span><div class="u" lang="ur" dir="rtl">${esc(e.ur)}</div></div>` }
    : { ts: e.ts, h: `<div class="bub pt"><span class="lbl">Patient reply · signed</span><b>${esc(e.en)}</b><div class="u" lang="ur" dir="rtl">${esc(e.ur)}</div></div>` }));
  it.sort((a, b) => b.ts - a.ts);
  return it.length ? it.map(i => i.h).join('') : `<div class="muted small" style="margin:auto">Nothing yet. The patient's signed answers appear here live.</div>`;
}
function composer(s) {
  const st = ST(), open = s.status !== 'closed';
  if (!open) return `<div class="cnote">${ic('lock', 14)} Closed record. Read only.</div>`;
  const listening = st.speech === 'listening', starting = st.speech === 'starting';
  const lab = listening ? 'Stop' : starting ? 'Starting… (cancel)' : 'Speak';
  const langBtn = (v, t) => `<button data-act="lang" data-v="${v}" aria-pressed="${st.lang === v}" ${st.speech !== 'idle' ? 'disabled' : ''}>${t}</button>`;
  return `<div class="composer"><div class="row" style="gap:10px">
    <button class="mic ${listening ? 'live' : ''}" data-act="${listening || starting ? 'stopSpeak' : 'speak'}" ${SR ? '' : 'title="Needs Chrome or Edge"'}>${ic(listening ? 'stop' : 'mic', 18)}<span>${lab}</span></button>
    ${listening ? '<span class="meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="miclive">Live mic</span>' : ''}
    <div class="seg sm" role="group" aria-label="Speech language">${langBtn('ur-PK', 'اردو')}${langBtn('en-US', 'English')}</div>
    <span class="muted small sp">Shown to the patient in large text</span></div>
    <div id="interim" class="interim" lang="${st.lang === 'ur-PK' ? 'ur' : 'en'}" dir="${st.lang === 'ur-PK' ? 'rtl' : 'ltr'}" ${st.interim ? '' : 'hidden'}>${esc(st.interim)}</div>
    ${st.micNote ? `<div class="micnote">${ic('info', 14)}<span>${esc(st.micNote)}</span></div>` : ''}
    <label class="sr" for="draft">Message to patient</label>
    <div class="cmpbox"><textarea id="draft" data-input="draft" lang="${st.lang === 'ur-PK' ? 'ur' : 'en'}" dir="auto" placeholder="${st.lang === 'ur-PK' ? 'بول کر یا ٹائپ کر کے اردو پیغام لکھیں…' : 'Speak or type a message…'}">${esc(st.draft)}</textarea>
    <div class="cmpbtns"><button class="btn primary" id="sendBtn" data-act="send" ${st.draft.trim() ? '' : 'disabled'}>${ic('send', 16)} Send</button>${st.draft ? `<button class="linkbtn" data-act="clearDraft">Clear</button>` : ''}</div></div></div>`;
}
function convoPanel(s) {
  return `<section class="card convo"><div class="row spread"><h3>Conversation</h3><button class="linkbtn" data-act="modal">Full transcript</button></div><div class="chat">${chatItems(s)}</div>${composer(s)}</section>`;
}
function empty() {
  return `<div class="card empty emptybig"><div>${ic('hand', 44)}</div><h3>Waiting for a patient</h3><p>When a patient presses <b>Start</b> on the patient screen, their case appears here and fills in live as they sign.</p><p class="muted small">Open the <b>Patient screen</b> in another browser tab or on the kiosk computer at this same address.</p></div>`;
}
function staffLive() {
  const sel = getS(ST().selectedId) || null;
  if (!S.sessions.length) return `<div class="ws solo">${empty()}</div>`;
  return `<div class="ws">${queuePanel()}${sel ? caseCard(sel) : '<div class="card empty">Select a case.</div>'}${sel ? convoPanel(sel) : ''}</div>`;
}
function staffHistory() {
  const st = ST(), q = st.q.trim().toLowerCase(), per = 7;
  const rows = S.sessions.filter(s => {
    if (st.urg !== 'all' && (!s.triage || s.triage.level !== st.urg)) return false;
    if (st.dept !== 'all' && s.department !== st.dept) return false;
    if (!q) return true;
    return [s.name, s.id, s.department, s.summary && s.summary.chief].join(' ').toLowerCase().includes(q);
  }).sort((a, b) => b.startedAt - a.startedAt);
  const pages = Math.max(1, Math.ceil(rows.length / per)); if (st.page >= pages) st.page = pages - 1; if (st.page < 0) st.page = 0;
  const view = rows.slice(st.page * per, st.page * per + per), depts = Object.keys(DEPT_UR), sel = getS(st.selectedId);
  return `<div class="filters"><label class="sr" for="q">Search sessions</label><input class="field" id="q" data-input="q" type="search" placeholder="Search by patient name, ID, department or complaint" value="${esc(st.q)}">
    <label class="sr" for="dept">Department</label><select class="field" id="dept" data-input="dept"><option value="all">All departments</option>${depts.map(d => `<option ${st.dept === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
    <div class="seg" role="group" aria-label="Urgency">${[['all', 'All'], ['critical', 'Critical'], ['non-urgent', 'Non-urgent']].map(([v, l]) => `<button data-act="urg" data-v="${v}" aria-pressed="${st.urg === v}">${l}</button>`).join('')}</div></div>
    <div class="tw"><table><thead><tr><th>Patient</th><th>Date</th><th>Department</th><th>Doctor</th><th>Urgency</th><th></th></tr></thead><tbody>
    ${view.map(s => { const d = docOf(s); return `<tr data-act="select" data-id="${s.id}"><td><b>${esc(s.name)}</b><div class="muted mono small">${s.id}</div></td><td>${fmtDT(s.startedAt)}</td><td>${esc(s.department || 'Pending')}</td><td>${d ? esc(d.name) : '—'}</td><td>${urgPill(s)}</td><td><button class="btn" style="min-height:28px;padding:2px 10px" data-act="select" data-id="${s.id}">Open</button></td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">No sessions yet.</td></tr>'}
    </tbody></table></div>
    <div class="pager"><span>${rows.length} of ${S.sessions.length} sessions</span><span class="row" style="gap:6px"><button class="btn" data-act="page" data-v="-1" ${st.page <= 0 ? 'disabled' : ''}>Previous</button><span>Page ${st.page + 1} of ${pages}</span><button class="btn" data-act="page" data-v="1" ${st.page >= pages - 1 ? 'disabled' : ''}>Next</button></span></div>
    ${st.open && sel ? `<div class="recordview"><div class="row"><button class="btn" data-act="back">← Back to sessions</button><span class="muted small">${ic('lock', 14)} Records are stored on this server (data/sessions.json).</span></div><div class="ws2">${caseCard(sel)}${convoPanel(sel)}</div></div>` : ''}`;
}
function modalView(s) {
  return `<div class="modal" role="dialog" aria-label="Full transcript"><div class="sheet"><div class="sh"><div><b>Full transcript · ${esc(s.name)}</b><div class="muted small mono">${s.id}</div></div><button class="btn" data-act="closeModal">Close</button></div><div class="sb">${timeline(s)}</div></div></div>`;
}
export function staffView() {
  const st = ST(), sel = getS(st.selectedId);
  const conn = { open: ['Live', 'live'], connecting: ['Connecting…', ''], down: ['Server offline — retrying', 'busy'] }[S.conn] || ['', ''];
  return `<div class="staff"><div class="shead"><h2>Staff dashboard</h2>
    <div class="tabs" role="tablist"><button role="tab" data-act="tab" data-v="live" aria-selected="${st.tab === 'live'}">Live cases</button><button role="tab" data-act="tab" data-v="history" aria-selected="${st.tab === 'history'}">Session history</button></div>
    <div class="sp"><span class="sys ${S.conn === 'open' ? 'recording' : ''}" role="status"><span class="dot ${conn[1]}"></span>${conn[0]}</span></div></div>
    <div class="sbody">${st.tab === 'live' ? staffLive() : staffHistory()}</div>
    <div class="foot">${ic('lock', 14)}<span>Sessions are saved on this server. No login is built in — run it only on a trusted network, or add authentication before real patient use.</span></div>
    ${st.modal && sel ? modalView(sel) : ''}</div>`;
}

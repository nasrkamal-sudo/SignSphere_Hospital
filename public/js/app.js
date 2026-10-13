/* App shell: boot, real-time sync (SSE), mode routing, rendering, events. */
import { S, hooks, esc, cam, loadModel, upsertSession, getS, urlParam, toast, emergencyAlarm } from './core.js';
import { patientView, sosHTML, sosDisabled, patientActions, syncPatient, resetPatient, resumePatient, onSessionUpdate, recognizer } from './patient.js';
import { staffView, staffActions, staffInput, staffKey, stopMic } from './staff.js';
import { doctorView, doctorActions, doctorInput, onDoctorSession, unreadCount, unreadCritical, setDoctorFromUrl } from './doctor.js';
import { trainView, trainActions, trainFrame, openTrain, refreshDataset, stopTraining } from './train.js';

if (urlParam('test')) window.__SS_TEST = true;

const $ = id => document.getElementById(id);

/* ---------- render ---------- */
let rendering = false;
function render() {
  const app = $('app');
  if (!S.vocab || rendering) return;
  rendering = true;
  try { renderNow(app); } finally { rendering = false; }
}
function renderNow(app) {
  const ae = document.activeElement, id = ae && ae.id, a = ae && ae.selectionStart, b = ae && ae.selectionEnd;
  app.dataset.mode = S.mode;
  document.querySelectorAll('#modeSeg [data-act="mode"]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.v === S.mode)));
  const sos = $('sosBtn'), showSos = S.mode === 'patient' || S.mode === 'split';
  sos.hidden = !showSos;
  if (showSos) { const h = sosHTML(); if (sos.dataset.h !== h) { sos.innerHTML = h; sos.dataset.h = h; } sos.disabled = sosDisabled(); }
  /* emergency beacon: small blinking light in the top bar (staff side) instead of a full-width banner */
  const bc = $('beacon'), emgs = S.sessions.filter(x => x.emergency && x.status !== 'closed'), showBc = S.mode !== 'patient' && S.mode !== 'doctor' && emgs.length > 0;
  bc.hidden = !showBc;
  if (showBc) {
    const h = `<span class="bdot" aria-hidden="true"></span><span class="btxt"><b>Emergency${emgs.length > 1 ? ' ×' + emgs.length : ''}</b><small>${esc(emgs[0].name)}</small></span>`;
    if (bc.dataset.h !== h) { bc.innerHTML = h; bc.dataset.h = h; }
    bc.title = 'Emergency alert from the patient screen. Click to open the case.';
  }
  const ub = $('docBadge'), un = unreadCount();
  ub.hidden = !un; ub.textContent = un; ub.classList.toggle('crit', unreadCritical());
  document.title = (un ? `(${un}) ` : '') + 'SignSphere — Hospital sign language interpreter';
  const showP = S.mode === 'patient' || S.mode === 'split', showS = S.mode === 'staff' || S.mode === 'split', showT = S.mode === 'train', showD = S.mode === 'doctor';
  if (cam.node.parentNode) cam.node.parentNode.removeChild(cam.node);
  if (showP) { syncPatient(); $('patientRoot').innerHTML = patientView(); } else $('patientRoot').innerHTML = '';
  if (showS) $('staffRoot').innerHTML = staffView(); else $('staffRoot').innerHTML = '';
  if (showT) $('trainRoot').innerHTML = trainView(); else $('trainRoot').innerHTML = '';
  if (showD) $('doctorRoot').innerHTML = doctorView(); else $('doctorRoot').innerHTML = '';
  /* the camera is one persistent element: put it in whichever screen has a slot, switch it off when nobody needs it */
  const slot = document.querySelector('[data-camslot]');
  if (slot) {
    slot.appendChild(cam.node); cam.resume();
    // back on a screen that needs the camera (e.g. a doctor's message arrived after intake): switch it on again
    if (cam.state === 'off' && S.mode !== 'train' && !window.__SS_TEST) setTimeout(() => { if (cam.state === 'off') cam.start(); }, 0);
  } else if ((cam.state === 'on' || cam.state === 'starting') && S.patient.stage !== 'building') cam.stop();
  const tEl = $('toast');
  if (S.toast) { tEl.hidden = false; tEl.className = 'toast ' + S.toast.kind; tEl.textContent = S.toast.msg; } else tEl.hidden = true;
  if (id) { const el = $(id); if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); try { if (a != null) el.setSelectionRange(a, b); } catch { /* not a text field */ } } }
}
hooks.render = render;

/* ---------- camera -> recogniser / trainer ---------- */
cam.onFrame = (lm, t) => { if (S.mode === 'train') trainFrame(lm, t); else recognizer.feed(lm, t); };
cam.onState = () => render();

/* ---------- mode switching ---------- */
function setMode(m) {
  const prev = S.mode;
  if (m === prev) return;
  if (prev === 'train') stopTraining();
  if ((prev === 'staff' || prev === 'split') && m !== 'staff' && m !== 'split') stopMic();
  S.mode = m;
  if (m === 'train') { openTrain(); }
  if (m === 'staff') stopMic();
  render();
  // coming back to a patient screen that is mid-conversation: start the camera again (permission is already granted)
  const needsCam = (S.mode === 'patient' || S.mode === 'split') && (S.patient.stage === 'q' || S.patient.stage === 'wait');
  if (needsCam && cam.state === 'off') cam.start();
}

const actions = {
  ...patientActions, ...staffActions, ...trainActions, ...doctorActions, mode: d => setMode(d.v),
  goEmergency: () => {
    const e = S.sessions.find(x => x.emergency && x.status !== 'closed'); if (!e) return;
    S.staff.selectedId = e.id; S.staff.tab = 'live'; S.staff.open = false;
    if (S.mode === 'train') setMode('staff'); else render();
  },
};

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
  const fn = actions[el.dataset.act]; if (fn) fn(el.dataset);
});
let holdT = null, holdEl = null;
function holdStart(el) { if (holdT || el.disabled) return; holdEl = el; el.classList.add('holding'); holdT = setTimeout(() => { holdT = null; el.classList.remove('holding'); holdEl = null; patientActions.sos(); }, 1500); }
function holdCancel() { if (holdT) { clearTimeout(holdT); holdT = null; } document.querySelectorAll('.sos.holding').forEach(x => x.classList.remove('holding')); holdEl = null; }
document.addEventListener('pointerdown', e => { const el = e.target.closest('[data-hold]'); if (el) holdStart(el); });
['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, holdCancel));
document.addEventListener('pointerout', e => { if (holdEl && !holdEl.contains(e.relatedTarget)) holdCancel(); });
document.addEventListener('keydown', e => {
  const el = e.target.closest && e.target.closest('[data-hold]');
  if (el && (e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); holdStart(el); }
  if (e.key === 'Escape' && S.staff.modal) { S.staff.modal = false; render(); }
  staffKey(e);
});
document.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') holdCancel(); });
document.addEventListener('input', e => staffInput(e, 'input'));
document.addEventListener('change', e => { staffInput(e, 'change'); doctorInput(e); });

/* ---------- real-time sync ---------- */
async function fetchSessions() {
  const list = await (await fetch('/api/sessions')).json();
  S.sessions = list.sort((a, b) => b.startedAt - a.startedAt);
}
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', async () => {
    const wasDown = S.conn !== 'open';
    S.conn = 'open';
    if (wasDown) { try { await fetchSessions(); await refreshDataset(); } catch { /* retry on next event */ } }
    render();
  });
  es.addEventListener('session', e => {
    const s = JSON.parse(e.data);
    const isNew = !getS(s.id), prev = getS(s.id) ? JSON.parse(JSON.stringify(getS(s.id))) : null;
    upsertSession(s);
    const note = onDoctorSession(prev, s);
    if (note) toast(`${note.critical ? 'CRITICAL case' : 'New case'} sent to you: ${note.name}`, note.critical ? 'crit' : 'warn');
    onSessionUpdate(s);
    if (s.emergency && !(prev && prev.emergency) && s.status !== 'closed' && S.mode !== 'patient' && S.mode !== 'doctor') emergencyAlarm(s.id);
    // a new patient appears on the dashboard straight away, unless staff are in the middle of writing/dictating
    const cur = getS(S.staff.selectedId), busy = S.staff.draft.trim() || S.staff.speech !== 'idle';
    if (!S.staff.selectedId || (isNew && (!busy || s.emergency)) || (cur && cur.status === 'closed' && s.id !== cur.id && isNew)) { S.staff.selectedId = s.id; S.staff.open = false; }
    render();
  });
  es.addEventListener('dataset', e => { S.train.counts = JSON.parse(e.data); render(); });
  es.addEventListener('model', async () => { try { await loadModel(); } catch { /* ignore */ } render(); });
  es.onerror = () => { if (S.conn !== 'down') { S.conn = 'down'; render(); } };
}

/* ---------- boot ---------- */
async function boot() {
  try {
    S.vocab = await (await fetch('/api/vocabulary')).json();
    S.vocab.glosses.forEach(g => { S.glossById[g.id] = g; });
    await Promise.all([loadModel(), fetchSessions(), refreshDataset()]);
  } catch (e) {
    document.body.innerHTML = `<div style="max-width:560px;margin:15vh auto;font:16px/1.6 system-ui;padding:0 16px"><h2>SignSphere server not reachable</h2><p>This page needs its local server. In the project folder run <code>node server.js</code>, then open <b>http://localhost:3000</b>.</p><p style="color:#666">${esc(e.message || e)}</p></div>`;
    return;
  }
  try { S.staff.lang = localStorage.getItem('signsphere.micLang') || 'ur-PK'; } catch { S.staff.lang = 'ur-PK'; }
  const m = urlParam('mode'); if (['patient', 'staff', 'train', 'split', 'doctor'].includes(m)) S.mode = m;
  setDoctorFromUrl(urlParam('doctor'));
  resumePatient();
  S.staff.selectedId = (S.sessions.find(s => s.status !== 'closed') || S.sessions[0] || {}).id || null;
  if (S.mode === 'train') openTrain();
  render();
  connect();
  if ((S.mode === 'patient' || S.mode === 'split') && (S.patient.stage === 'q' || S.patient.stage === 'wait') && !urlParam('test')) cam.start();
  if (urlParam('test')) window.__ss = { S, cam, recognizer, getS, render, setMode, actions };
}
boot();

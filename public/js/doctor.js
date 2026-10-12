/* Doctor screen: a doctor chooses who they are, then sees the cases staff have notified them about —
 * critical or not, patient summary, the patient's signed answers — and can acknowledge. Live over SSE. */
import { S, render, esc, bl, ic, api, getS, upsertSession, fmtT, fmtDT } from './core.js';
import { QUESTIONS, DOCTORS, DEPT_UR, doctorStatus, isNotified, notifEntry, ackAt } from './logic.js';

const LS_DOC = 'signsphere.doctorId', LS_SND = 'signsphere.doctorSound';
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export const D = { id: lsGet(LS_DOC, ''), sel: null, sound: lsGet(LS_SND, '1') === '1', obsolete: false };
export const setDoctorFromUrl = id => { if (id && DOCTORS.some(d => d.id === id)) { D.id = id; lsSet(LS_DOC, id); } };

const me = () => DOCTORS.find(d => d.id === D.id) || null;
const isCrit = s => !!(s.emergency || (s.triage && s.triage.level === 'critical'));

/** Cases this doctor was notified about, most urgent first. */
export function myCases() {
  if (!D.id) return [];
  const rank = s => s.status === 'closed' ? 3 : ackAt(s, D.id) ? 2 : isCrit(s) ? 0 : 1;
  return S.sessions.filter(s => isNotified(s, D.id)).sort((a, b) => rank(a) - rank(b) || (notifEntry(b, D.id).at || 0) - (notifEntry(a, D.id).at || 0));
}
export const unreadCount = () => myCases().filter(s => s.status !== 'closed' && !ackAt(s, D.id)).length;
export const unreadCritical = () => myCases().some(s => s.status !== 'closed' && !ackAt(s, D.id) && isCrit(s));

/* ---------- alerts when a new notification arrives ---------- */
let audio = null;
function beep(critical) {
  if (!D.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const n = critical ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const t0 = audio.currentTime + i * 0.28, o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = critical ? 988 : 660; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      o.start(t0); o.stop(t0 + 0.24);
    }
  } catch { /* audio blocked until the page has been clicked */ }
}
/** Called by the SSE handler with the previous and new copy of a session. */
export function onDoctorSession(prev, s) {
  if (!D.id || !isNotified(s, D.id) || (prev && isNotified(prev, D.id))) return null;
  beep(isCrit(s));
  D.sel = s.id;
  return { critical: isCrit(s), name: s.name };
}

/* ---------- actions ---------- */
export const doctorActions = {
  dsel: d => { D.sel = d.id; render(); },
  ack: async () => {
    const s = getS(D.sel); if (!s || !D.id || ackAt(s, D.id)) return;
    const doc = me(), now = Date.now();
    await api(`/api/sessions/${s.id}/exchange`, 'POST', { from: 'system', text: `${doc.name} acknowledged the notification.` });
    upsertSession(await api(`/api/sessions/${s.id}/patch`, 'POST', { ack: { ...(s.ack || {}), [D.id]: now } }));
    render();
  },
  dsound: () => { D.sound = !D.sound; lsSet(LS_SND, D.sound ? '1' : '0'); if (D.sound) beep(false); render(); },
  dswitch: () => { D.id = ''; D.sel = null; lsSet(LS_DOC, ''); render(); },
};
export function doctorInput(e) {
  if (e.target.dataset && e.target.dataset.input === 'docId') {
    D.id = e.target.value; D.sel = null; lsSet(LS_DOC, D.id); beep(false); render();
  }
}

/* ---------- views ---------- */
function picker() {
  const depts = [...new Set(DOCTORS.map(d => d.dept))];
  return `<div class="card empty emptybig docpick"><div>${ic('user', 44)}</div><h3>Doctor screen</h3>
    <p>Choose who you are to see the cases staff have sent to you.</p>
    <select class="field" data-input="docId" aria-label="Choose your name"><option value="">Select your name…</option>${depts.map(dp => `<optgroup label="${esc(dp)}">${DOCTORS.filter(d => d.dept === dp).map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</optgroup>`).join('')}</select>
    <p class="muted small">No password is used in this build. This is a name picker, not a login: anyone on this network could open any doctor's view. Add real authentication before clinical use.</p></div>`;
}
function listItem(s) {
  const crit = isCrit(s), acked = !!ackAt(s, D.id), closed = s.status === 'closed';
  const n = notifEntry(s, D.id);
  return `<button class="qi ${crit && !closed ? 'crit' : ''} ${D.sel === s.id ? 'sel' : ''}" data-act="dsel" data-id="${s.id}">
    <span class="qdot ${crit ? 'crit' : 'calm'}" title="${crit ? 'Critical' : 'Non-urgent'}"></span>
    <span class="qt"><b>${esc(s.name)}</b><small>${crit ? 'CRITICAL' : 'Non-urgent'} · ${s.summary ? esc(s.summary.chief) : 'Emergency button'}</small><small>${n && n.at ? 'Notified ' + fmtT(n.at) : ''}${closed ? ' · closed' : ''}</small></span>
    ${!acked && !closed ? '<span class="newtag">NEW</span>' : acked ? `<span class="ok-tick" title="Acknowledged">${ic('check', 14)}</span>` : ''}</button>`;
}
function detail(s) {
  const t = s.triage, sm = s.summary, crit = isCrit(s), acked = ackAt(s, D.id), closed = s.status === 'closed';
  const strip = crit
    ? `<div class="tstrip crit" role="alert">${ic('alert', 24)}<div><b>CRITICAL${s.emergency ? ' — EMERGENCY BUTTON PRESSED' : ''}</b> <span class="rs">${(t ? t.reasons : ['Patient pressed the emergency button']).map(r => `<span class="r">${esc(r)}</span>`).join('')}</span></div>${t ? `<span class="tw2">See within: ${esc(t.wait)}</span>` : ''}</div>`
    : t ? `<div class="tstrip calm">${ic('check', 22)}<div><b>NON-URGENT</b> <span>${esc(t.reasons[0])}</span></div><span class="tw2">See within: ${esc(t.wait)}</span></div>`
    : `<div class="tstrip pend">${ic('clock', 20)}<div><b>Triage pending</b> <span>${s.qa.length} of ${QUESTIONS.length} questions answered</span></div></div>`;
  const facts = sm ? `<div class="facts"><div><small>Complaint</small><b>${esc(sm.chief)}</b></div><div><small>Duration</small><b>${esc(sm.duration)}</b></div><div><small>Severity</small><b>${esc(sm.severity)}</b></div><div><small>Associated</small><b>${esc(sm.associated)}</b></div></div><p class="narr">${esc(sm.narrative)}</p>`
    : `<p class="muted small">Summary appears when the patient finishes the questions.</p>`;
  const answers = s.qa.length ? s.qa.map(a => `<div class="dans"><div class="muted small">${esc(a.q_en)}</div><div><b>${esc(a.a_en)}</b> <span class="ur" lang="ur" dir="rtl">${esc(a.a_ur)}</span></div><div class="muted small">${a.source && a.source.includes('touch') ? 'tapped' : 'signed'} · ${Math.round((a.conf || 0) * 100)}% confidence</div></div>`).join('') : '<p class="muted small">No answers yet.</p>';
  const replies = s.exchange.filter(e => e.from === 'patient').slice(-2).map(e => `<div class="dans pr"><div class="muted small">Patient reply · ${fmtT(e.ts)}</div><div><b>${esc(e.en)}</b> <span class="ur" lang="ur" dir="rtl">${esc(e.ur)}</span></div></div>`).join('');
  const act = closed ? `<span class="muted small">${ic('lock', 14)} Case closed by staff.</span>`
    : acked ? `<span class="pill ok">${ic('check', 13)} Acknowledged ${fmtT(acked)}</span><span class="muted small">Staff can see that you are on the case.</span>`
    : `<button class="btn primary ackbtn" data-act="ack">${ic('check', 18)} Acknowledge — I'm on it</button><span class="muted small">Lets the staff desk know you have seen this.</span>`;
  const dept = s.department ? `<span class="muted small">${esc(s.department)} <span class="ur" lang="ur" dir="rtl">${DEPT_UR[s.department] || ''}</span></span>` : '';
  return `<section class="card case ddetail"><div class="chead"><div><b class="nm">${esc(s.name)}</b><div class="muted small mono">${s.id} · started ${fmtDT(s.startedAt)}</div>${dept}</div><div class="chr"><span class="pill ${closed ? 'plain' : s.status === 'in-consult' ? 'ok' : 'warn'}">${closed ? 'Closed' : s.status === 'in-consult' ? 'In consultation' : 'Awaiting doctor'}</span></div></div>
    ${strip}
    <div class="cbody"><div><h3>Patient summary</h3>${facts}</div><div><h3>Patient's answers</h3><div class="danswers">${answers}${replies}</div></div></div>
    <div class="dact">${act}</div></section>`;
}
export function doctorView() {
  const doc = me();
  const conn = { open: ['Live', 'live'], connecting: ['Connecting…', ''], down: ['Server offline — retrying', 'busy'] }[S.conn] || ['', ''];
  const head = `<div class="shead"><h2>Doctor screen</h2>${doc ? `<span class="whoami">${ic('user', 16)} <b>${esc(doc.name)}</b> <span class="muted small">${esc(doc.dept)}</span></span><button class="linkbtn" data-act="dswitch">Not you?</button>` : ''}
    <div class="sp row" style="gap:8px">${doc ? `<button class="btn sndbtn" data-act="dsound" aria-pressed="${D.sound}">${D.sound ? 'Sound on' : 'Sound off'}</button>` : ''}<span class="sys ${S.conn === 'open' ? 'recording' : ''}" role="status"><span class="dot ${conn[1]}"></span>${conn[0]}</span></div></div>`;
  if (!doc) return `<div class="staff">${head}<div class="sbody">${picker()}</div></div>`;
  const cases = myCases();
  if (!cases.some(s => s.id === D.sel)) D.sel = cases.length ? cases[0].id : null;
  const sel = getS(D.sel);
  const unread = cases.filter(s => s.status !== 'closed' && !ackAt(s, D.id)).length;
  const ws = cases.length
    ? `<div class="ws dws"><aside class="queue" aria-label="My notifications"><div class="qhead"><h3>My notifications</h3><span class="small ${unread ? 'critnum' : 'muted'}">${unread ? unread + ' new' : cases.length + ' total'}</span></div><div class="qscroll">${cases.map(listItem).join('')}</div></aside>${sel ? detail(sel) : ''}</div>`
    : `<div class="card empty emptybig">${ic('clock', 44)}<h3>No notifications yet</h3><p>When the staff desk notifies you about a patient, the case appears here with an alert.</p><p class="muted small">${doc.name} · ${doctorStatus(doc).en}</p></div>`;
  return `<div class="staff doctorscr">${head}<div class="sbody">${ws}</div><div class="foot">${ic('lock', 14)}<span>Summaries come from the patient's confirmed sign answers and rule-based triage. Confirm key details with the patient.</span></div></div>`;
}

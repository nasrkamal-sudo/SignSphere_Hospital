/* Patient screen: live camera -> recognised signs -> on-screen interpretation -> confirm -> staff dashboard. */
import { S, render, esc, bl, bi, ic, cam, api, getS, activeSession, upsertSession, setSys, trainedSet, toast, urlParam } from './core.js';
import { LiveRecognizer } from './slr.js';
import { QUESTIONS, allowedGlosses, replyGlosses, buildAnswer, buildReply, summarize, classify, pickDoctor, DEPT_UR, urNum } from './logic.js';

const P = () => S.patient;
const LS_KEY = 'signsphere.activeSession';
export const recognizer = new LiveRecognizer(null, onRecEvent);

/* ---------- context: what is the patient being asked right now? ---------- */
export function pendingMsg(s) {
  if (!s) return null;
  const ex = s.exchange.filter(e => e.from === 'doctor' || e.from === 'patient');
  const last = ex[ex.length - 1];
  return last && last.from === 'doctor' ? last : null;
}
function lastPatientReplied(s) {
  if (!s) return false;
  const ex = s.exchange.filter(e => e.from === 'doctor' || e.from === 'patient');
  const last = ex[ex.length - 1]; return !!last && last.from === 'patient';
}
function ctx() {
  const p = P();
  if (p.stage === 'q') return { kind: 'q', q: QUESTIONS[p.qi] };
  if (p.stage === 'wait' && pendingMsg(activeSession())) return { kind: 'reply' };
  return null;
}
function allowedFor(c) {
  if (!c) return new Set();
  if (c.kind === 'reply') return replyGlosses(S.vocab);
  const set = allowedGlosses(S.vocab, c.q.id);
  if (c.q.id !== 'other') { set.add('yes'); set.add('no'); }      // yes = confirm, no = redo
  return set;
}
/** Keep the recogniser in step with the screen (called before every patient render). */
export function syncPatient() {
  if (!S.vocab) return;
  recognizer.setModel(S.model);
  const c = ctx();
  const key = c ? (c.kind === 'q' ? 'q' + c.q.id : 'reply') : 'none';
  if (P()._ctxKey !== key) { P()._ctxKey = key; P().tokens = []; P().picker = false; recognizer.reset(); }
  recognizer.setAllowed(allowedFor(c));
  avatarSync(c);
  cam.node.classList.toggle('standby', P().stage === 'wait' && !c);
}

/* ---------- avatar panel (placeholder: UI states only, no real signing animation yet) ---------- */
const AV_MS = 3600;
let avTimer = null;
function avatarStart() { const p = P(); clearTimeout(avTimer); p.avatar = 'signing'; avTimer = setTimeout(() => { p.avatar = 'finished'; render(); }, AV_MS); }
function avatarSync(c) {
  const p = P();
  const pm = c && c.kind === 'reply' ? pendingMsg(activeSession()) : null;
  const key = !c ? null : c.kind === 'q' ? 'q' + c.q.id : 'm' + (pm ? pm.ts : '');
  if (key === p.avKey) return;
  p.avKey = key;
  if (!key) { clearTimeout(avTimer); p.avatar = 'idle'; return; }
  avatarStart();
}

/* ---------- sign events from the recogniser ---------- */
function onRecEvent(ev) {
  if (S.mode === 'train') return;
  if (ev.type === 'candidate') { P().live = ev; paintLive(); return; }
  if (ev.type === 'token') handleToken({ gloss: ev.gloss, confidence: ev.confidence, source: 'sign' });
}
function paintLive() {
  const el = document.getElementById('liveHint'); if (!el) return;
  const l = P().live;
  const g = l && S.glossById[l.gloss];
  const lastTok = P().tokens[P().tokens.length - 1];
  if (l && l.accepted && g && lastTok && lastTok.gloss === l.gloss && lastTok.source === 'sign') el.innerHTML = `<span class="muted">Got it. Sign the next word, or confirm.</span>`;
  else if (l && l.accepted && g) el.innerHTML = `${ic('check', 16)} <b>${esc(g.en)}</b> <span class="ur" lang="ur" dir="rtl">${esc(g.ur)}</span> <small>${Math.round(l.confidence * 100)}%</small>`;
  else if (cam.handPresent) el.textContent = 'Reading your sign… · اشارہ پڑھا جا رہا ہے…';
  else el.textContent = '';
}
const answerCandidate = c => c.kind === 'q' ? buildAnswer(c.q.id, P().tokens, S.vocab) : buildReply(P().tokens, S.vocab);

function handleToken(tok) {
  const p = P(), c = ctx(); if (!c) return;
  const g = tok.gloss, cand = answerCandidate(c);
  const q = c.kind === 'q' ? c.q.id : null;
  const confirmSign = g === 'confirm' || (q && q !== 'other' && g === 'yes');
  const redoSign = g === 'cancel' || (q && q !== 'other' && g === 'no');
  if (confirmSign) { if (cand) confirmCandidate(); else flash('Nothing to confirm yet · ابھی تصدیق کرنے کو کچھ نہیں'); return; }
  if (redoSign) { if (p.tokens.length) { p.tokens = []; flash('Cleared · صاف کر دیا'); } return; }
  if (p.tokens.length >= 6) return;
  p.tokens.push({ gloss: g, confidence: tok.confidence, source: tok.source || 'sign' });
  render();
}
let flashT = null;
function flash(msg) { P().handNote = msg; render(); clearTimeout(flashT); flashT = setTimeout(() => { P().handNote = ''; render(); }, 2500); }

/* ---------- actions ---------- */
async function confirmCandidate() {
  const p = P(), s = activeSession(), c = ctx();
  if (!s || !c || p.busy) return;
  const cand = answerCandidate(c); if (!cand) return;
  p.busy = true;
  const signs = p.tokens.map(t => ({ gloss: t.gloss, conf: Math.round(t.confidence * 1000) / 1000, source: t.source }));
  const source = [...new Set(p.tokens.map(t => t.source))].join('+');
  try {
    if (c.kind === 'q') {
      const rec = { qid: c.q.id, q_en: c.q.en, q_ur: c.q.ur, a_en: cand.en, a_ur: cand.ur, clin: cand.clin, gloss: cand.gloss, conf: cand.conf, tags: cand.tags, source, signs };
      upsertSession(await api(`/api/sessions/${s.id}/qa`, 'POST', rec));
      p.tokens = []; p.picker = false; p.qi++;
      if (p.qi >= QUESTIONS.length) { p.stage = 'building'; setSys('patient', 'processing'); render(); await finishIntake(); }
    } else {
      upsertSession(await api(`/api/sessions/${s.id}/exchange`, 'POST', { from: 'patient', en: cand.en, ur: cand.ur, gloss: cand.gloss, conf: cand.conf, source, signs }));
      p.tokens = []; p.picker = false;
    }
  } finally { p.busy = false; render(); }
}

async function finishIntake() {
  const p = P(), s = activeSession(); if (!s) return;
  const summary = summarize(s.qa, { emergency: s.emergency });
  const triage = classify(s.qa, s.emergency);
  const doctorId = pickDoctor(triage.department);
  upsertSession(await api(`/api/sessions/${s.id}/patch`, 'POST', { summary, triage, department: triage.department, doctorId, status: s.status === 'in-consult' ? 'in-consult' : 'awaiting' }));
  setSys('patient', 'idle');
  if (p.stage !== 'emergency') p.stage = 'wait';
  render();
}

async function startSession() {
  const p = P();
  try {
    const s = await api('/api/sessions', 'POST', {});
    upsertSession(s);
    Object.assign(p, { stage: 'q', qi: 0, sessionId: s.id, tokens: [], picker: false });
    try { localStorage.setItem(LS_KEY, s.id); } catch { /* private mode */ }
    S.staff.selectedId = s.id;
    render();
    cam.start();
  } catch { /* api() already toasted */ }
}
export function resetPatient() {
  Object.assign(P(), { stage: 'welcome', qi: 0, sessionId: null, tokens: [], picker: false, live: null, _ctxKey: null, avKey: null, avatar: 'idle' });
  setSys('patient', 'idle'); recognizer.reset();
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}
/** After a reload: go back to the patient's open session if there is one. */
export function resumePatient() {
  let id = null; try { id = localStorage.getItem(LS_KEY); } catch { /* ignore */ }
  const s = id && getS(id);
  if (!s || s.status === 'closed') { resetPatient(); return; }
  const p = P();
  p.sessionId = s.id;
  if (s.emergency) { p.stage = 'emergency'; return; }
  if (s.qa.length >= QUESTIONS.length) p.stage = s.triage ? 'wait' : 'building';
  else { p.stage = 'q'; p.qi = s.qa.length; }
  if (p.stage === 'building') finishIntake();
}
/** Called when the server tells us a session changed. */
export function onSessionUpdate(s) {
  const p = P();
  if (s.id === p.sessionId && s.status === 'closed') { resetPatient(); }
}

async function triggerEmergency() {
  const p = P();
  try {
    let s = activeSession();
    if (!s) { s = await api('/api/sessions', 'POST', {}); upsertSession(s); p.sessionId = s.id; try { localStorage.setItem(LS_KEY, s.id); } catch { /* ignore */ } }
    if (s.emergency) return;
    const triage = classify(s.qa, true), summary = summarize(s.qa, { emergency: true });
    p.stage = 'emergency'; p.tokens = []; p.picker = false;
    await api(`/api/sessions/${s.id}/exchange`, 'POST', { from: 'system', text: 'Emergency button pressed on patient screen.' });
    upsertSession(await api(`/api/sessions/${s.id}/patch`, 'POST', { emergency: true, status: 'awaiting', triage, summary, department: triage.department, doctorId: pickDoctor(triage.department) }));
    S.staff.selectedId = s.id; S.staff.tab = 'live';
    render();
  } catch { /* toasted */ }
}
async function cancelEmergency() {
  const p = P(), s = activeSession(); if (!s) return;
  await api(`/api/sessions/${s.id}/exchange`, 'POST', { from: 'system', text: 'Emergency alert cancelled from the patient screen (marked as pressed by mistake).' });
  let patch;
  if (s.qa.length >= QUESTIONS.length) {
    const triage = classify(s.qa, false);
    patch = { emergency: false, status: 'awaiting', triage, summary: summarize(s.qa), department: triage.department, doctorId: pickDoctor(triage.department) };
    p.stage = 'wait';
  } else if (s.qa.length === 0) {
    patch = { emergency: false, status: 'closed', closedAt: Date.now(), triage: null, summary: null, department: null, doctorId: null };
    await api(`/api/sessions/${s.id}/exchange`, 'POST', { from: 'system', text: 'Session closed. No clinical data collected.' });
    upsertSession(await api(`/api/sessions/${s.id}/patch`, 'POST', patch)); resetPatient(); render(); return;
  } else {
    patch = { emergency: false, status: 'intake', triage: null, summary: null, department: null, doctorId: null };
    p.stage = 'q'; p.qi = s.qa.length;
  }
  upsertSession(await api(`/api/sessions/${s.id}/patch`, 'POST', patch));
  render();
}

export const patientActions = {
  start: () => startSession(),
  camOn: () => { cam.start(); },
  avReplay: () => { avatarStart(); render(); },
  confirm: () => confirmCandidate(),
  redo: () => { P().tokens = []; render(); },
  rmTok: d => { P().tokens.splice(Number(d.i), 1); render(); },
  picker: () => { P().picker = !P().picker; render(); },
  pickCat: d => { P().pickerCat = d.v; render(); },
  pick: d => handleToken({ gloss: d.g, confidence: 1, source: 'touch' }),
  cancelSos: () => cancelEmergency(),
  sos: () => triggerEmergency(),
};

/* ---------- views ---------- */
const QICON = { location: { icon: 'pin', c: 'coral' }, duration: { icon: 'clock', c: 'amber2' }, severity: { icon: 'gauge', c: 'violet' }, other: { icon: 'plus', c: 'teal' } };

/* top-bar emergency button (lives in index.html's top bar; app.js calls this on every render) */
export function sosHTML() {
  const em = P().stage === 'emergency';
  return `<span class="sostxt"><b>${em ? 'ALERT SENT' : 'SOS · Emergency'}</b><span class="ur" lang="ur" dir="rtl">${em ? 'الرٹ بھیج دیا گیا' : 'ہنگامی صورتحال'}</span></span>${ic('alert', 22)}<small class="soshold">${em ? '' : bl('Hold 1.5 s', '1.5 سیکنڈ دبائیں')}</small>`;
}
export const sosDisabled = () => P().stage === 'emergency';

function camStatus() {
  if (cam.state === 'error') return `<div class="micnote">${ic('info', 14)}<span>${esc(cam.error)}</span></div><button class="btn" data-act="camOn">${ic('cam', 16)}${bl('Try camera again', 'کیمرہ دوبارہ آزمائیں')}</button>`;
  if (cam.state === 'off') return `<button class="btn primary" data-act="camOn">${ic('cam', 16)}${bl('Turn on camera', 'کیمرہ چلائیں')}</button>`;
  if (cam.state === 'starting') return `<div class="pv-state"><span class="spin"></span>${bl('Starting camera…', 'کیمرہ شروع ہو رہا ہے…')}</div>`;
  return '';
}

function tokenChips() {
  const p = P();
  if (!p.tokens.length) return '';
  return `<div class="tokrow" aria-label="Signs recognised">${p.tokens.map((t, i) => {
    const g = S.glossById[t.gloss] || { en: t.gloss, ur: '' };
    return `<span class="tok ${t.source === 'touch' ? 'touch' : ''}"><b>${esc(g.en)}</b><span class="ur" lang="ur" dir="rtl">${esc(g.ur)}</span>${t.source === 'sign' ? `<small>${Math.round(t.confidence * 100)}%</small>` : `<small>${ic('hand', 11)}</small>`}<button class="tokx" data-act="rmTok" data-i="${i}" aria-label="Remove ${esc(g.en)}">${ic('x', 12)}</button></span>`;
  }).join('')}</div>`;
}

/* Tap-instead sheet: covers the camera panel only; the confirmation panel underneath stays visible. */
function pickerView(c) {
  const p = P(), allowed = allowedFor(c);
  const isQ = c.kind === 'q', qid = isQ ? c.q.id : null;
  const offer = g => allowed.has(g.id) && g.cat !== 'control' && !(isQ && g.cat === 'answer' && (qid !== 'other' || g.id !== 'no'));
  const cats = [...new Set(S.vocab.glosses.filter(offer).map(g => g.cat))];
  const catName = { answer: ['Yes / No', 'ہاں / نہیں'], number: ['Numbers', 'اعداد'], body: ['Body', 'جسم'], time: ['Time', 'وقت'], severity: ['How bad', 'شدت'], symptom: ['Symptoms', 'علامات'], reply: ['Words', 'الفاظ'] };
  const cat = cats.includes(p.pickerCat) ? p.pickerCat : cats[0];
  const items = S.vocab.glosses.filter(g => offer(g) && g.cat === cat);
  return `<div class="pv-picker"><div class="pk-head"><span class="pv-state">${ic('grid', 20)}${bl('Tap instead', 'ٹچ کریں')}</span><button class="btn" data-act="picker">${ic('hand', 16)}${bl('Back to signing', 'اشاروں پر واپس')}</button></div>
    ${cats.length > 1 ? `<div class="pcats">${cats.map(k => `<button class="pcat" data-act="pickCat" data-v="${k}" aria-pressed="${k === cat}">${catName[k] ? esc(catName[k][0]) : esc(k)}</button>`).join('')}</div>` : ''}
    <div class="pgrid">${items.map(g => `<button class="pbtn" data-act="pick" data-g="${g.id}"><b>${esc(g.en)}</b><span class="ur" lang="ur" dir="rtl">${esc(g.ur)}</span></button>`).join('')}</div></div>`;
}

/* ---- avatar panel ---- */
const AV_LABEL = { idle: ['Avatar idle', 'اوتار تیار ہے'], signing: ['Avatar signing…', 'اوتار اشارے کر رہا ہے…'], finished: ['Finished signing', 'اشارے مکمل'] };
function avatarPanel(cap) {
  const st = P().avatar || 'idle', lab = AV_LABEL[st];
  const idleMsg = ['Nothing to sign right now. The avatar will sign the doctor’s messages here.', 'ابھی کوئی پیغام نہیں۔ ڈاکٹر کے پیغامات یہاں اشاروں میں دکھائے جائیں گے۔'];
  return `<section class="avatar st-${st}" aria-label="Sign language avatar (placeholder)">
    <div class="av-top"><span class="av-badge">Placeholder · avatar not connected yet</span><span class="av-state ${st}" role="status">${st === 'signing' ? '<span class="av-dots"><i></i><i></i><i></i></span>' : st === 'finished' ? ic('check', 14) : '<span class="dot busy"></span>'}${bl(lab[0], lab[1])}</span></div>
    <div class="av-stage"><svg viewBox="0 0 240 300" class="av-fig" aria-hidden="true">
      <defs><linearGradient id="avBody" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--brand-2)"/><stop offset="1" stop-color="var(--violet)"/></linearGradient></defs>
      <path class="av-torso" d="M40 300c0-70 34-104 80-104s80 34 80 104z"/>
      <rect class="av-neck" x="108" y="150" width="24" height="30" rx="10"/>
      <circle class="av-head" cx="120" cy="118" r="42"/>
      <circle class="av-eye" cx="105" cy="114" r="4"/><circle class="av-eye" cx="135" cy="114" r="4"/>
      <path class="av-mouth" d="M107 136q13 10 26 0"/>
      <g class="av-arm l"><path class="av-sleeve" d="M62 214q-34 14-30 62"/><circle class="av-hand" cx="32" cy="278" r="15"/></g>
      <g class="av-arm r"><path class="av-sleeve" d="M178 214q34 14 30 62"/><circle class="av-hand" cx="208" cy="278" r="15"/></g>
    </svg>
    ${st === 'idle' ? `<div class="av-idle">${bl(idleMsg[0], idleMsg[1])}</div>` : ''}</div>
    <div class="av-foot">${cap ? `<div class="av-cap"><span lang="en">${esc(cap.en || '')}</span><span class="ur" lang="ur" dir="rtl">${esc(cap.ur || '')}</span></div>` : ''}
      ${st === 'signing' ? '<div class="pv-bar"><i></i></div>' : ''}
      ${st === 'finished' ? `<button class="btn" data-act="avReplay">${ic('undo', 16)}${bl('Show again', 'دوبارہ دکھائیں')}</button>` : ''}</div></section>`;
}

/* ---- signs recognised / confirmation panel (under the camera) ---- */
function confirmPanel(c) {
  const p = P(), cand = c ? answerCandidate(c) : null;
  const note = p.handNote ? `<div class="micnote">${ic('info', 14)}<span>${esc(p.handNote)}</span></div>` : '';
  const head = `<div class="cf-head"><h3>${bl('Signs recognized', 'پہچانے گئے اشارے')}</h3>${c ? `<button class="linkbtn tapbtn" data-act="picker">${ic('grid', 14)} Tap instead · ٹچ کریں</button>` : ''}</div>`;
  if (!c) {
    const s = activeSession(), replied = s && lastPatientReplied(s);
    return `<section class="card pv-confirm">${head}<div class="cf-body"><div class="pv-hint">${ic('clock', 18)}${bl(replied ? 'Your reply was sent. Waiting for the doctor.' : 'Waiting for the doctor. When they write to you, you can reply with signs.', replied ? 'آپ کا جواب بھیج دیا گیا۔ ڈاکٹر کا انتظار ہے۔' : 'ڈاکٹر کے لکھنے پر آپ اشاروں میں جواب دے سکتے ہیں۔')}</div></div></section>`;
  }
  const hint = c.kind === 'q' ? c.q.hint : ['Sign your reply to the doctor.', 'ڈاکٹر کو اشاروں میں جواب دیں۔'];
  const confirmHint = c.kind === 'q' && c.q.id !== 'other' ? ['Sign “yes” to confirm, “no” to redo.', '“جی ہاں” = درست، “نہیں” = دوبارہ۔'] : ['Sign “confirm” to send, “cancel” to redo.', '“تصدیق” = بھیجیں، “منسوخ” = دوبارہ۔'];
  const camBad = cam.state !== 'on';
  return `<section class="card pv-confirm">${head}<div class="cf-body">
    ${camBad ? `<div class="cf-cam">${camStatus()}</div>` : ''}
    <div id="liveHint" class="livehint" aria-live="polite"></div>
    ${tokenChips()}
    ${cand ? `<div class="cf-answer"><div class="pa" lang="en"><span class="ltag2">English</span><p>${esc(cand.en)}</p></div><div class="pa ur" lang="ur" dir="rtl"><span class="ltag2">اردو</span><p>${esc(cand.ur)}</p></div></div>`
      : `<div class="pv-hint">${ic('hand', 18)}${bl(hint[0], hint[1])}</div>`}
    ${note}</div>
    <div class="cf-actions"><button class="btn yes" data-act="confirm" ${cand ? '' : 'disabled'}>${ic('check', 18)}${bl('Yes, correct', 'جی ہاں، درست')}</button><button class="btn" data-act="redo" ${p.tokens.length ? '' : 'disabled'}>${ic('undo', 16)}${bl('Redo', 'دوبارہ')}</button>
      <span class="pv-hint small">${bl(confirmHint[0], confirmHint[1])}</span></div></section>`;
}

/* ---- question panel (under the avatar, narrower) ---- */
function questionPanel(o) {
  return `<section class="card pv-question ${o.cls || ''} ${o.en ? '' : 'noen'} ${o.ur ? '' : 'nour'}"><div class="pv-ico c-${o.c || 'teal'}">${ic(o.icon, 26)}</div><div class="pv-body">
    <div class="pv-meta">${o.meta}</div>
    <div class="pv-col en" lang="en"><p class="pv-en">${o.en || ''}</p></div>
    <div class="pv-col ur" lang="ur" dir="rtl"><p class="pv-ur" dir="auto">${o.ur || ''}</p></div></div></section>`;
}

/* ---- the stage: [camera | avatar] / [confirmation | question] ---- */
function pvStage(q, c, cap, standby) {
  const picker = c && P().picker ? pickerView(c) : '';
  return `<div class="pv-center"><div class="pv-cell pv-camcell ${standby ? 'standby' : ''}"><div class="camwrap" data-camslot></div>${picker}</div>
    <div class="pv-cell">${avatarPanel(cap)}</div>
    ${confirmPanel(c)}${questionPanel(q)}</div>`;
}

function stageWelcome() {
  const how = [['cam', 'Look at the camera', 'کیمرے کی طرف دیکھیں', 'teal'], ['hand', 'Sign your answer', 'اشاروں میں جواب دیں', 'coral'], ['check', 'Confirm on screen', 'اسکرین پر تصدیق کریں', 'violet']];
  const ready = trainedSet().size, total = S.vocab.glosses.length;
  return `<div class="card hero">
    <h1>Welcome</h1><div class="h-ur" lang="ur" dir="rtl">خوش آمدید</div>
    ${bi('We will ask you a few short questions. Please answer using sign language.', 'ہم آپ سے چند مختصر سوالات پوچھیں گے۔ براہ کرم اشاروں کی زبان میں جواب دیں۔', 'sm')}
    <div class="pv-how">${how.map(h => `<div class="pv-tile"><span class="pv-badge c-${h[3]}">${ic(h[0], 26)}</span>${bl(h[1], h[2])}</div>`).join('')}</div>
    <button class="btn primary big" data-act="start">${bl('Start', 'شروع کریں')}</button>
    <div class="muted small">${ic('lock', 12)} The camera is used only to read hand shapes on this device. Video is not recorded or stored. · <span class="${ready < total ? 'warnnote' : ''}">${ready} of ${total} signs ready</span></div></div>`;
}
function stageQuestion() {
  const p = P(), q = QUESTIONS[p.qi], n = p.qi + 1, tot = QUESTIONS.length;
  const dots = QUESTIONS.map((_, i) => `<span class="pv-dot ${i < p.qi ? 'done' : i === p.qi ? 'cur' : ''}">${i < p.qi ? ic('check', 12) : i + 1}</span>`).join('');
  const meta = `<span>Question ${n} of ${tot}</span><span class="pv-dots" role="progressbar" aria-valuemin="1" aria-valuemax="${tot}" aria-valuenow="${n}">${dots}</span><span class="ur" lang="ur" dir="rtl">سوال ${urNum(n)} از ${urNum(tot)}</span>`;
  return pvStage({ icon: QICON[q.id].icon, c: QICON[q.id].c, meta, en: q.en, ur: q.ur }, { kind: 'q', q }, { en: q.en, ur: q.ur }, false);
}
function stageBuilding() {
  return `<div class="card wait solo"><span class="spin"></span><div>${bi('Preparing your information for the doctor…', 'ڈاکٹر کے لیے آپ کی معلومات تیار کی جا رہی ہیں…', 'sm')}</div></div>`;
}
function stageWait() {
  const s = activeSession(), pm = pendingMsg(s), dept = (s && s.department) || '';
  const deptLine = dept ? `<span>${bl('Department: ' + esc(dept), 'شعبہ: ' + (DEPT_UR[dept] || ''))}</span>` : '';
  if (pm) {
    const isUr = /[؀-ۿ]/.test(pm.ur || '');
    return pvStage({ icon: 'msg', c: 'violet', cls: 'doc', meta: `<span>Message from the doctor</span><span class="ur" lang="ur" dir="rtl">ڈاکٹر کا پیغام</span>`, en: isUr ? '' : esc(pm.ur), ur: isUr ? esc(pm.ur) : '' },
      { kind: 'reply' }, { en: isUr ? '' : pm.ur, ur: isUr ? pm.ur : '' }, false);
  }
  return pvStage({ icon: 'check', c: 'teal', meta: `<span>Information sent</span>${deptLine}<span class="ur" lang="ur" dir="rtl">معلومات بھیج دی گئیں</span>`, en: 'Thank you. Please wait for the doctor.', ur: 'شکریہ۔ براہ کرم ڈاکٹر کا انتظار کریں۔' }, null, null, true);
}
function stageEmergency() {
  return `<div class="emerg" role="alert">
    <div class="row">${ic('alert', 32)}<b style="font-size:1.3rem">Emergency alert sent</b><span class="ur" lang="ur" dir="rtl" style="font-size:1.3rem;line-height:2;font-weight:600">ہنگامی الرٹ بھیج دیا گیا</span></div>
    ${bi('Help is on the way. Stay where you are. Staff have been alerted.', 'مدد آ رہی ہے۔ اپنی جگہ پر رہیں۔ عملے کو اطلاع دے دی گئی ہے۔', 'xl')}
    <div><button class="btn" data-act="cancelSos">${bl('Pressed by mistake — cancel', 'غلطی سے دب گیا — منسوخ کریں')}</button></div></div>`;
}
export function patientView() {
  const body = { welcome: stageWelcome, q: stageQuestion, building: stageBuilding, wait: stageWait, emergency: stageEmergency }[P().stage]();
  return `<div class="kiosk"><div class="kbody">${body}</div></div>`;
}

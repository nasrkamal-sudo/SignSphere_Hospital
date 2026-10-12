/* Train-signs screen: record your own signs with the camera, train the DTW model in the browser, check accuracy, live-test it.
 * Output is VIBETALK-compatible (dataset/<gloss>/session-NNN.json and a dtw model artefact). */
import { S, render, esc, sleep, bl, ic, cam, api, toast, loadModel } from './core.js';
import { trainFromSamples, evaluateLOO, LiveRecognizer } from './slr.js';

const T = () => S.train;
const CAT_NAMES = { control: ['Confirm / cancel', 'تصدیق / منسوخ'], answer: ['Yes / No', 'ہاں / نہیں'], reply: ['Replies to the doctor', 'ڈاکٹر کو جواب'], number: ['Numbers', 'اعداد'], body: ['Body parts', 'جسم'], time: ['Time', 'وقت'], severity: ['How bad', 'شدت'], symptom: ['Symptoms', 'علامات'] };
const CAT_ORDER = ['control', 'answer', 'number', 'body', 'time', 'severity', 'symptom', 'reply'];
const TARGET = 10;           // recordings per sign that the "auto ×10" button aims for
const GOOD = 6;              // fewer than this is flagged as thin
const CAPTURE_MS = 1300, SAMPLE_MS = 80;

export const testRecognizer = new LiveRecognizer(null, ev => {
  const t = T().test;
  if (ev.type === 'candidate') { t.live = ev; paintTest(); }
  else if (ev.type === 'token') { t.log.unshift({ gloss: ev.gloss, conf: ev.confidence, at: Date.now() }); t.log = t.log.slice(0, 6); render(); }
});

export async function refreshDataset() {
  try { T().counts = await (await fetch('/api/dataset')).json(); } catch { /* offline */ }
}
async function refreshSamples() {
  const g = T().gloss; if (!g) { T().samples = []; return; }
  try { T().samples = await (await fetch(`/api/dataset/${g}`)).json(); } catch { T().samples = []; }
}
export function openTrain() { const t = T(); if (!t.gloss) t.gloss = firstNeeded(); refreshDataset().then(refreshSamples).then(render); }
function firstNeeded() {
  const reused = S.vocab.reuse || {};
  const g = S.vocab.glosses.find(x => !reused[x.id] && !(T().counts[x.id] > 0));
  return (g || S.vocab.glosses[0]).id;
}
export function stopTraining() { T().rec.stop = true; testRecognizer.reset(); T().test.on = false; }

/* ---------- capture ---------- */
export function trainFrame(lm, t) {
  const tr = T();
  if (tr.test.on) { testRecognizer.setModel(S.model); testRecognizer.feed(lm, t); }
  const r = tr.rec;
  if (r.state !== 'capturing' || !lm) return;
  if (t - r.lastT >= SAMPLE_MS) { r.lastT = t; r.frames.push(lm.map(p => [p.x, p.y, p.z])); }
}
const camReady = () => cam.state === 'on' || !!window.__SS_TEST;

async function recordOne(countdown) {
  const r = T().rec;
  for (let i = countdown; i > 0; i--) {
    if (r.stop) return 'stopped';
    r.state = 'countdown'; r.left = i; render(); await sleep(1000);
  }
  if (r.stop) return 'stopped';
  r.state = 'capturing'; r.frames = []; r.lastT = -1e9; render();
  await sleep(CAPTURE_MS);
  const frames = r.frames; r.frames = null; r.state = 'saving'; render();
  if (frames.length < 8) { r.msg = `Your hand was only seen in ${frames.length} frames. Keep your hand fully in view for the whole recording.`; return 'nohand'; }
  const g = T().gloss;
  await api(`/api/dataset/${g}`, 'POST', { frames, fps: 12, hand: 'right' });
  r.msg = ''; r.n++;
  await refreshDataset(); await refreshSamples();
  return 'ok';
}
async function recordSession(auto) {
  const t = T(), r = t.rec;
  if (r.state !== 'idle') return;
  if (!camReady()) { r.msg = 'Turn the camera on first.'; render(); return; }
  Object.assign(r, { stop: false, n: 0, msg: '', auto });
  const start = t.counts[t.gloss] || 0;
  try {
    let first = true;
    do {
      const res = await recordOne(first ? 3 : 2);
      first = false;
      if (res !== 'ok') break;
      if (auto) await sleep(700);
    } while (auto && !r.stop && (t.counts[t.gloss] || 0) < start + TARGET);
  } catch { /* api() toasted */ }
  r.state = 'idle'; r.left = 0; render();
}

/* ---------- model ---------- */
async function collect() {
  const counts = T().counts, out = {};
  const glosses = Object.keys(counts).filter(g => counts[g] > 0);
  for (let i = 0; i < glosses.length; i++) {
    T().busy = `Loading recordings… ${i + 1}/${glosses.length}`; render();
    out[glosses[i]] = await (await fetch(`/api/dataset/${glosses[i]}`)).json();
  }
  return out;
}
async function buildModel() {
  const samples = await collect();
  T().busy = 'Training…'; render(); await sleep(40);
  const imp = await (await fetch('/api/model/imported')).json();
  const model = trainFromSamples(samples, { augment: 2, sigma: 0.03, mirror: true, threshold: imp.threshold || 0.6, extraSequences: imp.sequences, meta: { vocabulary: S.vocab.vocabulary, variant: S.vocab.variant } });
  return { model, nRec: Object.values(samples).reduce((a, x) => a + x.length, 0) };
}
async function trainModel() {
  const t = T(); if (t.busy) return;
  try {
    const { model, nRec } = await buildModel();
    t.busy = 'Saving model…'; render();
    await api('/api/model', 'POST', model.toJSON());
    await loadModel();
    t.trainedAt = new Date(); t.evalRes = null;
    t.note = `Trained on ${nRec} of your recordings (+ reused restaurant signs). ${S.model.glosses.length} signs ready, ${S.model.n} exemplars.`;
  } catch (e) { t.note = 'Training failed: ' + e.message; }
  t.busy = ''; render();
}
async function checkAccuracy() {
  const t = T(); if (t.busy) return;
  try {
    const { model, nRec } = await buildModel();
    if (!nRec) { t.note = 'Record some signs first.'; t.busy = ''; render(); return; }
    t.busy = 'Checking…'; render();
    t.evalRes = await evaluateLOO(model, p => { t.busy = `Checking… ${Math.round(p * 100)}%`; const el = document.getElementById('trainBusy'); if (el) el.textContent = t.busy; });
    t.note = '';
  } catch (e) { t.note = 'Check failed: ' + e.message; }
  t.busy = ''; render();
}

/* ---------- actions ---------- */
export const trainActions = {
  tg: d => { const t = T(); if (t.rec.state !== 'idle') return; t.gloss = d.g; t.rec.msg = ''; refreshSamples().then(render); render(); },
  camOn: () => cam.start(),
  rec1: () => recordSession(false),
  recN: () => recordSession(true),
  stopRec: () => { T().rec.stop = true; },
  delSample: async d => { await api(`/api/dataset/${T().gloss}/${d.id}`, 'DELETE'); await refreshDataset(); await refreshSamples(); render(); },
  delAll: async () => { if (!T().samples.length) return; await api(`/api/dataset/${T().gloss}`, 'DELETE'); await refreshDataset(); await refreshSamples(); render(); },
  train: () => trainModel(),
  check: () => checkAccuracy(),
  resetModel: async () => { await api('/api/model/reset', 'POST', {}); await loadModel(); T().evalRes = null; T().note = 'Model reset to the reused restaurant signs only. Your recordings are kept. Click Train model to rebuild.'; render(); },
  testToggle: () => { const t = T().test; t.on = !t.on; t.live = null; testRecognizer.reset(); render(); },
};
function paintTest() {
  const el = document.getElementById('testHint'); if (!el) return;
  const l = T().test.live, g = l && S.glossById[l.gloss];
  if (!l || !g) { el.textContent = ''; return; }
  el.innerHTML = l.accepted ? `${ic('check', 16)} <b>${esc(g.en)}</b> <span class="ur" lang="ur" dir="rtl">${esc(g.ur)}</span> <small>${Math.round(l.confidence * 100)}%</small>`
    : `<span class="muted">Not sure (best guess ${esc(g.en)}, ${Math.round(l.confidence * 100)}%) — below the confidence gate, so nothing is registered.</span>`;
}

/* ---------- views ---------- */
function glossList() {
  const t = T(), reuse = S.vocab.reuse || {}, mc = S.model ? S.model.glossCounts() : {};
  const total = S.vocab.glosses.length;
  const have = S.vocab.glosses.filter(g => (t.counts[g.id] || 0) >= GOOD || reuse[g.id]).length;
  const groups = CAT_ORDER.map(c => ({ c, items: S.vocab.glosses.filter(g => g.cat === c) })).filter(x => x.items.length);
  return `<aside class="tglist card"><div class="qhead"><h3>Signs</h3><span class="small muted">${have} of ${total} ready</span></div>
    <div class="qscroll">${groups.map(gr => `<div class="tgcat">${CAT_NAMES[gr.c] ? CAT_NAMES[gr.c][0] : gr.c}</div>${gr.items.map(g => {
      const n = t.counts[g.id] || 0, re = !!reuse[g.id], inModel = (mc[g.id] || 0) > 0;
      const badge = re ? `<span class="tgb re" title="Reused from your restaurant model">reused${n ? ' +' + n : ''}</span>` : n >= GOOD ? `<span class="tgb ok">${n}</span>` : n ? `<span class="tgb warn">${n}</span>` : `<span class="tgb none">0</span>`;
      return `<button class="tg ${t.gloss === g.id ? 'sel' : ''}" data-act="tg" data-g="${g.id}"><span class="tgn"><b>${esc(g.en)}</b><span class="ur" lang="ur" dir="rtl">${esc(g.ur)}</span></span>${badge}${inModel ? '' : '<span class="tgdot" title="Not in the trained model yet"></span>'}</button>`;
    }).join('')}`).join('')}</div></aside>`;
}
function recPanel() {
  const t = T(), r = t.rec, g = S.glossById[t.gloss]; if (!g) return '';
  const busy = r.state !== 'idle', n = t.counts[t.gloss] || 0, reused = !!(S.vocab.reuse || {})[t.gloss];
  let status = '';
  if (r.state === 'countdown') status = `<div class="recbig">${r.left}</div>`;
  else if (r.state === 'capturing') status = `<div class="recbig rec">${ic('rec', 30)} Signing…</div>`;
  else if (r.state === 'saving') status = `<div class="recbig"><span class="spin"></span> Saving…</div>`;
  const camBtn = cam.state === 'off' ? `<button class="btn primary" data-act="camOn">${ic('cam', 16)} Turn on camera</button>`
    : cam.state === 'starting' ? `<span class="muted"><span class="spin"></span> Starting camera…</span>`
    : cam.state === 'error' ? `<div class="micnote">${ic('info', 14)}<span>${esc(cam.error)}</span></div><button class="btn" data-act="camOn">Try again</button>` : '';
  return `<section class="card trec"><div class="trhead"><div><div class="muted small">Recording sign</div><div class="trname"><b>${esc(g.en)}</b> <span class="ur" lang="ur" dir="rtl">${esc(g.ur)}</span></div></div>
      <div class="muted small tright">${n} recorded${reused ? ' · plus restaurant exemplars' : ''}${n < GOOD && !reused ? ` · aim for ${TARGET}` : ''}</div></div>
    <div class="trcam"><div class="camwrap" data-camslot></div>${status ? `<div class="recover">${status}</div>` : ''}</div>
    <div class="trctl">${cam.state === 'on' || window.__SS_TEST ? `
      <button class="btn primary" data-act="rec1" ${busy ? 'disabled' : ''}>${ic('rec', 14)} Record 1</button>
      <button class="btn" data-act="recN" ${busy ? 'disabled' : ''}>Auto × ${TARGET}</button>
      ${busy && r.state !== 'saving' ? `<button class="btn" data-act="stopRec">${ic('stop', 14)} Stop</button>` : ''}` : camBtn}
      <span class="muted small sp">Hold the sign steady inside the frame, one hand. Small changes in position between takes make recognition more robust.</span></div>
    ${r.msg ? `<div class="micnote">${ic('info', 14)}<span>${esc(r.msg)}</span></div>` : ''}</section>`;
}
function samplesPanel() {
  const t = T();
  return `<div class="card tsamples"><div class="qhead"><h3>Recordings</h3>${t.samples.length ? `<button class="linkbtn" data-act="delAll">Delete all for this sign</button>` : ''}</div>
    <div class="qscroll">${t.samples.map(s => `<div class="smp"><span class="mono">${esc(s.id)}</span><span class="muted small">${s.frames.length} frames</span><button class="tokx" data-act="delSample" data-id="${esc(s.id)}" aria-label="Delete ${esc(s.id)}">${ic('trash', 13)}</button></div>`).join('') || '<div class="muted small" style="padding:6px">No recordings yet for this sign.</div>'}</div></div>`;
}
function modelPanel() {
  const t = T(), ev = t.evalRes, busy = !!t.busy, m = S.model;
  const reuse = S.vocab.reuse || {};
  const missing = S.vocab.glosses.filter(g => !(m && m.glossCounts()[g.id] > 0)).length;
  const evHtml = ev ? `<div class="evres"><div class="evbig"><div><b>${Math.round(ev.top1 * 100)}%</b><small>correct</small></div><div><b>${Math.round(ev.precision * 100)}%</b><small>correct when it answers</small></div><div><b>${Math.round(ev.coverage * 100)}%</b><small>answered</small></div></div>
      <div class="muted small">Leave-one-recording-out on ${ev.samples} of your recordings. ${Object.entries(ev.perGloss).filter(([, v]) => v.ok / v.n < 0.7).map(([g, v]) => `${esc((S.glossById[g] || { en: g }).en)} ${v.ok}/${v.n}`).join(', ') || 'No weak signs.'}</div>
      ${ev.confusions.length ? `<div class="muted small">Most confused: ${ev.confusions.slice(0, 3).map(([k, n]) => `${esc(k.split(' → ').map(x => (S.glossById[x] || { en: x }).en).join(' → '))} (${n})`).join('; ')}</div>` : ''}</div>` : '';
  const tst = t.test;
  return `<div class="card tmodel"><div class="qhead"><h3>Model</h3><span class="small muted">${m ? `${m.glosses.length} signs · ${m.n} exemplars` : 'loading…'}</span></div>
    <div class="trow"><button class="btn primary" data-act="train" ${busy ? 'disabled' : ''}>Train model</button><button class="btn" data-act="check" ${busy ? 'disabled' : ''}>Check accuracy</button></div>
    ${busy ? `<div class="muted small"><span class="spin"></span> <span id="trainBusy">${esc(t.busy)}</span></div>` : ''}
    ${t.note ? `<div class="muted small">${esc(t.note)}</div>` : `<div class="muted small">${missing ? `${missing} signs are not in the model yet (dot in the list).` : 'Every sign is in the model.'}</div>`}
    ${evHtml}
    <div class="trow"><button class="btn ${tst.on ? 'primary' : ''}" data-act="testToggle" ${cam.state === 'on' || window.__SS_TEST ? '' : 'disabled'}>${tst.on ? 'Stop live test' : 'Live test'}</button><button class="linkbtn" data-act="resetModel">Reset to restaurant signs only</button></div>
    ${tst.on ? `<div id="testHint" class="livehint"></div><div class="testlog">${tst.log.map(x => { const g = S.glossById[x.gloss] || { en: x.gloss, ur: '' }; return `<span class="tok"><b>${esc(g.en)}</b><span class="ur" lang="ur" dir="rtl">${esc(g.ur)}</span><small>${Math.round(x.conf * 100)}%</small></span>`; }).join('') || '<span class="muted small">Sign something — recognised signs appear here.</span>'}</div>` : ''}</div>`;
}
export function trainView() {
  return `<div class="staff trainer"><div class="shead"><h2>Train signs</h2><span class="muted small">Record each sign yourself, then train. Works like your VIBETALK pipeline: MediaPipe hand landmarks → 12-frame sequence → DTW nearest-neighbour. Saved in <span class="mono">data/dataset</span> and <span class="mono">data/models</span>.</span></div>
    <div class="tws">${glossList()}${recPanel()}<div class="tright2">${samplesPanel()}${modelPanel()}</div></div></div>`;
}

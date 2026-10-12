/* Shared state, helpers and server connection. */
import { DTWModel } from './slr.js';
import { Camera } from './hand.js';

export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const fmtDT = t => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtT = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const urlParam = k => new URLSearchParams(location.search).get(k);
export const hasArabic = s => /[؀-ۿ]/.test(s || '');

export const I = {
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  cam: '<path d="M3 8a2 2 0 012-2h9a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M16 10l5-3v10l-5-3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z"/>',
  hand: '<path d="M8 13V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7.5c0 4-2.5 7-6 7-2.5 0-4-1.5-5.5-4L4 13.5a1.5 1.5 0 012.5-1.5L8 14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  gauge: '<path d="M4 17a8 8 0 1116 0"/><path d="M12 17l4-5"/>',
  plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  msg: '<path d="M4 5h16v11H10l-6 4z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  rec: '<circle cx="12" cy="12" r="7" fill="currentColor"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 12"/>',
};
export const ic = (n, s = 20) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;
export const bl = (en, ur) => `<span class="bl"><span>${en}</span><span class="ur" lang="ur" dir="rtl">${ur}</span></span>`;
export const bi = (en, ur, cls = '') => `<div class="bi ${cls}"><div class="lang en" lang="en"><span class="tag">English</span><p>${en}</p></div><div class="lang ur" lang="ur" dir="rtl"><span class="tag">اردو</span><p>${ur}</p></div></div>`;

/* ---------- application state ---------- */
export const S = {
  vocab: null, glossById: {}, model: null, modelInfo: null,
  sessions: [], conn: 'connecting', toast: null,
  mode: 'patient',
  sys: { patient: 'idle', staff: 'idle' },
  patient: { stage: 'welcome', qi: 0, sessionId: null, tokens: [], picker: false, pickerCat: null, bannerNote: '', live: null, handNote: '' },
  staff: { tab: 'live', selectedId: null, sumOpen: false, q: '', urg: 'all', dept: 'all', page: 0, open: false, modal: false, draft: '', speech: 'idle', interim: '', micNote: '' },
  train: { gloss: null, counts: {}, samples: [], rec: { state: 'idle', n: 0, left: 0, msg: '' }, busy: '', evalRes: null, test: { live: null, log: [] }, trainedAt: null },
};
export const hooks = { render: () => {}, camera: null };
export const render = () => hooks.render();

export const cam = new Camera();

export const getS = id => S.sessions.find(s => s.id === id);
export const activeSession = () => getS(S.patient.sessionId);
export function upsertSession(s) {
  const i = S.sessions.findIndex(x => x.id === s.id);
  if (i >= 0) S.sessions[i] = s; else S.sessions.unshift(s);
  S.sessions.sort((a, b) => b.startedAt - a.startedAt);
}
export function setSys(k, v) { S.sys[k] = v; }

let toastT = null;
export function toast(msg, kind = 'warn') {
  S.toast = { msg, kind }; render();
  clearTimeout(toastT); toastT = setTimeout(() => { S.toast = null; render(); }, 6000);
}

/* ---------- server API ---------- */
export async function api(path, method = 'GET', body) {
  try {
    const r = await fetch(path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  } catch (e) {
    toast(`Server problem: ${e.message}. Is "node server.js" still running?`);
    throw e;
  }
}

export async function loadModel() {
  const doc = await (await fetch('/api/model')).json();
  S.model = DTWModel.fromJSON(doc);
  S.modelInfo = { trained_at: doc.trained_at, glosses: doc.glosses, counts: S.model.glossCounts() };
  return S.model;
}

/* which vocabulary glosses can the current model actually recognise? */
export function trainedSet() { return new Set(S.model ? S.model.glosses.filter(g => (S.model.glossCounts()[g] || 0) > 0) : []); }

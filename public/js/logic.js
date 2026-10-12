/* Triage logic (no DOM): questions, turning recognised signs into structured answers,
 * rule-based urgency + routing, and real-time doctor availability.
 * Everything here is deterministic and inspectable — it is NOT an LLM, and it never invents data. */

export const QUESTIONS = [
  { id: 'location', label: 'Location', en: 'Where is the pain or problem?', ur: 'درد یا تکلیف کہاں ہے؟',
    hint: ['Sign the body part.', 'جسم کا حصہ اشارے سے بتائیں۔'], allow: ['body'] },
  { id: 'duration', label: 'Duration', en: 'How long have you had this problem?', ur: 'یہ تکلیف آپ کو کتنے عرصے سے ہے؟',
    hint: ['Sign a number, then hour / day / week / month. Or sign "today" / "yesterday".', 'عدد، پھر گھنٹہ / دن / ہفتہ / مہینہ۔ یا "آج" / "کل"۔'], allow: ['number', 'time'] },
  { id: 'severity', label: 'Severity', en: 'How bad is it? Mild, moderate, or severe?', ur: 'تکلیف کتنی زیادہ ہے؟ ہلکی، درمیانی یا شدید؟',
    hint: ['Sign mild, moderate or severe.', 'ہلکی، درمیانی یا شدید کا اشارہ کریں۔'], allow: ['severity'] },
  { id: 'other', label: 'Other symptoms', en: 'Do you have any other symptoms?', ur: 'کیا آپ کو کوئی اور علامات بھی ہیں؟',
    hint: ['Sign each symptom, or "no" if none.', 'ہر علامت کا اشارہ کریں، یا کوئی نہیں تو "نہیں"۔'], allow: ['symptom', 'answer'] }
];

export const CONTROL = ['confirm', 'cancel'];
export const urNum = n => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const dedupe = a => [...new Set(a)];

/** Glosses the recogniser may accept for a question (controls are always allowed). */
export function allowedGlosses(vocab, qid) {
  const q = QUESTIONS.find(x => x.id === qid);
  const cats = q ? q.allow : null;
  return new Set(vocab.glosses.filter(g => CONTROL.includes(g.id) || !cats || cats.includes(g.cat)).map(g => g.id));
}
/** For the doctor-reply phase: any content word, plus controls. */
export function replyGlosses(vocab) { return new Set(vocab.glosses.map(g => g.id)); }

const joinEn = a => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
const joinUr = a => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join('، ') + ' اور ' + a[a.length - 1];

const REGION = { head: 'head', ear: 'ear', throat: 'throat', chest: 'chest', stomach: 'abdomen', back: 'back', arm: 'limb', leg: 'limb', knee: 'limb' };
const FLAG = { breathless: 'dyspnea', sweating: 'diaphoresis', vomiting: 'vomiting', bleeding: 'bleeding', fever: 'fever', dizzy: 'dizziness', cough: 'cough', weakness: 'weakness' };

/**
 * Turn the signs recognised for one question into a structured answer.
 * Returns null while the signs are not yet a complete answer.
 */
export function buildAnswer(qid, tokens, vocab) {
  const G = id => vocab.glosses.find(g => g.id === id);
  const t = tokens.map(x => x.gloss);
  const conf = tokens.length ? tokens.reduce((a, x) => a + x.confidence, 0) / tokens.length : 0;
  if (qid === 'location') {
    const parts = dedupe(t).map(G).filter(g => g && g.cat === 'body');
    if (!parts.length) return null;
    return {
      en: `Pain in ${joinEn(parts.map(p => p.obj_en))}`, ur: `${joinUr(parts.map(p => p.obj_ur))} میں درد`,
      clin: `pain in ${joinEn(parts.map(p => p.obj_en))}`.replace(/the /g, ''), gloss: parts.map(p => p.id.toUpperCase()), conf,
      tags: { region: REGION[parts[0].id], regions: dedupe(parts.map(p => REGION[p.id])), parts: parts.map(p => p.id) },
    };
  }
  if (qid === 'duration') {
    const rel = t.map(G).find(g => g && g.cat === 'time' && !g.unit_en);
    if (rel && !t.map(G).some(g => g && g.unit_en)) {
      return { en: rel.en, ur: rel.ur, clin: rel.id === 'today' ? 'since today' : 'since yesterday', gloss: [rel.id.toUpperCase()], conf, tags: { unit: rel.id, n: rel.id === 'today' ? 0 : 1 } };
    }
    const unit = t.map(G).find(g => g && g.unit_en);
    if (!unit) return null;                                       // a number alone is not yet a duration
    const num = t.map(G).filter(g => g && g.cat === 'number').pop();
    const n = num ? num.n : 1;
    const en = `${n} ${unit.unit_en[n === 1 ? 0 : 1]}`;
    return { en: cap(en), ur: `${urNum(n)} ${unit.unit_ur} سے`, clin: en, gloss: [...(num ? [num.id.toUpperCase()] : []), unit.id.toUpperCase()], conf, tags: { unit: unit.id, n } };
  }
  if (qid === 'severity') {
    const s = t.map(G).find(g => g && g.cat === 'severity');
    if (!s) return null;
    return { en: s.en, ur: s.ur, clin: s.id, gloss: [s.id.toUpperCase()], conf, tags: { level: s.id } };
  }
  if (qid === 'other') {
    const sy = dedupe(t).map(G).filter(g => g && g.cat === 'symptom');
    if (sy.length) {
      return { en: joinEn(sy.map(s => s.en)), ur: joinUr(sy.map(s => s.ur)), clin: joinEn(sy.map(s => s.clin)), gloss: sy.map(s => s.id.toUpperCase()), conf, tags: { flags: sy.map(s => FLAG[s.id]) } };
    }
    if (t.includes('no')) return { en: 'No other symptoms', ur: 'کوئی اور علامات نہیں', clin: 'no other symptoms reported', gloss: ['NO'], conf, tags: { flags: [] } };
    return null;
  }
  return null;
}

/** Free reply to a doctor's message: the signed words, shown as a word sequence (no invented grammar). */
export function buildReply(tokens, vocab) {
  const G = id => vocab.glosses.find(g => g.id === id);
  const gl = tokens.map(x => G(x.gloss)).filter(g => g && !CONTROL.includes(g.id));
  if (!gl.length) return null;
  const conf = tokens.reduce((a, x) => a + x.confidence, 0) / tokens.length;
  return { en: gl.map(g => g.en).join(', '), ur: gl.map(g => g.ur).join('، '), gloss: gl.map(g => g.id.toUpperCase()), conf, clin: gl.map(g => g.en.toLowerCase()).join(', '), tags: {} };
}

/* ---------- departments and doctors ---------- */

export const REGION_DEPT = { chest: 'Internal Medicine', head: 'Internal Medicine', abdomen: 'General Surgery', ear: 'ENT', throat: 'ENT', back: 'Orthopedics', limb: 'Orthopedics', general: 'General Surgery' };
const DEPT_PRIORITY = ['chest', 'head', 'abdomen', 'throat', 'ear', 'back', 'limb'];
export const DEPT_UR = { 'Internal Medicine': 'شعبہ امراضِ باطنی', 'Orthopedics': 'آرتھوپیڈکس', 'ENT': 'کان، ناک اور گلے کا شعبہ', 'General Surgery': 'جنرل سرجری', 'Emergency Medicine': 'ایمرجنسی' };

/* Real physicians and published weekly clinic hours from a public hospital directory
   (https://rimstrauma.net/doctor.html), a few per department. Availability is never invented:
   it is computed live from these published slots (see doctorStatus). Replace with your own
   hospital's roster before real use. */
export const DOCTORS = [
  { id: 'd1', name: 'Dr. Vikash Singh', dept: 'Orthopedics', specialty: 'Orthopedic Surgeon', qual: 'FCPS (Orthopaedic Surgery), MRCS (Edin), AO-Spine Fellowship (Germany)', slots: [{ days: ['Tue', 'Thu', 'Sat'], start: '21:00', end: '22:00' }] },
  { id: 'd2', name: 'Dr. S M Azfar', dept: 'Orthopedics', specialty: 'Orthopedic Surgeon', slots: [{ days: ['Mon', 'Wed', 'Fri'], start: '19:00', end: '20:00' }] },
  { id: 'd3', name: 'Dr. Naveed Khan', dept: 'Orthopedics', specialty: 'Orthopedic Surgeon', slots: [{ days: ['Wed'], start: '09:00', end: '10:00' }] },
  { id: 'd4', name: 'Dr. M. Asif Peracha', dept: 'Orthopedics', specialty: 'Orthopedic Surgeon', qual: 'MBBS, FCPS (Orth & Trauma), FRCS (Glasgow), FACS (USA)', slots: [{ days: ['Mon'], start: '18:30', end: '19:30' }, { days: ['Thu'], start: '16:00', end: '17:00' }] },
  { id: 'd5', name: 'Dr. Asif Ali Arain', dept: 'ENT', specialty: 'ENT Specialist', slots: [{ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], start: '20:00', end: '21:00' }] },
  { id: 'd6', name: 'Dr. Abdul Razzak Doggar', dept: 'ENT', specialty: 'ENT Specialist', slots: [{ days: ['Mon', 'Wed', 'Fri'], start: '14:30', end: '15:30' }] },
  { id: 'd7', name: 'Dr. Muntazir Hussain', dept: 'ENT', specialty: 'ENT Specialist', slots: [{ days: ['Mon'], start: '15:30', end: '16:00' }] },
  { id: 'd8', name: 'Dr. Kamal Ahmed', dept: 'Internal Medicine', specialty: 'Physician', slots: [{ days: ['Mon', 'Fri'], start: '20:30', end: '21:30' }] },
  { id: 'd9', name: 'Dr. Sajid Abbas Jaffri', dept: 'Internal Medicine', specialty: 'Physician', slots: [{ days: ['Tue', 'Thu', 'Sat'], start: '13:00', end: '15:00' }] },
  { id: 'd10', name: 'Dr. Malika Tharani', dept: 'Internal Medicine', specialty: 'Physician', slots: [{ days: ['Mon', 'Wed', 'Fri'], start: '13:00', end: '15:00' }] },
  { id: 'd11', name: 'Dr. Jetender Maheswari', dept: 'Internal Medicine', specialty: 'Physician', slots: [{ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], start: '17:00', end: '19:00' }] },
  { id: 'd12', name: 'Dr. Muhammad Muneer', dept: 'General Surgery', specialty: 'General Surgeon', qual: 'MBBS, FCPS, FRCS (UK)', slots: [{ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Sat'], start: '11:00', end: '14:00' }] },
  { id: 'd13', name: 'Dr. Ghansham Rawtani', dept: 'General Surgery', specialty: 'General Surgeon', qual: 'MBBS, MRCPS, FCPS, FACS, CHPE, ICMT', slots: [{ days: ['Mon', 'Wed', 'Fri'], start: '18:00', end: '19:00' }] },
  { id: 'd14', name: 'Dr. Farah Shah', dept: 'General Surgery', specialty: 'General Surgeon', slots: [{ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], start: '21:00', end: '22:00' }] },
  { id: 'd15', name: 'Dr. Syed Shafqat', dept: 'General Surgery', specialty: 'General Surgeon', slots: [{ days: ['Mon', 'Wed', 'Fri'], start: '14:00', end: '16:00' }] },
  { id: 'd16', name: 'Dr. Salah Ud Din', dept: 'Emergency Medicine', specialty: 'General Surgeon · on-call team', onCall: true, slots: [] },
  { id: 'd17', name: 'Dr. Madiha Masood', dept: 'Emergency Medicine', specialty: 'General Surgeon · on-call team', onCall: true, slots: [] },
  { id: 'd18', name: 'Dr. Kazim Rahim, MD', dept: 'Emergency Medicine', specialty: 'Orthopedic Surgeon · on-call team', onCall: true, slots: [] },
  { id: 'd19', name: 'Dr. Saad Akhter', dept: 'Emergency Medicine', specialty: 'Neurosurgeon · on-call team', onCall: true, slots: [] }
];
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_FULL = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
export function karachiNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const m = {}; parts.forEach(p => m[p.type] = p.value);
  return { wd: m.weekday, hm: (m.hour === '24' ? '00' : m.hour) + ':' + m.minute };
}
function fmt12(hm) { const [h, mn] = hm.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; let hh = h % 12; if (hh === 0) hh = 12; return `${hh}:${String(mn).padStart(2, '0')} ${ap}`; }
function nextSlot(doc, now) {
  const idx = WEEK.indexOf(now.wd);
  for (let i = 0; i < 8; i++) {
    const wd = WEEK[(idx + i) % 7];
    const todays = doc.slots.filter(s => s.days.includes(wd)).sort((a, b) => a.start.localeCompare(b.start));
    for (const s of todays) { if (i === 0 && s.start <= now.hm) continue; return { wd, slot: s, daysAhead: i }; }
  }
  return null;
}
export function doctorStatus(doc, now = karachiNow()) {
  if (doc.onCall) return { state: 'oncall', en: 'On call now', ur: 'اس وقت کال پر دستیاب' };
  for (const s of doc.slots) if (s.days.includes(now.wd) && now.hm >= s.start && now.hm < s.end) return { state: 'now', en: `In clinic now · until ${fmt12(s.end)}`, ur: 'اس وقت کلینک میں موجود' };
  const nx = nextSlot(doc, now);
  if (!nx) return { state: 'unknown', en: 'No published schedule', ur: 'شیڈول دستیاب نہیں' };
  const when = nx.daysAhead === 0 ? `today ${fmt12(nx.slot.start)}` : nx.daysAhead === 1 ? `tomorrow ${fmt12(nx.slot.start)}` : `${WEEK_FULL[nx.wd]} ${fmt12(nx.slot.start)}`;
  return { state: 'next', en: `Next in clinic: ${when}`, ur: `اگلی دستیابی: ${when}` };
}
export function pickDoctor(dept, now = karachiNow()) {
  const l = DOCTORS.filter(d => d.dept === dept);
  if (!l.length) return null;
  const rank = st => st.state === 'now' ? 0 : st.state === 'oncall' ? 1 : st.state === 'next' ? 2 : 3;
  return l.map(d => ({ d, st: doctorStatus(d, now) })).sort((a, b) => rank(a.st) - rank(b.st))[0].d.id;
}

/* ---------- summary + urgency (rule-based) ---------- */

export function summarize(qa, opts = {}) {
  const m = Object.fromEntries(qa.map(x => [x.qid, x]));
  const g = k => m[k] ? m[k].clin : null, na = 'not obtained';
  const conf = qa.length ? qa.reduce((a, x) => a + x.conf, 0) / qa.length : null;
  const parts = [];
  if (g('location')) parts.push(`Patient presents with ${g('location')}` + (g('duration') ? ` for ${g('duration').replace(/^since /, 'since ')}` : '') + (g('severity') ? `, reported as ${g('severity')}` : '') + '.');
  if (g('other')) parts.push(`Associated symptoms: ${g('other')}.`);
  if (opts.emergency) parts.unshift('Patient activated the emergency alert on the kiosk; the triage questionnaire was bypassed.');
  parts.push('History obtained through sign-language recognition (limited vocabulary, patient-confirmed). Please confirm key details with the patient.');
  return { chief: cap(g('location') || na), duration: g('duration') || na, severity: cap(g('severity') || na), associated: cap(g('other') || na), confidence: conf, narrative: parts.join(' ') };
}
export function classify(qa, emergency) {
  const tags = x => (qa.find(a => a.qid === x) || { tags: {} }).tags;
  const regions = tags('location').regions || (tags('location').region ? [tags('location').region] : []);
  const level = tags('severity').level, flags = tags('other').flags || [];
  const reasons = [];
  if (emergency) reasons.push('Patient pressed the emergency button');
  const chest = regions.includes('chest');
  if (chest && level === 'severe') reasons.push('Severe chest pain, possible acute cardiac event');
  if (chest && flags.includes('dyspnea')) reasons.push('Chest pain with shortness of breath');
  if (chest && flags.includes('diaphoresis')) reasons.push('Chest pain with sweating (diaphoresis)');
  if (flags.includes('dyspnea') && !chest) reasons.push('Reports difficulty breathing');
  if (flags.includes('bleeding') && level === 'severe') reasons.push('Severe symptoms with bleeding');
  if (!reasons.length && level === 'severe') reasons.push('Severe pain reported');
  const critical = reasons.length > 0;
  const region = DEPT_PRIORITY.find(r => regions.includes(r)) || 'general';
  return {
    level: critical ? 'critical' : 'non-urgent',
    reasons: critical ? reasons : [`No red-flag symptoms identified. Reported severity: ${level || 'not stated'}.`],
    department: emergency ? 'Emergency Medicine' : (critical && (chest || flags.includes('dyspnea')) ? 'Internal Medicine' : REGION_DEPT[region]),
    wait: critical ? 'Immediate' : 'About 15 minutes'
  };
}

/* ---------- doctor notifications ---------- */
export const notifEntry = (s, id) => (s.notifiedDoctors || []).find(n => n.id === id) || (s.notified && s.doctorId === id ? { id, at: null } : null);
export const isNotified = (s, id) => !!notifEntry(s, id);
export const ackAt = (s, id) => (s.ack || {})[id] || null;

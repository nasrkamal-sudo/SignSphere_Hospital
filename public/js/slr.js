/* Sign-language recognition core (no DOM, runs in the browser and in Node tests).
 *
 * This is a JavaScript port of the pipeline from the VIBETALK project
 * (ai/signsphere_ai/slr): wrist-centred + scale-normalised 63-value hand
 * landmark frames -> resampled to 12 frames -> dynamic-time-warping
 * 1-nearest-neighbour with a relative-margin confidence gate. Frames that
 * do not clear the gate return nothing: the recogniser never guesses.
 * Models trained with VIBETALK's Python scripts load here unchanged. */

export const NUM_LANDMARKS = 21;
export const FEATURE_DIM = 63;
export const SEQ_LENGTH = 12;
export const DEFAULTS = { threshold: 0.6, marginMidpoint: 0.13, marginScale: 0.05 };

/* ---------- preprocessing ---------- */

/** 21 x [x,y,z] -> 63-value vector, wrist-centred and divided by the largest wrist-to-joint distance. */
export function normalizeLandmarks(lm, mirror = false) {
  if (!lm || lm.length !== NUM_LANDMARKS) throw new Error(`Expected ${NUM_LANDMARKS} landmarks`);
  const w = lm[0], wx = w.x ?? w[0], wy = w.y ?? w[1], wz = w.z ?? w[2] ?? 0;
  const pts = new Array(NUM_LANDMARKS);
  let scale = 0;
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const p = lm[i];
    const x = (p.x ?? p[0]) - wx, y = (p.y ?? p[1]) - wy, z = (p.z ?? p[2] ?? 0) - wz;
    pts[i] = [x, y, z];
    const d = Math.sqrt(x * x + y * y + z * z);
    if (d > scale) scale = d;
  }
  if (scale <= 1e-9) throw new Error('Degenerate hand');
  const out = new Array(FEATURE_DIM);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    out[i * 3] = (mirror ? -pts[i][0] : pts[i][0]) / scale;
    out[i * 3 + 1] = pts[i][1] / scale;
    out[i * 3 + 2] = pts[i][2] / scale;
  }
  return out;
}

/** Linear resample of a list of feature frames to exactly `length` frames. */
export function resampleSequence(seq, length = SEQ_LENGTH) {
  const n = seq.length;
  if (!n) throw new Error('Cannot resample an empty sequence');
  if (n === length) return seq.map(f => f.slice());
  const dim = seq[0].length, out = [];
  for (let i = 0; i < length; i++) {
    const pos = length > 1 ? i * (n - 1) / (length - 1) : 0;
    const lo = Math.floor(pos), hi = Math.min(lo + 1, n - 1), wgt = pos - lo;
    const f = new Array(dim);
    for (let d = 0; d < dim; d++) f[d] = (1 - wgt) * seq[lo][d] + wgt * seq[hi][d];
    out.push(f);
  }
  return out;
}

/* seeded RNG so a trained artefact is reproducible */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Jittered / mirrored copies of each (label, sequence); the real sequence is always kept. */
export function augmentPairs(pairs, { factor = 2, sigma = 0.03, mirror = true, seed = 20260830 } = {}) {
  const out = pairs.map(([label, seq]) => [label, seq.map(f => f.slice())]);
  if (factor <= 0) return out;
  const rng = mulberry32(seed);
  for (const [label, seq] of pairs) {
    for (let k = 0; k < factor; k++) {
      const flip = mirror && k % 2 === 1;
      out.push([label, seq.map(frame => frame.map((v, i) => {
        let c = flip && i % 3 === 0 ? -v : v;
        if (sigma) c += gauss(rng) * sigma;
        return c;
      }))]);
    }
  }
  return out;
}

/* ---------- DTW 1-NN classifier ---------- */

export class DTWModel {
  /** sequences: { gloss: [ [frame(63)] x seqLength ] ... } */
  constructor({ glosses, sequences, seqLength = SEQ_LENGTH, threshold = DEFAULTS.threshold,
                marginMidpoint = DEFAULTS.marginMidpoint, marginScale = DEFAULTS.marginScale, meta = {} }) {
    this.glosses = glosses.slice();
    this.seqLength = seqLength;
    this.threshold = threshold;
    this.marginMidpoint = marginMidpoint;
    this.marginScale = marginScale;
    this.meta = meta;
    this.sequences = sequences;
    this._build();
  }
  _build() {
    const rows = [], owner = [], srcOf = [];
    for (const g of this.glosses) for (const s of (this.sequences[g] || [])) { rows.push(s); owner.push(g); srcOf.push(s.src ?? -1); }
    this.owner = owner; this.srcOf = srcOf;
    this.n = rows.length;
    this.flat = new Float32Array(this.n * this.seqLength * FEATURE_DIM);
    rows.forEach((s, i) => {
      for (let t = 0; t < this.seqLength; t++) this.flat.set(s[t], (i * this.seqLength + t) * FEATURE_DIM);
    });
  }
  get ready() { return this.n > 0 && new Set(this.owner).size >= 2; }
  glossCounts() {
    const c = {};
    for (const g of this.owner) c[g] = (c[g] || 0) + 1;
    return c;
  }

  /** frames: array of normalised 63-value frames (any length >= 1). */
  classify(frames, { exclude = null } = {}) {
    if (!this.ready) return { gloss: null, confidence: 0, accepted: false, distances: {} };
    const T = this.seqLength, D = FEATURE_DIM;
    const q = resampleSequence(frames, T);
    const qf = new Float32Array(T * D);
    q.forEach((f, t) => qf.set(f, t * D));
    const nearest = new Map();
    const cost = new Float32Array(T * T), prev = new Float32Array(T + 1), cur = new Float32Array(T + 1);
    for (let e = 0; e < this.n; e++) {
      if (exclude !== null && this.srcOf[e] === exclude) continue;   // leave-one-recording-out
      const base = e * T * D;
      for (let i = 0; i < T; i++) {
        const qi = i * D;
        for (let j = 0; j < T; j++) {
          const ej = base + j * D;
          let s = 0;
          for (let d = 0; d < D; d++) { const x = qf[qi + d] - this.flat[ej + d]; s += x * x; }
          cost[i * T + j] = Math.sqrt(s);
        }
      }
      prev.fill(Infinity); prev[0] = 0;
      for (let i = 1; i <= T; i++) {
        cur.fill(Infinity);
        for (let j = 1; j <= T; j++) {
          const m = Math.min(prev[j], cur[j - 1], prev[j - 1]);
          cur[j] = cost[(i - 1) * T + (j - 1)] + m;
        }
        prev.set(cur);
      }
      const dist = prev[T], g = this.owner[e];
      if (!nearest.has(g) || dist < nearest.get(g)) nearest.set(g, dist);
    }
    const ranked = [...nearest.entries()].sort((a, b) => a[1] - b[1]);
    const [g0, d0] = ranked[0];
    const d1 = ranked.length > 1 ? ranked[1][1] : d0 + 1;
    const rel = (d1 - d0) / (d1 + d0 + 1e-9);
    const confidence = 1 / (1 + Math.exp(-(rel - this.marginMidpoint) / this.marginScale));
    return {
      gloss: g0, confidence, accepted: confidence >= this.threshold,
      runnerUp: ranked.length > 1 ? ranked[1][0] : null,
      distances: Object.fromEntries(ranked.slice(0, 4)),
    };
  }

  /** VIBETALK-compatible artefact (loadable by its Python `load_model`). */
  toJSON() {
    const round = s => s.map(fr => fr.map(v => Math.round(v * 1e4) / 1e4));
    const seqs = {};
    for (const g of this.glosses) if (this.sequences[g]) seqs[g] = this.sequences[g].map(round);
    return {
      model_type: 'dtw', vocabulary: this.meta.vocabulary || 'hospital-triage-v1',
      variant: this.meta.variant || 'signsphere-hospital-v1',
      threshold: this.threshold, feature_dim: FEATURE_DIM,
      glosses: this.glosses.filter(g => seqs[g] && seqs[g].length),
      trained_at: new Date().toISOString(),
      payload: { seq_length: this.seqLength, margin_midpoint: this.marginMidpoint, margin_scale: this.marginScale, sequences: seqs },
    };
  }
  static fromJSON(doc) {
    const p = doc.payload || {};
    return new DTWModel({
      glosses: doc.glosses, sequences: p.sequences || {}, seqLength: p.seq_length || SEQ_LENGTH,
      threshold: doc.threshold ?? DEFAULTS.threshold,
      marginMidpoint: p.margin_midpoint ?? DEFAULTS.marginMidpoint,
      marginScale: p.margin_scale ?? DEFAULTS.marginScale,
      meta: { vocabulary: doc.vocabulary, variant: doc.variant },
    });
  }
}

/** Build a model from raw recorded samples: { gloss: [ { frames: [[x,y,z]x21, ...] }, ... ] }. */
export function trainFromSamples(samplesByGloss, { augment = 2, sigma = 0.03, mirror = true, threshold = DEFAULTS.threshold, extraSequences = {}, meta = {} } = {}) {
  const pairs = [], evalSet = [];
  let src = 0;
  for (const [gloss, samples] of Object.entries(samplesByGloss)) {
    for (const s of samples) {
      const feats = [];
      for (const fr of s.frames) { try { feats.push(normalizeLandmarks(fr)); } catch { /* skip degenerate frame */ } }
      if (feats.length >= 4) {
        const seq = resampleSequence(feats, SEQ_LENGTH);
        seq.src = src; pairs.push([gloss, seq]); evalSet.push({ label: gloss, seq, src }); src++;
      }
    }
  }
  const aug = augmentPairs(pairs, { factor: augment, sigma, mirror });
  // augmented copies inherit the id of the recording they came from
  let k = 0;
  const sequences = {};
  const origin = []; pairs.forEach(([, seq]) => { origin.push(seq.src); });
  aug.forEach(([g, seq], i) => {
    // augmentPairs returns the originals first (same order), then `factor` variants per original
    const o = i < pairs.length ? pairs[i][1].src : origin[Math.floor((i - pairs.length) / Math.max(augment, 1))];
    seq.src = o; (sequences[g] ||= []).push(seq); k++;
  });
  // exemplars imported from an already-trained model (already augmented there)
  for (const [g, seqs] of Object.entries(extraSequences)) sequences[g] = (sequences[g] || []).concat(seqs);
  const model = new DTWModel({ glosses: Object.keys(sequences), sequences, threshold, meta });
  model.evalSet = evalSet;
  return model;
}

/** Leave-one-recording-out check on your own recordings: how often the right sign wins, and how often it clears the gate. */
export async function evaluateLOO(model, onProgress) {
  const set = model.evalSet || [];
  const per = {}; const confusion = {};
  let correct = 0, accepted = 0, acceptedCorrect = 0;
  for (let i = 0; i < set.length; i++) {
    const { label, seq, src } = set[i];
    const r = model.classify(seq, { exclude: src });
    const ok = r.gloss === label;
    (per[label] ||= { n: 0, ok: 0, acc: 0 }); per[label].n++;
    if (ok) { correct++; per[label].ok++; } else { const key = `${label} → ${r.gloss}`; confusion[key] = (confusion[key] || 0) + 1; }
    if (r.accepted) { accepted++; per[label].acc++; if (ok) acceptedCorrect++; }
    if (i % 5 === 0) { if (onProgress) onProgress(i / set.length); await new Promise(r => setTimeout(r, 0)); }
  }
  const n = set.length || 1;
  return {
    samples: set.length, top1: correct / n, coverage: accepted / n,
    precision: accepted ? acceptedCorrect / accepted : 0,
    perGloss: per, confusions: Object.entries(confusion).sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

/* ---------- live recogniser: turns a stream of hand frames into signed tokens ---------- */

export class LiveRecognizer {
  /**
   * @param {DTWModel} model
   * @param {(ev:object)=>void} onEvent  events: {type:'candidate',gloss,confidence,accepted} {type:'token',gloss,confidence} {type:'hand',present}
   * @param {{allowed?:Set<string>|null}} opts  gloss filter for the current question (null = any)
   */
  constructor(model, onEvent, opts = {}) {
    this.model = model; this.onEvent = onEvent;
    this.allowed = opts.allowed || null;
    this.sampleMs = 1000 / 12;       // training recordings are ~12 fps
    this.windowMs = 1300;            // length of sign window that is classified
    this.minFrames = 8;              // need ~0.7 s of hand before classifying
    this.classifyEveryMs = 220;
    this.agree = 2;                  // consecutive agreeing windows needed to register a sign
    this.absentMs = 350;             // hand gone this long => ready for the next sign
    this.reset();
  }
  setModel(m) { this.model = m; }
  setAllowed(set) { this.allowed = set; }
  reset() {
    this.buf = []; this.lastSample = -1e9; this.lastClassify = 0; this.lastSeen = -1e9;
    this.streak = { gloss: null, n: 0, conf: 0 };
    this.lastToken = null; this.needRelease = false; this.handWas = false;
  }
  /** Feed one detector result. lm = 21 landmarks or null. t = ms timestamp. */
  feed(lm, t) {
    const present = !!lm;
    if (present !== this.handWas) { this.handWas = present; this.onEvent({ type: 'hand', present }); }
    if (!present) {
      if (t - this.lastSeen > this.absentMs) { this.buf = []; this.streak = { gloss: null, n: 0, conf: 0 }; this.needRelease = false; }
      return;
    }
    this.lastSeen = t;
    if (t - this.lastSample >= this.sampleMs) {
      this.lastSample = t;
      try { this.buf.push({ t, f: normalizeLandmarks(lm) }); } catch { return; }
      while (this.buf.length && t - this.buf[0].t > this.windowMs) this.buf.shift();
    }
    if (this.buf.length < this.minFrames || t - this.lastClassify < this.classifyEveryMs || !this.model || !this.model.ready) return;
    this.lastClassify = t;
    const r = this.model.classify(this.buf.map(b => b.f));
    const okGloss = r.accepted && (!this.allowed || this.allowed.has(r.gloss));
    this.onEvent({ type: 'candidate', gloss: r.gloss, confidence: r.confidence, accepted: okGloss, rejectedByFilter: r.accepted && !okGloss });
    if (!okGloss) { this.streak = { gloss: null, n: 0, conf: 0 }; return; }
    if (this.needRelease && r.gloss === this.lastToken) return;       // same sign still being held
    if (this.streak.gloss === r.gloss) { this.streak.n++; this.streak.conf += r.confidence; }
    else this.streak = { gloss: r.gloss, n: 1, conf: r.confidence };
    if (this.streak.n >= this.agree) {
      const token = { type: 'token', gloss: r.gloss, confidence: this.streak.conf / this.streak.n };
      this.lastToken = r.gloss; this.needRelease = true;
      this.buf = []; this.streak = { gloss: null, n: 0, conf: 0 };
      this.onEvent(token);
    }
  }
}

/* ---------- reuse of exemplars from a VIBETALK model ---------- */

/** Pick exemplars out of an existing artefact. mapping: { newGloss: oldGloss } */
export function importExemplars(doc, mapping) {
  const seqs = (doc.payload && doc.payload.sequences) || {};
  const out = {};
  for (const [gloss, old] of Object.entries(mapping)) if (seqs[old]) out[gloss] = seqs[old];
  return out;
}

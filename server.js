/* SignSphere hospital server — zero dependencies (Node 18+).
 * Serves the web app and keeps everything real-time:
 *   - sessions (patient answers, doctor messages, patient replies) persisted to data/sessions.json
 *   - the sign dataset you record (data/dataset/<gloss>/session-NNN.json, VIBETALK-compatible)
 *   - the trained sign model (data/models/hospital-model.json)
 *   - a Server-Sent-Events stream so the patient screen and staff dashboard update instantly
 * Run:  node server.js     then open http://localhost:3000
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importExemplars, DTWModel } from './public/js/slr.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const VENDOR = path.join(ROOT, 'vendor');
const DATA = path.join(ROOT, 'data');
const DATASET = path.join(DATA, 'dataset');
const MODELS = path.join(DATA, 'models');
const SESSIONS_FILE = path.join(DATA, 'sessions.json');
const MODEL_FILE = path.join(MODELS, 'hospital-model.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
fs.mkdirSync(DATASET, { recursive: true });
fs.mkdirSync(MODELS, { recursive: true });

const vocabulary = JSON.parse(fs.readFileSync(path.join(DATA, 'hospital-vocabulary.json'), 'utf8'));
const glossIds = new Set(vocabulary.glosses.map(g => g.id));

/* ---------- storage ---------- */
let sessions = [];
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { sessions = []; }
let saveTimer = null;
function persistSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sessions));
    fs.renameSync(tmp, SESSIONS_FILE);
  }, 150);
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
function newSessionId() {
  const d = new Date(), stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const n = sessions.filter(s => s.id.startsWith(`SS-${stamp}-`)).length + 1;
  return `SS-${stamp}-${pad(n, 3)}`;
}

function datasetCounts() {
  const counts = {};
  for (const g of fs.readdirSync(DATASET)) {
    const dir = path.join(DATASET, g);
    if (fs.statSync(dir).isDirectory() && glossIds.has(g)) counts[g] = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
  }
  return counts;
}

let importedCache = null;
function importedSequences() {
  if (!importedCache) {
    const restaurant = JSON.parse(fs.readFileSync(path.join(DATA, 'restaurant-signs-model.json'), 'utf8'));
    importedCache = { threshold: restaurant.threshold || 0.6, sequences: importExemplars(restaurant, vocabulary.reuse) };
  }
  return importedCache;
}
function defaultModel() {
  const restaurant = JSON.parse(fs.readFileSync(path.join(DATA, 'restaurant-signs-model.json'), 'utf8'));
  const sequences = importExemplars(restaurant, vocabulary.reuse);
  const model = new DTWModel({ glosses: Object.keys(sequences), sequences, threshold: restaurant.threshold || 0.6, meta: { vocabulary: vocabulary.vocabulary, variant: vocabulary.variant } });
  const doc = model.toJSON();
  doc.imported_from = 'VIBETALK restaurant-signs-model.json';
  return doc;
}

/* ---------- real-time stream ---------- */
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

/* ---------- http helpers ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };
function send(res, code, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function serveFile(res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': file.includes('vendor') ? 'public, max-age=86400' : 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

const SESSION_PATCH = new Set(['name', 'status', 'summary', 'triage', 'department', 'doctorId', 'emergency', 'notified', 'notifiedDoctors', 'ack', 'closedAt']);

async function api(req, res, u) {
  const p = u.pathname, m = req.method;
  let match;
  if (p === '/api/health') return send(res, 200, { ok: true });
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: hello\ndata: {}\n\n`);
    clients.add(res);
    const ka = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }
  if (p === '/api/vocabulary' && m === 'GET') return send(res, 200, vocabulary);

  /* sessions */
  if (p === '/api/sessions' && m === 'GET') return send(res, 200, sessions);
  if (p === '/api/sessions' && m === 'POST') {
    const body = await readBody(req);
    const s = { id: newSessionId(), name: body.name || 'Walk-in patient', startedAt: Date.now(), status: 'intake', emergency: false, qa: [], exchange: [], summary: null, triage: null, department: null, doctorId: null };
    sessions.unshift(s); persistSessions(); broadcast('session', s);
    return send(res, 201, s);
  }
  if ((match = p.match(/^\/api\/sessions\/([\w-]+)\/(qa|exchange|patch)$/)) && m === 'POST') {
    const s = sessions.find(x => x.id === match[1]);
    if (!s) return send(res, 404, { error: 'Unknown session' });
    const body = await readBody(req);
    if (match[2] === 'qa') s.qa.push({ ...body, ts: Date.now() });
    else if (match[2] === 'exchange') s.exchange.push({ ...body, ts: Date.now() });
    else for (const [k, v] of Object.entries(body)) if (SESSION_PATCH.has(k)) s[k] = v;
    persistSessions(); broadcast('session', s);
    return send(res, 200, s);
  }

  /* trained model */
  if (p === '/api/model' && m === 'GET') {
    if (!fs.existsSync(MODEL_FILE)) fs.writeFileSync(MODEL_FILE, JSON.stringify(defaultModel()));
    return serveFile(res, MODELS, 'hospital-model.json');
  }
  if (p === '/api/model' && m === 'POST') {
    const doc = await readBody(req);
    if (!doc || doc.model_type !== 'dtw' || !doc.payload || !doc.payload.sequences) return send(res, 400, { error: 'Not a DTW model artefact' });
    fs.writeFileSync(MODEL_FILE + '.tmp', JSON.stringify(doc)); fs.renameSync(MODEL_FILE + '.tmp', MODEL_FILE);
    broadcast('model', { trained_at: doc.trained_at, glosses: doc.glosses });
    return send(res, 200, { ok: true, glosses: doc.glosses.length });
  }
  if (p === '/api/model/imported' && m === 'GET') return send(res, 200, importedSequences());
  if (p === '/api/model/reset' && m === 'POST') {
    fs.writeFileSync(MODEL_FILE, JSON.stringify(defaultModel()));
    broadcast('model', {});
    return send(res, 200, { ok: true });
  }

  /* recorded sign dataset (same layout as VIBETALK: dataset/<gloss>/session-NNN.json) */
  if (p === '/api/dataset' && m === 'GET') return send(res, 200, datasetCounts());
  if ((match = p.match(/^\/api\/dataset\/([a-z0-9-]+)$/))) {
    const g = match[1];
    if (!glossIds.has(g)) return send(res, 404, { error: 'Gloss not in vocabulary' });
    const dir = path.join(DATASET, g);
    if (m === 'GET') {
      if (!fs.existsSync(dir)) return send(res, 200, []);
      const out = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => ({ id: f.replace('.json', ''), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
      return send(res, 200, out);
    }
    if (m === 'POST') {
      const body = await readBody(req);
      if (!Array.isArray(body.frames) || body.frames.length < 4 || body.frames.some(f => !Array.isArray(f) || f.length !== 21)) return send(res, 400, { error: 'Need >=4 frames of 21 landmarks' });
      fs.mkdirSync(dir, { recursive: true });
      let hi = 0; for (const f of fs.readdirSync(dir)) { const n = parseInt((f.match(/session-(\d+)/) || [])[1], 10); if (n > hi) hi = n; }
      const id = `session-${pad(hi + 1, 3)}`;
      const round = v => Math.round(v * 1e5) / 1e5;
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ label: g, variant: vocabulary.variant, fps: body.fps || 12, hand: body.hand || 'right', frames: body.frames.map(fr => fr.map(pt => pt.map(round))) }));
      broadcast('dataset', datasetCounts());
      return send(res, 201, { id, count: hi + 1 });
    }
    if (m === 'DELETE') { fs.rmSync(dir, { recursive: true, force: true }); broadcast('dataset', datasetCounts()); return send(res, 200, { ok: true }); }
  }
  if ((match = p.match(/^\/api\/dataset\/([a-z0-9-]+)\/(session-\d+)$/)) && m === 'DELETE') {
    if (!glossIds.has(match[1])) return send(res, 404, { error: 'Gloss not in vocabulary' });
    fs.rmSync(path.join(DATASET, match[1], match[2] + '.json'), { force: true });
    broadcast('dataset', datasetCounts());
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    if (u.pathname.startsWith('/vendor/')) return serveFile(res, VENDOR, u.pathname.slice(8));
    return serveFile(res, PUBLIC, u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, { error: String(e.message || e) });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`\nSignSphere hospital is running:\n  http://localhost:${PORT}\n`);
});

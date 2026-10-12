import fs from 'fs';
import { DTWModel, LiveRecognizer, resampleSequence } from '../public/js/slr.js';
const doc = JSON.parse(fs.readFileSync(new URL('../data/restaurant-signs-model.json', import.meta.url), 'utf8'));
const model = DTWModel.fromJSON(doc);
const toLm = f => Array.from({ length: 21 }, (_, i) => ({ x: f[i*3]*0.2+0.5, y: f[i*3+1]*0.2+0.5, z: f[i*3+2]*0.2 }));
const events = [];
const rec = new LiveRecognizer(model, e => { if (e.type === 'token') events.push(e); });
let t = 0;
const FPS = 30, dt = 1000 / FPS;
function perform(gloss, which = 3, seconds = 1.4) {
  const seq = doc.payload.sequences[gloss][which];
  const n = Math.round(seconds * FPS);
  const frames = resampleSequence(seq, n);
  for (const f of frames) { rec.feed(toLm(f), t); t += dt; }
}
function rest(ms) { const end = t + ms; while (t < end) { rec.feed(null, t); t += dt; } }
const script = ['two', 'yes', 'confirm', 'help', 'five'];
for (const g of script) { rest(600); perform(g); }
rest(600);
const got = events.map(e => e.gloss);
console.log('performed:', script.join(' '), '\nrecognised:', got.join(' '));
console.log(events.map(e => e.gloss + ' ' + e.confidence.toFixed(2)).join(', '));
if (got.join() !== script.join()) process.exit(1);
// holding one sign must register once, not repeatedly
events.length = 0; rec.reset(); t += 5000;
perform('yes', 5, 4.0); rest(600);
console.log('held "yes" for 4s ->', events.map(e => e.gloss).join(' ') || '(none)');
if (events.length !== 1) process.exit(1);
// filter: only allow yes/no
events.length = 0; rec.reset(); rec.setAllowed(new Set(['yes','no']));
rest(600); perform('five'); rest(600); perform('no', 4); rest(600);
console.log('filtered (yes/no only):', events.map(e => e.gloss).join(' '));
if (events.length !== 1 || events[0].gloss !== 'no') process.exit(1);
console.log('LIVE OK');

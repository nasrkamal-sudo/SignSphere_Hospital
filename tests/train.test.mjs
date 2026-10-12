import fs from 'fs';
import { trainFromSamples, evaluateLOO, DTWModel, resampleSequence } from '../public/js/slr.js';
const doc = JSON.parse(fs.readFileSync(new URL('../data/restaurant-signs-model.json', import.meta.url), 'utf8'));
// Build "recordings" (raw landmark frames, 14 frames each) from real exemplars + small noise
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const toLm = f => Array.from({ length: 21 }, (_, i) => [f[i*3]*0.2+0.5, f[i*3+1]*0.2+0.5, f[i*3+2]*0.2]);
const glosses = ['coffee', 'tea', 'water', 'pizza', 'help', 'hello'];
const samples = {};
for (const g of glosses) {
  samples[g] = [];
  for (let k = 0; k < 8; k++) {
    const base = doc.payload.sequences[g][k * 2 % doc.payload.sequences[g].length];
    const fr = resampleSequence(base, 14).map(f => f.map(v => v + (rnd() - 0.5) * 0.06));
    samples[g].push({ frames: fr.map(toLm) });
  }
}
const model = trainFromSamples(samples, { augment: 2 });
console.log('glosses', model.glosses.length, 'exemplars', model.n, 'eval samples', model.evalSet.length);
const ev = await evaluateLOO(model);
console.log('LOO top1', ev.top1.toFixed(2), 'coverage', ev.coverage.toFixed(2), 'precision', ev.precision.toFixed(2));
// artefact round trip
const doc2 = JSON.parse(JSON.stringify(model.toJSON()));
const m2 = DTWModel.fromJSON(doc2);
const q = resampleSequence(samples.tea[0].frames.map(f => { const w=f[0]; const c=f.map(p=>[p[0]-w[0],p[1]-w[1],p[2]-w[2]]); const s=Math.max(...c.map(p=>Math.hypot(...p))); return c.flatMap(p=>p.map(v=>v/s)); }), 12);
console.log('round-trip classify:', m2.classify(q).gloss);
if (ev.top1 < 0.8 || m2.classify(q).gloss !== 'tea') process.exit(1);
console.log('TRAIN OK');

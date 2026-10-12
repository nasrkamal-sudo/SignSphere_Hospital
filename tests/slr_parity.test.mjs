import fs from 'fs';
import { DTWModel } from '../public/js/slr.js';

const doc = JSON.parse(fs.readFileSync(new URL('../data/restaurant-signs-model.json', import.meta.url), 'utf8'));
const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/cmp_cases.json', import.meta.url), 'utf8'));
const t0 = Date.now();
const m = DTWModel.fromJSON(doc);
console.log('exemplars', m.n, 'load ms', Date.now() - t0);
let agree = 0, maxd = 0, t1 = Date.now();
for (const c of cases) {
  const r = m.classify(c.query);
  if (r.gloss === c.py_gloss) agree++;
  maxd = Math.max(maxd, Math.abs(r.confidence - c.py_conf));
}
console.log(`JS vs Python: ${agree}/${cases.length} same gloss, max |confidence diff| = ${maxd.toExponential(2)}, ${(Date.now()-t1)/cases.length} ms/classification`);
if (agree !== cases.length || maxd > 1e-3) process.exit(1);

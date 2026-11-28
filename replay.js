// Replay copied Tone Fish recognition logs through the tone decision before and after a change.
//   node replay.js log1.json [log2.json ...] [--old index.before.html] [--new index.html]
// Each log is the JSON from "Copy recognition log". Logs made before hiLevel existed have no relLowHi /
// relStartHi in feats: they are rebuilt here the way the game does it (median pitch of syllables wanted and
// heard as Tone 1, last 10, 2+ needed), from the logged absolute pitch (st0, stMin, contour).
const fs = require('fs');

const args = process.argv.slice(2), logs = [];
let oldPath = 'index.before.html', newPath = 'index.html';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--old') oldPath = args[++i];
  else if (args[i] === '--new') newPath = args[++i];
  else logs.push(args[i]);
}
if (!logs.length) { console.error('usage: node replay.js log.json [...] [--old file] [--new file]'); process.exit(2); }

// Pull the decision code out of a page: whole function bodies by brace matching, plus a few one-line consts.
function extractFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let j = src.indexOf('{', i), depth = 0;
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  return src.slice(i, j + 1);
}
function extractLine(src, start) {
  const i = src.indexOf(start);
  return i < 0 ? '' : src.slice(i, src.indexOf('\n', i));
}
function loadDecider(path) {
  const src = fs.readFileSync(path, 'utf8');
  const code = [extractLine(src, 'const median ='), extractLine(src, 'const RULE_TH ='),
    extractFn(src, 'score3'), extractFn(src, 'decideTone'), extractFn(src, 'decideCore')].join('\n');
  return new Function('cfg', code + '\nreturn decideTone;');
}
const mkOld = loadDecider(oldPath), mkNew = loadDecider(newPath);
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

const T = [1, 2, 3, 4];
const emptyCM = () => Object.fromEntries(T.map(w => [w, Object.fromEntries(T.map(h => [h, 0]))]));
const tot = { n: 0, old: 0, neu: 0, len: 0, cmOld: emptyCM(), cmNew: emptyCM(), cmLen: emptyCM() };
const changed = [], broke = [], badLenient = [];
let heardMismatch = 0, rebuilt = 0;

for (const file of logs) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = { sens: 8, flat: 1.6, minMs: 100, endMs: 160, lenient: true, ...(data.cfg || {}) };
  const decOld = mkOld(cfg), decNew = mkNew(cfg);
  const hiHist = [];
  for (const e of data.log || []) {
    if (!e.feats || !e.want || e.heard == null) continue;
    const f = { ...e.feats, range: e.range, dur: e.dur };
    if (!('relLowHi' in e.feats)) {           // old log: rebuild the hiLevel features
      const hi = hiHist.length >= 2 ? median(hiHist) : null;
      f.relLowHi = hi != null && e.stMin != null ? e.stMin - hi : null;
      f.relStartHi = hi != null && e.stMin != null ? e.stMin + f.down - hi : null;
      rebuilt++;
    }
    const o = decOld({ ...e.feats, range: e.range, dur: e.dur }).tone;
    const r = decNew(f), nw = r.tone;
    if (nw === 1 && e.want === 1 && e.st0 != null && e.contour) {
      hiHist.push(median(e.contour.map(x => e.st0 + x))); if (hiHist.length > 10) hiHist.shift();
    }
    const lenient = nw !== e.want && r.ambiguous && r.alt === e.want && cfg.lenient !== false;
    const ln = lenient ? e.want : nw;
    if (o !== e.heard) heardMismatch++;
    tot.n++; tot.old += o === e.want; tot.neu += nw === e.want; tot.len += ln === e.want;
    tot.cmOld[e.want][o]++; tot.cmNew[e.want][nw]++; tot.cmLen[e.want][ln]++;
    const row = { file, t: e.t, word: e.word, want: e.want, old: o, new: nw, alt: r.alt, ambiguous: r.ambiguous, lenient,
      range: e.range, down: f.down, up: f.up, minPos: f.minPos, creak: f.creak,
      relLowHi: f.relLowHi == null ? null : +f.relLowHi.toFixed(2), relStartHi: f.relStartHi == null ? null : +f.relStartHi.toFixed(2) };
    if (o !== nw || lenient) changed.push(row);
    if (o === e.want && nw !== e.want) broke.push(row);
    if (lenient && !r.ambiguous) badLenient.push(row);
  }
}

const pctS = x => (100 * x / tot.n).toFixed(1) + '%';
const printCM = (title, cm) => {
  console.log(`\n${title}  (rows = wanted, columns = heard)`);
  console.log('        ' + T.map(h => ('T' + h).padStart(5)).join(''));
  for (const w of T) console.log(('  T' + w).padEnd(8) + T.map(h => String(cm[w][h]).padStart(5)).join(''));
};
console.log(`syllables replayed: ${tot.n}  (hiLevel features rebuilt for ${rebuilt} old-log entries)`);
console.log(`old decision ≠ logged "heard": ${heardMismatch}  (older app version or rounded feats)`);
console.log(`accuracy  before: ${tot.old}/${tot.n} ${pctS(tot.old)}   after: ${tot.neu}/${tot.n} ${pctS(tot.neu)}   after + leniency: ${tot.len}/${tot.n} ${pctS(tot.len)}`);
printCM('BEFORE', tot.cmOld); printCM('AFTER (strict)', tot.cmNew); printCM('AFTER + leniency', tot.cmLen);
console.log(`\nchanged syllables (${changed.length}):`);
for (const c of changed)
  console.log(`  ${c.t} ${c.word} want ${c.want}: ${c.old} → ${c.new}` + (c.lenient ? ` → lenient ${c.want}` : '') +
    `  alt=${c.alt} amb=${c.ambiguous}  range ${c.range} down ${c.down} up ${c.up} minPos ${c.minPos} creak ${c.creak}` +
    ` relLowHi ${c.relLowHi} relStartHi ${c.relStartHi}`);
console.log(`\nCHECK correct before → wrong after: ${broke.length ? 'FAIL ' + broke.map(b => b.word + '@' + b.t).join(', ') : 'OK (none)'}`);
console.log(`CHECK leniency only on ambiguous:   ${badLenient.length ? 'FAIL ' + badLenient.length : 'OK'}`);
process.exit(broke.length || badLenient.length ? 1 : 0);

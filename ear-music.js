/* ear-music.js — pure music-logic for Right Key "Play by Ear".
 * No DOM, no audio I/O. Usable in the browser (window.EarMusic) and Node (module.exports).
 * Notes are { midi, start, dur, amp } with start/dur in seconds.
 * Chords are { root (0-11 pitch class), type ('','m','dim'), start, dur }.
 */
(function (g) {
'use strict';

const NN = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
const MAJ = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MIN = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
const DIA_MAJ = [0,2,4,5,7,9,11], DIA_MIN = [0,2,3,5,7,8,10];
// Chord templates: pitch-class sets relative to root.
const TEMPLATES = [
  { type: '',   pcs: [0, 4, 7] },
  { type: 'm',  pcs: [0, 3, 7] },
  { type: 'dim',pcs: [0, 3, 6] },
  { type: '7',  pcs: [0, 4, 7, 10] },
];

const P = m => ((m % 12) + 12) % 12;

function midiToName(m) {
  const pcs = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  return pcs[P(m)] + (Math.floor(m / 12) - 1);
}
function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function chordName(c) { return NN[c.root] + (c.type === 'm' ? 'm' : c.type === 'dim' ? '°' : c.type === '7' ? '7' : ''); }

function pearson(a, b) {
  const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < n; i++) { d += (a[i] - ma) * (b[i] - mb); x += (a[i] - ma) ** 2; y += (b[i] - mb) ** 2; }
  return d / Math.sqrt(x * y || 1);
}
function rot(p, k) { return p.map((_, i) => p[(i - k + 12) % 12]); }

/* Score one 12-dim pitch-class weight vector against triad templates.
 * bass = pitch class of the lowest sounding note (-1 = unknown). A chord whose
 * root sits in the bass gets a strong boost; a fifth in the bass a small one.
 * Returns { root, type, score } or null when nothing fits. */
function scoreChord(pc, bass = -1) {
  const total = pc.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let best = null;
  for (let r = 0; r < 12; r++) {
    for (const t of TEMPLATES) {
      let s = 0;
      for (let p = 0; p < 12; p++) {
        const rel = (p - r + 12) % 12;
        s += t.pcs.includes(rel) ? pc[p] : -0.4 * pc[p];
      }
      // Prefer simpler triads over 7ths unless clearly stronger.
      if (t.type === '7') s *= 0.92;
      if (bass >= 0) {
        if (r === bass) s += 0.28 * total;            // root in the bass
        else if (r === (bass + 7) % 12) s += 0.10 * total; // fifth in the bass
      }
      const ns = s / total;
      if (!best || ns > best.score) best = { root: r, type: t.type, score: ns };
    }
  }
  return best && best.score > 0.22 ? best : null;
}

/* Slice notes into fixed windows and name the chord sounding in each.
 * 1s windows by default (stable), bass-aware, with majority smoothing over
 * neighbouring windows so a single noisy window can't flip the chord.
 * Returns [{ root, type, start, dur }] merged across consecutive same chords. */
function chordsOverTime(notes, winSec = 1.0) {
  if (!notes.length) return [];
  const t0 = Math.min(...notes.map(n => n.start));
  const t1 = Math.max(...notes.map(n => n.start + n.dur));
  const wins = [];
  for (let t = t0; t < t1; t += winSec) {
    const pc = new Array(12).fill(0);
    let bass = -1, low = Infinity;
    for (const n of notes) {
      const s = Math.max(n.start, t), e = Math.min(n.start + n.dur, t + winSec);
      if (e > s) {
        const p = P(n.midi);
        pc[p] += (e - s) * (0.3 + (n.amp || 0.5));
        if (n.midi < low) { low = n.midi; bass = p; }
      }
    }
    const c = scoreChord(pc, bass);
    wins.push(c ? { root: c.root, type: c.type, start: t, dur: winSec } : null);
  }
  // Majority smoothing: a window takes the label that wins among itself and
  // its neighbours, so one bad window can't flicker the chord.
  const sym = i => (wins[i] ? wins[i].root + wins[i].type : '');
  const smoothed = wins.map((w, i) => {
    if (!w) return w;
    const votes = [sym(i - 1), sym(i), sym(i + 1)].filter(Boolean);
    const counts = {};
    for (const v of votes) counts[v] = (counts[v] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top[1] >= 2 && top[0] !== sym(i)) {
      const m = top[0].match(/^(-?\d+)(.*)$/);
      return { root: parseInt(m[1], 10), type: m[2], start: w.start, dur: w.dur };
    }
    return w;
  });
  // Merge consecutive windows with the same chord; drop silent gaps.
  const merged = [];
  for (const w of smoothed) {
    if (!w) continue;
    const last = merged[merged.length - 1];
    if (last && last.root === w.root && last.type === w.type) last.dur += w.dur;
    else merged.push({ root: w.root, type: w.type, start: w.start, dur: w.dur });
  }
  return merged;
}

/* Key detection over transcribed notes.
 * Robustness rules (this is what was wrong before — it guessed too early and
 * trusted every pitch class equally):
 *  - Waits for real evidence: >= 10 notes spanning >= 5 seconds, else null.
 *  - Recent notes weigh more (the key is what it's in NOW, not a minute ago).
 *  - The bass line gets extra weight: bass notes usually sit on chord roots,
 *    the single strongest key clue in real music.
 *  - Blends Krumhansl-Schmuckler correlation with diatonic coverage (share of
 *    note weight on the key's 7 scale tones) — less fooled by one odd note.
 *  - Refuses to call it when the top two keys are nearly tied (returns null).
 * Returns { tonic (0-11), minor (bool), confidence (0-1), name, oneLiner } or null. */
function detectKey(notes) {
  if (!notes || notes.length < 10) return null;
  const t0 = Math.min(...notes.map(n => n.start));
  const t1 = Math.max(...notes.map(n => n.start + n.dur));
  if (t1 - t0 < 5) return null;
  const span = t1 - t0;
  const pc = new Array(12).fill(0);
  for (const n of notes) {
    const recency = 0.6 + 0.4 * (n.start - t0) / span;
    pc[P(n.midi)] += n.dur * (0.3 + (n.amp || 0.5)) * recency;
  }
  for (let t = t0; t < t1; t += 0.5) {
    let low = null;
    for (const n of notes) {
      if (n.start < t + 0.5 && n.start + n.dur > t && (low === null || n.midi < low)) low = n.midi;
    }
    if (low !== null) pc[P(low)] += 0.5;
  }
  // Compress: a single dominant pitch (e.g. a pedal bass) must not drown out
  // the smaller notes that decide major vs minor. sqrt keeps order, tames spikes.
  for (let p = 0; p < 12; p++) pc[p] = Math.sqrt(pc[p]);
  const total = pc.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const scored = [];
  for (let r = 0; r < 12; r++) {
    for (const minor of [false, true]) {
      const ks = pearson(pc, rot(minor ? MIN : MAJ, r));
      const diaSet = minor ? DIA_MIN : DIA_MAJ;
      let dia = 0;
      for (const iv of diaSet) dia += pc[(r + iv) % 12];
      dia /= total;
      scored.push({ tonic: r, minor, s: 0.65 * ks + 0.35 * dia });
    }
  }
  scored.sort((a, b) => b.s - a.s);
  let top = scored[0];
  const second = scored[1];
  if (top.s - second.s < 0.04) {
    // Nearly tied: if it's the classic relative major/minor ambiguity (same key
    // signature), trust the tonic that's actually sounding instead of guessing.
    const isRel = (a, b) =>
      (!a.minor && b.minor && b.tonic === (a.tonic + 9) % 12) ||
      (a.minor && !b.minor && b.tonic === (a.tonic + 3) % 12);
    if (isRel(top, second)) top = pc[top.tonic] >= pc[second.tonic] ? top : second;
    else return null; // genuinely ambiguous — keep listening
  }
  const tonicName = NN[top.tonic];
  return {
    tonic: top.tonic, minor: top.minor,
    confidence: Math.max(0, Math.min(1, (top.s - second.s) * 5)),
    name: tonicName + (top.minor ? ' minor' : ' major'),
    oneLiner: top.minor ? `1 = ${NN[(top.tonic + 3) % 12]} (relative major)` : `Do = ${tonicName}`,
  };
}

/* Find a repeating chord loop in a chord sequence.
 * Returns the loop (array of chords) once the tail contains >= 2 full cycles,
 * else null. Compares root+type, but treats 7th chords as their base triad —
 * a melody note brushing the 7th shouldn't break an otherwise solid loop. */
function detectLoop(chords, minCycles = 2) {
  const norm = c => c.root + (c.type === '7' ? '' : c.type);
  const syms = chords.map(norm);
  const n = syms.length;
  for (let p = 2; p <= 8 && p * minCycles <= n; p++) {
    let ok = true;
    for (let i = n - p * minCycles; i < n - p; i++) {
      if (syms[i] !== syms[i + p]) { ok = false; break; }
    }
    if (!ok) continue;
    const loop = chords.slice(n - p).map(c => c.type === '7' ? { ...c, type: '' } : c);
    if (new Set(loop.map(norm)).size < 2) continue; // need >= 2 distinct chords
    return loop;
  }
  return null;
}

/* Melody = highest sounding note at any moment ("skyline" algorithm).
 * Returns merged [{ midi, start, dur }]. */
function skyline(notes) {
  if (!notes.length) return [];
  const pts = [...new Set(notes.flatMap(n => [n.start, n.start + n.dur]))].sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const t = pts[i], t2 = pts[i + 1];
    let top = -1;
    for (const n of notes) {
      if (n.start <= t + 1e-6 && n.start + n.dur > t && n.midi > top) top = n.midi;
    }
    if (top >= 0) {
      const last = segs[segs.length - 1];
      if (last && last.midi === top && Math.abs(last.start + last.dur - t) < 1e-6) last.dur += t2 - t;
      else segs.push({ midi: top, start: t, dur: t2 - t });
    }
  }
  // Drop micro-blips.
  return segs.filter(s => s.dur >= 0.09);
}

/* Harmonize a sung/played melody: pick one diatonic chord per segment so that
 * the chords fit the melody notes and move smoothly. Used for "Sing to me".
 * key = { tonic, minor } from detectKey. Returns [{ root, type, start, dur }]. */
function harmonize(melody, key, segSec = 1.6) {
  if (!melody.length || !key) return [];
  const t = key.tonic;
  // Diatonic triads: [scale degree offset, type]
  const degrees = key.minor
    ? [[0,'m'],[2,'dim'],[3,''],[5,'m'],[7,'m'],[8,''],[10,'']]
    : [[0,''],[2,'m'],[4,'m'],[5,''],[7,''],[9,'m'],[11,'dim']];
  const cands = degrees.map(([off, ty]) => {
    const root = (t + off) % 12;
    const tmpl = TEMPLATES.find(x => x.type === ty);
    return { root, type: ty, tones: tmpl.pcs.map(p => (root + p) % 12) };
  });
  const t0 = melody[0].start, t1 = Math.max(...melody.map(n => n.start + n.dur));
  const out = [];
  let prev = null;
  for (let s = t0; s < t1; s += segSec) {
    const pcs = new Array(12).fill(0);
    for (const n of melody) {
      if (n.start < s + segSec && n.start + n.dur > s) {
        const overlap = Math.min(n.start + n.dur, s + segSec) - Math.max(n.start, s);
        pcs[P(n.midi)] += overlap;
      }
    }
    if (pcs.reduce((a, b) => a + b, 0) <= 0) continue;
    let best = null;
    for (const c of cands) {
      let sc = 0;
      for (let p = 0; p < 12; p++) {
        if (pcs[p] <= 0) continue;
        if (c.tones.includes(p)) sc += 2.5 * pcs[p];          // melody note is a chord tone
        else if (pcs[p] > 0.35) sc -= 1.5 * pcs[p];           // long non-chord tone hurts
        else sc -= 0.2 * pcs[p];                              // passing tone: tiny penalty
      }
      if (prev) sc += 0.3 * c.tones.filter(x => prev.tones.includes(x)).length; // gentle smoothness
      if (c.root === t) sc += 0.25;                            // slight pull to tonic
      if (c.root === (t + 7) % 12) sc += 0.15;                // and to the dominant
      if (!best || sc > best.sc) best = { c, sc };
    }
    if (best) {
      const last = out[out.length - 1];
      if (last && last.root === best.c.root && last.type === best.c.type) last.dur += segSec;
      else { out.push({ root: best.c.root, type: best.c.type, start: s, dur: segSec }); prev = best.c; }
    }
  }
  return out;
}

const EarMusic = { NN, midiToName, midiToFreq, chordName, scoreChord, chordsOverTime, detectKey, detectLoop, skyline, harmonize };
if (typeof module !== 'undefined' && module.exports) module.exports = EarMusic;
g.EarMusic = EarMusic;
})(typeof window !== 'undefined' ? window : globalThis);

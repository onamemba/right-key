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
// Chord templates: pitch-class sets relative to root.
const TEMPLATES = [
  { type: '',   pcs: [0, 4, 7] },
  { type: 'm',  pcs: [0, 3, 7] },
  { type: 'dim',pcs: [0, 3, 6] },
  { type: '7',  pcs: [0, 4, 7, 10] },
];

function midiToName(m) {
  const pcs = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  return pcs[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
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
 * Returns { root, type, score } or null when nothing fits. */
function scoreChord(pc) {
  const total = pc.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let best = null;
  for (let r = 0; r < 12; r++) {
    for (const t of TEMPLATES) {
      let s = 0;
      for (let p = 0; p < 12; p++) {
        const rel = (p - r + 12) % 12;
        s += t.pcs.includes(rel) ? pc[p] : -0.35 * pc[p];
      }
      // Prefer simpler triads over 7ths unless clearly stronger.
      if (t.type === '7') s *= 0.92;
      const ns = s / total;
      if (!best || ns > best.score) best = { root: r, type: t.type, score: ns };
    }
  }
  return best && best.score > 0.18 ? best : null;
}

/* Slice notes into fixed windows and name the chord sounding in each.
 * Returns [{ root, type, start, dur }] merged across consecutive same chords. */
function chordsOverTime(notes, winSec = 0.5) {
  if (!notes.length) return [];
  const t0 = Math.min(...notes.map(n => n.start));
  const t1 = Math.max(...notes.map(n => n.start + n.dur));
  const out = [];
  for (let t = t0; t < t1; t += winSec) {
    const pc = new Array(12).fill(0);
    for (const n of notes) {
      if (n.start < t + winSec && n.start + n.dur > t) {
        const overlap = Math.min(n.start + n.dur, t + winSec) - Math.max(n.start, t);
        pc[((n.midi % 12) + 12) % 12] += overlap * (0.3 + (n.amp || 0.5));
      }
    }
    const c = scoreChord(pc);
    out.push({ root: c ? c.root : -1, type: c ? c.type : '', start: t, dur: winSec, score: c ? c.score : 0 });
  }
  // Merge consecutive windows with the same chord.
  const merged = [];
  for (const w of out) {
    const last = merged[merged.length - 1];
    if (w.root >= 0 && last && last.root === w.root && last.type === w.type) {
      last.dur += w.dur;
    } else if (w.root >= 0) {
      merged.push({ root: w.root, type: w.type, start: w.start, dur: w.dur });
    }
  }
  return merged;
}

/* Krumhansl-Schmuckler key detection over transcribed notes (duration-weighted).
 * Returns { tonic (0-11), minor (bool), confidence (0-1), name }. */
function detectKey(notes) {
  const pc = new Array(12).fill(0);
  for (const n of notes) pc[((n.midi % 12) + 12) % 12] += n.dur * (0.3 + (n.amp || 0.5));
  const total = pc.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const scored = [];
  for (let r = 0; r < 12; r++) {
    scored.push({ tonic: r, minor: false, s: pearson(pc, rot(MAJ, r)) });
    scored.push({ tonic: r, minor: true,  s: pearson(pc, rot(MIN, r)) });
  }
  scored.sort((a, b) => b.s - a.s);
  const top = scored[0], second = scored[1];
  const tonicName = NN[top.tonic];
  const relName = top.minor ? NN[(top.tonic + 3) % 12] : null;
  return {
    tonic: top.tonic, minor: top.minor,
    confidence: Math.max(0, Math.min(1, (top.s - second.s) * 2.5)),
    name: tonicName + (top.minor ? ' minor' : ' major'),
    oneLiner: top.minor ? `1 = ${relName}  (relative major)` : `Do = ${tonicName}`,
  };
}

/* Find a repeating chord loop in a chord sequence.
 * Returns the loop (array of chords) once the tail contains >= 2 full cycles,
 * else null. Symbols compare root+type. */
function detectLoop(chords, minCycles = 2) {
  const syms = chords.map(c => c.root + c.type);
  const n = syms.length;
  for (let p = 2; p <= 8 && p * minCycles <= n; p++) {
    let ok = true;
    for (let i = n - p * minCycles; i < n - p; i++) {
      if (syms[i] !== syms[i + p]) { ok = false; break; }
    }
    if (!ok) continue;
    const loop = chords.slice(n - p);
    if (new Set(loop.map(c => c.root + c.type)).size < 2) continue; // need >= 2 distinct chords
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
        pcs[((n.midi % 12) + 12) % 12] += overlap;
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

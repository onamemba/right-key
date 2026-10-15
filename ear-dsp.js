/* ear-dsp.js — the proven Right Key listening engine as a reusable module.
 *
 * This is the exact analysis core from index.html (the page Francis confirms
 * finds keys on real songs), refactored to run without DOM: feed it analyser
 * frames from mic OR from an uploaded file playing through an AnalyserNode.
 *
 * Why this instead of neural transcription: it listens to SOUND (FFT chroma),
 * not to guessed notes. No model download, no worker, no thresholds that
 * hallucinate — just spectral energy matched against discriminative
 * major/minor templates, the way the main page does it.
 *
 * Usage:
 *   const ear = EarDSP.create();
 *   // per animation frame:
 *   ear.frame(freqData, timeData, sampleRate, fftSize, nowMs);
 *   ear.getKey() -> { k, m, ... } | null
 *   ear.getLoop() -> chord array | null
 *   ear.getProgression() -> recent chords
 *   ear.getTempo() -> { bpm } | null
 */
(function (g) {
'use strict';

const NN = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
const MAJ = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MIN = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
// Discriminative templates: reward chord tones, punish the wrong third (-.35)
// and other non-chord tones (-.1). This is what separates major from minor.
const TY = [
  { n:'',  s:[0,4,7], w:{0:1,4:1,7:.9,3:-.35}, o:-.1 },
  { n:'m', s:[0,3,7], w:{0:1,3:1,7:.9,4:-.35}, o:-.1 },
].map(t => { const v = Array(12).fill(t.o); for (const k in t.w) v[k] = t.w[k];
             const m = Math.hypot(...v); t.v = v.map(x => x / m); return t; });
const DIA = { 0:['','7'], 2:['m'], 4:['m'], 5:['','7'], 7:['','7'], 9:['m'] };
const chordName = c => NN[c.r] + c.t;

function pearson(a, b) {
  const n = a.length, ma = a.reduce((x,y)=>x+y,0)/n, mb = b.reduce((x,y)=>x+y,0)/n;
  let d=0, x=0, y=0;
  for (let i=0;i<n;i++){ d+=(a[i]-ma)*(b[i]-mb); x+=(a[i]-ma)**2; y+=(b[i]-mb)**2; }
  return d / Math.sqrt(x*y || 1);
}
const rot = (p,k) => p.map((_,i) => p[(i-k+12)%12]);
const sg = p => p.r + (p.t === 'm' ? 'm' : '');
const isRot = (a,b) => a.length===b.length && a.some((_,k)=>a.every((p,i)=>sg(p)===sg(b[(i+k)%b.length])));

function acf(buf, sr) {
  const n = 2048;
  let e = 0;
  for (let i=0;i<n;i++) e += buf[i]*buf[i];
  if (Math.sqrt(e/n) < .01) return -1;
  const lo = Math.floor(sr/1000), hi = Math.floor(sr/70), r = new Float32Array(hi+2);
  let mx = 0;
  for (let l=lo;l<=hi;l++){ let s=0; for(let i=0;i<n;i++) s+=buf[i]*buf[i+l]; r[l]=s/e; if(r[l]>mx)mx=r[l]; }
  if (mx < .5) return -1;
  for (let l=lo+1;l<hi;l++) if (r[l]>.9*mx && r[l]>=r[l-1] && r[l]>=r[l+1]) return sr/l;
  return -1;
}

function create() {
  // ---- state (mirrors index.html) ----
  let L = Array(12).fill(0);          // long-term chroma
  let bh = Array(12).fill(0);         // bass histogram
  let rKey = null, mSc = 0, minorF = false;
  let loud = 0, key = null, locked = false;
  let cur = null, cand = '', stab = 0;
  let prog = [], seqA = [], lps = null;
  let sus = null;                     // sustained-note memory (per fftSize)
  let prevMag = null;                 // for spectral flux (tempo)
  let onsets = [];                    // onset times in seconds
  let melody = [];                    // { midi, at } pitch track
  let lastFrameAt = 0;

  const base = () => key ? (key.m ? (key.k+3)%12 : key.k) : null;

  function score(c, r, t, bass) {
    let d = 0;
    for (let i=0;i<12;i++) d += c[(i+r)%12] * t.v[i];
    d /= Math.hypot(...c) || 1;
    if (r === bass) d += .03;
    const b = base();
    if (b !== null) { const ok = (DIA[(r-b+12)%12]||[]).includes(t.n); d += ok ? .05 : -.03; }
    return d;
  }

  function detect() {
    const s = seqA, n = s.length;
    for (let p=2; p<=8 && 2*p<=n; p++) {
      let j = n-1, m = 0;
      while (j-p>=0 && sg(s[j])===sg(s[j-p])) { m++; j--; }
      if (m < (p===2?4:p-1)) continue;
      const i = n-(m+p), l = s.slice(i, i+p);
      if (new Set(l.map(sg)).size < 2) continue;
      return l;
    }
    return null;
  }

  function src() { return lps || (seqA.length ? seqA : prog); }

  function findKey() {
    const tw = src().reduce((a,p)=>a+1+Math.min(p.n||0,300)/60,0)||1,
          bsum = bh.reduce((a,b)=>a+b)||1, sc = [];
    for (let R=0; R<12; R++) {
      let ch = 0;
      src().forEach((p,i) => {
        const o = (p.r-R+12)%12, ok = (DIA[o]||[]).includes(p.t), w = 1+Math.min(p.n||0,300)/60;
        ch += (ok ? w : -.5*w)/tw;
        if (!lps && i===0 && o===0 && p.t!=='m') ch += seqA.length<4 ? .5 : .25;
      });
      const b = (bh[R]+.9*bh[(R+9)%12]+.4*bh[(R+7)%12])/bsum,
            maj = pearson(L, rot(MAJ,R)), mn = pearson(L, rot(MIN,(R+9)%12));
      sc.push({ R, maj, mn, s: Math.max(maj,mn)+.7*ch+.9*b });
    }
    sc.sort((a,b)=>b.s-a.s);
    let t = sc[0];
    if (rKey!==null && t.R!==rKey) { const o = sc.find(x=>x.R===rKey); if (o && t.s-o.s<.15) t = o; }
    rKey = t.R;
    let mw = 0;
    src().forEach(p => {
      const o = (p.r-t.R+12)%12, w = 1+Math.min(p.n||0,300)/60;
      if (o===0 && p.t!=='m') mw -= w;
      if (o===9 && p.t==='m') mw += w;
    });
    mSc = mSc*.8 + .2*(.4*mw/tw + 1.2*(bh[(t.R+9)%12]-bh[t.R])/bsum);
    minorF = minorF ? mSc>.25 : mSc>.55;
    const minor = minorF;
    return { k: minor ? (t.R+9)%12 : t.R, m: minor?1:0, gap: t.s-sc[1].s,
             early: !lps && (src().length<3 || loud<240) };
  }

  function setKey() { key = findKey(); }

  /* Process one analyser frame. Returns an event object with whatever is new:
   * { chord, keyChanged, loopFound, melodyMidi, bassPc } — any may be null. */
  function frame(fb, tb, sr, fftSize, nowMs, nowSec) {
    const ev = { chord:null, keyChanged:false, loopFound:false, melodyMidi:-1, bassPc:-1 };
    const hz = sr/fftSize, lo = Math.ceil(65/hz), hi = Math.floor(1800/hz), bb = Math.floor(220/hz);
    if (!sus || sus.length !== fb.length) { sus = new Float32Array(fb.length); prevMag = new Float32Array(fb.length); }
    const c = Array(12).fill(0), bc = Array(12).fill(0);
    let pk = -200, tot = 0, bt = 0, flux = 0;
    for (let i=lo; i<=hi; i++) {
      const db = fb[i];
      if (db > pk) pk = db;
      const m = db < -90 ? 0 : Math.sqrt(Math.pow(10, db/20));
      // spectral flux for onset/tempo detection
      const d = m - prevMag[i];
      if (d > 0) flux += d;
      prevMag[i] = m;
      sus[i] = sus[i]*.9 + m*.1;
      const h = Math.min(m, 2.5*sus[i]); // sustained notes stay, drum hits die
      const mi = 69+12*Math.log2(i*hz/440), r = Math.round(mi);
      if (Math.abs(mi-r)>.35 || h<=0) continue;
      const p = ((r%12)+12)%12, wq = Math.sqrt(130.81/(i*hz)); // 1/sqrt(f)
      c[p] += h*wq; tot += h*wq;
      if (i<=bb) { bc[p] += h*wq; bt += h*wq; }
    }
    // onset -> tempo tracking (flux peak = something started)
    if (flux > 1.2 && tot > 0) {
      if (!onsets.length || nowSec - onsets[onsets.length-1] > 0.12) {
        onsets.push(nowSec);
        if (onsets.length > 400) onsets.shift();
      }
    }
    if (pk < -65 || tot <= 0) { stab = 0; cand = ''; return ev; }
    for (let k=0;k<12;k++){ c[k]/=tot; L[k] = L[k]*.995 + c[k]; }
    loud++;
    if (cur) cur.n = (cur.n||0)+1;
    for (let k=0;k<12;k++) bh[k] *= .999;
    let bass = -1;
    if (bt > 0) { const mx = Math.max(...bc); if (mx/bt > .35) bass = bc.indexOf(mx); }
    if (bass >= 0) bh[bass] += 1;
    ev.bassPc = bass;
    // melody pitch (for sing mode)
    const f = acf(tb, sr);
    if (f > 0) {
      const midi = Math.round(69+12*Math.log2(f/440));
      ev.melodyMidi = midi;
      melody.push({ midi, at: nowSec });
      if (melody.length > 600) melody.shift();
    }
    if (!locked && loud > 10 && loud % 6 === 0) {
      const before = key ? key.k+':'+key.m : '';
      setKey();
      const after = key ? key.k+':'+key.m : '';
      if (before !== after) ev.keyChanged = true;
    }
    let best = null, bs = 0;
    for (let r=0;r<12;r++) TY.forEach(t => {
      const s = score(c, r, t, bass);
      if (s > bs) { bs = s; best = { r, t: t.n, s }; }
    });
    if (!best || bs < .7) { stab = 0; cand = ''; return ev; }
    const id = best.r+':'+best.t;
    if (cur && id === cur.id) { stab = 0; cand = ''; return ev; }
    if (id === cand) stab++; else { cand = id; stab = 0; }
    const curS = cur ? score(c, cur.r, TY.find(t=>t.n===cur.t), bass) : 0;
    if (stab >= 10 && bs > curS + .04) {
      cur = { id, r: best.r, t: best.t, at: nowMs, n: 0 };
      prog.push(cur); if (prog.length > 24) prog.shift();
      stab = 0;
      if (!seqA.length || sg(seqA[seqA.length-1]) !== sg(cur)) seqA.push(cur);
      if (seqA.length > 200) seqA.shift();
      const dl = detect();
      if (dl && !(lps && isRot(lps, dl))) { lps = dl; ev.loopFound = true; }
      if (!locked) setKey();
      ev.chord = cur;
    }
    lastFrameAt = nowMs;
    return ev;
  }

  function getKey() {
    if (!key) return null;
    return { ...key, name: NN[key.k] + (key.m ? ' minor' : ' major'),
             oneLiner: key.m ? '1 = ' + NN[(key.k+3)%12] + ' (relative major)' : 'Do = ' + NN[key.k] };
  }
  function getProgression() { return prog.slice(); }
  function getLoop() { return lps ? lps.slice() : null; }
  function getTempo() {
    // autocorrelation of onset times -> BPM (reuses the proven approach)
    if (onsets.length < 8) return null;
    const t0 = onsets[0], t1 = onsets[onsets.length-1], sr = 50;
    const len = Math.ceil((t1-t0)*sr);
    if (len < sr*4) return null;
    const pulse = new Float32Array(len);
    for (const t of onsets) { const i = Math.floor((t-t0)*sr); if (i>=0 && i<len) pulse[i] += 1; }
    let best = null;
    for (let bpm=50; bpm<=220; bpm++) {
      const lag = Math.round(60/bpm*sr);
      if (lag<1 || lag>=len) continue;
      let s = 0;
      for (let i=0; i+lag<len; i++) s += pulse[i]*pulse[i+lag];
      s /= (len-lag);
      if (bpm>=80 && bpm<=160) s *= 1.15;
      if (!best || s > best.s) best = { bpm, s };
    }
    return best ? { bpm: best.bpm } : null;
  }
  function getMelody(sinceSec) {
    return sinceSec == null ? melody.slice() : melody.filter(m => m.at >= sinceSec);
  }
  function getStats() { return { frames: loud, onsets: onsets.length }; }

  function reset() {
    L = Array(12).fill(0); bh = Array(12).fill(0);
    rKey = null; mSc = 0; minorF = false;
    loud = 0; key = null; locked = false;
    cur = null; cand = ''; stab = 0;
    prog = []; seqA = []; lps = null;
    sus = null; prevMag = null; onsets = []; melody = [];
  }
  function setLocked(v) { locked = v; }

  return { frame, getKey, getProgression, getLoop, getTempo, getMelody, getStats,
           reset, setLocked, chordName, NN };
}

const EarDSP = { create, NN, chordName };
if (typeof module !== 'undefined' && module.exports) module.exports = EarDSP;
g.EarDSP = EarDSP;
})(typeof window !== 'undefined' ? window : globalThis);

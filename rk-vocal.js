/* Right Key Vocal: turns a sung melody (pitch frames) into piano chords.
   push(timeMs, midiFloat|null, confidence) -> onChord({r,t}), onStrike({r,t}), onKey(tonicPc, minor) */
(function (g) {
  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const DEG = [[0, ''], [2, 'm'], [4, 'm'], [5, ''], [7, ''], [9, 'm']];                     // I ii iii IV V vi (offsets from the major tonic)
  const TR = { '0>3': .35, '0>4': .3, '0>5': .25, '0>1': .1, '3>0': .3, '3>4': .35, '3>1': .15, '3>5': .1, '4>0': .45, '4>5': .3, '4>3': .2, '5>3': .4, '5>1': .15, '5>4': .25, '5>0': .1, '1>4': .5, '1>3': .1, '1>0': .1, '2>5': .35, '2>3': .35 };
  const pear = (a, b) => { let ma = 0, mb = 0; for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; } ma /= 12; mb /= 12; let d = 0, x = 0, y = 0; for (let i = 0; i < 12; i++) { d += (a[i] - ma) * (b[i] - mb); x += (a[i] - ma) ** 2; y += (b[i] - mb) ** 2; } return d / Math.sqrt(x * y || 1); };
  function Harmonizer(o) {
    this.o = o; this.notes = []; this.run = null; this.hist = Array(12).fill(0); this.key = null; this.chord = null; this.since = 0; this.struck = 0; this.lastVoiced = -1e9; this.lastEval = 0; this.minDwell = o.minDwell || 900; this.n = 0;
  }
  Harmonizer.prototype.close = function (t) {
    const r = this.run; this.run = null; if (!r || r.t1 - r.t0 < 100) return;
    const m = Math.round(r.sum / r.n); this.notes.push({ m, t0: r.t0, t1: r.t1 }); if (this.notes.length > 40) this.notes.shift();
    for (let i = 0; i < 12; i++) this.hist[i] *= .985; this.hist[((m % 12) + 12) % 12] += (r.t1 - r.t0) / 1000; this.n++; this.updateKey();
  };
  Harmonizer.prototype.updateKey = function () {
    let best = null; for (let k = 0; k < 12; k++) for (const mn of [0, 1]) { const p = mn ? MIN : MAJ, s = pear(this.hist, p.map((_, i) => p[(i - k + 12) % 12])); if (!best || s > best.s) best = { k, mn, s }; }
    const R = best.mn ? (best.k + 3) % 12 : best.k;
    if (!this.key || (R !== this.key.R && best.s > this.key.s + .08) || (R === this.key.R && best.mn !== this.key.mn)) { this.key = { R, mn: best.mn, s: best.s }; this.o.onKey && this.o.onKey(best.k, best.mn); }
    else this.key.s = Math.max(this.key.s * .98, best.s * .5 + this.key.s * .5);
  };
  Harmonizer.prototype.push = function (t, midi, conf) {
    const voiced = midi != null && conf >= .5;
    if (voiced) {
      const gap = t - this.lastVoiced; this.lastVoiced = t; const newPhrase = gap > 600;
      if (this.run && Math.abs(midi - this.run.sum / this.run.n) < .65) { this.run.sum += midi; this.run.n++; this.run.t1 = t; }
      else { this.close(t); this.run = { sum: midi, n: 1, t0: t, t1: t }; }
      if (newPhrase) this.phraseStart = t;
    } else if (this.run && t - this.run.t1 > 300) this.close(t);
    if (t - this.lastEval >= 150 && t - this.lastVoiced < 1500) { this.lastEval = t; this.decide(t, voiced); }
  };
  Harmonizer.prototype.decide = function (t) {
    if (!this.key) return; const win = 1400, ns = this.notes.filter(n => n.t1 > t - win).concat(this.run && this.run.t1 - this.run.t0 >= 100 ? [{ m: Math.round(this.run.sum / this.run.n), t0: this.run.t0, t1: this.run.t1 }] : []);
    const total = ns.reduce((a, n) => a + (n.t1 - n.t0), 0); if (this.n < 5 || total < 700) return;
    const R = this.key.R, prev = this.chord ? this.chord.d : -1, sc = [];
    DEG.forEach(([off, q], d) => {
      const root = (R + off) % 12, third = (root + (q === 'm' ? 3 : 4)) % 12, fifth = (root + 7) % 12; let s = 0;
      for (const n of ns) { const pc = ((n.m % 12) + 12) % 12, w = (n.t1 - n.t0) / 1000 * (.4 + .6 * Math.max(0, (n.t1 - (t - win)) / win)); s += w * (pc === root ? 1 : pc === third ? .9 : pc === fifth ? .8 : -.5); }
      s += .6 * (TR[prev + '>' + d] || (prev >= 0 ? .05 : 0)) + (d === prev ? .25 : 0); sc.push({ d, root, q, s });
    });
    sc.sort((a, b) => b.s - a.s); const best = sc[0];
    if (!this.chord) return this.set(best, t);
    const cur = sc.find(x => x.d === this.chord.d), phrase = this.phraseStart && this.phraseStart > this.since;
    if (best.d !== this.chord.d && best.s > cur.s + (phrase ? .2 : .35) && t - this.since >= (phrase ? 500 : this.minDwell)) this.set(best, t);
    else if (t - this.struck >= 2600 && t - this.lastVoiced < 400) { this.struck = t; this.o.onStrike && this.o.onStrike(this.chord); }
  };
  Harmonizer.prototype.set = function (b, t) { this.chord = { r: b.root, t: b.q, d: b.d }; this.since = t; this.struck = t; this.o.onChord && this.o.onChord(this.chord, t); };
  g.RKVocal = { Harmonizer };
  if (typeof module !== 'undefined') module.exports = g.RKVocal;
})(typeof window !== 'undefined' ? window : globalThis);

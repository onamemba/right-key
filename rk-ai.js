/* Right Key AI: runs the ChordMini chord model and a tempo tracker inside the browser.
   mic -> 22.05 kHz -> CQT (JavaScript) -> ChordMini (onnxruntime-web) -> chords for Right Key. */
(function (g) {
  const SR = 22050, HOP = 2048, WIN = 108, NB = 144, BPO = 24, FMIN = 32.70319566257483, FR = HOP / SR;
  const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  const MODEL_URLS = ['models/chordnet.onnx', 'https://huggingface.co/musetric/chordmini-onnx/resolve/main/chordnet.onnx'];
  const CONFIG_URLS = ['models/config.json', 'https://huggingface.co/musetric/chordmini-onnx/resolve/main/config.json'];
  const TFJS = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
  const CREPE = 'https://cdn.jsdelivr.net/gh/ml5js/ml5-data-and-models@0612a3e7c51cbffdc5db701dff49d16d1ac26fa8/models/pitch-detection/crepe/model.json';
  const QL = ['min', 'maj', 'dim', 'aug', 'min6', 'maj6', 'min7', 'minmaj7', 'maj7', '7', 'dim7', 'hdim7', 'sus2', 'sus4'];
  const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

  /* ---------- CQT: a direct version of librosa's CQT (checked against librosa) ---------- */
  function kernels() {
    const al = (Math.pow(2, 2 / BPO) - 1) / (Math.pow(2, 2 / BPO) + 1), K = [];
    for (let k = 0; k < NB; k++) {
      const f = FMIN * Math.pow(2, k / BPO), L = SR / (al * f), N = Math.ceil(L), h = N >> 1;
      const re = new Float32Array(N), im = new Float32Array(N); let sw = 0;
      for (let n = 0; n < N; n++) sw += .5 - .5 * Math.cos(2 * Math.PI * n / N);
      const sc = Math.sqrt(L) * .9958 / sw;
      for (let n = 0; n < N; n++) { const w = .5 - .5 * Math.cos(2 * Math.PI * n / N), ph = 2 * Math.PI * f * (n - h) / SR; re[n] = w * Math.cos(ph) * sc; im[n] = w * Math.sin(ph) * sc; }
      K.push({ N, h, re, im });
    }
    return K;
  }
  function cqtFrame(K, x, base, i) {                 // x holds samples from absolute index `base`
    const out = new Float32Array(NB), c = i * HOP;
    for (let k = 0; k < NB; k++) {
      const { N, h, re, im } = K[k], s = c - h - base; let a = 0, b = 0;
      for (let n = Math.max(0, -s), n1 = Math.min(N, x.length - s); n < n1; n++) { const v = x[s + n]; a += v * re[n]; b += v * im[n]; }
      out[k] = Math.log(Math.hypot(a, b) + 1e-6);
    }
    return out;
  }

  /* ---------- tempo from onsets ---------- */
  function tempo(env) {                              // env: onset strength, hop 512 samples
    const n = env.length; if (n < 200) return null;
    const m = env.reduce((a, b) => a + b, 0) / n, e = env.map(v => v - m), hs = 512 / SR;
    let a0 = 0; for (let i = 0; i < n; i++) a0 += e[i] * e[i]; if (a0 <= 0) return null;
    const ac = []; let best = -1, bs = -1e9;
    for (let l = 12; l <= 46; l++) { let s = 0; for (let i = 0; i + l < n; i++) s += e[i] * e[i + l]; ac[l] = s / a0 * n / (n - l);
      const bpm = 60 / (l * hs), pr = Math.exp(-Math.pow(Math.log2(bpm / 110), 2) / (2 * .55 * .55)); if (ac[l] * pr > bs) { bs = ac[l] * pr; best = l; } }
    let l = best; if (ac[l - 1] !== undefined && ac[l + 1] !== undefined) { const d = ac[l - 1] - 2 * ac[l] + ac[l + 1]; if (d < 0) l += .5 * (ac[l - 1] - ac[l + 1]) / d; }
    return { bpm: 60 / (l * hs), conf: ac[best] };
  }

  /* ---------- labels ---------- */
  function parseLabel(l) {
    if (typeof l !== 'string') return null; l = l.split('/')[0];
    if (!l.includes(':')) { const pc = PC[l]; return pc === undefined ? null : [pc, '']; }
    const [r, q] = l.split(':'), pc = PC[r]; return pc === undefined ? null : [pc, /^(min|dim|hdim)/.test(q) ? 'm' : ''];
  }
  function findLabels(o) {
    if (Array.isArray(o)) { if (o.length === 170 && o.every(x => typeof x === 'string')) return o; for (const v of o) { const r = findLabels(v); if (r) return r; } }
    else if (o && typeof o === 'object') {
      const ks = Object.keys(o); if (ks.length === 170 && ks.every(k => /^\d+$/.test(k)) && ks.every(k => typeof o[k] === 'string')) return ks.sort((a, b) => a - b).map(k => o[k]);
      for (const k of ks) { const r = findLabels(o[k]); if (r) return r; }
    }
    return null;
  }
  const fallbackLabels = () => Array.from({ length: 170 }, (_, i) => i === 169 ? 'N' : i === 168 ? 'X' : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][i % 12] + ':' + QL[Math.floor(i / 12)]);
  function smoothArgmax(lg, T, C) {                  // 9-frame uniform smoothing, then argmax
    const out = new Int32Array(T), tmp = new Float32Array(C);
    for (let t = 0; t < T; t++) {
      tmp.fill(0);
      for (let d = -4; d <= 4; d++) { let u = t + d; if (u < 0) u = -u - 1; if (u >= T) u = 2 * T - u - 1; u = Math.min(Math.max(u, 0), T - 1); const o = u * C; for (let c = 0; c < C; c++) tmp[c] += lg[o + c]; }
      let b = 0; for (let c = 1; c < C; c++) if (tmp[c] > tmp[b]) b = c; out[t] = b;
    }
    return out;
  }

  /* ---------- singing pitch: CREPE (small web model, 2 MB) ---------- */
  function Crepe(onPitch) {
    this.on = onPitch; this.model = null; this.r = SR / 16000; this.rin = 0; this.rout = 0; this.last = 0; this.cap = 48000; this.buf = new Float32Array(this.cap); this.n = 0; this.since = 0; this.busy = false;
    this.cents = Float32Array.from({ length: 360 }, (_, i) => i * 7180 / 359 + 1997.3794084376191);
  }
  Crepe.prototype.push = function (x) {
    for (let i = 0; i < x.length; i++) {
      const cur = x[i];
      while (this.rout * this.r <= this.rin) { this.buf[this.n % this.cap] = this.last + (cur - this.last) * (this.rout * this.r - (this.rin - 1)); this.n++; this.since++; this.rout++; }
      this.last = cur; this.rin++;
    }
    if (this.since >= 1024 && this.model && !this.busy) { this.since = 0; this.run(); }
  };
  Crepe.prototype.run = async function () {
    this.busy = true;
    try {
      const fr = new Float32Array(1024); let m = 0, e = 0;
      for (let i = 0; i < 1024; i++) { fr[i] = this.buf[(this.n - 1024 + i + this.cap * 2) % this.cap]; m += fr[i]; }
      m /= 1024; for (let i = 0; i < 1024; i++) { fr[i] -= m; e += fr[i] * fr[i]; } const sd = Math.sqrt(e / 1024);
      if (sd < .005) { this.on(performance.now(), null, 0); this.busy = false; return; }
      for (let i = 0; i < 1024; i++) fr[i] /= sd;
      const t = tf.tensor2d(fr, [1, 1024]), out = this.model.predict(t), p = await out.data(); t.dispose(); out.dispose();
      let b = 0; for (let i = 1; i < 360; i++) if (p[i] > p[b]) b = i;
      let sw = 0, sc = 0; for (let i = Math.max(0, b - 4); i <= Math.min(359, b + 4); i++) { sw += p[i]; sc += p[i] * this.cents[i]; }
      this.on(performance.now(), 69 + 12 * Math.log2(10 * Math.pow(2, sc / sw / 1200) / 440), p[b]);
    } catch (e) { /* skip this frame */ }
    this.busy = false;
  };

  /* ---------- engine ---------- */
  function Engine(opt) {
    this.o = opt; this.K = kernels(); this.hmax = this.K[0].h; this.cap = SR * 40; this.buf = new Float32Array(this.cap);
    this.total = 0; this.next = 0; this.rows = []; this.done = -1; this.lastInfer = 0; this.busy = false; this.model = opt.model || null; this.labels = opt.labels || null;
    this.lagFrames = Math.round((opt.lag || 1.5) / FR); this.rmsE = 0; this.nChunk = 0;
    this.env = []; this.acc = []; this.pa = 0; this.ph = 0; this.lastTempo = 0; this.prevDiff = 0;
  }
  Engine.prototype.range = function (a, b) {
    const out = new Float32Array(b - a);
    for (let i = a; i < b; i++) if (i >= 0 && i >= this.total - this.cap && i < this.total) out[i - a] = this.buf[i % this.cap];
    return out;
  };
  Engine.prototype.push = function (x) {
    let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i]; e /= x.length;
    if (e > 1e-7) { this.nChunk++; const al = Math.max(.0005, 1 / this.nChunk); this.rmsE += (e - this.rmsE) * al; }
    const gain = this.rmsE > 0 ? Math.min(40, Math.max(.05, .1 / Math.sqrt(this.rmsE))) : 1;       // keep loudness near what the model was trained on
    for (let i = 0; i < x.length; i++) { const v = x[i] * gain; this.buf[(this.total + i) % this.cap] = v; this.onsets(v); }
    if (this.o.onRaw) this.o.onRaw(x); this.total += x.length; if (!this.noChords) this.frames();
    if (!this.noChords && this.total - this.lastTempo >= 2 * SR && this.env.length > 200) { this.lastTempo = this.total; const t = tempo(this.env.slice(-344)); if (t && t.conf > .15 && this.o.onBpm) this.o.onBpm(t.bpm, t.conf); }
    if (this.model && !this.busy && this.total - this.lastInfer >= Math.max(SR, (this.cost || 0) / 1000 * SR * 1.5) && this.rows.length >= 60) { this.lastInfer = this.total; this.infer(); }
  };
  Engine.prototype.onsets = function (v) {                    // two bands: loudness and brightness, hop 512
    this.pa += v * v; const d = v - this.prevDiff; this.prevDiff = v; this.ph += d * d;
    this.n512 = (this.n512 || 0) + 1;
    if (this.n512 === 512) {
      const a = Math.log(Math.sqrt(this.pa / 512) + 1e-4), b = Math.log(Math.sqrt(this.ph / 512) + 1e-4);
      this.env.push(Math.max(0, a - (this.la || a)) + Math.max(0, b - (this.lb || b))); this.la = a; this.lb = b; this.pa = 0; this.ph = 0; this.n512 = 0; if (this.env.length > 800) this.env.shift();
    }
  };
  Engine.prototype.frames = function () {
    while (this.next * HOP + this.hmax + 1 <= this.total) {
      const c = this.next * HOP, base = c - this.hmax, seg = this.range(base, c + this.hmax + 1);
      this.rows.push({ idx: this.next, f: cqtFrame(this.K, seg, base, this.next) }); this.next++; if (this.rows.length > 130) this.rows.shift();
    }
  };
  Engine.prototype.infer = async function () {
    this.busy = true; const t0 = Date.now();
    try {
      const rows = this.rows.slice(-WIN), T = rows.length, X = new Float32Array(WIN * NB).fill(Math.log(1e-6));
      rows.forEach((r, j) => X.set(r.f, j * NB));
      const lg = await this.model(X), C = lg.length / WIN, ids = smoothArgmax(lg, T, C), limit = T - 1 - this.lagFrames, out = [];
      for (let j = 0; j <= limit; j++) if (rows[j].idx > this.done) out.push([rows[j].idx, parseLabel(this.labels[ids[j]])]);
      this.cost = Date.now() - t0; if (!this.shown) { this.shown = true; this.o.onStatus && this.o.onStatus('AI chords running · ' + this.cost + ' ms per update'); }
      if (out.length) { this.done = out[out.length - 1][0]; this.o.onChords({ t0: out[0][0] * FR, hop: FR, now: this.total / SR * 1000, chords: out.map(o => o[1]) }); }
    } catch (e) { this.o.onStatus && this.o.onStatus('AI error: ' + e.message); }
    this.busy = false;
  };

  /* the exported model takes a fixed batch of windows (16); fill the spare slots with silence and keep the first result */
  function makeRunner(sess, Tensor, B0) {
    let B = B0 || 16; const inName = sess.inputNames[0], outName = sess.outputNames[0];
    return async X => {
      for (let tries = 0; tries < 2; tries++) {
        const buf = new Float32Array(B * WIN * NB).fill(Math.log(1e-6)); buf.set(X);
        try { const d = (await sess.run({ [inName]: new Tensor('float32', buf, [B, WIN, NB]) }))[outName].data; return d.subarray(0, d.length / B); }
        catch (e) { const m = /Expected: (\d+)/.exec(e.message || ''); if (m && +m[1] !== B && tries === 0) { B = +m[1]; continue; } throw e; }
      }
    };
  }

  /* ---------- browser glue ---------- */
  const load = u => new Promise((ok, no) => { const s = document.createElement('script'); s.src = u; s.onload = ok; s.onerror = () => no(new Error('could not load ' + u)); document.head.appendChild(s); });
  async function getBytes(urls, tag, say) {
    const cache = await caches.open('rk-models-v1');
    for (const u of urls) {
      try {
        let r = await cache.match(u); if (!r) { say('Downloading ' + tag + '…'); r = await fetch(u); if (!r.ok) continue; await cache.put(u, r.clone()); }
        return await r.arrayBuffer();
      } catch (e) { /* try the next address */ }
    }
    throw new Error('could not get ' + tag);
  }
  const pend = {};
  function loadOnce(u, ok) { if (ok()) return Promise.resolve(); return pend[u] || (pend[u] = load(u).catch(e => { delete pend[u]; throw e; })); }
  let crepeP = null, chordP = null;
  function getCrepe() {                                  // load TensorFlow.js and CREPE once, never twice
    return crepeP || (crepeP = (async () => { await loadOnce(TFJS, () => typeof tf !== 'undefined'); await tf.ready(); return tf.loadLayersModel(g.RKAI_CREPE || CREPE); })().catch(e => { crepeP = null; throw e; }));
  }
  function getChord(say) {                               // load onnxruntime and ChordMini once
    return chordP || (chordP = (async () => {
      await loadOnce(ORT + 'ort.min.js', () => typeof ort !== 'undefined'); ort.env.wasm.wasmPaths = ORT; ort.env.wasm.numThreads = 1;
      const bytes = await getBytes(MODEL_URLS, 'chord model (10 MB, first time only)', say);
      let labels = null; try { labels = findLabels(JSON.parse(new TextDecoder().decode(await getBytes(CONFIG_URLS, 'model labels', say)))); } catch (x) { }
      const sess = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'] });
      return { run: makeRunner(sess, ort.Tensor, 16), labels };
    })().catch(e => { chordP = null; throw e; }));
  }
  let eng = null, node = null;
  const RKAI = {
    on: false,
    async start(o) {
      this.stop(); const say = o.onStatus || (() => { }); let alive = true; this.on = true; this._alive = () => alive; this._kill = () => { alive = false; };
      const ctx = o.ctx;
      const e = new Engine({ lag: o.lag, onChords: o.onChords, onBpm: o.onBpm, onStatus: say }); eng = e;
      // 1. audio tap, resampled to 22.05 kHz
      try {
        await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([`class C extends AudioWorkletProcessor{process(i){const x=i[0][0];if(x)this.port.postMessage(x.slice(0));return true}}registerProcessor('rk-cap',C)`], { type: 'application/javascript' })));
        const src = ctx.createMediaStreamSource(o.stream), lp1 = ctx.createBiquadFilter(), lp2 = ctx.createBiquadFilter(), mute = ctx.createGain();
        lp1.type = lp2.type = 'lowpass'; lp1.frequency.value = lp2.frequency.value = 9000; mute.gain.value = 0;
        node = new AudioWorkletNode(ctx, 'rk-cap'); src.connect(lp1); lp1.connect(lp2); lp2.connect(node); node.connect(mute); mute.connect(ctx.destination);
        const r = ctx.sampleRate / SR; let rin = 0, rout = 0, last = 0;
        node.port.onmessage = ev => { const x = ev.data, out = [];
          for (let i = 0; i < x.length; i++) { const cur = x[i]; while (rout * r <= rin) { out.push(last + (cur - last) * (rout * r - (rin - 1))); rout++; } last = cur; rin++; }
          if (out.length) e.push(Float32Array.from(out)); };
      } catch (err) { say('AI unavailable: ' + err.message); return; }
      if (o.mode === 'vocal') {
        e.noChords = true; const cr = new Crepe(o.onPitch); e.o.onRaw = x => cr.push(x); say('AI: loading singing-pitch model (2 MB)…');
        try { cr.model = await getCrepe(); if (alive) say('AI voice model ready'); }
        catch (err) { say('Voice model unavailable (' + err.message + '). Using the fast pitch tracker.'); }
        return;
      }
      say('AI: listening, loading chord model…');
      // 2. the model
      try {
        const c = await getChord(say); e.labels = c.labels || fallbackLabels(); e.model = c.run; const labels = c.labels;
        if (alive) say('AI model ready' + (labels ? '' : ' (default labels)'));
      } catch (err) { say('AI model unavailable (' + err.message + '). Using the fast engine.'); }
    },
    stop() { this.on = false; this._kill && this._kill(); try { node && node.disconnect(); } catch (e) { } node = null; eng = null; }
  };
  g.RKAI = RKAI;
  if (typeof module !== 'undefined') module.exports = { getCrepe, makeRunner, Crepe, kernels, cqtFrame, tempo, Engine, parseLabel, findLabels, fallbackLabels, smoothArgmax, SR, HOP, WIN, NB, FR };
})(typeof window !== 'undefined' ? window : globalThis);

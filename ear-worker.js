/* ear-worker.js — runs Spotify Basic Pitch (TF.js) off the main thread.
 * Uses the WASM backend when it loads (much faster than plain JS),
 * falls back to the CPU backend otherwise.
 *
 * Messages in:  { kind:'init' } | { kind:'transcribe', id, pcm (Float32Array @22050Hz mono), windowStart }
 * Messages out: { kind:'ready', backend } | { kind:'notes', id, notes:[{midi,start,dur,amp}] } | { kind:'error', id, message }
 *
 * Note: all three imports below resolve to the SAME tfjs module instance
 * (same canonical jsdelivr URLs), so setBackend('wasm') here also applies
 * to the copy of tfjs bundled inside @spotify/basic-pitch.
 */
import * as tf from 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.19.0/+esm';
import { BasicPitch, outputToNotesPoly, noteFramesToTime } from 'https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/+esm';

let bp = null;
let backendName = 'cpu';
let backendTried = false;

async function ensureBackend() {
  if (backendTried) return;
  backendTried = true;
  // NOTE 2026-10-14: the WASM backend passes a smoke test but then fails
  // inside Basic Pitch's inference with "Unknown dtype undefined" — an
  // op-level incompatibility in tfjs 3.19.0's WASM kernels for this model
  // (verified: CPU transcribes the same audio correctly). The CPU backend is
  // ~2x slower than realtime, but correct; the adaptive mic pump in ear.html
  // skips stale audio so the app stays usable.
  try {
    await tf.setBackend('cpu');
    await tf.ready();
  } catch (e) { /* keep default */ }
  backendName = tf.getBackend();
}

async function ensureModel() {
  await ensureBackend();
  if (!bp) {
    // Model weights load from jsDelivr (pinned to an immutable commit —
    // the TF.js binary shard can't be pushed through the GitHub file API).
    bp = new BasicPitch('https://cdn.jsdelivr.net/gh/spotify/basic-pitch-ts@2d498f82b61c71898edf0e8dd661b99076676c8b/model/model.json');
    await bp.model; // wait for the graph + weights to actually load
  }
  return bp;
}

onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.kind === 'init') {
      await ensureModel();
      postMessage({ kind: 'ready', backend: backendName });
      return;
    }
    if (msg.kind === 'transcribe') {
      const model = await ensureModel();
      const frames = [], onsets = [];
      await model.evaluateModel(
        msg.pcm,
        (f, o) => { frames.push(...f); onsets.push(...o); },
        () => {}
      );
      const events = outputToNotesPoly(frames, onsets, 0.55, 0.35, 11);
      // Drop micro-blips: phantom notes poison key/chord detection on real audio.
      const notes = noteFramesToTime(events).filter(n => n.durationSeconds >= 0.07).map(n => ({
        midi: n.pitchMidi,
        start: msg.windowStart + n.startTimeSeconds,
        dur: Math.max(0.05, n.durationSeconds),
        amp: Math.max(0, Math.min(1, n.amplitude || 0)),
      })).filter(n => n.midi >= 21 && n.midi <= 108);
      postMessage({ kind: 'notes', id: msg.id, notes });
      return;
    }
  } catch (err) {
    const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 8).join(' | ') : '';
    postMessage({ kind: 'error', id: msg.id, message: String((err && err.message) || err) + (stack ? ' :: STACK :: ' + stack : '') });
  }
};

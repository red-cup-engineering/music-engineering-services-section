// render-worker.mjs
//
// worker_threads (node:worker_threads, built-in -- no new runtime
// dependency) entry point that performs exactly one render + WAV encode off
// the main thread. renderTrack() is synchronous, CPU-bound JS: running it
// on the main thread would block the whole HTTP server (including /health
// and any other in-flight request) for the render's full wall-clock time.
// http-server.mjs spawns one of these per accepted /generate job (bounded
// by a small concurrency cap -- see that file's header comment for why a
// full job-queue system wasn't built for this pass).
//
// Protocol: workerData = { params }, where params is whatever
// presets.mjs's resolveGenerateParams() produced (already validated by the
// main thread before the worker is spawned). Posts back exactly one message:
//   { ok: true, wav: ArrayBuffer, meta: {...} }
//   { ok: false, error: string }

import { parentPort, workerData } from 'node:worker_threads';
import { renderTrack } from '../generative/compose.mjs';
import { renderLoopableTrack } from './presets.mjs';
import { encodeWav } from "@red-cup-engineering/computer-audio-engineering-services-section/wav-writer";

function run() {
  const { params } = workerData;

  const track = params.loop
    ? renderLoopableTrack(params)
    : renderTrack(params);

  const wavBuffer = encodeWav({
    sampleRate: track.sampleRate,
    numChannels: track.numChannels ?? 2,
    bitDepth: 24,
    bufferL: track.left,
    bufferR: track.right,
  });

  // Copy into a fresh, exactly-sized ArrayBuffer so it can be transferred
  // (zero-copy handoff back to the main thread) rather than structured-
  // cloned.
  const wavArrayBuffer = wavBuffer.buffer.slice(wavBuffer.byteOffset, wavBuffer.byteOffset + wavBuffer.byteLength);

  const meta = {
    sampleRate: track.sampleRate,
    numSamples: track.left.length,
    durationSec: track.left.length / track.sampleRate,
    peak: track.peak,
    rms: track.rms,
    finalRegime: track.finalRegime ?? null,
    spiralCount: track.spiralCount ?? null,
    // regimeTransitions/melodyUniqueDegrees/melodyUniqueDurationsSec were
    // already computed and returned by renderTrack() -- just not previously
    // threaded through to the HTTP response. Real numbers about what the
    // render actually did (how many distinct pitches/durations the melodic
    // grammar produced, how many times the macro-form regime changed), not
    // new instrumentation.
    regimeTransitions: params.loop ? null : track.regimeTransitions ?? null,
    melodyNoteOnsets: track.melodyNoteOnsets ?? 0,
    melodyUniqueDegrees: params.loop ? null : track.melodyUniqueDegrees ?? null,
    melodyUniqueDurationsSec: params.loop ? null : track.melodyUniqueDurationsSec ?? null,
    loop: Boolean(params.loop),
    loopFadeSec: params.loop ? track.loopFadeSec : undefined,
    sourceDurationSec: params.loop ? track.sourceDurationSec : undefined,
  };

  parentPort.postMessage({ ok: true, wav: wavArrayBuffer, meta }, [wavArrayBuffer]);
}

try {
  run();
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}

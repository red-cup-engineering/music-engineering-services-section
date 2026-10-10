#!/usr/bin/env node
// http-server.mjs
//
// Plain node:http HTTP microservice wrapping the generative ambient engine
// (renderTrack(), src/generative/compose.mjs) so other services in the
// system (e.g. the browser games at play.561.group and its siblings) can
// request audio on demand over a normal HTTP request instead of running
// this package as a one-off CLI script. No framework, no runtime
// dependencies -- same zero-dependency convention as the rest of this
// package (package.json's own description: "a zero-dependency, pure-Node
// DSP core").
//
// Routes:
//   GET  /health    -> 200 JSON liveness/status check
//   GET  /presets   -> 200 JSON listing of every named preset and mood
//   GET  /schema    -> 200 JSON structured description of the real
//                       /generate parameter space (see presets.mjs's
//                       buildParameterSchema) -- what the web GUI
//                       (src/service/web/) reads to build its controls
//   POST /generate  -> 200 audio/wav body, or 4xx/5xx JSON {error, ...}
//   GET  /, /web/*  -> the static Tufte-flavored web GUI (src/service/web/)
//
// --- Concurrency / blocking, read this before relying on this in prod ----
//
// renderTrack() is synchronous, CPU-bound JS. Running it directly on the
// HTTP server's own thread would block the whole event loop -- including
// /health and every other in-flight request -- for the render's full
// wall-clock duration (measured ~1:9 of the requested audio duration, e.g.
// a 30s render takes ~3.3s wall clock on the machine this was built on).
// To avoid that, every render runs in a separate node:worker_threads
// Worker (render-worker.mjs) rather than inline here, so the main thread
// stays responsive to /health and to accepting new connections while a
// render is in flight.
//
// That said, this is deliberately NOT a full job-queue system: there is no
// persistence, no retry, no job IDs/polling -- a request just waits (HTTP
// connection held open) until its worker finishes or MAX_CONCURRENT_RENDERS
// workers are busy, in which case it queues in-process (FIFO) behind
// whichever requests got there first. If the process restarts, any
// in-flight or queued request is simply lost -- fine for the "give me a
// short clip on demand" use case this was built for, not fine as a
// general-purpose render pipeline. For genuinely long-running or
// high-volume rendering, a real queue (with persistence and backpressure)
// would be the next step, not a bigger version of this.
//
// MAX_CONCURRENT_RENDERS (default 2) bounds how many renders run in
// parallel worker threads at once; anything beyond that queues. Set via the
// MAX_CONCURRENT_RENDERS env var. Each concurrent render is real CPU work
// (worker_threads are OS threads, not free parallelism on a single core),
// so raising this past the number of available CPU cores just means more
// renders competing for the same cores rather than more real throughput.

import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { resolveGenerateParams, buildParameterSchema, PRESETS, STINGER_PRESETS, BED_PRESETS, MOOD_PRESETS, DURATION_LIMITS, LOOP_LIMITS } from './presets.mjs';

const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const WORKER_PATH = resolve(SERVICE_ROOT, 'render-worker.mjs');
const WEB_ROOT = resolve(SERVICE_ROOT, 'web');

const PORT = Number(process.env.PORT) || 5610;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_CONCURRENT_RENDERS = Number(process.env.MAX_CONCURRENT_RENDERS) || 2;
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS) || 120000;
const MAX_BODY_BYTES = 64 * 1024; // request bodies are just a handful of small fields

const startedAt = Date.now();

// --- tiny in-process render job queue (bounded worker_thread concurrency) --

let activeRenders = 0;
const queue = [];

function pumpQueue() {
  if (activeRenders >= MAX_CONCURRENT_RENDERS) return;
  const job = queue.shift();
  if (!job) return;
  activeRenders += 1;

  const worker = new Worker(WORKER_PATH, { workerData: { params: job.params } });
  let settled = false;

  const finish = (fn) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn();
  };

  const timer = setTimeout(() => {
    finish(() => job.reject(new Error(`render timed out after ${RENDER_TIMEOUT_MS}ms`)));
    worker.terminate();
  }, RENDER_TIMEOUT_MS);

  worker.once('message', (msg) => {
    finish(() => {
      if (msg.ok) job.resolve({ wav: Buffer.from(msg.wav), meta: msg.meta });
      else job.reject(new Error(msg.error));
    });
    worker.terminate();
  });

  worker.once('error', (err) => {
    finish(() => job.reject(err));
  });

  worker.once('exit', () => {
    activeRenders -= 1;
    pumpQueue();
  });
}

function runRenderJob(params) {
  return new Promise((resolvePromise, rejectPromise) => {
    queue.push({ params, resolve: resolvePromise, reject: rejectPromise });
    pumpQueue();
  });
}

// --- tiny request helpers ---------------------------------------------------

function sendJson(res, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let received = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        rejectPromise(Object.assign(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectPromise(Object.assign(new Error('request body is not valid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', rejectPromise);
  });
}

function summarizePresets(table) {
  const out = {};
  for (const [id, preset] of Object.entries(table)) {
    out[id] = { ...preset };
  }
  return out;
}

// --- route handlers ----------------------------------------------------------

function handleHealth(req, res) {
  sendJson(res, 200, {
    status: 'ok',
    service: '@red-cup-engineering/music-engineering-services-section',
    uptimeSec: (Date.now() - startedAt) / 1000,
    activeRenders,
    queuedRenders: queue.length,
    maxConcurrentRenders: MAX_CONCURRENT_RENDERS,
  });
}

function handlePresets(req, res) {
  sendJson(res, 200, {
    stingers: summarizePresets(STINGER_PRESETS),
    beds: summarizePresets(BED_PRESETS),
    moods: MOOD_PRESETS,
    durationLimits: DURATION_LIMITS,
    loopLimits: LOOP_LIMITS,
  });
}

function handleSchema(req, res) {
  sendJson(res, 200, buildParameterSchema());
}

// --- static web GUI (src/service/web/) --------------------------------------
//
// Deliberately tiny and hand-rolled rather than reaching for a static-file
// middleware package: a fixed, explicit map of the handful of files the GUI
// actually has, read into memory once at startup (they're a few KB of plain
// HTML/CSS/JS, not worth re-reading from disk per request) and served with
// the right Content-Type. No wildcard filesystem serving, so there's no path
// traversal surface to worry about -- a request for anything not in this map
// falls through to the ordinary 404 handler below.
const STATIC_FILES = {
  '/': { root: WEB_ROOT, file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { root: WEB_ROOT, file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { root: WEB_ROOT, file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { root: WEB_ROOT, file: 'style.css', type: 'text/css; charset=utf-8' },
  // Served as-is (not rendered) so the GUI's "see ../README.md" link works
  // without needing a markdown renderer -- a plain-text fallback, not a
  // second UI.
  '/README.md': { root: SERVICE_ROOT, file: 'README.md', type: 'text/plain; charset=utf-8' },
};

const staticFileCache = new Map();

async function handleStatic(req, res, entry) {
  try {
    const cacheKey = `${entry.root}/${entry.file}`;
    let body = staticFileCache.get(cacheKey);
    if (body === undefined) {
      body = await readFile(resolve(entry.root, entry.file));
      staticFileCache.set(cacheKey, body);
    }
    res.writeHead(200, { 'Content-Type': entry.type, 'Content-Length': body.length });
    res.end(body);
  } catch (err) {
    sendJson(res, 500, { error: 'failed to read static file', detail: err.message });
  }
}

async function handleGenerate(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: err.message });
    return;
  }

  const resolved = resolveGenerateParams(body);
  if (!resolved.ok) {
    sendJson(res, 400, { error: 'invalid request', details: resolved.errors });
    return;
  }

  let result;
  try {
    result = await runRenderJob(resolved.params);
  } catch (err) {
    const timedOut = /timed out/.test(err.message);
    sendJson(res, timedOut ? 504 : 500, { error: timedOut ? 'render timed out' : 'render failed', detail: err.message });
    return;
  }

  const { wav, meta } = result;
  const headers = {
    'Content-Type': 'audio/wav',
    'Content-Length': wav.length,
    'X-Track-Duration-Sec': String(meta.durationSec),
    'X-Track-Sample-Rate': String(meta.sampleRate),
    'X-Track-Peak': String(meta.peak),
    'X-Track-Rms': String(meta.rms),
    'X-Track-Loop': String(meta.loop),
    // Real generative-process facts already computed by renderTrack() --
    // exposed here rather than left inside the worker's meta object, so a
    // client (the web GUI included) can show actual numbers about what the
    // render did (how many times the macro-form regime changed, how many
    // distinct scale degrees/durations the melodic grammar produced) instead
    // of nothing at all.
    'X-Track-Final-Regime': String(meta.finalRegime ?? ''),
    'X-Track-Spiral-Count': String(meta.spiralCount ?? ''),
    'X-Track-Melody-Note-Onsets': String(meta.melodyNoteOnsets ?? 0),
  };
  if (meta.regimeTransitions !== null && meta.regimeTransitions !== undefined) headers['X-Track-Regime-Transitions'] = String(meta.regimeTransitions);
  if (meta.melodyUniqueDegrees !== null && meta.melodyUniqueDegrees !== undefined) headers['X-Track-Melody-Unique-Degrees'] = String(meta.melodyUniqueDegrees);
  if (meta.melodyUniqueDurationsSec !== null && meta.melodyUniqueDurationsSec !== undefined) headers['X-Track-Melody-Unique-Durations'] = String(meta.melodyUniqueDurationsSec);
  res.writeHead(200, headers);
  res.end(wav);
}

// --- server --------------------------------------------------------------

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    handleHealth(req, res);
    return;
  }
  if (url.pathname === '/presets' && req.method === 'GET') {
    handlePresets(req, res);
    return;
  }
  if (url.pathname === '/schema' && req.method === 'GET') {
    handleSchema(req, res);
    return;
  }
  if (url.pathname === '/generate' && req.method === 'POST') {
    handleGenerate(req, res).catch((err) => {
      sendJson(res, 500, { error: 'internal error', detail: err.message });
    });
    return;
  }
  const staticEntry = STATIC_FILES[url.pathname];
  if (staticEntry && req.method === 'GET') {
    handleStatic(req, res, staticEntry).catch((err) => {
      sendJson(res, 500, { error: 'internal error', detail: err.message });
    });
    return;
  }
  if (url.pathname === '/generate' || url.pathname === '/health' || url.pathname === '/presets' || url.pathname === '/schema' || staticEntry) {
    sendJson(res, 405, { error: `method ${req.method} not allowed on ${url.pathname}` });
    return;
  }
  sendJson(res, 404, { error: `not found: ${url.pathname}` });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, HOST, () => {
    console.log(`music-engineering-services-section HTTP service listening on http://${HOST}:${PORT}`);
    console.log(`  GET  http://${HOST}:${PORT}/            (web GUI)`);
    console.log(`  GET  http://${HOST}:${PORT}/health`);
    console.log(`  GET  http://${HOST}:${PORT}/presets`);
    console.log(`  GET  http://${HOST}:${PORT}/schema`);
    console.log(`  POST http://${HOST}:${PORT}/generate`);
  });
}

export { server };

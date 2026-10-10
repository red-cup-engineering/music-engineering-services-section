#!/usr/bin/env node
// client-example.mjs
//
// Minimal, runnable example of how another Node service (e.g. one of the
// play.561.group game sites, or a build step for one) would pull audio out
// of this service over plain HTTP -- no client library, just fetch() and
// fs. Requires the server to already be running (`npm run serve`, or
// `node src/service/http-server.mjs`).
//
// Usage:
//   node src/service/client-example.mjs
//   node src/service/client-example.mjs stinger-success ./out/success.wav
//   node src/service/client-example.mjs bed-calm ./out/bed-calm.wav
//   BASE_URL=http://localhost:5610 node src/service/client-example.mjs
//
// Exits nonzero (with a message) on any HTTP-level or WAV-shape problem, so
// it doubles as a quick liveness smoke test for a running server.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5610';

function checkWavHeader(buffer) {
  if (buffer.length < 44) throw new Error(`response too short to be a WAV file (${buffer.length} bytes)`);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('missing RIFF chunk id');
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('missing WAVE format id');
  if (buffer.toString('ascii', 12, 16) !== 'fmt ') throw new Error('missing fmt chunk id');
  const dataByteLength = buffer.readUInt32LE(40);
  if (44 + dataByteLength !== buffer.length) {
    throw new Error(`data chunk size (${dataByteLength}) + header (44) does not match actual file size (${buffer.length})`);
  }
  return {
    sampleRate: buffer.readUInt32LE(24),
    numChannels: buffer.readUInt16LE(22),
    bitsPerSample: buffer.readUInt16LE(34),
    dataByteLength,
  };
}

async function requestTrack(body) {
  const res = await fetch(`${BASE_URL}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text();
    }
    throw new Error(`POST /generate -> HTTP ${res.status}: ${JSON.stringify(detail)}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    headers: {
      durationSec: Number(res.headers.get('x-track-duration-sec')),
      sampleRate: Number(res.headers.get('x-track-sample-rate')),
      peak: Number(res.headers.get('x-track-peak')),
      rms: Number(res.headers.get('x-track-rms')),
      loop: res.headers.get('x-track-loop'),
    },
  };
}

async function main() {
  const [, , presetArg, outArg] = process.argv;
  const preset = presetArg || 'stinger-success';
  const outPath = resolve(outArg || `./data/service-example/${preset}.wav`);

  const healthRes = await fetch(`${BASE_URL}/health`);
  if (!healthRes.ok) throw new Error(`GET /health -> HTTP ${healthRes.status}; is the server running (npm run serve)?`);
  const health = await healthRes.json();
  console.log(`server ok: ${JSON.stringify(health)}`);

  console.log(`requesting preset "${preset}" from ${BASE_URL}/generate ...`);
  const t0 = Date.now();
  const { buffer, headers } = await requestTrack({ preset });
  const wallMs = Date.now() - t0;

  const wavInfo = checkWavHeader(buffer);
  console.log(`got ${buffer.length} bytes in ${wallMs}ms`);
  console.log(`  WAV: ${wavInfo.sampleRate}Hz, ${wavInfo.numChannels}ch, ${wavInfo.bitsPerSample}-bit, ${wavInfo.dataByteLength} data bytes`);
  console.log(`  reported: durationSec=${headers.durationSec} peak=${headers.peak} rms=${headers.rms} loop=${headers.loop}`);

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, buffer);
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});

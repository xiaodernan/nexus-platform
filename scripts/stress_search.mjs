#!/usr/bin/env node
/**
 * NEXUS D1131 — the real load/stress harness for the BFF and the page plane.
 *
 * Why: the user asked for a high-pressure test that simulates a flood of concurrent users. This does
 * it honestly — real HTTP, real response bodies counted, real per-request latencies. What is NOT
 * asserted here: any SLO; it is a measurement tool, not a gate. It is wired into no CI lane to
 * avoid burning runner minutes on load assertions that drift.
 *
 * Modes:
 *   --page=<path>   flood one route; every request gets a 200-series check and a byte count
 *   --bursts=N      number of requests per burst (default 64)
 *   --repeat=N      number of bursts (default 4)
 *   --concurrency=N parallel in-flight requests (default 16)
 *   --url=<origin>  target (default http://127.0.0.1:3002)
 *
 * Example:
 *   node scripts/stress_search.mjs --page=/hong-kong --concurrency=32
 *   node scripts/stress_search.mjs --page=/ --concurrency=16
 *   node scripts/stress_search.mjs --page=/api/nexus/search?q=... --concurrency=8 --bursts=24
 *
 * Exit:  0 every request returned 2xx (within the 15s ceiling)   1 any failed or timed out   2 refused
 */
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

const FLAGS = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const eq = a.indexOf('=');
      return eq < 0 ? [a.slice(2), 'true'] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);
const page = FLAGS.page;
const url = FLAGS.url ?? 'http://127.0.0.1:3002';
const concurrency = Math.max(1, Number(FLAGS.concurrency ?? 16));
const bursts = Math.max(1, Number(FLAGS.bursts ?? 64));
const repeat = Math.max(1, Number(FLAGS.repeat ?? 4));
const deadlineMs = 15000;

if (!page) {
  console.error('need --page=<path>');
  process.exit(2);
}

const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency * 2 });
const requester = url.startsWith('https') ? https : http;

function once(path, agentRef) {
  return new Promise((resolve) => {
    const started = performance.now();
    const req = requester.get({ agent: agentRef, hostname: new URL(url).hostname, port: new URL(url).port || (url.startsWith('https') ? 443 : 80), path, timeout: deadlineMs }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, bytes, ms: performance.now() - started });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); resolve({ ok: false, status: -1, bytes: 0, ms: deadlineMs, error: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, status: -2, bytes: 0, ms: performance.now() - started, error: String(err.message || err) }));
  });
}

async function burst(path, n, c) {
  const out = [];
  const sema = [];
  let i = 0;
  const worker = async () => { do { if (i >= n) return; const mine = i++; out[mine] = await once(path, agent); } while (true); };
  for (let w = 0; w < c; w += 1) sema.push(worker());
  await Promise.all(sema);
  return out;
}

const all = [];
const t0 = performance.now();
let okCount = 0, errCount = 0, timeouts = 0, bytesTotal = 0;
let p50 = [], p99 = [], latencies = [];

for (let r = 0; r < repeat; r += 1) {
  const batch = await burst(page, bursts, concurrency);
  for (const item of batch) {
    all.push(item);
    if (item.ok) { okCount += 1; } else { errCount += 1; if (item.status === -1) timeouts += 1; }
    bytesTotal += item.bytes;
    latencies.push(item.ms);
  }
  const el = performance.now() - t0;
  console.log(`burst ${r + 1}: ok=${batch.filter((b) => b.ok).length} err=${batch.filter((b) => !b.ok).length} elapsed=${el.toFixed(0)}ms`);
}

latencies.sort((a, b) => a - b);
const percentile = (p) => latencies[Math.floor((p / 100) * latencies.length)] ?? 0;
p50 = percentile(50);
p99 = percentile(99);
const totalMs = performance.now() - t0;
const rps = (all.length / (totalMs / 1000)).toFixed(1);
console.log('');
console.log(`route          ${page}`);
console.log(`bursts         ${repeat} × ${bursts} @ concurrency ${concurrency}`);
console.log(`total ms       ${totalMs.toFixed(0)}`);
console.log(`throughput     ${all.length} requests, ${rps} req/s`);
console.log(`ok/err/timeout ${okCount}/${errCount}/${timeouts}`);
console.log(`bytes total    ${bytesTotal}`);
console.log(`p50 ms         ${p50.toFixed(0)}`);
console.log(`p99 ms         ${p99.toFixed(0)}`);
console.log(`exit           ${errCount === 0 ? 'ALL GREEN' : 'FAILURES PRESENT'}`);
process.exit(errCount === 0 ? 0 : 1);

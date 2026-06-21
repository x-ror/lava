// HTTP server benchmark: run the hello-world fixture (bench/http/server.js) under Node,
// Lava, and Bun, then measure, per runtime:
//   - throughput: req/s and latency (p50/p99) under a fixed concurrency, closed-loop
//     keep-alive load for a fixed duration;
//   - memory/connection: marginal server RSS while holding N idle keep-alive connections.
// Report-only (the "benchmark gate" for the io_uring memory-per-connection thesis). Run
// under Node: `node bench/http/run-http-bench.mjs`. Env: NODE_BIN, LAVA_BIN, BUN_BIN,
// HTTP_BENCH_CONNS, HTTP_BENCH_DURATION_MS, HTTP_BENCH_IDLE_CONNS.
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SERVER = join(HERE, 'server.js');
const NODE_BIN = process.env.NODE_BIN || 'node';
const LAVA_BIN = process.env.LAVA_BIN || join(ROOT, 'bin', 'lava');
const BUN_BIN = process.env.BUN_BIN || 'bun';

const CONNS = Number(process.env.HTTP_BENCH_CONNS || 50);
const DURATION_MS = Number(process.env.HTTP_BENCH_DURATION_MS || 3000);
const IDLE_CONNS = Number(process.env.HTTP_BENCH_IDLE_CONNS || 1000);
const REQ = 'GET / HTTP/1.1\r\nHost: b\r\n\r\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnServer(launch) {
  return new Promise((resolve, reject) => {
    const child = spawn(launch[0], launch.slice(1), { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    const onData = (d) => {
      buf += d;
      const m = buf.match(/READYPORT=(\d+)/);
      if (m) {
        child.stdout.off('data', onData);
        resolve({ child, port: Number(m[1]) });
      }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    child.on('exit', (c) => reject(new Error(`server exited early (code ${c})`)));
    setTimeout(() => reject(new Error('server did not report READYPORT')), 5000);
  });
}

function rss(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

// One closed-loop keep-alive connection: send a request, parse the Content-Length response,
// send the next, until `deadline`. Records per-request latency into `lat`.
function loadConn(port, deadline, lat, counter) {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let need = -1;
    let headEnd = -1;
    let start = 0;
    const fire = () => {
      if (Date.now() >= deadline) {
        c.destroy();
        return;
      }
      start = performance.now();
      c.write(REQ);
    };
    c.on('connect', fire);
    c.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      for (;;) {
        if (headEnd < 0) {
          const i = buf.indexOf('\r\n\r\n');
          if (i < 0) return;
          headEnd = i + 4;
          const m = buf
            .slice(0, i)
            .toString('latin1')
            .match(/content-length:\s*(\d+)/i);
          need = headEnd + (m ? Number(m[1]) : 0);
        }
        if (buf.length < need) return;
        buf = buf.slice(need);
        headEnd = -1;
        need = -1;
        lat.push(performance.now() - start);
        counter.n++;
        fire();
        if (buf.length === 0) return;
      }
    });
    c.on('close', resolve);
    c.on('error', resolve);
  });
}

// Preferred throughput driver: autocannon (the standard Node HTTP benchmark — proper
// warmup and HdrHistogram latency). Run via bunx/npx so it needs no committed dependency;
// returns null if unavailable so the caller falls back to the built-in generator.
function autocannonThroughput(port) {
  const durationSec = Math.max(1, Math.round(DURATION_MS / 1000));
  const args = [
    'autocannon',
    '-c',
    String(CONNS),
    '-d',
    String(durationSec),
    '-j',
    `http://127.0.0.1:${port}/`,
  ];
  for (const runner of ['bunx', 'npx']) {
    try {
      const out = execFileSync(runner, runner === 'npx' ? ['--yes', ...args] : args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 16 * 1024 * 1024,
      });
      const r = JSON.parse(out);
      return {
        rps: Math.round(r.requests.average),
        p50: +Number(r.latency.p50).toFixed(3),
        p99: +Number(r.latency.p99).toFixed(3),
        errors: (r.errors || 0) + (r.timeouts || 0) + (r.non2xx || 0),
        tool: 'autocannon',
      };
    } catch {
      // try the next runner, else fall through to the built-in generator
    }
  }
  return null;
}

async function throughput(port) {
  const lat = [];
  const counter = { n: 0 };
  const deadline = Date.now() + DURATION_MS;
  const conns = [];
  for (let i = 0; i < CONNS; i++) conns.push(loadConn(port, deadline, lat, counter));
  await Promise.all(conns);
  lat.sort((a, b) => a - b);
  const pct = (p) =>
    lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : 0;
  return {
    rps: Math.round(counter.n / (DURATION_MS / 1000)),
    p50: +pct(50).toFixed(3),
    p99: +pct(99).toFixed(3),
  };
}

// Hold IDLE_CONNS keep-alive connections open (one request each, then idle) and measure the
// marginal server RSS over an idle baseline.
async function memPerConn(port, pid) {
  await sleep(500); // let the runtime's own startup memory settle before the baseline
  const base = rss(pid);
  const sockets = [];
  let established = 0;
  await new Promise((resolve) => {
    let pending = IDLE_CONNS;
    for (let i = 0; i < IDLE_CONNS; i++) {
      const c = net.connect(port, '127.0.0.1');
      sockets.push(c);
      c.on('connect', () => c.write(REQ));
      c.once('data', () => {
        established++;
        if (--pending === 0) resolve();
      });
      c.on('error', () => {
        if (--pending === 0) resolve();
      });
    }
    setTimeout(resolve, 4000); // safety
  });
  await sleep(600); // let the server settle with all connections held
  const held = rss(pid);
  for (const c of sockets) c.destroy();
  const perConn = established > 0 ? Math.round((held - base) / established) : 0;
  return { established, baseKB: Math.round(base / 1024), heldKB: Math.round(held / 1024), perConn };
}

async function benchRuntime(name, launch) {
  // Throughput and memory each get a FRESH server so the throughput run's JIT warmup /
  // GC churn doesn't pollute the idle-memory baseline.
  let tput, mem;
  let srv;
  try {
    srv = await spawnServer(launch);
  } catch (e) {
    return { name, error: e.message };
  }
  try {
    await sleep(200);
    tput = autocannonThroughput(srv.port);
    if (!tput) tput = { ...(await throughput(srv.port)), tool: 'builtin' };
  } finally {
    srv.child.kill('SIGKILL');
  }
  await sleep(150);
  try {
    srv = await spawnServer(launch);
  } catch (e) {
    return { name, ...tput, error: e.message };
  }
  try {
    mem = await memPerConn(srv.port, srv.child.pid);
  } finally {
    srv.child.kill('SIGKILL');
  }
  return { name, ...tput, ...mem };
}

async function main() {
  const targets = [
    { name: 'node', launch: [NODE_BIN, SERVER] },
    { name: 'lava', launch: [LAVA_BIN, 'run', SERVER] },
    { name: 'bun', launch: [BUN_BIN, SERVER] },
  ];
  console.log(
    `HTTP server bench — conns=${CONNS} duration=${DURATION_MS}ms idle-conns=${IDLE_CONNS}\n`,
  );
  const rows = [];
  for (const t of targets) {
    const r = await benchRuntime(t.name, t.launch);
    rows.push(r);
    if (r.error) console.log(`${t.name.padEnd(6)} — skipped (${r.error})`);
  }
  const loadTool = (rows.find((r) => r.tool) || {}).tool || 'builtin';
  console.log(`\nload generator: ${loadTool}`);
  console.log('runtime    req/s     p50(ms)  p99(ms)   errors    mem/conn   (idle conns)');
  console.log('-------    -----     -------  -------   ------    --------   ------------');
  for (const r of rows) {
    if (r.error) continue;
    const perKB = (r.perConn / 1024).toFixed(1) + ' KiB';
    const errs = r.errors === undefined ? 'n/a' : String(r.errors);
    console.log(
      `${r.name.padEnd(8)} ${String(r.rps).padStart(8)}  ${String(r.p50).padStart(7)}  ${String(r.p99).padStart(7)}   ${errs.padStart(6)}    ${perKB.padStart(8)}   (${r.established})`,
    );
  }
  // Relative to node, if present.
  const node = rows.find((r) => r.name === 'node' && !r.error);
  if (node) {
    console.log('\nvs node (req/s ratio):');
    for (const r of rows) {
      if (r.error || r.name === 'node') continue;
      console.log(
        `  ${r.name}: ${(r.rps / node.rps).toFixed(2)}x throughput, ${(r.perConn / node.perConn).toFixed(2)}x mem/conn`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

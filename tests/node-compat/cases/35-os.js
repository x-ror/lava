// node:os — the values are mostly host- and run-specific (memory, uptime, cpus,
// load average, network interfaces), so this case asserts their SHAPE and the
// invariants Node guarantees rather than the raw magnitudes, then prints only the
// handful of values that are a deterministic function of the host (platform,
// arch, type, endianness, EOL, devNull, homedir/tmpdir derived from the shared
// environment) so Node and Lava produce byte-identical output.
const assert = require('node:assert/strict');
const os = require('node:os');

// ---- module surface --------------------------------------------------------
for (const fn of [
  'arch',
  'platform',
  'type',
  'release',
  'version',
  'machine',
  'hostname',
  'endianness',
  'homedir',
  'tmpdir',
  'totalmem',
  'freemem',
  'uptime',
  'loadavg',
  'cpus',
  'availableParallelism',
  'getPriority',
  'setPriority',
  'networkInterfaces',
  'userInfo',
]) {
  assert.equal(typeof os[fn], 'function', `os.${fn} should be a function`);
}
assert.equal(typeof os.constants, 'object');
assert.equal(typeof os.EOL, 'string');
assert.equal(typeof os.devNull, 'string');

// ---- os.platform()/arch() track process; type() is a fixed sysname ----------
assert.equal(os.platform(), process.platform);
assert.equal(os.arch(), process.arch);
assert.equal(['Linux', 'Darwin', 'Windows_NT'].includes(os.type()), true);
assert.equal(os.endianness() === 'LE' || os.endianness() === 'BE', true);
assert.equal(os.EOL, process.platform === 'win32' ? '\r\n' : '\n');

// ---- string accessors are non-empty strings --------------------------------
for (const fn of ['release', 'version', 'machine', 'hostname']) {
  const v = os[fn]();
  assert.equal(typeof v, 'string', `os.${fn}() should be a string`);
  assert.ok(v.length > 0, `os.${fn}() should be non-empty`);
}

// ---- homedir/tmpdir: absolute, non-empty, no trailing separator (POSIX) -----
const home = os.homedir();
const tmp = os.tmpdir();
assert.equal(typeof home, 'string');
assert.ok(home.length > 0);
assert.equal(typeof tmp, 'string');
assert.ok(tmp.length > 0);
if (process.platform !== 'win32') {
  assert.ok(home.startsWith('/'), 'POSIX homedir is absolute');
  assert.ok(tmp.startsWith('/'), 'POSIX tmpdir is absolute');
  // libuv trims a trailing slash (except the root).
  assert.ok(tmp === '/' || !tmp.endsWith('/'), 'tmpdir has no trailing slash');
}

// ---- memory / uptime: positive numbers; free never exceeds total ------------
const total = os.totalmem();
const free = os.freemem();
assert.equal(typeof total, 'number');
assert.ok(total > 0, 'totalmem is positive');
assert.equal(Number.isInteger(total), true);
assert.equal(typeof free, 'number');
assert.ok(free >= 0, 'freemem is non-negative');
assert.ok(free <= total, 'freemem does not exceed totalmem');

const up = os.uptime();
assert.equal(typeof up, 'number');
assert.ok(up >= 0, 'uptime is non-negative');

// ---- loadavg(): exactly three finite, non-negative numbers ------------------
const load = os.loadavg();
assert.ok(Array.isArray(load));
assert.equal(load.length, 3);
for (const n of load) {
  assert.equal(typeof n, 'number');
  assert.ok(Number.isFinite(n) && n >= 0, 'loadavg entries are finite and >= 0');
}

// ---- availableParallelism(): a positive integer -----------------------------
const par = os.availableParallelism();
assert.equal(typeof par, 'number');
assert.equal(Number.isInteger(par), true);
assert.ok(par >= 1, 'availableParallelism is at least 1');

// ---- cpus(): a non-empty array of the Node-shaped records -------------------
const cpus = os.cpus();
assert.ok(Array.isArray(cpus));
assert.ok(cpus.length >= 1, 'at least one CPU');
for (const cpu of cpus) {
  assert.equal(typeof cpu.model, 'string');
  assert.equal(typeof cpu.speed, 'number');
  assert.equal(typeof cpu.times, 'object');
  for (const field of ['user', 'nice', 'sys', 'idle', 'irq']) {
    assert.equal(typeof cpu.times[field], 'number', `cpu.times.${field} is a number`);
    assert.ok(cpu.times[field] >= 0, `cpu.times.${field} is non-negative`);
  }
}

// ---- networkInterfaces(): name -> array of decorated address records --------
const nifs = os.networkInterfaces();
assert.equal(typeof nifs, 'object');
for (const name of Object.keys(nifs)) {
  assert.ok(Array.isArray(nifs[name]));
  for (const rec of nifs[name]) {
    assert.equal(typeof rec.address, 'string');
    assert.equal(typeof rec.netmask, 'string');
    assert.equal(rec.family === 'IPv4' || rec.family === 'IPv6', true);
    assert.equal(typeof rec.mac, 'string');
    assert.equal(typeof rec.internal, 'boolean');
    // cidr is "address/prefix" or null; scopeid is present only for IPv6.
    assert.ok(rec.cidr === null || typeof rec.cidr === 'string');
    if (rec.family === 'IPv6') {
      assert.equal(typeof rec.scopeid, 'number');
    } else {
      assert.equal('scopeid' in rec, false, 'IPv4 records have no scopeid');
    }
  }
}
// On POSIX the loopback interface is always present with an internal record.
// Lava's Windows networkInterfaces is a stub that returns no entries, so this
// existence check is POSIX-only; the per-record shape checks above still apply.
if (process.platform !== 'win32') {
  const loopbackName = Object.keys(nifs).find((name) =>
    nifs[name].some((rec) => rec.internal && rec.address.startsWith('127.')),
  );
  assert.ok(loopbackName !== undefined, 'an internal IPv4 loopback address exists');
}

// ---- userInfo(): the five fields, plus the buffer-encoding variant ----------
const info = os.userInfo();
assert.equal(typeof info.uid, 'number');
assert.equal(typeof info.gid, 'number');
assert.equal(typeof info.username, 'string');
assert.equal(typeof info.homedir, 'string');
assert.ok(info.shell === null || typeof info.shell === 'string');
const infoBuf = os.userInfo({ encoding: 'buffer' });
assert.equal(Buffer.isBuffer(infoBuf.username), true);
assert.equal(Buffer.isBuffer(infoBuf.homedir), true);
assert.equal(typeof infoBuf.uid, 'number');

// ---- getPriority(): an integer in the libuv band; setPriority is callable ---
const prio = os.getPriority();
assert.equal(typeof prio, 'number');
assert.ok(prio >= -20 && prio <= 19, 'priority is within [-20, 19]');
assert.equal(os.getPriority(0), prio); // 0 == current process

// ---- constants: the cross-platform priority band + a few signal numbers -----
const c = os.constants;
assert.equal(c.priority.PRIORITY_NORMAL, 0);
assert.equal(c.priority.PRIORITY_LOW, 19);
assert.equal(c.priority.PRIORITY_HIGHEST, -20);
assert.equal(typeof c.signals.SIGINT, 'number');
assert.equal(typeof c.signals.SIGKILL, 'number');
assert.equal(typeof c.signals.SIGTERM, 'number');
assert.equal(c.UV_UDP_REUSEADDR, 4);

// ---- deterministic, host-stable output (identical under Node and Lava) ------
console.log('platform:', os.platform());
console.log('arch:', os.arch());
console.log('type:', os.type());
console.log('endianness:', os.endianness());
console.log('EOL:', JSON.stringify(os.EOL));
console.log('devNull:', os.devNull);
if (process.platform !== 'win32') {
  // env-derived; printed on POSIX only. Windows env casing / path normalization
  // is covered by the shape asserts above rather than byte-compared here.
  console.log('homedir:', os.homedir());
  console.log('tmpdir:', os.tmpdir());
}
console.log('PRIORITY_NORMAL:', os.constants.priority.PRIORITY_NORMAL);
console.log('os ok');

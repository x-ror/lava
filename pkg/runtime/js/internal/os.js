// node:os — operating-system info, modeled on Node's `os`. The split mirrors
// Node/libuv: anything that is a pure function of process.platform/process.env or
// a fixed per-platform constant is computed here in JS (homedir, tmpdir, EOL,
// devNull, endianness, constants), while the live system numbers that require a
// syscall (hostname, uname, total/free memory, uptime, load average, cpus,
// network interfaces, user info, priority) come from the Odin bridge
// (pkg/runtime/os.odin + the per-platform os_*.odin files) via `native`.
//
// Non-deterministic values (memory, uptime, cpus, …) are returned as-is; the
// node-compat oracle asserts their SHAPE rather than their magnitude, since they
// differ run-to-run and host-to-host.
(function (require, module, exports, native) {
  'use strict';

  if (!native) {
    throw new Error('node:os is unavailable: native bindings missing');
  }

  var isWindows = process.platform === 'win32';

  // ---- endianness: probe the host byte order once (cheap, deterministic) -----
  var _endianness = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 'LE' : 'BE';

  // ---- pure constants --------------------------------------------------------
  var EOL = isWindows ? '\r\n' : '\n';
  var devNull = isWindows ? '\\\\.\\nul' : '/dev/null';

  // os.type() is the uname sysname; for the platforms Node supports it is a fixed
  // string, so map it from process.platform and only fall back to the native
  // uname for anything exotic. Keeps the hot path syscall-free.
  function type() {
    switch (process.platform) {
      case 'linux':
        return 'Linux';
      case 'darwin':
        return 'Darwin';
      case 'win32':
        return 'Windows_NT';
      default:
        return native.type();
    }
  }

  // ---- homedir / tmpdir: libuv's algorithm (env first, then the password DB) --
  function homedir() {
    if (isWindows) {
      return process.env.USERPROFILE || native.homedir();
    }
    return process.env.HOME || native.homedir();
  }

  // uv_os_tmpdir: first env var that is set wins; a trailing separator is trimmed
  // unless the whole path is the root. POSIX consults TMPDIR/TMP/TEMP then /tmp;
  // Windows consults TEMP/TMP then the system root.
  function tmpdir() {
    if (isWindows) {
      var winPath =
        process.env.TEMP ||
        process.env.TMP ||
        (process.env.SystemRoot || process.env.windir || '') + '\\temp';
      // Trim a single trailing backslash, but keep a drive root like "C:\".
      var isDriveRoot = winPath.length === 3 && winPath[1] === ':';
      if (winPath.length > 1 && winPath.endsWith('\\') && !isDriveRoot) {
        winPath = winPath.slice(0, -1);
      }
      return winPath;
    }
    var path = process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    return path;
  }

  // ---- os.constants ----------------------------------------------------------
  // signals + errno are platform-specific numbers straight from the system
  // headers; priority/dlopen/UV are libuv's cross-platform abstraction. Values
  // mirror Node's so feature-detection and `process.kill(pid, 'SIGTERM')`-style
  // lookups resolve to the same numbers the host kernel uses.
  var signals;
  if (process.platform === 'darwin') {
    signals = {
      SIGHUP: 1,
      SIGINT: 2,
      SIGQUIT: 3,
      SIGILL: 4,
      SIGTRAP: 5,
      SIGABRT: 6,
      SIGIOT: 6,
      SIGEMT: 7,
      SIGFPE: 8,
      SIGKILL: 9,
      SIGBUS: 10,
      SIGSEGV: 11,
      SIGSYS: 12,
      SIGPIPE: 13,
      SIGALRM: 14,
      SIGTERM: 15,
      SIGURG: 16,
      SIGSTOP: 17,
      SIGTSTP: 18,
      SIGCONT: 19,
      SIGCHLD: 20,
      SIGTTIN: 21,
      SIGTTOU: 22,
      SIGIO: 23,
      SIGXCPU: 24,
      SIGXFSZ: 25,
      SIGVTALRM: 26,
      SIGPROF: 27,
      SIGWINCH: 28,
      SIGINFO: 29,
      SIGUSR1: 30,
      SIGUSR2: 31,
    };
  } else if (isWindows) {
    signals = {
      SIGHUP: 1,
      SIGINT: 2,
      SIGILL: 4,
      SIGABRT: 22,
      SIGFPE: 8,
      SIGKILL: 9,
      SIGSEGV: 11,
      SIGTERM: 15,
      SIGBREAK: 21,
      SIGWINCH: 28,
    };
  } else {
    signals = {
      SIGHUP: 1,
      SIGINT: 2,
      SIGQUIT: 3,
      SIGILL: 4,
      SIGTRAP: 5,
      SIGABRT: 6,
      SIGIOT: 6,
      SIGBUS: 7,
      SIGFPE: 8,
      SIGKILL: 9,
      SIGUSR1: 10,
      SIGSEGV: 11,
      SIGUSR2: 12,
      SIGPIPE: 13,
      SIGALRM: 14,
      SIGTERM: 15,
      SIGSTKFLT: 16,
      SIGCHLD: 17,
      SIGCONT: 18,
      SIGSTOP: 19,
      SIGTSTP: 20,
      SIGTTIN: 21,
      SIGTTOU: 22,
      SIGURG: 23,
      SIGXCPU: 24,
      SIGXFSZ: 25,
      SIGVTALRM: 26,
      SIGPROF: 27,
      SIGWINCH: 28,
      SIGIO: 29,
      SIGPOLL: 29,
      SIGPWR: 30,
      SIGSYS: 31,
    };
  }

  // libuv priority band (UV_PRIORITY_*): identical on every platform; setPriority
  // clamps user input into [HIGHEST, LOW] = [-20, 19].
  var priority = {
    PRIORITY_LOW: 19,
    PRIORITY_BELOW_NORMAL: 10,
    PRIORITY_NORMAL: 0,
    PRIORITY_ABOVE_NORMAL: -7,
    PRIORITY_HIGH: -14,
    PRIORITY_HIGHEST: -20,
  };

  // dlopen flags (RTLD_*). Linux and Darwin disagree on the bit values, so brand
  // them per host; absent on Windows (no dlopen).
  var dlopen;
  if (process.platform === 'darwin') {
    dlopen = { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_LOCAL: 4, RTLD_GLOBAL: 8 };
  } else if (!isWindows) {
    dlopen = { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0 };
  } else {
    dlopen = {};
  }

  var constants = {
    UV_UDP_REUSEADDR: 4,
    signals: signals,
    priority: priority,
    dlopen: dlopen,
  };

  // ---- cpus(): the native bridge returns plain records; pass them through ----
  // Each entry is { model, speed, times: { user, nice, sys, idle, irq } }, the
  // exact Node shape, so no reshaping is needed here.
  function cpus() {
    return native.cpus();
  }

  // ---- loadavg(): always a 3-element array of numbers (0,0,0 on Windows) -----
  function loadavg() {
    return native.loadavg();
  }

  // ---- networkInterfaces(): group the flat native records by interface name --
  // Native returns a flat list of { name, address, netmask, family (4|6), mac,
  // internal, scopeid }. Node groups them by name and decorates each with the
  // string family ('IPv4'/'IPv6') and a CIDR. scopeid is only meaningful for
  // IPv6 (null otherwise, as in Node).
  function networkInterfaces() {
    var list = native.networkInterfaces();
    var out = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      var entry = {
        address: rec.address,
        netmask: rec.netmask,
        family: rec.family === 6 ? 'IPv6' : 'IPv4',
        mac: rec.mac,
        internal: rec.internal,
      };
      if (rec.family === 6) {
        entry.scopeid = rec.scopeid;
      }
      entry.cidr = toCidr(rec.address, rec.netmask, rec.family);
      if (!out[rec.name]) out[rec.name] = [];
      out[rec.name].push(entry);
    }
    return out;
  }

  // toCidr renders "address/prefixlen" by counting the set bits of the netmask,
  // matching Node's uv_interface_addresses → cidr. Returns null when the netmask
  // is unusable (Node does the same).
  function toCidr(address, netmask, family) {
    var bits = family === 6 ? cidrBitsV6(netmask) : cidrBitsV4(netmask);
    return bits === null ? null : address + '/' + bits;
  }

  function popcount8(n) {
    var c = 0;
    while (n) {
      c += n & 1;
      n >>= 1;
    }
    return c;
  }

  function cidrBitsV4(netmask) {
    var parts = netmask.split('.');
    if (parts.length !== 4) return null;
    var bits = 0;
    for (var i = 0; i < 4; i++) {
      var n = Number(parts[i]);
      if (n < 0 || n > 255 || Number.isNaN(n)) return null;
      bits += popcount8(n);
    }
    return bits;
  }

  function cidrBitsV6(netmask) {
    // Expand "::" and count set bits across the eight 16-bit groups.
    var groups = expandV6(netmask);
    if (groups === null) return null;
    var bits = 0;
    for (var i = 0; i < groups.length; i++) {
      bits += popcount8((groups[i] >> 8) & 0xff) + popcount8(groups[i] & 0xff);
    }
    return bits;
  }

  function expandV6(addr) {
    var halves = addr.split('::');
    if (halves.length > 2) return null;
    var head = halves[0] ? halves[0].split(':') : [];
    var tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    var fill = 8 - head.length - tail.length;
    if (halves.length === 1) {
      if (head.length !== 8) return null;
      fill = 0;
    } else if (fill < 0) {
      return null;
    }
    var groups = [];
    for (var i = 0; i < head.length; i++) groups.push(parseInt(head[i], 16) || 0);
    for (var f = 0; f < fill; f++) groups.push(0);
    for (var j = 0; j < tail.length; j++) groups.push(parseInt(tail[j], 16) || 0);
    return groups.length === 8 ? groups : null;
  }

  // ---- userInfo(): { uid, gid, username, homedir, shell }. The encoding option
  // only affects username/shell/homedir; 'buffer' returns them as Buffers (Node
  // parity). uid/gid are -1 on Windows.
  function userInfo(options) {
    var info = native.userInfo();
    var encoding = options && options.encoding;
    if (encoding && encoding !== 'utf8') {
      var Buffer = require('buffer').Buffer;
      return {
        uid: info.uid,
        gid: info.gid,
        username: Buffer.from(info.username, 'utf8'),
        homedir: Buffer.from(info.homedir, 'utf8'),
        shell: info.shell === null ? null : Buffer.from(info.shell, 'utf8'),
      };
    }
    return info;
  }

  // ---- get/setPriority: thin wrappers; the native side truncates the pid/priority
  // to integers and applies the [-20, 19] clamp. A 0/undefined pid means the
  // current process (Node parity).
  function getPriority(pid) {
    return native.getPriority(pid === undefined ? 0 : pid);
  }

  function setPriority(pid, priorityValue) {
    // Node allows setPriority(priority) — a single arg is the priority, pid = 0.
    if (priorityValue === undefined) {
      priorityValue = pid;
      pid = 0;
    }
    native.setPriority(pid, priorityValue);
  }

  module.exports = {
    arch: function () {
      return process.arch;
    },
    platform: function () {
      return process.platform;
    },
    type: type,
    release: function () {
      return native.release();
    },
    version: function () {
      return native.version();
    },
    machine: function () {
      return native.machine();
    },
    hostname: function () {
      return native.hostname();
    },
    endianness: function () {
      return _endianness;
    },
    homedir: homedir,
    tmpdir: tmpdir,
    totalmem: function () {
      return native.totalmem();
    },
    freemem: function () {
      return native.freemem();
    },
    uptime: function () {
      return native.uptime();
    },
    loadavg: loadavg,
    cpus: cpus,
    availableParallelism: function () {
      return native.availableParallelism();
    },
    getPriority: getPriority,
    setPriority: setPriority,
    networkInterfaces: networkInterfaces,
    userInfo: userInfo,
    constants: constants,
    EOL: EOL,
    devNull: devNull,
  };
});

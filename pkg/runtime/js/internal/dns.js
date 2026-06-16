// node:dns — modeled on Node's dns / dns.promises. Tier 1 (lookup) is backed by
// the OS resolver (getaddrinfo) through the native bridge (pkg/runtime/dns.odin
// -> core:net), run off the event loop. The record-type queries (resolve*,
// reverse, lookupService) and the Resolver class are Tier 2 (c-ares) and throw a
// clear "not implemented" until that backend lands — the full surface is exposed
// so feature-detection and shapes match Node.
(function (require, module, exports, native) {
  'use strict';

  if (!native) {
    throw new Error('node:dns is unavailable: native bindings missing');
  }

  function familyToNumber(f) {
    if (f === 4 || f === 6 || f === 0) return f;
    if (f === 'IPv4') return 4;
    if (f === 'IPv6') return 6;
    return 0;
  }

  function makeDnsError(code, syscall, hostname) {
    var err = new Error(syscall + ' ' + code + (hostname ? ' ' + hostname : ''));
    err.code = code;
    err.errno = code;
    err.syscall = syscall;
    if (hostname !== undefined) err.hostname = hostname;
    return err;
  }

  function validateHostname(name) {
    // Node accepts a falsy hostname (resolves to null); only a non-string truthy
    // value is a type error.
    if (name && typeof name !== 'string') {
      var e = new TypeError('The "hostname" argument must be of type string. Received ' + typeof name);
      e.code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    }
  }

  // dns.lookup(hostname[, options], callback)
  function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== 'function') {
      var e = new TypeError('The "callback" argument must be of type function.');
      e.code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    }
    validateHostname(hostname);

    var family = 0;
    var all = false;
    if (typeof options === 'number') {
      family = familyToNumber(options);
    } else if (options && typeof options === 'object') {
      family = familyToNumber(options.family);
      all = !!options.all;
    }

    // Node returns null/[] for an empty hostname rather than erroring.
    if (!hostname) {
      queueMicrotask(function () {
        if (all) callback(null, []);
        else callback(null, null, family === 6 ? 6 : 4);
      });
      return;
    }

    native.lookup(String(hostname), family, all, function (code, addresses) {
      if (code) {
        callback(makeDnsError(code, 'getaddrinfo', hostname));
        return;
      }
      if (all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    });
  }

  var defaultResultOrder = 'verbatim';
  function setDefaultResultOrder(order) {
    if (order !== 'ipv4first' && order !== 'ipv6first' && order !== 'verbatim') {
      var e = new TypeError(
        "The argument 'order' must be one of 'verbatim', 'ipv4first', 'ipv6first'. Received '" + order + "'"
      );
      e.code = 'ERR_INVALID_ARG_VALUE';
      throw e;
    }
    defaultResultOrder = order;
  }
  function getDefaultResultOrder() {
    return defaultResultOrder;
  }

  // ---- Tier 2 (c-ares) — surface present, not yet implemented ----
  var TIER2 = [
    'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveCaa',
    'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv',
    'resolveTxt', 'reverse', 'lookupService', 'getServers', 'setServers',
  ];

  function notImplemented(name) {
    return function () {
      throw new Error('node:dns ' + name + ' is not implemented in Lava (pending c-ares backend)');
    };
  }

  function Resolver(options) {
    if (!(this instanceof Resolver)) return new Resolver(options);
  }
  TIER2.forEach(function (m) {
    Resolver.prototype[m] = notImplemented('Resolver.' + m);
  });
  Resolver.prototype.cancel = notImplemented('Resolver.cancel');
  Resolver.prototype.setLocalAddress = notImplemented('Resolver.setLocalAddress');

  // ---- promises ----
  function promisesLookup(hostname, options) {
    var all = !!(options && typeof options === 'object' && options.all);
    return new Promise(function (resolve, reject) {
      lookup(hostname, options, function (err, address, family) {
        if (err) {
          reject(err);
        } else if (all) {
          resolve(address); // `address` is the array when all=true
        } else {
          resolve({ address: address, family: family });
        }
      });
    });
  }

  function PromisesResolver(options) {
    if (!(this instanceof PromisesResolver)) return new PromisesResolver(options);
  }
  TIER2.forEach(function (m) {
    PromisesResolver.prototype[m] = notImplemented('promises.Resolver.' + m);
  });
  PromisesResolver.prototype.cancel = notImplemented('promises.Resolver.cancel');

  var promises = {
    lookup: promisesLookup,
    Resolver: PromisesResolver,
    setDefaultResultOrder: setDefaultResultOrder,
    getDefaultResultOrder: getDefaultResultOrder,
  };
  TIER2.forEach(function (m) {
    promises[m] = notImplemented('promises.' + m);
  });

  // ---- error codes & getaddrinfo hint flags (Node parity) ----
  var CODES = {
    NODATA: 'ENODATA', FORMERR: 'EFORMERR', SERVFAIL: 'ESERVFAIL', NOTFOUND: 'ENOTFOUND',
    NOTIMP: 'ENOTIMP', REFUSED: 'EREFUSED', BADQUERY: 'EBADQUERY', BADNAME: 'EBADNAME',
    BADFAMILY: 'EBADFAMILY', BADRESP: 'EBADRESP', CONNREFUSED: 'ECONNREFUSED', TIMEOUT: 'ETIMEOUT',
    EOF: 'EOF', FILE: 'EFILE', NOMEM: 'ENOMEM', DESTRUCTION: 'EDESTRUCTION', BADSTR: 'EBADSTR',
    BADFLAGS: 'EBADFLAGS', NONAME: 'ENONAME', BADHINTS: 'EBADHINTS', NOTINITIALIZED: 'ENOTINITIALIZED',
    LOADIPHLPAPI: 'ELOADIPHLPAPI', ADDRGETNETWORKPARAMS: 'EADDRGETNETWORKPARAMS', CANCELLED: 'ECANCELLED',
  };

  exports.lookup = lookup;
  exports.setDefaultResultOrder = setDefaultResultOrder;
  exports.getDefaultResultOrder = getDefaultResultOrder;
  exports.Resolver = Resolver;
  exports.ADDRCONFIG = 1024;
  exports.V4MAPPED = 2048;
  exports.ALL = 256;
  Object.keys(CODES).forEach(function (k) {
    exports[k] = CODES[k];
  });
  TIER2.forEach(function (m) {
    exports[m] = notImplemented(m);
  });
  exports.promises = promises;
})

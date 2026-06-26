// node:https — HTTPS server (M1), the TLS counterpart of node:http. https.createServer wraps an
// http.Server whose connections are TLS-terminated natively (pkg/runtime/tls_server.odin): the
// SAME request/response machinery (node:http over node:net) runs over the decrypted socket, so
// keep-alive, chunked, and the timeouts all work unchanged.
//
// M1 surface: { key, cert } (PEM strings or Buffers, including a leaf+chain PEM). Deferred (and
// REJECTED rather than silently ignored, so a caller never gets weaker security than asked):
// client-cert auth (requestCert/ca/rejectUnauthorized), SNI (SNICallback), ALPN, ciphers,
// min/maxVersion, passphrase. The HTTPS client (https.request/get/Agent) is provided by fetch and
// is out of scope here.
(function (require, module, exports, native) {
  'use strict';

  if (!native || typeof native.createSecureContext !== 'function') {
    throw new Error('node:https is unavailable on this platform');
  }

  var http = require('http');
  var { Buffer } = require('buffer');

  function unsupported(name) {
    var e = new Error(
      "node:https (M1) does not support the '" +
        name +
        "' option; it is rejected rather than ignored so the connection is never weaker than requested",
    );
    e.code = 'ERR_TLS_UNSUPPORTED_OPTION';
    throw e;
  }

  // Reject the deferred, security-sensitive options — but only when set to a value that would
  // CHANGE behavior, so an ordinary options bag carrying `undefined`/default-equivalent fields
  // (very common when spreading config) still works. Includes the legacy protocol/cipher knobs
  // (secureProtocol/secureOptions/honorCipherOrder/ecdhCurve/dhparam) so a pin via the old API is
  // rejected the same as the modern minVersion/ciphers — never silently weaker than requested.
  function rejectDeferred(options) {
    if (options.requestCert) unsupported('requestCert');
    if (options.rejectUnauthorized === true) unsupported('rejectUnauthorized');
    if (options.ca != null) unsupported('ca');
    if (options.minVersion !== undefined) unsupported('minVersion');
    if (options.maxVersion !== undefined) unsupported('maxVersion');
    if (options.secureProtocol !== undefined) unsupported('secureProtocol');
    if (options.secureOptions !== undefined) unsupported('secureOptions');
    if (options.ciphers !== undefined) unsupported('ciphers');
    if (options.honorCipherOrder !== undefined) unsupported('honorCipherOrder');
    if (options.ecdhCurve !== undefined) unsupported('ecdhCurve');
    if (options.dhparam != null) unsupported('dhparam');
    if (options.passphrase !== undefined) unsupported('passphrase');
    if (typeof options.SNICallback === 'function') unsupported('SNICallback');
    if (options.ALPNProtocols !== undefined) unsupported('ALPNProtocols');
  }

  // Node accepts key/cert as a string, a Buffer, or (for multiple contexts) an array. M1 is one
  // key + one cert (the cert PEM may itself hold leaf+intermediates), so arrays are rejected.
  function toPem(value, field) {
    if (value == null || value === '') {
      var e = new Error("node:https requires the '" + field + "' option");
      e.code = 'ERR_TLS_CERT';
      throw e;
    }
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    if (Array.isArray(value)) {
      var ae = new Error(
        "node:https (M1) supports a single '" +
          field +
          "'; arrays (multiple contexts) are deferred",
      );
      ae.code = 'ERR_TLS_UNSUPPORTED_OPTION';
      throw ae;
    }
    // Anything else (a stray object/number) — throw a clear type error rather than feeding
    // String(value) (e.g. '[object Object]') to OpenSSL and surfacing a confusing ERR_TLS_CERT.
    var te = new TypeError(
      "node:https option '" + field + "' must be a string, Buffer, or Uint8Array (PEM)",
    );
    te.code = 'ERR_INVALID_ARG_TYPE';
    throw te;
  }

  function createServer(options, requestListener) {
    // Unlike http, https has no (requestListener)-only form: key+cert are mandatory.
    if (typeof options === 'function') {
      var e = new Error('node:https requires an options object with `key` and `cert`');
      e.code = 'ERR_TLS_CERT';
      throw e;
    }
    if (!options || typeof options !== 'object') options = {};

    rejectDeferred(options);
    var keyPem = toPem(options.key, 'key');
    var certPem = toPem(options.cert, 'cert');

    // Build + validate the context synchronously: a bad PEM / key-cert mismatch / encrypted key
    // THROWS here, which is exactly where a Node caller's try/catch around createServer expects it.
    var ctxId;
    try {
      ctxId = native.createSecureContext(keyPem, certPem);
    } catch (e) {
      if (e && !e.code) e.code = 'ERR_TLS_CERT';
      throw e;
    }

    // Reuse all of node:http, attaching the TLS context (threaded http.Server → net → native.listen).
    // Pass through the http timeout options too.
    var server = http.createServer(
      {
        tls: ctxId,
        keepAliveTimeout: options.keepAliveTimeout,
        headersTimeout: options.headersTimeout,
        requestTimeout: options.requestTimeout,
      },
      requestListener,
    );

    // Free the context once the server is done with it. After a successful listen the native side
    // owns it (freed on server close), so this no-ops then; it only matters for a context that was
    // built but never listened on (createServer without listen, or a listen that failed). Such a
    // context that is also never closed lingers until process teardown (net_destroy_state frees it),
    // so a long-lived process that repeatedly builds-and-drops unlistened servers accumulates them —
    // acceptable for M1, revisit if it becomes a real pattern.
    var freed = false;
    function freeCtx() {
      if (freed) return;
      freed = true;
      if (typeof native.freeSecureContext === 'function') native.freeSecureContext(ctxId);
    }
    server.once('close', freeCtx);
    server.once('error', freeCtx);

    return server;
  }

  // https.Server: M1 returns an http.Server with TLS transport (not a distinct tls.Server subclass),
  // so `new https.Server(opts, fn)` works but `instanceof https.Server` is not meaningful yet.
  function Server(options, requestListener) {
    return createServer(options, requestListener);
  }

  // Client surface (https.request/get/Agent/globalAgent) is deferred — the HTTPS *client* is `fetch`.
  // Provide throwing stubs rather than leaving them undefined so a dependency that calls
  // https.request(...) gets an actionable message (use fetch) instead of an opaque
  // "https.request is not a function" TypeError.
  function clientUnsupported(name) {
    var e = new Error(
      'node:https client API `' +
        name +
        '` is not implemented; use the global `fetch()` for HTTPS requests',
    );
    e.code = 'ERR_TLS_UNSUPPORTED_OPTION';
    throw e;
  }
  function request() {
    clientUnsupported('https.request');
  }
  function get() {
    clientUnsupported('https.get');
  }
  function Agent() {
    clientUnsupported('https.Agent');
  }

  module.exports = {
    createServer: createServer,
    Server: Server,
    request: request,
    get: get,
    Agent: Agent,
    get globalAgent() {
      return clientUnsupported('https.globalAgent');
    },
  };
});

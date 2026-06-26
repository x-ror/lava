// HTTPS error-case assertions (run under Lava; no server). Validates that https.createServer
// fails SYNCHRONOUSLY and SAFELY: bad/mismatched/encrypted PEM throws (never a deferred handshake
// failure, and an encrypted key must THROW rather than block on a terminal prompt), and the
// deferred security-sensitive options are rejected by VALUE (not mere presence) so a benign
// options bag still works. Exits non-zero on any failure.
const fs = require('fs');
const https = require('https');
const SP = process.env.TLS_DIR;

let failed = 0;
function expectThrow(label, fn) {
  try {
    const s = fn();
    if (s && typeof s.close === 'function') s.close();
    console.error('FAIL ' + label + ': did NOT throw');
    failed++;
  } catch (e) {
    console.log('ok: ' + label + ' threw ' + (e.code || '(no code)'));
  }
}
function expectOk(label, fn) {
  try {
    const s = fn();
    if (s && typeof s.close === 'function') s.close();
    console.log('ok: ' + label);
  } catch (e) {
    console.error('FAIL ' + label + ': threw ' + e.message);
    failed++;
  }
}

const cert = fs.readFileSync(SP + '/cert.pem');
const key = fs.readFileSync(SP + '/key.pem');

expectThrow('bad PEM cert', () => https.createServer({ key, cert: 'not a pem' }));
expectThrow('bad PEM key', () => https.createServer({ key: 'not a pem', cert }));
expectThrow('key/cert mismatch', () =>
  https.createServer({ key: fs.readFileSync(SP + '/otherkey.pem'), cert }),
);
expectThrow('encrypted key without passphrase (must not hang)', () =>
  https.createServer({ key: fs.readFileSync(SP + '/enckey.pem'), cert }),
);
expectThrow('missing cert', () => https.createServer({ key }));
expectThrow('missing key', () => https.createServer({ cert }));
expectThrow('requestCert:true (deferred)', () =>
  https.createServer({ key, cert, requestCert: true }),
);
expectThrow('ca set (deferred)', () => https.createServer({ key, cert, ca: cert }));
expectThrow('minVersion (deferred)', () =>
  https.createServer({ key, cert, minVersion: 'TLSv1.3' }),
);
expectThrow('secureProtocol (deferred legacy)', () =>
  https.createServer({ key, cert, secureProtocol: 'TLSv1_2_method' }),
);
expectThrow('pfx (deferred)', () => https.createServer({ key, cert, pfx: cert }));
expectThrow('sigalgs (deferred)', () => https.createServer({ key, cert, sigalgs: 'ECDSA+SHA256' }));
expectThrow('requestListener-only form (no key/cert)', () => https.createServer(() => {}));

// A benign options bag whose deferred fields are undefined/null/default must NOT throw. Includes
// rejectUnauthorized:true (a server no-op without requestCert) and null-valued knobs, both of which
// are common in shared client/server config and must not spuriously throw.
expectOk('benign options bag (undefined/null/default deferred fields)', () =>
  https.createServer({
    key,
    cert,
    ca: undefined,
    requestCert: false,
    rejectUnauthorized: true,
    minVersion: null,
    ciphers: null,
  }),
);

if (failed > 0) {
  console.error('HTTPS ERRCASES FAIL: ' + failed + ' case(s) failed');
  process.exit(1);
}
console.log('HTTPS ERRCASES OK');

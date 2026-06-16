const assert = require('node:assert/strict');
const buffer = require('node:buffer');

// node:buffer.resolveObjectURL pairs with URL.createObjectURL / URL.revokeObjectURL:
// createObjectURL registers a Blob under a `blob:nodedata:<uuid>` URL, resolve
// hands it back, revoke drops it. No platform-specific behavior — pure JS over
// the in-process registry.

assert.equal(typeof buffer.resolveObjectURL, 'function');
assert.equal(typeof URL.createObjectURL, 'function');
assert.equal(typeof URL.revokeObjectURL, 'function');

// Round-trip a Blob through an object URL.
const blob = new Blob(['hello world'], { type: 'text/plain' });
const url = URL.createObjectURL(blob);
assert.match(url, /^blob:nodedata:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const resolved = buffer.resolveObjectURL(url);
assert.equal(resolved.constructor.name, 'Blob');
assert.equal(resolved.size, 11);
assert.equal(resolved.type, 'text/plain');

// resolve hands back a fresh Blob each call, never the registered instance.
assert.notEqual(buffer.resolveObjectURL(url), buffer.resolveObjectURL(url));
assert.notEqual(buffer.resolveObjectURL(url), blob);

// Distinct ids per registration.
assert.notEqual(URL.createObjectURL(blob), URL.createObjectURL(blob));

// A File registers fine but resolves back as a plain Blob (name is dropped).
const fileUrl = URL.createObjectURL(new File(['xyz'], 'note.txt', { type: 'text/plain' }));
const fileResolved = buffer.resolveObjectURL(fileUrl);
assert.equal(fileResolved.constructor.name, 'Blob');
assert.equal(fileResolved.size, 3);
assert.equal(fileResolved.type, 'text/plain');
assert.equal(fileResolved.name, undefined);

// revoke removes the registration; resolving afterwards yields undefined.
assert.equal(URL.revokeObjectURL(url), undefined);
assert.equal(buffer.resolveObjectURL(url), undefined);

// Invalid / unregistered inputs to resolveObjectURL return undefined, never throw.
assert.equal(buffer.resolveObjectURL('not-a-blob-url'), undefined);
assert.equal(
  buffer.resolveObjectURL('blob:nodedata:00000000-0000-4000-8000-000000000000'),
  undefined,
);
assert.equal(buffer.resolveObjectURL(123), undefined);
assert.equal(buffer.resolveObjectURL(), undefined);
assert.equal(buffer.resolveObjectURL(null), undefined);

// createObjectURL rejects non-Blob values with ERR_INVALID_ARG_TYPE.
for (const bad of [{}, 'str', 123, undefined, null]) {
  assert.throws(
    () => URL.createObjectURL(bad),
    (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_TYPE',
  );
}

// revokeObjectURL with no argument throws ERR_MISSING_ARGS...
assert.throws(
  () => URL.revokeObjectURL(),
  (err) => err instanceof TypeError && err.code === 'ERR_MISSING_ARGS',
);

// ...but a junk or unregistered id is a silent no-op.
assert.equal(URL.revokeObjectURL(123), undefined);
assert.equal(URL.revokeObjectURL('blah'), undefined);
assert.equal(URL.revokeObjectURL('blob:nodedata:nope'), undefined);

console.log('object-url ok');

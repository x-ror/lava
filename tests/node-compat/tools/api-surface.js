(function () {
  'use strict';

  function typeOfOwn(object, name) {
    var descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (!descriptor) return 'missing';
    if ('value' in descriptor) return typeof descriptor.value;
    var parts = [];
    if (descriptor.get) parts.push('get');
    if (descriptor.set) parts.push('set');
    return parts.join('/') || 'accessor';
  }

  function describeOwn(object) {
    var out = {};
    Object.getOwnPropertyNames(object)
      .sort()
      .forEach(function (name) {
        out[name] = typeOfOwn(object, name);
      });
    return out;
  }

  function describeInstance(instance) {
    if (!instance) return {};
    return describeOwn(Object.getPrototypeOf(instance));
  }

  var bufferModule = require('node:buffer');
  var BufferCtor = bufferModule.Buffer || globalThis.Buffer;
  var crypto = require('node:crypto');
  var hash = crypto.createHash && crypto.createHash('sha256');
  var hmac = crypto.createHmac && crypto.createHmac('sha256', 'key');

  var surface = {
    buffer: {
      module: describeOwn(bufferModule),
      Buffer: describeOwn(BufferCtor),
      BufferPrototype: describeOwn(BufferCtor.prototype),
    },
    crypto: {
      module: describeOwn(crypto),
      HashObject: describeOwn(hash),
      HashPrototype: describeInstance(hash),
      HmacObject: describeOwn(hmac),
      HmacPrototype: describeInstance(hmac),
    },
  };

  console.log(JSON.stringify(surface, null, 2));
})();

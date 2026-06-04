// Fetch surface — Headers, Request, Response, and a global `fetch`. Installs
// the WHATWG globals (Node exposes them without a require). This is the pure-JS
// half: Headers/Request/Response/Body machinery lives here, exactly as Node
// keeps it in JS; the actual `http://` network transport is Odin-backed and
// reached through the `native` bindings (native.request), mirroring how
// crypto/buffer receive their Odin primitives as the factory's fourth argument.
(function (require, module, exports, native) {
	"use strict";

	function normalizeName(name) {
		return String(name).toLowerCase();
	}

	class Headers {
		constructor(init) {
			this._map = new Map();
			if (init instanceof Headers) {
				init.forEach((value, key) => this.append(key, value));
			} else if (Array.isArray(init)) {
				for (var i = 0; i < init.length; i++) this.append(init[i][0], init[i][1]);
			} else if (init && typeof init === "object") {
				var keys = Object.keys(init);
				for (var j = 0; j < keys.length; j++) this.append(keys[j], init[keys[j]]);
			}
		}
		append(name, value) {
			var key = normalizeName(name);
			var existing = this._map.get(key);
			this._map.set(key, existing === undefined ? String(value) : existing + ", " + value);
		}
		set(name, value) { this._map.set(normalizeName(name), String(value)); }
		get(name) {
			var v = this._map.get(normalizeName(name));
			return v === undefined ? null : v;
		}
		has(name) { return this._map.has(normalizeName(name)); }
		delete(name) { this._map.delete(normalizeName(name)); }
		forEach(callback, thisArg) {
			this._map.forEach((value, key) => callback.call(thisArg, value, key, this));
		}
		keys() { return this._map.keys(); }
		values() { return this._map.values(); }
		entries() { return this._map.entries(); }
		[Symbol.iterator]() { return this._map.entries(); }
	}

	// bodyToBytes normalizes a body init into byte-exact storage (a Uint8Array) or
	// null. Strings are UTF-8 encoded; Buffer/Uint8Array/ArrayBuffer are kept
	// byte-for-byte (no latin1 round-trip), so binary request bodies are not
	// corrupted and so response bytes survive intact for arrayBuffer().
	function bodyToBytes(body) {
		if (body === null || body === undefined || body === "") return null;
		if (body instanceof Uint8Array) return body; // Buffer is a Uint8Array subclass
		if (body instanceof ArrayBuffer) return new Uint8Array(body);
		var text = typeof body === "string" ? body : String(body);
		if (text === "") return null;
		if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
		var bytes = new Uint8Array(text.length);
		for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
		return bytes;
	}

	// bytesToText UTF-8 decodes stored bytes (matches Node's Body.text(); a latin1
	// fallback keeps things working if TextDecoder is somehow unavailable).
	function bytesToText(bytes) {
		if (bytes === null) return "";
		if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
		var s = "";
		for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
		return s;
	}

	class Body {
		constructor(body) {
			this._bodyBytes = bodyToBytes(body); // Uint8Array or null, byte-exact
			this.bodyUsed = false;
		}
		text() {
			this.bodyUsed = true;
			return Promise.resolve(bytesToText(this._bodyBytes));
		}
		json() {
			this.bodyUsed = true;
			// Parse inside the promise chain so invalid JSON rejects rather than
			// throwing synchronously (WHATWG fetch semantics).
			return this.text().then(function (text) {
				return JSON.parse(text);
			});
		}
		arrayBuffer() {
			this.bodyUsed = true;
			var bytes = this._bodyBytes;
			if (bytes === null) return Promise.resolve(new ArrayBuffer(0));
			var copy = new Uint8Array(bytes.length);
			copy.set(bytes);
			return Promise.resolve(copy.buffer);
		}
	}

	class Response extends Body {
		constructor(body, init) {
			super(body);
			init = init || {};
			this.status = init.status === undefined ? 200 : init.status;
			this.statusText = init.statusText === undefined ? "" : init.statusText;
			this.headers = new Headers(init.headers);
			this.ok = this.status >= 200 && this.status < 300;
			this.redirected = false;
			this.type = "default";
			this.url = init.url || "";
		}
		clone() {
			return new Response(this._bodyBytes, {
				status: this.status,
				statusText: this.statusText,
				headers: this.headers,
				url: this.url,
			});
		}
	}

	Response.json = function (data, init) {
		init = init || {};
		var headers = new Headers(init.headers);
		if (!headers.has("content-type")) headers.set("content-type", "application/json");
		return new Response(JSON.stringify(data), { status: init.status, statusText: init.statusText, headers: headers });
	};

	Response.error = function () { return new Response(null, { status: 0 }); };

	class Request extends Body {
		constructor(input, init) {
			init = init || {};
			super(init.body);
			this.url = typeof input === "string" ? input : (input && input.url) || "";
			this.method = (init.method || "GET").toUpperCase();
			this.headers = new Headers(init.headers);
		}
	}

	// The transport sets these itself from the URL and body length; a caller copy
	// would otherwise be emitted as a duplicate header on the wire.
	var TRANSPORT_OWNED_HEADERS = { host: 1, "content-length": 1, connection: 1, "transfer-encoding": 1 };

	// fetch(input, init) — build a Request, then hand the method/url/headers/body
	// to the Odin transport. native.request settles by invoking one of the two
	// callbacks we pass: onResponse({status, statusText, headers, body}) on
	// success, or onError(message) on failure. The transport runs on the event
	// loop, so the returned promise resolves on a later tick. Only http:// is
	// wired today; https:// rejects from the native side.
	function fetch(input, init) {
		var req;
		try {
			req = new Request(input, init);
		} catch (error) {
			return Promise.reject(error);
		}

		if (!native || typeof native.request !== "function") {
			return Promise.reject(new TypeError("fetch: native network backend unavailable"));
		}

		var headerLines = "";
		req.headers.forEach(function (value, key) {
			if (TRANSPORT_OWNED_HEADERS[key]) return; // key is lowercased by normalizeName
			var text = String(value);
			// Reject header-injection attempts rather than splitting the request.
			if (/[\r\n]/.test(key) || /[\r\n]/.test(text)) return;
			headerLines += key + ": " + text + "\r\n";
		});
		// Body bytes are stored byte-exact on the Request (see bodyToBytes).
		var body = req._bodyBytes;

		return new Promise(function (resolve, reject) {
			function onResponse(raw) {
				var headers = new Headers();
				var pairs = raw.headers || [];
				for (var i = 0; i + 1 < pairs.length; i += 2) headers.append(pairs[i], pairs[i + 1]);
				resolve(
					new Response(raw.body, {
						status: raw.status,
						statusText: raw.statusText,
						headers: headers,
						url: req.url,
					}),
				);
			}
			function onError(message) {
				reject(new TypeError(String(message)));
			}
			native.request(req.method, req.url, headerLines, body, onResponse, onError);
		});
	}

	if (typeof globalThis.Headers === "undefined") globalThis.Headers = Headers;
	if (typeof globalThis.Request === "undefined") globalThis.Request = Request;
	if (typeof globalThis.Response === "undefined") globalThis.Response = Response;
	if (typeof globalThis.fetch === "undefined") globalThis.fetch = fetch;

	module.exports = { fetch: fetch, Headers: Headers, Request: Request, Response: Response };
})

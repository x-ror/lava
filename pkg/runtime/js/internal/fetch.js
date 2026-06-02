// Fetch surface — Headers, Request, Response, and a global `fetch`. Installs
// the WHATWG globals (Node exposes them without a require). This is the pure-JS
// half: the body/headers machinery is real, but the network transport in
// fetch() is a stub until the Odin phase wires actual sockets.
(function (require, module) {
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

	function consumeBody(body) {
		if (body === null || body === undefined) return "";
		if (typeof body === "string") return body;
		if (typeof Buffer !== "undefined" && body instanceof Buffer) return body.toString("utf8");
		if (body instanceof Uint8Array) {
			var s = "";
			for (var i = 0; i < body.length; i++) s += String.fromCharCode(body[i]);
			return s;
		}
		return String(body);
	}

	class Body {
		constructor(body) {
			this._bodyText = consumeBody(body);
			this.bodyUsed = false;
		}
		text() {
			this.bodyUsed = true;
			return Promise.resolve(this._bodyText);
		}
		json() {
			this.bodyUsed = true;
			return Promise.resolve(JSON.parse(this._bodyText));
		}
		arrayBuffer() {
			this.bodyUsed = true;
			var text = this._bodyText;
			var buf = new ArrayBuffer(text.length);
			var view = new Uint8Array(buf);
			for (var i = 0; i < text.length; i++) view[i] = text.charCodeAt(i) & 0xff;
			return Promise.resolve(buf);
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
			return new Response(this._bodyText, {
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

	// TODO(odin): real network transport. The compat target only checks
	// `typeof fetch === 'function'`; an actual request rejects for now.
	function fetch(input, init) {
		return Promise.reject(new Error("fetch: network backend not implemented yet"));
	}

	if (typeof globalThis.Headers === "undefined") globalThis.Headers = Headers;
	if (typeof globalThis.Request === "undefined") globalThis.Request = Request;
	if (typeof globalThis.Response === "undefined") globalThis.Response = Response;
	if (typeof globalThis.fetch === "undefined") globalThis.fetch = fetch;

	module.exports = { fetch: fetch, Headers: Headers, Request: Request, Response: Response };
})

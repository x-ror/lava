#!/usr/bin/env python3
"""Generate reference/node-compat.json — the machine-readable Lava<->Node matrix.

The per-module statuses below are curated from probing the built `bin/lava`
(require('node:x'), global lookups, calling representative functions). Keep them
in sync with reference/node-compatibility.md. Run:

    python3 scripts/node-compat/gen-matrix.py
"""
import json, os, subprocess

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# status: full | partial | missing | na  (page -> (status, implemented, gaps))
MODULES = {
    "assert": ("full", "node:assert + assert/strict, AssertionError", ""),
    "buffer": ("full", "Buffer/Blob/File/SlowBuffer/atob/btoa/isAscii/isUtf8/transcode", ""),
    "events": ("full", "EventEmitter + static once", "EventTarget/CustomEvent"),
    "intl": ("full", "engine (JavaScriptCore) Intl", "engine-provided, not lava code"),
    "path": ("full", "posix+win32 full surface", ""),
    "sqlite": ("full", "DatabaseSync/StatementSync", "session/backup"),
    "console": ("partial", "global console (rich)", "no node:console module / Console class"),
    "crypto": ("partial", "hash/hmac/hkdf/pbkdf2/random*/uuid/timingSafeEqual", "~50 stubbed: ciphers/keys/sign/verify/scrypt/x509/ecdh/dh/argon2/subtle"),
    "esm": ("partial", ".mjs transform, import works", "loader hooks/register"),
    "fs": ("partial", "13 fns: readFile/writeFile(Sync)/stat/readdir/mkdir/rm/...", "no promises/streams/watch/copyFile/access/chmod/open"),
    "globals": ("partial", "27 globals present", "URL/Event/streams/atob/navigator/reportError"),
    "module": ("partial", "CommonJS require + node: resolution", "createRequire/register/isBuiltin/SourceMap"),
    "modules": ("partial", "CommonJS require", "same as module"),
    "packages": ("partial", "package.json resolution (partial)", "exports/imports map edge cases"),
    "perf_hooks": ("partial", "performance.now/timeOrigin", "PerformanceObserver/marks/entries"),
    "process": ("partial", "argv/env/cwd/exit/nextTick/pid/platform/arch/version(s)", "hrtime/stdio/on/kill/memoryUsage/execPath"),
    "timers": ("partial", "global timers + node:timers/promises", "no node:timers module; no ref/unref"),
    "url": ("partial", "fileURLToPath", "URL/URLSearchParams/pathToFileURL/format"),
    "util": ("partial", "inspect/format/formatWithOptions", "promisify/callbackify/types/inherits/parseArgs"),
    "webcrypto": ("partial", "crypto.getRandomValues/randomUUID", "crypto.subtle (all SubtleCrypto)"),
    "environment_variables": ("partial", "some env honored", ""),
    "async_context": ("missing", "", "AsyncLocalStorage"),
    "async_hooks": ("missing", "", ""),
    "child_process": ("missing", "", ""),
    "cluster": ("missing", "", ""),
    "dgram": ("missing", "", ""),
    "diagnostics_channel": ("missing", "", ""),
    "dns": ("missing", "internal IPv4 resolver in fetch only", "public module in progress (c-ares)"),
    "domain": ("missing", "", "deprecated upstream"),
    "dtls": ("missing", "", ""),
    "ffi": ("missing", "", ""),
    "http": ("missing", "", "fetch covers client only"),
    "http2": ("missing", "", ""),
    "https": ("missing", "", ""),
    "inspector": ("missing", "", ""),
    "net": ("missing", "", ""),
    "os": ("missing", "", ""),
    "permissions": ("missing", "", ""),
    "punycode": ("missing", "", "deprecated upstream"),
    "querystring": ("missing", "", ""),
    "quic": ("missing", "", ""),
    "readline": ("missing", "", ""),
    "repl": ("missing", "", ""),
    "report": ("missing", "", ""),
    "single-executable-applications": ("missing", "", "tooling"),
    "stream": ("missing", "", ""),
    "stream_iter": ("missing", "", ""),
    "string_decoder": ("missing", "", ""),
    "test": ("missing", "", ""),
    "tls": ("missing", "used internally by fetch", ""),
    "tracing": ("missing", "", "trace_events"),
    "tty": ("missing", "", ""),
    "typescript": ("missing", "", "no type stripping"),
    "v8": ("missing", "", ""),
    "vfs": ("missing", "", ""),
    "vm": ("missing", "", ""),
    "wasi": ("missing", "", "WebAssembly present, WASI glue absent"),
    "webstreams": ("missing", "", "ReadableStream/WritableStream/TransformStream"),
    "worker_threads": ("missing", "", ""),
    "zlib": ("missing", "", ""),
    "addons": ("na", "", "C++ addon docs"),
    "cli": ("na", "eval/run only", "CLI flags"),
    "debugger": ("na", "", ""),
    "deprecations": ("na", "", "catalog"),
    "documentation": ("na", "", ""),
    "embedding": ("na", "", "C++ embedding"),
    "errors": ("na", "some codes used", "error catalog"),
    "index": ("na", "", "TOC"),
    "n-api": ("na", "", "C API"),
    "synopsis": ("na", "", "intro"),
}

GLOBALS_PRESENT = ["global", "globalThis", "Buffer", "fetch", "Headers", "Request", "Response", "TextEncoder", "TextDecoder", "AbortController", "AbortSignal", "structuredClone", "queueMicrotask", "setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval", "clearImmediate", "console", "process", "performance", "Blob", "File", "crypto", "WebAssembly", "Intl"]
GLOBALS_MISSING = ["URL", "URLSearchParams", "atob", "btoa", "Event", "EventTarget", "CustomEvent", "ReadableStream", "WritableStream", "TransformStream", "TextEncoderStream", "TextDecoderStream", "CompressionStream", "MessageChannel", "MessagePort", "Worker", "BroadcastChannel", "navigator", "reportError", "crypto.subtle"]
PROCESS_PRESENT = ["argv", "env", "cwd", "exit", "nextTick", "pid", "platform", "arch", "version", "versions"]
PROCESS_MISSING = ["hrtime", "chdir", "kill", "memoryUsage", "resourceUsage", "uptime", "stdout", "stderr", "stdin", "execPath", "argv0", "execArgv", "umask", "on", "once", "exitCode", "title", "report"]


def lava_rev():
    try:
        return subprocess.check_output(
            ["git", "-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], text=True
        ).strip()
    except Exception:
        return "unknown"


def node_sha():
    src = os.path.join(REPO_ROOT, "reference", "node-doc-api", "SOURCE.txt")
    if os.path.exists(src):
        for line in open(src):
            if line.startswith("Node main commit:"):
                return line.split(":", 1)[1].strip()
    return ""


def main():
    counts = {"full": 0, "partial": 0, "missing": 0, "na": 0}
    rows = []
    for name, (status, have, gaps) in sorted(MODULES.items()):
        counts[status] += 1
        rows.append({"page": name, "status": status, "implemented": have, "gaps": gaps})

    out = {
        "generated_against": {
            "lava_rev": lava_rev(),
            "node_doc_sha": node_sha(),
            "node_doc_pages": len(MODULES),
        },
        "legend": {
            "full": "implemented (substantial)",
            "partial": "core works, notable gaps/stubs",
            "missing": "require throws MODULE_NOT_FOUND",
            "na": "not a JS-API surface",
        },
        "counts": counts,
        "modules": rows,
        "globals": {"present": GLOBALS_PRESENT, "missing": GLOBALS_MISSING},
        "process": {"present": PROCESS_PRESENT, "missing": PROCESS_MISSING},
    }
    dest = os.path.join(REPO_ROOT, "reference", "node-compat.json")
    with open(dest, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print("counts:", counts, "total:", sum(counts.values()))
    print("wrote", dest)


if __name__ == "__main__":
    main()

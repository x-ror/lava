#!/usr/bin/env python3
"""Mirror the Node.js `doc/api` markdown pages into reference/node-doc-api/.

Pins to the current `nodejs/node` main commit and records it in SOURCE.txt so
the mirror is reproducible. The .md pages themselves are gitignored (regenerable
from the pinned SHA); only SOURCE.txt is tracked. Run from anywhere:

    python3 scripts/node-compat/fetch-node-docs.py
"""
import json, os, urllib.request
from urllib.parse import urlparse

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEST = os.path.join(REPO_ROOT, "reference", "node-doc-api")

ALLOWED_HOSTS = {"api.github.com", "raw.githubusercontent.com"}


def get(url, accept="application/vnd.github+json"):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise ValueError(f"URL not allowed: {url}")
    req = urllib.request.Request(
        url, headers={"Accept": accept, "User-Agent": "lava-node-compat"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main():
    os.makedirs(DEST, exist_ok=True)
    sha = json.loads(get("https://api.github.com/repos/nodejs/node/commits/main"))["sha"]
    print("node main sha:", sha)

    listing = json.loads(
        get(f"https://api.github.com/repos/nodejs/node/contents/doc/api?ref={sha}")
    )
    mds = sorted(f["name"] for f in listing if f["name"].endswith(".md"))

    for i, name in enumerate(mds, 1):
        raw = get(
            f"https://raw.githubusercontent.com/nodejs/node/{sha}/doc/api/{name}",
            accept="text/plain",
        )
        with open(os.path.join(DEST, name), "wb") as fh:
            fh.write(raw)
        print(f"  [{i}/{len(mds)}] {name} ({len(raw)} bytes)")

    with open(os.path.join(DEST, "SOURCE.txt"), "w") as fh:
        fh.write(f"Source: https://github.com/nodejs/node/tree/{sha}/doc/api\n")
        fh.write(f"Node main commit: {sha}\n")
        fh.write(f"Files: {len(mds)} markdown pages\n")

    print(f"done: {len(mds)} files -> {DEST}")


if __name__ == "__main__":
    main()

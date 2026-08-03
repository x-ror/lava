// actionlint over .github/workflows.
//
// `yaml.safe_load` proves a workflow parses; it says nothing about whether GitHub will
// accept it. The mistakes that actually bite are semantic and only surface on a live PR:
// a context used where it is not available (`secrets` in an `if:` is the classic — the
// availability table forbids it at both job and step level), a `needs` on a job that does
// not exist, a shellcheck error inside a `run:` block, a deprecated runner label.
//
// The npm package is a WASM build of actionlint, so this needs no Go toolchain and no
// binary download — it runs anywhere bun does, which is what makes it usable as a local
// pre-commit check rather than a CI-only gate.
//
// One known wart in this build: its table of GitHub-hosted runner labels is stale and
// tops out around ubuntu-22.04, so pinning a newer image (`runs-on: ubuntu-24.04`) is
// reported as an unknown label. Every workflow here uses `ubuntu-latest`, so nothing is
// affected today; if a pinned image is ever needed, declare the label in a
// `.github/actionlint.yaml` (`self-hosted-runner: labels:`) rather than deleting the gate.

import { createLinter } from 'actionlint';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_DIR = join(import.meta.dirname, '..', '.github', 'workflows');

const files = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

let problems = 0;

for (const name of files) {
  const path = join(WORKFLOW_DIR, name);
  const relative = `.github/workflows/${name}`;
  // A linter per file, not one reused across all of them. The WASM instance does
  // not survive several sizeable documents: with three workflows present it
  // aborted with `RuntimeError: unreachable` partway through the second, and the
  // gate then reported a crash rather than a lint result. Reused state failing
  // on the SECOND file also means the failure moves as files are added or
  // renamed, which is what makes it worth the extra instantiation.
  const lint = await createLinter();
  for (const result of lint(readFileSync(path, 'utf8'), relative)) {
    console.error(
      `${relative}:${result.line}:${result.column}: ${result.message} [${result.kind}]`,
    );
    problems += 1;
  }
}

if (problems > 0) {
  console.error(`\nactionlint: ${problems} problem(s) across ${files.length} workflow(s)`);
  process.exit(1);
}

console.log(`OK: actionlint clean (${files.length} workflows).`);

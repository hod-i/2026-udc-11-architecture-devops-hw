// Tests for `env-unread` in docs/rca-queries.mjs — the query behind evidence 2–3 in docs/rca.md.
// It reads app/src/config.js relative to the working directory, so it runs from the repo root.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(REPO, "docs", "rca-queries.mjs");

function neverRead(content, side) {
  const dir = mkdtempSync(join(tmpdir(), "rca-queries-"));
  try {
    const file = join(dir, "input");
    writeFileSync(file, content);
    const out = execFileSync(process.execPath, [SCRIPT, "env-unread", file, ...(side ? [side] : [])], { cwd: REPO, encoding: "utf8" });
    return /^never read: (.*)$/m.exec(out)[1];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// a release diff that renames DB_POOL_MAX inside a one-line flow map
const flowMapDiff = [
  "diff --git a/deploy/compose.yaml b/deploy/compose.yaml",
  "--- a/deploy/compose.yaml",
  "+++ b/deploy/compose.yaml",
  "@@ -1,4 +1,4 @@",
  " services:",
  "   api:",
  '-    environment: {DB_POOL_MAX: "20", PORT: "8080"}',
  '+    environment: {DB_POOL_SIZE: "20", PORT: "8080"}',
  "",
].join("\n");

test("env-unread new: a renamed variable in a flow-map environment is reported", () => {
  assert.equal(neverRead(flowMapDiff, "new"), "DB_POOL_SIZE");
  assert.equal(neverRead(flowMapDiff, "old"), "none");
});

test("env-unread new: flow-list environment, with an anchor", () => {
  const diff = ["@@ -1,3 +1,3 @@", " services:", "   api:", "+    environment: &api-env [DB_POOL_SIZE=20, PORT=8080]", ""].join("\n");
  assert.equal(neverRead(diff, "new"), "DB_POOL_SIZE");
});

test("env-unread: flow maps outside environment (labels) are not variables", () => {
  const compose = ["services:", "  api:", "    labels: {APP_VERSION: x}", '    environment: {PORT: "8080"}', ""].join("\n");
  assert.equal(neverRead(compose), "none");
});

test("env-unread: a comma inside a quoted flow value does not start a new variable", () => {
  const map = ["services:", "  api:", '    environment: {SMS_BASE_URL: "https://x, FAKE_VAR: y", PORT: "8080"}', ""].join("\n");
  assert.equal(neverRead(map), "none");
  const list = ["@@ -1,3 +1,3 @@", " services:", "   api:", '+    environment: ["SMS_BASE_URL=https://x, FAKE_VAR=y", DB_POOL_SIZE=20]', ""].join("\n");
  assert.equal(neverRead(list, "new"), "DB_POOL_SIZE");
});

test("env-unread on the real incident diff: new → DB_POOL_SIZE, old → none", () => {
  const diff = join(REPO, "incident", "changes", "v1.8.0.diff");
  const run = (side) => /^never read: (.*)$/m.exec(execFileSync(process.execPath, [SCRIPT, "env-unread", diff, side], { cwd: REPO, encoding: "utf8" }))[1];
  assert.equal(run("new"), "DB_POOL_SIZE");
  assert.equal(run("old"), "none");
});

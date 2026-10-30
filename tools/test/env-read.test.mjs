// Tests for rule E1 (post-mortem 2026-10-14, action item #1): every environment variable
// that compose gives the app must be one app/src/config.js actually reads.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envReadByApp, parseYaml, RULES } from "../check-deploy.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const E1 = RULES.find((r) => r.id === "E1");

const check = (root, compose) => E1.check({ root, compose: { exists: true, data: compose } });

// A tree with its own small app: config.js reads PORT, DB_POOL_MAX and SMS_TOKEN.
function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "env-read-"));
  try {
    mkdirSync(join(dir, "app", "src"), { recursive: true });
    writeFileSync(join(dir, "app", "package.json"), JSON.stringify({ name: "parcels" }));
    writeFileSync(
      join(dir, "app", "src", "config.js"),
      [
        "export function loadConfig(env = process.env) {",
        "  return { port: Number(env.PORT) || 8080, dbPoolMax: Number(env.DB_POOL_MAX) || 4,",
        '    smsToken: env["SMS_TOKEN"] || "" };',
        "}",
        "",
      ].join("\n"),
    );
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("E1 reads the names from app/src/config.js: env.NAME and env[\"NAME\"]", () => {
  withApp((dir) => assert.deepEqual([...envReadByApp(dir)].sort(), ["DB_POOL_MAX", "PORT", "SMS_TOKEN"]));
  assert.equal(envReadByApp(join(tmpdir(), "no-such-tree-e1")), null);
});

test("E1 FAIL: the 14.10 incident — DB_POOL_SIZE instead of DB_POOL_MAX, against the real app/src/config.js", () => {
  // environment of api and worker exactly as in incident/changes/v1.8.0.diff
  const env = {
    COURIER_BASE_URL: "https://courier.example.com/api/v1",
    DATABASE_URL: "postgres://poshtomat@192.0.2.10:5432/poshtomat",
    DB_POOL_SIZE: "20",
    DB_POOL_WAIT_MS: "2000",
    LOG_LEVEL: "info",
    PORT: "8080",
    SMS_BASE_URL: "https://sms.example.net/api/v2",
    SMS_RATE_PER_SEC: "20",
    SMS_TOKEN: "${SMS_TOKEN:?}",
    TZ: "Europe/Kyiv",
  };
  const result = check(REPO, {
    services: {
      api: { image: "poshtomat:1.8.0", environment: env },
      worker: { image: "poshtomat:1.8.0", environment: env },
    },
  });
  assert.equal(result.status, "FAIL");
  assert.match(result.message, /api: DB_POOL_SIZE; worker: DB_POOL_SIZE/);
});

test("E1 FAIL: a renamed variable is caught in list form and when it comes through a YAML merge key", () => {
  withApp((dir) => {
    assert.equal(check(dir, { services: { web: { build: "app", image: "parcels:1", environment: ["PORT=8080", "DB_POOL_SIZE=20"] } } }).status, "FAIL");
    const parsed = parseYaml(
      [
        "x-db: &db",
        '  DB_POOL_SIZE: "20"',
        "services:",
        "  web:",
        "    image: ${PARCELS_IMAGE:?}",
        "    environment:",
        "      <<: *db",
        '      PORT: "8080"',
        "",
      ].join("\n"),
    );
    assert.ok(parsed.data, parsed.error ?? parsed.toolError);
    const result = check(dir, parsed.data);
    assert.equal(result.status, "FAIL");
    assert.match(result.message, /web: DB_POOL_SIZE/);
  });
});

test("E1 PASS: a correct compose that a naive rule would flag", () => {
  withApp((dir) => {
    const result = check(dir, {
      services: {
        // TZ / NODE_ENV are read by Node itself, not by config.js
        api: { image: "registry.example.org/parcels@sha256:abc", environment: { TZ: "Europe/Kyiv", NODE_ENV: "production", PORT: "8080", DB_POOL_MAX: "20" } },
        // list form; a bare name passes the value through from the host
        worker: { image: "registry.example.org/parcels@sha256:abc", environment: ["DB_POOL_MAX=20", "SMS_TOKEN"] },
        // not our app: its own variables are none of config.js's business
        db: { image: "postgres:16.4", environment: { POSTGRES_PASSWORD: "${PG_PASSWORD:?}", PGDATA: "/var/lib/postgresql/data" } },
        // no environment at all
        cron: { image: "registry.example.org/parcels@sha256:abc", command: ["node", "bin/job.js"] },
      },
    });
    assert.equal(result.status, "PASS", result.message);
    assert.match(result.message, /api, worker, cron/);
  });
});

test("E1 PASS on this repo's deploy/compose.yaml; SKIP when there is nothing to compare with", () => {
  const compose = parseYaml(readRepo("deploy/compose.yaml"));
  assert.ok(compose.data, compose.error ?? compose.toolError);
  assert.equal(check(REPO, compose.data).status, "PASS");
  const empty = mkdtempSync(join(tmpdir(), "env-read-empty-"));
  try {
    assert.equal(check(empty, { services: { web: { image: "parcels:1", environment: { X: "1" } } } }).status, "SKIP");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

function readRepo(rel) {
  return readFileSync(join(REPO, rel), "utf8");
}

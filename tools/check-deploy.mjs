#!/usr/bin/env node
// Deterministic checks for the deploy configuration (Task D).
//
//   npm run check:deploy                 checks this repo
//   node tools/check-deploy.mjs --root <dir>   checks another tree with the same layout
//
// Files: deploy/Dockerfile, deploy/compose.yaml, pipeline/deploy.yml.
// Output: one row per rule (PASS / FAIL / SKIP) and a hint under every FAIL.
// Exit code 1 when any rule fails.
//
// Adding a rule: append { id, title, hint, check(ctx) } to RULES. `check` returns
// pass(message) / fail(message) / skip(message). `ctx` holds the parsed files and
// `ctx.root`, so a rule can read any other file of the repo too.
// Cover the new rule in tools/test/check-deploy.test.mjs or in a new
// tools/test/<name>.test.mjs (npm run test:tools runs only tools/test/*.test.mjs).

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PATHS = {
  dockerfile: "deploy/Dockerfile",
  compose: "deploy/compose.yaml",
  workflow: "pipeline/deploy.yml",
};

// ---------------------------------------------------------------- parsing

export const YAML_TOOL = "npx yaml@2.8.1";

/**
 * YAML → plain JS via the `yaml` package's CLI (no npm install in this repo).
 * The first run downloads yaml@2.8.1 through npx; later runs use the npm cache.
 * Returns { data } | { error } (the text is not valid YAML) | { toolError } (npx/npm
 * itself could not run — says nothing about the file).
 */
export function parseYaml(text) {
  try {
    const out = execSync("npx --yes yaml@2.8.1 --json --single --strict --merge", {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: 60_000,
    });
    return { data: JSON.parse(out.trim()) };
  } catch (err) {
    return classifyYamlFailure(err);
  }
}

/** Why did `npx yaml` fail: the YAML (→ { error }) or npx/npm itself (→ { toolError })? */
export function classifyYamlFailure(err) {
  const stderr = String(err?.stderr ?? "");
  const lines = stderr.split(/\r?\n/);
  // 1. the parser ran and rejected the text — whatever else stderr says
  const yamlLine = lines.find((l) => /YAML\w*Error/.test(l));
  if (yamlLine) return { error: yamlLine.trim() };
  // 2. npx/npm never got as far as parsing
  if (err?.code === "ETIMEDOUT") return { toolError: "npx не відповів за 60 с" };
  if (err?.code === "ENOENT" || /is not recognized as an internal|command not found|npx: not found/.test(stderr)) {
    return { toolError: "команду npx не знайдено (потрібен Node.js 22+ разом з npm)" };
  }
  if (/^npm (error|ERR!)/m.test(stderr)) {
    const code = /^npm (?:error|ERR!) code (\S+)/m.exec(stderr)?.[1];
    const first = lines.find((l) => /^npm (error|ERR!)\s*\S/.test(l))?.trim();
    return { toolError: code ? `npm error code ${code}` : first };
  }
  // 3. anything else: report it as the file's problem, as before
  const line = lines.find((l) => /^Error:/.test(l)) ?? lines.find((l) => l.trim()) ?? String(err?.message ?? err ?? "unknown error");
  return { error: line.trim() };
}

function tokenize(args) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (const ch of args) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

const unquote = (s) => s.replace(/^(["'])(.*)\1$/s, "$2");

/** Dockerfile → [{ instruction, args, line }], line continuations joined, comments dropped. */
export function parseDockerfile(text) {
  const out = [];
  let buf = "";
  let start = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^\s*#/.test(line) || (!buf && !line.trim())) return;
    if (!buf) start = i + 1;
    if (line.endsWith("\\")) {
      buf += `${line.slice(0, -1)} `;
      return;
    }
    buf += line;
    const m = /^\s*([A-Za-z]+)\s*([\s\S]*)$/.exec(buf);
    if (m) out.push({ instruction: m[1].toUpperCase(), args: m[2].trim(), line: start });
    buf = "";
  });
  if (buf.trim()) {
    const m = /^\s*([A-Za-z]+)\s*([\s\S]*)$/.exec(buf);
    if (m) out.push({ instruction: m[1].toUpperCase(), args: m[2].trim(), line: start });
  }
  return out;
}

/** `ENV A=1 B="2 3"`, legacy `ENV KEY some value`, `ARG NAME[=default]` → [[key, value|null]]. */
export function keyValues(instruction, args) {
  const tokens = tokenize(args);
  if (instruction === "ENV" && tokens.length && !tokens[0].includes("=")) {
    return [[tokens[0], args.slice(args.indexOf(tokens[0]) + tokens[0].length).trim()]];
  }
  return tokens.map((t) => {
    const i = t.indexOf("=");
    return i === -1 ? [t, null] : [t.slice(0, i), unquote(t.slice(i + 1))];
  });
}

export function parseImageRef(ref) {
  const [beforeDigest, digest = null] = String(ref).split("@");
  const slash = beforeDigest.lastIndexOf("/");
  const colon = beforeDigest.lastIndexOf(":");
  const tag = colon > slash ? beforeDigest.slice(colon + 1) : null;
  return { name: tag === null ? beforeDigest : beforeDigest.slice(0, colon), tag, digest };
}

/**
 * Is this the name of something that should only ever arrive as a secret?
 * A part (between _ or -) that ends in TOKEN / SECRET / PASSWORD / PASSWD / PASSPHRASE /
 * APIKEY (PGPASSWORD, DBPASSWORD) or is KEY as a whole (API_KEY, SSH_KEY, plain `key`).
 * The `key` of an actions/cache step is a cache key — W4 exempts it there.
 */
export function isSecretLike(name) {
  const upper = String(name).toUpperCase().replace(/-/g, "_");
  if (/_FILES?$/.test(upper)) return false; // a path to a mounted secret, not the secret itself
  if (upper.includes("CACHE")) return false; // cache keys
  return upper
    .split("_")
    .some((part) => /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY)S?$/.test(part) || /^(API|SSH|PRIVATE|ACCESS)?KEYS?$/.test(part));
}

// ---------------------------------------------------------------- context

export function dockerfileSource(text, path = PATHS.dockerfile) {
  if (text === null || text === undefined) return { path, exists: false, instructions: [] };
  return { path, exists: true, text, instructions: parseDockerfile(text) };
}

function readYamlFile(root, rel, parse) {
  const full = join(root, rel);
  if (!existsSync(full)) return { path: rel, exists: false };
  const parsed = parse(readFileSync(full, "utf8"));
  return { path: rel, exists: true, ...parsed };
}

export function loadContext(root, { parse = parseYaml } = {}) {
  const dockerPath = join(root, PATHS.dockerfile);
  // once npx has failed, do not wait for it again on the next file
  let toolError = null;
  const guarded = (text) => {
    if (toolError) return { toolError };
    const result = parse(text);
    if (result.toolError) toolError = result.toolError;
    return result;
  };
  return {
    root,
    dockerfile: dockerfileSource(existsSync(dockerPath) ? readFileSync(dockerPath, "utf8") : null),
    compose: readYamlFile(root, PATHS.compose, guarded),
    workflow: readYamlFile(root, PATHS.workflow, guarded),
  };
}

// ---------------------------------------------------------------- helpers for rules

export const pass = (message) => ({ status: "PASS", message });
export const fail = (message) => ({ status: "FAIL", message });
export const skip = (message) => ({ status: "SKIP", message });

export const TOOL_HINT =
  "Це не помилка у ваших файлах: їх не вдалося навіть розібрати. Перший запуск check:deploy один раз завантажує yaml@2.8.1 через npx (потрібна мережа), далі перевірка працює офлайн з npm-кешу. Під'єднайтеся до мережі (або перевірте proxy / registry у npm config) і запустіть ще раз.";

/** A rule that could not run because npx could not: FAIL, but without the rule's hint. */
const toolFail = (source, prefix = "") => ({
  status: "FAIL",
  message: `${prefix}не вдалося запустити ${YAML_TOOL} — перший запуск потребує мережі (${source.toolError})`,
  toolError: true,
});

function stages(dockerfile) {
  const result = [];
  for (const ins of dockerfile.instructions) {
    if (ins.instruction === "FROM") result.push({ from: ins, body: [] });
    else if (result.length) result.at(-1).body.push(ins);
  }
  return result;
}

function globalArgs(dockerfile) {
  const args = {};
  for (const ins of dockerfile.instructions) {
    if (ins.instruction === "FROM") break;
    if (ins.instruction === "ARG") for (const [k, v] of keyValues("ARG", ins.args)) args[k] = v;
  }
  return args;
}

function substitute(value, vars) {
  return value.replace(/\$\{(\w+)(?::?-([^}]*))?\}|\$(\w+)/g, (whole, a, def, b) => {
    const name = a ?? b;
    if (vars[name] !== undefined && vars[name] !== null) return vars[name];
    return def !== undefined ? def : whole;
  });
}

function services(compose) {
  const s = compose.data?.services;
  return s && typeof s === "object" && !Array.isArray(s) ? Object.entries(s) : [];
}

/** null when compose is usable, otherwise the FAIL result for a rule that needs it. */
function composeProblem(compose, prefix = "") {
  if (!compose.exists) return fail(`${prefix}${PATHS.compose} не знайдено`);
  if (compose.toolError) return toolFail(compose, prefix);
  if (compose.error) return fail(`${prefix}${PATHS.compose} не розібрався як YAML: ${compose.error}`);
  if (!services(compose).length) return fail(`${prefix}${PATHS.compose}: немає жодного сервісу в services:`);
  return null;
}

function envEntries(environment) {
  if (!environment) return [];
  if (Array.isArray(environment)) {
    return environment.map((item) => {
      const s = String(item);
      const i = s.indexOf("=");
      return i === -1 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
    });
  }
  return Object.entries(environment);
}

/** `${VAR}`, `${VAR:?msg}`, `$VAR` — a value that comes from outside the file. */
function isComposeReference(value) {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*(:?\?[^}]*)?\}$/.test(value) || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function workflowJobs(workflow) {
  const jobs = workflow.data?.jobs;
  return jobs && typeof jobs === "object" && !Array.isArray(jobs) ? jobs : null;
}

function workflowUnavailable(workflow) {
  return !workflow.exists || workflow.error || workflow.toolError || !workflowJobs(workflow);
}

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// tests may also run inside a Dockerfile stage: docker build --target test
const TEST_COMMAND = /\b(?:npm|pnpm|yarn|bun)\b.*\btest\b|\bnode\s+--test\b|\bdocker\s+(?:buildx\s+)?build\b.*--target[ =]test\b/;

/** A job that actually runs the tests; a reusable workflow's steps are not visible, so its id or path decides. */
function isTestJob(id, job) {
  if (typeof job?.uses === "string") return /test/i.test(id) || /test/i.test(job.uses);
  return asList(job?.steps).some((step) => typeof step?.run === "string" && TEST_COMMAND.test(step.run));
}

// `permissions:` maps hold scopes (`id-token: write`), not values — never inspected.
// `parents` is the chain of objects/arrays above the key, nearest last.
function walk(node, path, visit, parents = []) {
  if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`, visit, [...parents, node]));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "permissions") continue;
      const p = path ? `${path}.${k}` : k;
      visit(k, v, p, [...parents, node]);
      walk(v, p, visit, [...parents, node]);
    }
  }
}

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const SECRET_OPERAND = /^(secrets\.[A-Za-z_][A-Za-z0-9_]*|github\.token)$/;
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;
const PLACEHOLDER = "\u0000"; // stands in for an already-vetted ${{ … }}
// A value filled in from elsewhere: $VAR / ${VAR}, a vetted ${{ … }}, or a printf format slot
// (%s), as in printf "TOKEN=%s" "$TOKEN" when a deploy step writes .env on the server.
const fromOutside = (rhs) => /^["']?\$/.test(rhs) || /^["']?%[-+ 0#]*\d*[sdqb]/.test(rhs) || rhs.replace(/^["']/, "").startsWith(PLACEHOLDER);
// An obvious dummy value (a CI test job needs some value): not a leaked secret.
// (CHANGE_ME is NOT exempt: the seeded configs and the tests use it as the stand-in for a real secret.)
const DUMMY_VALUE = /placeholder|dummy|^(?:ci|test|fake|example)(?:[-_.][\w.-]*)?$/i;
const isDummy = (value) => DUMMY_VALUE.test(String(value).replace(/^["']|["']$/g, ""));

/** Names assigned a literal (NAME=literal) in a shell-ish text, among those `select` keeps. */
function literalAssignments(text, select = () => true) {
  return [...String(text).matchAll(ASSIGNMENT)].filter((m) => select(m[1]) && !fromOutside(m[2]) && !isDummy(m[2])).map((m) => m[1]);
}

/**
 * A value that can only come from secrets: it has at least one ${{ … }}, every one of
 * them uses only secrets.NAME / github.token (`||`, `&&` and parentheses allowed), and
 * no NAME= in it is followed by a literal (multi-line `secrets:` of build actions).
 */
export function isSecretReference(value) {
  const text = String(value);
  const expressions = [...text.matchAll(EXPRESSION)];
  if (!expressions.length) return false;
  for (const [, inner] of expressions) {
    const operands = inner.split(/\|\||&&|[()]/).map((o) => o.trim()).filter(Boolean);
    if (!operands.length || !operands.every((o) => SECRET_OPERAND.test(o))) return false;
  }
  return literalAssignments(text.replace(EXPRESSION, PLACEHOLDER)).length === 0;
}

// keys under `with:` that hold a shell script (appleboy/ssh-action and friends)
const SCRIPT_KEYS = new Set(["run", "script", "command", "commands", "args"]);
const isCacheStep = (step) => typeof step?.uses === "string" && /^actions\/cache(\/|@)/.test(step.uses);

function usesPinned(uses) {
  if (uses.startsWith("./")) return true;
  if (uses.startsWith("docker://")) {
    const ref = parseImageRef(uses.slice("docker://".length));
    return Boolean(ref.digest) || (ref.tag !== null && ref.tag !== "latest");
  }
  const at = uses.lastIndexOf("@");
  if (at === -1) return false;
  const ref = uses.slice(at + 1);
  return /^[0-9a-f]{40}$/i.test(ref) || /^v?\d+(\.\d+){0,2}$/.test(ref);
}

const REQUIRED = "__REQUIRED__"; // ${VAR:?…}: compose refuses to start without it
const UNSET = "__UNSET__"; // ${VAR} / $VAR: may well be empty

/** Why a compose image reference is not pinned, or null. Variables: a :- default is used, :? counts as set. */
export function imageProblem(image) {
  const resolved = image.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*)|(:?\?)[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, name, dash, def, required) => (dash ? def : required ? REQUIRED : UNSET),
  );
  const ref = parseImageRef(resolved);
  if (ref.digest) return null;
  const viaVar = resolved !== image;
  if (ref.tag === null) {
    if (ref.name.endsWith(REQUIRED)) return null; // the whole reference, tag included, comes from a required variable
    if (ref.name.endsWith(UNSET)) return "змінна без :? — якщо її не задано, образ буде без тегу";
    return viaVar ? "за замовчуванням без тегу" : "без тегу";
  }
  if (ref.tag.includes(REQUIRED)) return null;
  if (ref.tag.includes(UNSET)) return "тег зі змінної без :? і без значення за замовчуванням";
  if (ref.tag === "latest") return viaVar ? "за замовчуванням latest" : "тег latest";
  return null;
}

const isNoneTest = (t) => (Array.isArray(t) ? String(t[0]).toUpperCase() === "NONE" : typeof t === "string" && t.trim().toUpperCase() === "NONE");
const healthcheckOff = (hc) => hc?.disable === true || isNoneTest(hc?.test);

// ---------------------------------------------------------------- rules

// A one-shot job (e.g. a nightly script run by `docker compose run`): no ports and an explicit
// "do not restart" policy. It needs neither a restart policy nor a healthcheck.
function oneShot(svc) {
  if (asList(svc?.ports).length) return false;
  return String(svc?.restart ?? "") === "no" || svc?.deploy?.restart_policy?.condition === "none";
}

export const APP_CONFIG = "app/src/config.js";
// Read by Node itself (or the C library under it), not by app/src/config.js.
export const RUNTIME_ENV = new Set(["TZ", "NODE_ENV", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS"]);

/** Names the app reads: every env.NAME / env["NAME"] in app/src/config.js; null if there is no such file. */
export function envReadByApp(root) {
  const full = join(root, APP_CONFIG);
  if (!existsSync(full)) return null;
  const text = readFileSync(full, "utf8");
  return new Set([...text.matchAll(/\benv(?:\.([A-Za-z_]\w*)|\[\s*["']([A-Za-z_]\w*)["']\s*\])/g)].map((m) => m[1] ?? m[2]));
}

// A service runs the app if it builds it, uses the image of a service that does, or its image
// is named after the app (app/package.json "name"). A postgres or nginx sidecar has its own env.
function appServices(compose, root) {
  let appName = null;
  try {
    appName = JSON.parse(readFileSync(join(root, "app/package.json"), "utf8")).name?.toLowerCase() ?? null;
  } catch {
    // no package.json: only build: and shared images identify the app
  }
  const all = services(compose);
  const built = new Set(all.filter(([, svc]) => svc?.build && svc?.image).map(([, svc]) => String(svc.image)));
  return all.filter(([, svc]) => {
    if (svc?.build) return true;
    const image = String(svc?.image ?? "");
    return image !== "" && (built.has(image) || (appName !== null && image.toLowerCase().includes(appName)));
  });
}

export const RULES = [
  {
    id: "D1",
    title: "Базовий образ з явним тегом (не latest)",
    hint: "Вкажіть конкретну версію базового образу (наприклад, мажорна версія Node + варіант) або digest @sha256:…",
    check({ dockerfile }) {
      if (!dockerfile.exists) return fail(`${PATHS.dockerfile} не знайдено`);
      const all = stages(dockerfile);
      if (!all.length) return fail(`${PATHS.dockerfile}: немає FROM`);
      const vars = globalArgs(dockerfile);
      const aliases = new Set();
      const problems = [];
      for (const { from } of all) {
        const tokens = tokenize(from.args).filter((t) => !t.startsWith("--"));
        const image = substitute(tokens[0] ?? "", vars);
        const asIndex = tokens.findIndex((t) => t.toUpperCase() === "AS");
        const alias = asIndex !== -1 ? tokens[asIndex + 1]?.toLowerCase() : null;
        if (!aliases.has(image.toLowerCase()) && image !== "scratch") {
          const ref = parseImageRef(image);
          if (image.includes("$")) problems.push(`рядок ${from.line}: FROM ${tokens[0]} — тег з ARG без значення`);
          else if (!ref.digest && (ref.tag === null || ref.tag === "latest")) {
            problems.push(`рядок ${from.line}: FROM ${image} — ${ref.tag ? "тег latest" : "без тегу"}`);
          }
        }
        if (alias) aliases.add(alias);
      }
      return problems.length ? fail(problems.join("; ")) : pass("усі FROM мають конкретний тег або digest");
    },
  },
  {
    id: "D2",
    title: "USER у фінальному образі, не root",
    hint: "Додайте у фінальну стадію USER з непривілейованим користувачем (в образах node є користувач node) — після COPY і перед CMD.",
    check({ dockerfile }) {
      if (!dockerfile.exists) return fail(`${PATHS.dockerfile} не знайдено`);
      const last = stages(dockerfile).at(-1);
      const user = last?.body.filter((i) => i.instruction === "USER").at(-1);
      if (!user) return fail("у фінальній стадії немає USER — контейнер працює як root");
      const name = user.args.split(":")[0].trim().toLowerCase();
      if (name === "root" || name === "0") return fail(`рядок ${user.line}: USER ${user.args} — це root`);
      return pass(`USER ${user.args}`);
    },
  },
  {
    id: "D3",
    title: "Перевірка здоров'я: HEALTHCHECK або healthcheck у кожного сервісу",
    hint: "Або HEALTHCHECK у Dockerfile, або healthcheck: (test, interval, retries) у кожного сервісу compose; HEALTHCHECK NONE, test: [\"NONE\"] і disable: true — це не перевірка. Образ спільний для api і worker, а HTTP-сервер є лише в api: HTTP-перевірку з образу worker не пройде — для worker вимкніть її (healthcheck: disable: true) або дайте йому власну, а сервісу з ports: її вимикати не можна. У node:*-alpine і node:*-slim немає curl — перевіряйте через node -e.",
    check({ dockerfile, compose }) {
      const final = stages(dockerfile).at(-1);
      const hc = final?.body.filter((i) => i.instruction === "HEALTHCHECK").at(-1);
      if (hc && !/^NONE\b/i.test(hc.args)) {
        const where = `HEALTHCHECK у Dockerfile (рядок ${hc.line})`;
        if (composeProblem(compose)) return pass(where);
        const off = services(compose)
          .filter(([, svc]) => asList(svc?.ports).length && healthcheckOff(svc?.healthcheck))
          .map(([name]) => name);
        if (off.length) return fail(`${where}, але compose вимикає його для сервісів з ports: ${off.join(", ")}`);
        return pass(where);
      }
      const problem = composeProblem(compose, "у Dockerfile немає HEALTHCHECK, а ");
      if (problem) return problem;
      const missing = services(compose)
        .filter(([, svc]) => !oneShot(svc) && (!svc?.healthcheck?.test || healthcheckOff(svc.healthcheck)))
        .map(([name]) => name);
      if (missing.length) return fail(`у Dockerfile немає HEALTHCHECK; без healthcheck у compose: ${missing.join(", ")}`);
      return pass("healthcheck є в кожного сервісу compose");
    },
  },
  {
    id: "D4",
    title: "Жодних секретів у ENV/ARG Dockerfile",
    hint: "Секрет не має бути в образі: приберіть ENV/ARG зі значенням для TOKEN/SECRET/PASSWORD/KEY і передавайте його під час запуску — environment: з ${VAR:?…} з оточення. secrets: / *_FILE — лише якщо додасте читання файлу в app/src/config.js: застосунок бере секрети тільки зі змінних оточення.",
    check({ dockerfile }) {
      if (!dockerfile.exists) return fail(`${PATHS.dockerfile} не знайдено`);
      const problems = [];
      for (const ins of dockerfile.instructions) {
        if (ins.instruction !== "ENV" && ins.instruction !== "ARG") continue;
        for (const [key, value] of keyValues(ins.instruction, ins.args)) {
          if (isSecretLike(key) && value !== null && value !== "") {
            problems.push(`рядок ${ins.line}: ${ins.instruction} ${key} має значення в образі`);
          }
        }
      }
      return problems.length ? fail(problems.join("; ")) : pass("секретоподібних ENV/ARG зі значенням немає");
    },
  },
  {
    id: "C1",
    title: "Образи в compose з фіксованим тегом",
    hint: "Кожен сервіс — image: з версією (наприклад, тег релізу або ${IMAGE_TAG:?}), не latest і не без тегу. Змінна в тегу — лише з :? (обов'язкова) або з :-значенням за замовчуванням, яке саме є версією. Лише build: без image теж не годиться.",
    check({ compose }) {
      const problem = composeProblem(compose);
      if (problem) return problem;
      const problems = [];
      for (const [name, svc] of services(compose)) {
        const image = svc?.image;
        if (!image) problems.push(`${name}: немає image`);
        else {
          const why = imageProblem(String(image));
          if (why) problems.push(`${name}: ${image} — ${why}`);
        }
      }
      return problems.length ? fail(problems.join("; ")) : pass("усі образи мають тег або digest");
    },
  },
  {
    id: "C2",
    title: "Політика перезапуску в кожного сервісу",
    hint: "Додайте restart: unless-stopped (або on-failure) кожному довгоживучому сервісу — інакше впалий процес так і лишиться лежати. Разова задача без ports: (запуск через docker compose run) може мати restart: \"no\" — це теж явне рішення.",
    check({ compose }) {
      const problem = composeProblem(compose);
      if (problem) return problem;
      const missing = services(compose)
        .filter(([, svc]) => {
          const restart = String(svc?.restart ?? "");
          const ok = ["always", "unless-stopped", "on-failure"].includes(restart) || restart.startsWith("on-failure:");
          const condition = svc?.deploy?.restart_policy?.condition;
          return !ok && !["on-failure", "any"].includes(condition) && !oneShot(svc);
        })
        .map(([name]) => name);
      return missing.length ? fail(`без restart: ${missing.join(", ")}`) : pass("restart є в кожного сервісу");
    },
  },
  {
    id: "C3",
    title: "Ліміт пам'яті в кожного сервісу",
    hint: "Задайте mem_limit: або deploy.resources.limits.memory кожному сервісу — разом вони мають уміститися в пам'ять VM.",
    check({ compose }) {
      const problem = composeProblem(compose);
      if (problem) return problem;
      const missing = services(compose)
        .filter(([, svc]) => !svc?.mem_limit && !svc?.deploy?.resources?.limits?.memory)
        .map(([name]) => name);
      return missing.length ? fail(`без ліміту пам'яті: ${missing.join(", ")}`) : pass("ліміт пам'яті є в кожного сервісу");
    },
  },
  {
    id: "C4",
    title: "Секрети в compose лише посиланням",
    hint: "Для TOKEN/SECRET/PASSWORD/KEY — значення ${VAR} або ${VAR:?…} з оточення чи .env поза git; ${VAR:-літерал} — теж літерал. secrets: / *_FILE — лише якщо додасте читання файлу в app/src/config.js: застосунок бере секрети тільки зі змінних оточення.",
    check({ compose }) {
      const problem = composeProblem(compose);
      if (problem) return problem;
      const problems = [];
      for (const [name, svc] of services(compose)) {
        for (const [key, value] of envEntries(svc?.environment)) {
          if (!isSecretLike(key) || value === null || value === undefined) continue;
          if (!isComposeReference(String(value))) problems.push(`${name}: ${key} задано літералом`);
        }
      }
      return problems.length ? fail(problems.join("; ")) : pass("секретоподібні змінні задано посиланнями");
    },
  },
  {
    // Post-mortem 2026-10-14, action item #1: DB_POOL_MAX was renamed to DB_POOL_SIZE in
    // compose, config.js never read the new name, and the pool silently fell back to 4.
    id: "E1",
    title: "Кожну змінну з environment: застосунку читає app/src/config.js",
    hint: "Застосунок бачить лише змінні, які читає app/src/config.js (env.NAME); змінну з іншою назвою він мовчки ігнорує і бере значення за замовчуванням — так 14.10 DB_POOL_SIZE замість DB_POOL_MAX зменшив пул БД з 20 до 4. Поверніть назву, яку читає config.js, або спершу додайте її читання в config.js. TZ, NODE_ENV, NODE_OPTIONS, NODE_EXTRA_CA_CERTS читає сам Node — їх можна. Сервіси з чужими образами (postgres, nginx) не перевіряються.",
    check({ compose, root }) {
      const problem = composeProblem(compose);
      if (problem) return problem;
      const known = envReadByApp(root);
      if (!known) return skip(`немає ${APP_CONFIG} — нема з чим звірити змінні`);
      const ours = appServices(compose, root);
      if (!ours.length) return skip("жоден сервіс compose не запускає застосунок (build:, його образ чи назва з app/package.json)");
      const problems = [];
      for (const [name, svc] of ours) {
        for (const [key] of envEntries(svc?.environment)) {
          if (!known.has(key) && !RUNTIME_ENV.has(key)) problems.push(`${name}: ${key}`);
        }
      }
      return problems.length
        ? fail(`${APP_CONFIG} не читає: ${problems.join("; ")}`)
        : pass(`змінні ${ours.map(([n]) => n).join(", ")} читає ${APP_CONFIG}`);
    },
  },
  {
    id: "W1",
    title: "pipeline/deploy.yml існує, валідний YAML, без pull_request_target",
    hint: "Створіть pipeline/deploy.yml (не в .github/workflows/) з on: і jobs:. Тригер pull_request_target дає коду з чужого PR доступ до секретів — не використовуйте його.",
    check({ workflow }) {
      if (!workflow.exists) return fail(`${PATHS.workflow} не знайдено`);
      if (workflow.toolError) return toolFail(workflow);
      if (workflow.error) return fail(`${PATHS.workflow} не розібрався як YAML: ${workflow.error}`);
      if (!workflowJobs(workflow)) return fail(`${PATHS.workflow}: немає jobs:`);
      const on = workflow.data.on;
      if (on === undefined) return fail(`${PATHS.workflow}: немає on:`);
      const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
      if (triggers.includes("pull_request_target")) return fail("тригер pull_request_target");
      return pass(`тригери: ${triggers.join(", ")}`);
    },
  },
  {
    id: "W2",
    title: "Мінімальні permissions на рівні workflow",
    hint: "Додайте на верхньому рівні permissions: (наприклад, contents: read) і розширюйте права лише в job, якій вони потрібні. write-all — ні.",
    check({ workflow }) {
      if (workflowUnavailable(workflow)) return skip(`немає валідного ${PATHS.workflow} (див. W1)`);
      if (!("permissions" in workflow.data)) return fail("немає permissions: на верхньому рівні — діють права за замовчуванням");
      if (workflow.data.permissions === "write-all") return fail("permissions: write-all");
      return pass("permissions задано");
    },
  },
  {
    id: "W3",
    title: "Деплой-job з environment: і needs: на тести",
    hint: "Job деплою — це job з environment: (там налаштовують approval). Вона має залежати через needs: (прямо або через build) від job, яка справді запускає тести: крок run: з npm test / node --test (для reusable workflow — test в id або в шляху).",
    check({ workflow }) {
      if (workflowUnavailable(workflow)) return skip(`немає валідного ${PATHS.workflow} (див. W1)`);
      const jobs = workflowJobs(workflow);
      const deployJobs = Object.entries(jobs).filter(([, job]) => job?.environment);
      if (!deployJobs.length) return fail("немає job з environment:");
      for (const [id] of deployJobs) {
        const seen = new Set();
        const queue = asList(jobs[id]?.needs).map(String);
        while (queue.length) {
          const next = queue.shift();
          if (seen.has(next) || !jobs[next]) continue;
          seen.add(next);
          queue.push(...asList(jobs[next].needs).map(String));
        }
        const tests = [...seen].filter((j) => j !== id && isTestJob(j, jobs[j]));
        if (tests.length) return pass(`${id} (environment) ← needs ← ${tests.join(", ")}`);
      }
      return fail(`${deployJobs.map(([id]) => id).join(", ")}: environment є, але needs: не веде до job тестів`);
    },
  },
  {
    id: "W4",
    title: "Секрети в workflow лише через ${{ secrets.NAME }}",
    hint: "Значення для TOKEN/SECRET/PASSWORD/KEY — тільки ${{ secrets.NAME }} (або ${{ github.token }}), ніяких літералів ні в env:/with:, ні в скриптах run: / with.script.",
    check({ workflow }) {
      if (workflowUnavailable(workflow)) return skip(`немає валідного ${PATHS.workflow} (див. W1)`);
      const problems = [];
      walk(workflow.data, "", (key, value, path, parents) => {
        if (key === "secrets" && value === "inherit") return; // reusable workflow: pass caller's secrets on
        const inWith = parents.length >= 2 && parents.at(-2)?.with === parents.at(-1);
        if (inWith && isCacheStep(parents.at(-2)) && ["key", "restore-keys"].includes(key)) return; // cache keys
        if (typeof value !== "string" && typeof value !== "number") return;
        if (isSecretLike(key)) {
          if (!isSecretReference(value) && !isDummy(value)) problems.push(`${path} не з secrets`);
          return;
        }
        const script = key === "run" || (inWith && (SCRIPT_KEYS.has(key) || String(value).includes("\n")));
        if (script) for (const name of literalAssignments(value, isSecretLike)) problems.push(`${path}: ${name}= літералом`);
      });
      return problems.length ? fail(problems.join("; ")) : pass("секретоподібні значення лише з secrets");
    },
  },
  {
    id: "W5",
    title: "Кожен uses: закріплено тегом або SHA",
    hint: "Пишіть owner/action@v4 (тег версії) або @<40-символьний SHA>, не @main/@master і не без @. Локальні ./… не перевіряються.",
    check({ workflow }) {
      if (workflowUnavailable(workflow)) return skip(`немає валідного ${PATHS.workflow} (див. W1)`);
      const problems = [];
      let count = 0;
      for (const [id, job] of Object.entries(workflowJobs(workflow))) {
        const refs = [job?.uses, ...asList(job?.steps).map((s) => s?.uses)].filter((u) => typeof u === "string");
        for (const uses of refs) {
          count += 1;
          if (!usesPinned(uses)) problems.push(`${id}: ${uses}`);
        }
      }
      return problems.length ? fail(`не закріплено: ${problems.join("; ")}`) : pass(`закріплено: ${count}`);
    },
  },
];

// ---------------------------------------------------------------- running

export function runChecks(ctx, rules = RULES) {
  return rules.map((rule) => {
    let result;
    try {
      result = rule.check(ctx);
    } catch (err) {
      result = fail(`правило впало: ${err.message}`);
    }
    return { id: rule.id, title: rule.title, hint: rule.hint, ...result };
  });
}

export function formatReport(results) {
  const lines = ["ID  STATUS  MESSAGE"];
  for (const r of results) {
    lines.push(`${r.id.padEnd(3)} ${r.status.padEnd(7)} ${r.title}: ${r.message}`);
    if (r.status === "FAIL" && !r.toolError) lines.push(`            підказка: ${r.hint}`);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  lines.push("", `PASS ${count("PASS")}  FAIL ${count("FAIL")}  SKIP ${count("SKIP")}`);
  if (results.some((r) => r.toolError)) lines.push("", `УВАГА: ${YAML_TOOL} не запустився, YAML-правила не перевірено. ${TOOL_HINT}`);
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--root");
  const root = resolve(i !== -1 ? argv[i + 1] : fileURLToPath(new URL("..", import.meta.url)));
  const results = runChecks(loadContext(root));
  process.stdout.write(formatReport(results));
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}

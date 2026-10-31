#!/usr/bin/env node
// Queries over incident/ for docs/rca.md. No dependencies; run from the repo root:
//   node docs/rca-queries.mjs <command> [args]
// Works the same in PowerShell, cmd and Git Bash.
//
//   msgs <log.jsonl>                          count of each "msg", most frequent first
//   find <log.jsonl> <text>                   lines containing <text>: count, first and last ts
//   lines <file> <text>                       every line containing <text>, with its number
//   count <log.jsonl> <text> [HH:MM] [HH:MM]  how many lines contain <text> in [from, to)
//   per-minute <log.jsonl> <text> [HH:MM] [HH:MM]  lines containing <text>, per minute
//   group <log.jsonl> <msg> <field,field,...> [HH:MM] [HH:MM]  events with this msg, counted
//                                             by the given fields (e.g. status,path,error)
//   metric <metrics.csv> <column> <HH:MM> <HH:MM>  avg / min / max of a column, [from, to)
//   rows <metrics.csv> <HH:MM> <HH:MM> [col,col,...]  the rows themselves, [from, to)
//   above <metrics.csv> <column> <threshold> [HH:MM] [HH:MM]  minutes where column > threshold:
//                                             how many, first and last
//   est-5xx <metrics.csv> [HH:MM] [HH:MM]     5xx responses the metrics imply: sum over minutes
//                                             of rps * 60 * error_rate (to compare with the log)
//   env-unread <file> [old|new]               env vars set in <file> (compose or diff) that
//                                             app/src/config.js never reads; for a diff, `old`
//                                             reads the -/context lines, `new` the +/context
//                                             lines, nothing — every line. TZ is read by Node.

import { readFileSync } from "node:fs";

const [cmd, ...args] = process.argv.slice(2);
const read = (file) => readFileSync(file, "utf8");
const jsonLines = (file) => read(file).trim().split("\n").map((line) => JSON.parse(line));
const hhmm = (ts) => ts.slice(11, 16);
const inRange = (ts, from = "00:00", to = "24:00") => hhmm(ts) >= from && hhmm(ts) < to;

function csv(file) {
  const [head, ...rows] = read(file).trim().split("\n");
  const cols = head.split(",");
  return rows.map((row) => Object.fromEntries(row.split(",").map((v, i) => [cols[i], i === 0 ? v : Number(v)])));
}

const commands = {
  msgs([file]) {
    const counts = {};
    for (const e of jsonLines(file)) counts[`${e.level} ${e.msg}`] = (counts[`${e.level} ${e.msg}`] ?? 0) + 1;
    for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(7), k);
  },

  find([file, text]) {
    const hits = read(file).trim().split("\n").filter((line) => line.includes(text));
    console.log(`count ${hits.length}`);
    if (hits.length) {
      console.log(`first ${hits[0]}`);
      console.log(`last  ${hits.at(-1)}`);
    }
  },

  lines([file, text]) {
    read(file).split("\n").forEach((line, i) => {
      if (line.includes(text)) console.log(`${i + 1}: ${line}`);
    });
  },

  count([file, text, from, to]) {
    let n = 0;
    for (const line of read(file).trim().split("\n")) {
      if (line.includes(text) && inRange(JSON.parse(line).ts, from, to)) n += 1;
    }
    console.log(`count ${n}`);
  },

  "per-minute"([file, text, from, to]) {
    const counts = new Map();
    for (const line of read(file).trim().split("\n")) {
      if (!line.includes(text)) continue;
      const ts = JSON.parse(line).ts;
      if (inRange(ts, from, to)) counts.set(hhmm(ts), (counts.get(hhmm(ts)) ?? 0) + 1);
    }
    for (const [m, n] of counts) console.log(m, n);
  },

  group([file, msg, fields, from, to]) {
    const keys = fields.split(",");
    const counts = {};
    for (const e of jsonLines(file)) {
      if (e.msg !== msg || !inRange(e.ts, from, to)) continue;
      const k = keys.map((f) => `${f}=${e[f]}`).join("  ");
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(7), k);
  },

  metric([file, col, from, to]) {
    const v = csv(file).filter((r) => inRange(r.ts, from, to)).map((r) => r[col]);
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    console.log(`${col} ${from}-${to} n=${v.length} avg=${avg.toFixed(2)} min=${Math.min(...v)} max=${Math.max(...v)}`);
  },

  rows([file, from, to, cols]) {
    const rows = csv(file).filter((r) => inRange(r.ts, from, to));
    const pick = cols ? ["ts", ...cols.split(",")] : Object.keys(rows[0] ?? {});
    console.log(pick.join(","));
    for (const r of rows) console.log(pick.map((c) => (c === "ts" ? hhmm(r.ts) : r[c])).join(","));
  },

  above([file, col, threshold, from, to]) {
    const hits = csv(file).filter((r) => inRange(r.ts, from, to) && r[col] > Number(threshold));
    console.log(`${col} > ${threshold}: ${hits.length} min` + (hits.length ? `, first ${hhmm(hits[0].ts)}, last ${hhmm(hits.at(-1).ts)}` : ""));
  },

  "est-5xx"([file, from, to]) {
    const n = csv(file)
      .filter((r) => inRange(r.ts, from, to))
      .reduce((sum, r) => sum + r.rps * 60 * r.error_rate, 0);
    console.log(`5xx implied by metrics: ${Math.round(n)}`);
  },

  "env-unread"([file, side]) {
    const readByApp = new Set([...read("app/src/config.js").matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]));
    const keep = { old: /^[- ]/, new: /^[+ ]/ }[side];
    const set = new Set();
    // Variables count only inside an `environment:` block or a top-level `x-*:` extension
    // block (anchors like `x-db-env: &db-env` merged into environment:) — not in `labels:`,
    // `cap_drop:` or other lists and maps. `ctxIndent` is the indent of that block's key.
    let ctxIndent = null;
    for (const raw of read(file).split("\n")) {
      if (keep && !keep.test(raw)) continue;
      const line = keep ? raw.slice(1) : raw;
      const indent = line.search(/\S/);
      if (indent === -1 || line[indent] === "#") continue; // blank or comment-only line
      if (ctxIndent !== null && indent <= ctxIndent) ctxIndent = null;
      // one-line flow form: `environment: {NAME: "v", …}` or `environment: [NAME=v, …]`
      const flow = /^\s*environment:\s*(?:&[\w-]+\s*)?([{[].*)$/.exec(line);
      if (flow) {
        for (const m of flow[1].matchAll(/[{[,]\s*["']?([A-Z][A-Z0-9_]*)["']?\s*(?=[:=,\]}])/g)) set.add(m[1]);
        continue;
      }
      // `environment:` alone, with an anchor (`environment: &app-env`) and/or a trailing comment
      if (/^\s*environment:\s*(&[\w-]+\s*)?(#.*)?$/.test(line) || /^x-[\w-]+:/.test(line)) {
        ctxIndent = indent;
        continue;
      }
      if (ctxIndent === null) continue;
      // map form `NAME: value`; list form `- NAME=value` or a bare `- NAME` (value from the host)
      const map = /^\s+([A-Z][A-Z0-9_]*):/.exec(line);
      const list = /^\s+-\s+["']?([A-Z][A-Z0-9_]*)(=|["']?\s*$)/.exec(line);
      if (map) set.add(map[1]);
      else if (list) set.add(list[1]);
    }
    const unread = [...set].filter((k) => !readByApp.has(k) && k !== "TZ");
    console.log(`read by app/src/config.js: ${[...readByApp].join(", ")}`);
    console.log(`set in ${file}${side ? ` (${side})` : ""}: ${[...set].join(", ")}`);
    console.log(`never read: ${unread.join(", ") || "none"}`);
  },
};

if (!commands[cmd]) {
  console.error(`unknown command: ${cmd ?? "(none)"}; see the header of docs/rca-queries.mjs`);
  process.exit(2);
}
commands[cmd](args);

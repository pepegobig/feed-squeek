#!/usr/bin/env node
// Finds Feed Squeek level orders on IMD and prepares them for the game. Run by the game's operator, not by builders.
//   node tools/ingest.mjs scan [--work <dir>] [--canvas <path>]   find finished orders, check them, write a report;
//                                                                  the last line counts results that are new since the last scan
//   node tools/ingest.mjs add <job id>...                          list checked orders in levels/index.json
//   node tools/ingest.mjs reject <job id> <reason>                 skip an order in later scans
// An order is an IMD job that a player paid for and whose objective starts with "Feed Squeek level order" (agent.md).
// scan downloads each finished job's submission, takes levels/<id>.js out of it, runs validate-level.mjs on it in a
// separate process, compares it with the order, renders a preview when --canvas is given, and prints every text a
// player will see. A person reads that report and looks at the preview before running add.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const API = process.env.FEED_SQUEEK_API || "https://api.imd.fun"; // the override is for tests
const REPO_URL = "https://github.com/pepegobig/feed-squeek.git";
const MARKER = "Feed Squeek level order";
const MAX_BUNDLE = 32 * 1024 * 1024;
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? resolve(args.splice(i, 2)[1]) : dflt; };
const WORK = opt("--work", join(ROOT, ".ingest"));
const CANVAS = opt("--canvas", null);
const INDEX = join(ROOT, "levels", "index.json");
const DONE = join(WORK, "done.json");

const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2) + "\n");
const git = (...a) => execFileSync("git", ["-C", join(WORK, "repo.git"), ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
async function getJson(path) {
  const r = await fetch(API + path, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
// Canvas settings that are not text a player reads.
const CANVAS_WORDS = new Set(["center", "middle", "left", "right", "top", "bottom", "start", "end", "alphabetic", "hanging", "ideographic",
  "round", "butt", "square", "bevel", "miter", "lighter", "source-over", "source-atop", "destination-out", "multiply", "screen", "overlay",
  "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "copy", "xor"]);
const textOk = (t) => !/[<>\u0000-\u0008\u000b-\u001f]|https?:|www\./i.test(t);

// The order lines at the top of the objective (agent.md, "Write the brief").
function parseOrder(objective) {
  const lines = String(objective).split("\n").slice(0, 6).map((l) => l.trim());
  if (lines[0] !== MARKER) return null;
  const field = (name) => { const l = lines.find((x) => x.startsWith(name + ":")); return l === undefined ? null : l.slice(name.length + 1).trim(); };
  const file = field("Level file"), m = file && /^levels\/([a-z0-9-]{3,48})\.js$/.exec(file);
  const weapon = field("Weapon");
  return {
    id: m ? m[1] : null, theme: field("Theme"), snacks: Number(field("Snacks")),
    faster: Number(String(field("Faster") || "").replace(/%$/, "")), weapon: weapon && weapon.toLowerCase() !== "none" ? weapon : "",
  };
}

function orderProblems(o) {
  const p = [];
  if (!o.id) p.push("the objective has no valid 'Level file: levels/<id>.js' line");
  if (!o.theme || o.theme.length > 140 || !textOk(o.theme)) p.push("the theme is missing, longer than 140 characters, or has a link or markup");
  if (!Number.isInteger(o.snacks) || o.snacks < 8 || o.snacks > 40) p.push("snacks is not a whole number from 8 to 40");
  if (!Number.isInteger(o.faster) || o.faster < 0 || o.faster > 100) p.push("faster is not a whole number from 0 to 100");
  if (o.weapon.length > 100 || !textOk(o.weapon)) p.push("the weapon text is longer than 100 characters or has a link or markup");
  return p;
}

function prepareRepo() {
  mkdirSync(WORK, { recursive: true });
  if (!existsSync(join(WORK, "repo.git"))) execFileSync("git", ["init", "--quiet", "--bare", join(WORK, "repo.git")]);
  // A submission bundle needs the commit it was built on, so fetch the game's history first.
  git("fetch", "--quiet", "--no-tags", REPO_URL, "+refs/heads/*:refs/remotes/github/*");
  try { git("fetch", "--quiet", "--no-tags", ROOT, "+refs/heads/*:refs/remotes/local/*"); } catch { /* a clone without local branches */ }
}

async function download(url, dest) {
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`bundle download: HTTP ${r.status}`);
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_BUNDLE) throw new Error(`the bundle is larger than ${MAX_BUNDLE} bytes`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BUNDLE) throw new Error(`the bundle is larger than ${MAX_BUNDLE} bytes`);
  writeFileSync(dest, buf);
}

// Returns { file } with the level taken out of the job's last submission, or { problems }.
async function extract(job, result, order, dir) {
  const sources = (Array.isArray(result.source) ? result.source : []).filter((s) => s && typeof s.url === "string" && /^[0-9a-f]{64}$/.test(s.hash || ""));
  if (!sources.length) return { problems: ["the job result has no source bundle"] };
  const want = `levels/${order.id}.js`, ref = `refs/orders/${job.id}`;
  for (const s of sources.slice().reverse()) {
    const bundle = join(dir, `${s.hash}.bundle`);
    if (!existsSync(bundle)) await download(s.url, bundle);
    try {
      const heads = execFileSync("git", ["bundle", "list-heads", bundle], { encoding: "utf8" }).trim().split("\n");
      const head = heads.map((l) => l.split(" ")).find(([, name]) => name === "refs/heads/imd-submission");
      if (!head) continue;
      git("fetch", "--quiet", "--no-tags", bundle, `+refs/heads/imd-submission:${ref}`);
      const base = job.project && job.project.versions && job.project.versions.find((v) => v.jobId === job.id);
      const changed = git("diff", "--name-only", `${base && base.baseCommit ? base.baseCommit : `${ref}~1`}`, ref).trim().split("\n").filter(Boolean);
      if (!changed.includes(want)) continue;
      const others = changed.filter((f) => f !== want);
      const file = join(dir, "levels", `${order.id}.js`);
      mkdirSync(join(dir, "levels"), { recursive: true });
      writeFileSync(file, git("show", `${ref}:${want}`));
      return { file, others };
    } catch (e) { return { problems: [`the submission could not be read: ${String(e.message || e).split("\n")[0]}`] }; }
  }
  return { problems: [`no submission adds ${want}`] };
}

function validate(file) {
  try {
    const out = execFileSync(process.execPath, ["--max-old-space-size=256", join(ROOT, "tools", "validate-level.mjs"), "--json", file],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(out.trim().split("\n").pop());
  } catch (e) {
    const out = String(e.stdout || "").trim().split("\n").pop();
    try { return JSON.parse(out); } catch { return { errors: [`the check did not finish: ${String(e.message || e).split("\n")[0]}`] }; }
  }
}

function preview(file, png) {
  if (!CANVAS) return null;
  try {
    execFileSync(process.execPath, ["--max-old-space-size=512", join(ROOT, "tools", "preview-level.mjs"), file, png, "--canvas", CANVAS],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    return png;
  } catch { return null; }
}

async function scan() {
  const index = readJson(INDEX, { levels: [] }), done = readJson(DONE, {});
  const listed = new Set(index.levels.map((l) => l.order && l.order.job).filter(Boolean));
  const ids = new Set(index.levels.map((l) => l.id));
  const list = await getJson(`/jobs?limit=200&q=${encodeURIComponent(MARKER)}`);
  const jobs = (list.jobs || []).filter((j) => String(j.objective || "").startsWith(MARKER) && !listed.has(j.id) && !done[j.id]);
  if (!jobs.length) { console.log("No new orders.\n\nNothing new since the last scan."); return; }
  prepareRepo();
  const fresh = {};
  for (const j of jobs) {
    const dir = join(WORK, j.id);
    mkdirSync(dir, { recursive: true });
    const report = { job: j.id, state: j.state, explorer: `https://explorer.imd.fun/jobs/${j.id}`, problems: [] };
    try {
      const job = await getJson(`/jobs/${j.id}`);
      report.paidBy = job.paidBy; report.createdAt = job.createdAt;
      const order = parseOrder(job.objective);
      if (!order) { report.problems.push("the objective does not start with the order lines"); }
      else {
        report.order = order;
        report.problems.push(...orderProblems(order));
        if (order.id && ids.has(order.id)) report.problems.push(`a level with the id ${order.id} is already listed`);
      }
      if (j.state !== "completed") { report.status = j.state === "blocked" ? "blocked" : "waiting"; report.blockedReason = job.blockedReason || null; }
      else if (!report.problems.length) {
        const got = await extract(job, await getJson(`/jobs/${j.id}/result`), order, dir);
        if (got.problems) report.problems.push(...got.problems);
        else {
          report.file = got.file;
          if (got.others.length) report.otherFiles = got.others;
          const v = validate(got.file);
          if (!v.ok) report.problems.push(...(v.errors || ["the check failed"]).map((e) => `check: ${e}`));
          else {
            report.level = v.level; report.strings = v.strings;
            if (v.level.start !== order.snacks) report.problems.push(`start is ${v.level.start}, the order asked for ${order.snacks} snacks`);
            if (Math.abs(v.level.speed - (1 + order.faster / 100)) > 0.005) report.problems.push(`speed is ${v.level.speed}, the order asked for ${1 + order.faster / 100}`);
            report.preview = preview(got.file, join(dir, "preview.png"));
          }
        }
      }
    } catch (e) { report.problems.push(String(e.message || e).split("\n")[0]); }
    if (!report.status) report.status = report.problems.length ? "rejected" : "ready";
    const before = readJson(join(dir, "report.json"), null);
    report.isNew = report.status !== "waiting" && (!before || before.status !== report.status);
    writeJson(join(dir, "report.json"), report);
    printReport(report);
    if (report.isNew) fresh[report.status] = (fresh[report.status] || 0) + 1;
  }
  const n = Object.entries(fresh).map(([k, v]) => `${v} ${k}`).join(", ");
  console.log(`\n${n ? `NEW SINCE LAST SCAN: ${n}` : "Nothing new since the last scan."}`);
}

function printReport(r) {
  console.log(`\n${r.isNew ? "NEW " : ""}${r.status.toUpperCase()}  ${r.job}  ${r.explorer}`);
  if (r.order) {
    console.log(`  theme:  ${JSON.stringify(r.order.theme)}`);
    console.log(`  weapon: ${JSON.stringify(r.order.weapon)}   snacks ${r.order.snacks}, faster ${r.order.faster}%   file levels/${r.order.id}.js`);
  }
  if (r.level) {
    console.log(`  level:  name ${JSON.stringify(r.level.name)}, cue ${JSON.stringify(r.level.cue)}${r.level.weapon ? `, weapon ${JSON.stringify(r.level.weapon.name || "")}` : ""}`);
    const texts = (r.strings || []).filter((t) => /[a-z]{3}/i.test(t) && !CANVAS_WORDS.has(t) && !/^(rgba?|hsla?)\(|^#[0-9a-f]{3,8}$|\bpx\b/i.test(t));
    if (texts.length) console.log(`  painter text: ${texts.map((t) => JSON.stringify(t)).join(", ")}`);
  }
  if (r.preview) console.log(`  preview: ${r.preview}`);
  if (r.otherFiles) console.log(`  also changed (ignored): ${r.otherFiles.join(", ")}`);
  if (r.blockedReason) console.log(`  blocked: ${r.blockedReason}`);
  for (const p of r.problems) console.log(`  - ${p}`);
}

function add(jobIds) {
  const index = readJson(INDEX, { levels: [] }), done = readJson(DONE, {});
  for (const id of jobIds) {
    const r = readJson(join(WORK, id, "report.json"), null);
    if (!r || r.status !== "ready") { console.log(`skip ${id}: no ready report (run scan first)`); continue; }
    if (index.levels.some((l) => l.id === r.level.id)) { console.log(`skip ${id}: ${r.level.id} is already listed`); continue; }
    const v = validate(r.file);
    if (!v.ok) { console.log(`skip ${id}: the check fails now`); continue; }
    copyFileSync(r.file, join(ROOT, "levels", `${r.level.id}.js`));
    const entry = { id: r.level.id, name: r.level.name, cue: r.level.cue, start: r.level.start, speed: r.level.speed };
    if (r.level.weapon) entry.weapon = r.level.weapon;
    entry.order = { job: id, theme: r.order.theme, weapon: r.order.weapon, snacks: r.order.snacks, faster: r.order.faster };
    entry.added = new Date().toISOString().slice(0, 10);
    index.levels.push(entry);
    done[id] = { added: entry.id };
    console.log(`added levels/${entry.id}.js from ${id}`);
  }
  writeJson(INDEX, index);
  mkdirSync(WORK, { recursive: true });
  writeJson(DONE, done);
  console.log("Now sign the list for the game's other copies: node tools/sign-levels.mjs <private key PEM file>");
}

function reject(id, reason) {
  if (!/^[0-9a-f-]{36}$/.test(id || "") || !reason) { console.error("usage: node tools/ingest.mjs reject <job id> <reason>"); process.exit(2); }
  mkdirSync(WORK, { recursive: true });
  const done = readJson(DONE, {});
  done[id] = { rejected: reason, at: new Date().toISOString() };
  writeJson(DONE, done);
  console.log(`${id} will be skipped: ${reason}`);
}

const cmd = args.shift();
if (cmd === "scan") await scan();
else if (cmd === "add" && args.length) add(args);
else if (cmd === "reject") reject(args[0], args.slice(1).join(" "));
else { console.error("usage: node tools/ingest.mjs scan [--work <dir>] [--canvas <path>] | add <job id>... | reject <job id> <reason>"); process.exit(2); }

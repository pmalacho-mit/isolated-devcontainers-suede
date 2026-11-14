// A terminal session as a video: pty-record.py runs a plan in bash on a pty and logs what the
// terminal showed; this plays it into xterm.js (the copy the git terminal ships) in headless
// Chrome and keeps the frames. Long waits are cut short (a VM starting is ~20 s of nothing).
//
//   node tests/v3/demo/record-terminal.ts <plan.json> <out.mp4>
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launch, sleep } from "./cdp.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const [planFile = "", out = "terminal.mp4"] = process.argv.slice(2);
const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "term-")), "session.jsonl");
execFileSync("python3", ["-I", path.join(HERE, "pty-record.py"), planFile, log], { stdio: "inherit", env: process.env });
const events = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { t: number; out?: string; caption?: string; error?: string; end?: boolean });
for (const e of events) if (e.error) process.stderr.write(`record-terminal: ${e.error}\n`);

const VENDOR = path.resolve(HERE, "../../../release/host/git-ui/vendor");
const page = path.join(path.dirname(log), "play.html");
fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="file://${VENDOR}/xterm.css">
<style>html,body{margin:0;background:#16181d;height:100%}#t{padding:18px 20px 0}#cap{position:fixed;left:0;right:0;bottom:0;padding:14px 20px;background:rgba(20,60,110,.94);color:#fff;font:600 19px system-ui,sans-serif;display:none}</style>
<div id="t"></div><div id="cap"></div><script src="file://${VENDOR}/xterm.js"></script>
<script>const term = new Terminal({ cols: 118, rows: 32, fontSize: 15, fontFamily: "Menlo, monospace", theme: { background: "#16181d" }, cursorBlink: false });
term.open(document.getElementById("t"));
window.put = (b64) => term.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
window.caption = (text) => { const c = document.getElementById("cap"); c.textContent = text; c.style.display = text ? "block" : "none"; };</script>`);

const browser = await launch(9355, 1280, 760);
try {
  const t = await browser.tab(`file://${page}`, { dark: true });
  await sleep(1200);
  const video = await browser.record(t);
  let last = 0;
  for (const e of events) {
    const gap = e.t - last;
    last = e.t;
    await sleep(Math.min(gap, 1.6) * 1000);
    if (e.out) await browser.evaluate(t, `put(${JSON.stringify(e.out)})`);
    if (e.caption !== undefined) await browser.evaluate(t, `caption(${JSON.stringify(e.caption)})`);
  }
  await sleep(2500);
  process.stderr.write(`record-terminal: ${await video.save(path.resolve(out))} frames -> ${out}\n`);
} finally {
  await browser.close();
}

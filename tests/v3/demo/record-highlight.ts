// Syntax colour in diffs, recorded end to end on a throwaway stack (the fake backend and the
// stand-in forge of the tests): an agent's change in Python, TypeScript, JavaScript, Svelte,
// Rust and TOML is offered; its review in the dashboard, side by side and unified; then Push,
// and the same diff on the approval page, which refuses it: nothing is pushed.
//
//   DESOLATE_TIER=T2 TMPDIR=$HOME/t node tests/v3/demo/record-highlight.ts <out.mp4>
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import { launch, sleep } from "./cdp.ts";
import type { Tab } from "./cdp.ts";

const out = path.resolve(process.argv[2] ?? "highlight.mp4");
const SAMPLE = path.join(path.dirname(new URL(import.meta.url).pathname), "highlight-sample");
const say = (line: string) => process.stderr.write(`demo: ${line}\n`);
// (In the diff's own order: git's, by path.)
const FILES: [string, string][] = [["api/users.py", "Python"], ["crates/core/Cargo.toml", "TOML"], ["crates/core/src/lib.rs", "Rust"], ["src/format.js", "JavaScript"], ["src/store.ts", "TypeScript"], ["web/Counter.svelte", "Svelte"]];

const stack = newStack("highlight");
stack.seed("acme/app", (dir) => {
  fs.cpSync(path.join(SAMPLE, "base"), dir, { recursive: true });
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "base");
});
const browser = await launch(9367, 1280, 800);
const clips: string[] = [];
try {
  if (bootstrap(stack).code !== 0) throw new Error("bootstrap failed");
  for (const step of [["clone", "acme/app", "--no-domain"], ["domain", "create", "web", "--repo", "acme/app"], ["up", "web", "--name", "one", "--branch", "typed-and-tested"]]) {
    const done = stack.quiet(...step);
    if (done.code !== 0) throw new Error(`${step.join(" ")}: ${done.stderr}`);
  }
  const patch = fs.readFileSync(path.join(SAMPLE, "change.diff")).toString("base64");
  const work = stack.quiet("exec", "web/one", "--", "sh", "-c", `echo ${patch} | base64 -d | git apply && git add -A && git -c user.name=agent -c user.email=agent@example.test commit -qm 'Typed, case-insensitive, and tested' && desolate offer`);
  if (work.code !== 0) throw new Error(`the agent's commit: ${work.stderr}`);
  say("offered");

  // ---------------------------------------------------------------- the dashboard
  const dashboard = /dashboard\s+(http:\S+)/.exec(stack.desolate("ui").stdout)![1]!;
  const t = await browser.tab(`${dashboard}&review&domain=web&repo=acme%2Fapp&branch=typed-and-tested`);
  await browser.until(t, /files? changed|commit\(s\)/);
  const coloured = async (tab: Tab, selector: string) => {
    for (let i = 0; i < 100; i++) {
      if (await browser.evaluate(tab, `document.querySelectorAll(${JSON.stringify(selector)}).length`)) return;
      await sleep(100);
    }
    throw new Error(`never coloured: ${selector}`);
  };
  await coloured(t, ".sbs .hl");
  /** The diff's box to the top of the window, scrolled inside to `file`. */
  const toFile = (tab: Tab, box: string, header: string, file: string) => browser.evaluate(tab, `(() => {
    const box = document.querySelector(${JSON.stringify(box)});
    box.scrollIntoView({ block: "start" }); scrollBy(0, -12);
    const head = [...box.querySelectorAll(${JSON.stringify(header)})].find((h) => h.textContent.includes(${JSON.stringify(file)}));
    // (By the line after the header: a side-by-side header is sticky, and says where it is stuck.)
    const target = head && (head.nextElementSibling || head);
    if (target) box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - 28;
  })()`);
  const video = await browser.record(t);
  await browser.caption(t, "An agent offered a change in six languages. The dashboard's review: the diff, made by git in the root");
  await sleep(2500);
  for (const [file, language] of FILES) {
    await toFile(t, ".sbs", ".sbs-file", file);
    await browser.caption(t, `${language} · ${file}  (side by side; changed words marked)`);
    await sleep(3200);
  }
  await browser.clickOn(t, "[data-layout]");
  await coloured(t, "pre.diff .hl");
  await toFile(t, "pre.diff", ".file", "web/Counter.svelte");
  await browser.caption(t, "Unified, as git prints it: coloured the same way");
  await sleep(3500);
  await browser.clickOn(t, "[data-layout]");
  await browser.evaluate(t, "scrollTo(0, document.body.scrollHeight)");
  await browser.caption(t, "Push: the dashboard asks; the person approves on the host, on the approval page");
  await sleep(1500);
  await browser.clickOn(t, "button", /^Push exactly/);
  await browser.until(t, /approve|waiting/i);
  await sleep(2000);
  clips.push(path.join(os.tmpdir(), `hl-dashboard-${process.pid}.mp4`));
  await video.save(clips.at(-1)!);
  say("dashboard recorded");

  // ---------------------------------------------------------------- the approval page
  const approvals = /approvals\s+(http:\S+)/.exec(stack.desolate("approve", "--web").stdout)![1]!;
  const a = await browser.tab(approvals);
  await browser.until(a, /file\(s\) changed/, 120_000);
  await sleep(1500);
  const second = await browser.record(a);
  await browser.caption(a, "The approval page: what the push names, and what it would send");
  await sleep(2500);
  await browser.clickOn(a, "button", /Show the diff/);
  await coloured(a, "pre.diff .hl");
  for (const [file, language] of FILES) {
    await toFile(a, "pre.diff", ".file", file);
    await browser.caption(a, `${language} · ${file}  (on the approval page)`);
    await sleep(2800);
  }
  await browser.caption(a, "Refused here, with a real click: nothing is pushed");
  await sleep(1200);
  await browser.clickOn(a, "button.refuse");
  await browser.until(a, /refused/i);
  await sleep(2000);
  clips.push(path.join(os.tmpdir(), `hl-approve-${process.pid}.mp4`));
  await second.save(clips.at(-1)!);
  const list = path.join(os.tmpdir(), `hl-list-${process.pid}.txt`);
  fs.writeFileSync(list, clips.map((c) => `file '${c}'`).join("\n") + "\n");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
  say(`-> ${out}`);
} finally {
  await browser.close();
  for (const c of clips) fs.rmSync(c, { force: true });
  stack.destroy();
}

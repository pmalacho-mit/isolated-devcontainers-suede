// The dashboard's review of a branch, recorded: the diff, and (where the dashboard has it)
// the layout toggle between unified and side by side. Against a running stack whose domain
// has the branch; nothing is pushed.
//
//   DESOLATE_INSTANCE=... DESOLATE_HOME=... node tests/v3/demo/record-diff.ts <branch> <out.mp4>
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { launch, sleep } from "./cdp.ts";

const [BRANCH = "", outArg = "diff.mp4"] = process.argv.slice(2);
// (DESOLATE_CLI: the CLI of the release the stack runs, when this script is another checkout's.)
const CLI = process.env.DESOLATE_CLI ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../release/cli.sh");
const dashboard = /dashboard\s+(http:\S+)/.exec(spawnSync(CLI, ["ui"], { encoding: "utf8", env: process.env }).stdout)![1]!;
const browser = await launch(9353, 1280, 760);
try {
  const t = await browser.tab(dashboard);
  await browser.until(t, new RegExp(BRANCH));
  await browser.evaluate(t, `document.querySelector("details.branches summary")?.click()`);
  await sleep(800);
  const video = await browser.record(t);
  await browser.caption(t, `The dashboard: a branch an agent offered (${BRANCH})`);
  await sleep(1800);
  await browser.clickOn(t, "button", /^Review$/);
  await browser.until(t, /files? changed/);
  await browser.caption(t, "Review: what a push would send, and the diff");
  await browser.evaluate(t, `document.querySelector("[data-diff], .sbs")?.scrollIntoView({ block: "start" })`);
  await sleep(3500);
  const toggle = await browser.evaluate(t, `!!document.querySelector("[data-layout]")`);
  if (toggle) {
    const sides = await browser.evaluate(t, `!!document.querySelector(".sbs")`);
    await browser.caption(t, sides ? "Side by side (the default): old and new lines paired, the words that changed marked" : "Unified");
    await sleep(4500);
    await browser.clickOn(t, "[data-layout]");
    await sleep(400);
    await browser.caption(t, "One click: unified, as git prints it (remembered in this browser)");
    await browser.evaluate(t, `document.querySelector("[data-diff], .sbs")?.scrollIntoView({ block: "start" })`);
    await sleep(3500);
    await browser.clickOn(t, "[data-layout]");
    await sleep(400);
    await browser.caption(t, "And back to side by side");
    await browser.evaluate(t, `document.querySelector("[data-diff], .sbs")?.scrollIntoView({ block: "start" })`);
    await sleep(3000);
  } else {
    await browser.caption(t, "Unified only: old and new lines one under the other, the changed words left to find");
    await sleep(6000);
  }
  process.stderr.write(`record-diff: ${await video.save(path.resolve(outArg))} frames -> ${outArg}\n`);
} finally {
  await browser.close();
}

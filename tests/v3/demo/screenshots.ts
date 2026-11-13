// The documentation's screenshots, from a running stack (release/docs/assets/). Dark mode,
// twice the pixels, each cropped to what it shows. The stack needs: a domain `acme` with a
// workspace `agent-2` whose checkouts include <lib>, an offer waiting, and the git VM.
//
//   DESOLATE_INSTANCE=... DESOLATE_HOME=... DESOLATE_EDITOR_PORT=... \
//     node tests/v3/demo/screenshots.ts <owner/app> <owner/lib> <branch of lib to push> <out dir>
//
// The push it starts from the git VM is refused on the approval page: nothing is pushed.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.resolve(HERE, "../../../release/cli.sh");
const [APP = "", LIB = "", LIB_BRANCH = "", outArg = "release/docs/assets"] = process.argv.slice(2);
const OUT = path.resolve(outArg);
fs.mkdirSync(OUT, { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line: string) => process.stderr.write(`screenshots: ${line}\n`);
const address = (pattern: RegExp, ...args: string[]) => pattern.exec(spawnSync(CLI, args, { encoding: "utf8", env: process.env }).stdout)![1]!;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "shots-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9351", `--user-data-dir=${profile}`, "--no-first-run", "--host-resolver-rules=MAP *.localhost 127.0.0.1", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
let ws = "";
for (let i = 0; i < 50 && !ws; i++) {
  await sleep(200);
  ws = await fetch("http://127.0.0.1:9351/json/version").then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).then((j) => j.webSocketDebuggerUrl).catch(() => "");
}
const socket = new WebSocket(ws);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
let nextId = 1;
const pending = new Map<number, (value: Record<string, unknown>) => void>();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown> };
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)!(message.result ?? {});
    pending.delete(message.id);
  }
});
const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
type Tab = { sessionId: string };
const tab = async (url: string, width: number, height: number, scale = 2): Promise<Tab> => {
  const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
  await send("Page.navigate", { url }, sessionId);
  await send("Target.activateTarget", { targetId });
  return { sessionId };
};
const evaluate = async (t: Tab, expression: string) =>
  ((await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, t.sessionId)) as { result?: { value?: unknown } }).result?.value;
const until = async (t: Tab, pattern: RegExp, ms = 90_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (pattern.test(String(await evaluate(t, "document.body ? document.body.innerText : ''")))) return;
  throw new Error(`never saw ${pattern}`);
};
/** A picture of one element (or the viewport), with a margin, at twice the pixels. */
const shot = async (t: Tab, name: string, selector?: string, margin = 12, maxHeight = 2000) => {
  const box = selector
    ? ((await evaluate(t, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + scrollX, r.y + scrollY, r.width, r.height]; })()`)) as number[])
    : null;
  const clip = box ? { x: Math.max(0, box[0]! - margin), y: Math.max(0, box[1]! - margin), width: box[2]! + 2 * margin, height: Math.min(maxHeight, box[3]! + 2 * margin), scale: 1 } : undefined;
  const taken = (await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) }, t.sessionId)) as { data: string };
  fs.writeFileSync(path.join(OUT, name), Buffer.from(taken.data, "base64"));
  say(`${name}${clip ? ` (${Math.round(clip.width)}x${Math.round(clip.height)})` : ""}`);
};
const press = async (t: Tab, key: string, code: string, keyCode: number, modifiers = 0) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(key === "Enter" ? { text: "\r" } : {}) }, t.sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers }, t.sessionId);
};
const type = async (t: Tab, text: string) => {
  for (const ch of text) {
    await send("Input.insertText", { text: ch }, t.sessionId);
    await sleep(15);
  }
};
const click = async (t: Tab, x: number, y: number) => {
  for (const [from, to] of [[x - 40, y - 20], [x, y]] as const) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from, y: to }, t.sessionId);
  await sleep(400);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 2, y: y + 1 }, t.sessionId);
  await sleep(400);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x + 2, y: y + 1, button: "left", clickCount: 1 }, t.sessionId);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 2, y: y + 1, button: "left", clickCount: 1 }, t.sessionId);
};

// SHOTS=dashboard,git,editor (the default: all three)
const only = new Set((process.env.SHOTS ?? "dashboard,git,editor").split(","));
try {
  // ------------------------------------------------------------ the dashboard
  if (only.has("dashboard")) {
  const dashboard = await tab(address(/dashboard\s+(http:\S+)/, "ui"), 1100, 900);
  await until(dashboard, /Offered: /);
  await sleep(1500);
  await shot(dashboard, "dashboard.png", "main", 0);
  await evaluate(dashboard, `document.querySelector("details.branches summary")?.click()`);
  await sleep(600);
  await shot(dashboard, "dashboard-branches.png", "details.branches", 10);
  await evaluate(dashboard, `[...document.querySelectorAll("button")].find((b) => b.textContent === "Review")?.click()`);
  await until(dashboard, /files? changed/);
  await sleep(2500);
  await shot(dashboard, "review.png", "#review-card", 0, 1500);
  }

  // ------------------------------------------------------------ the git terminal, a push, its approval beside it
  if (only.has("git")) {
  const git = await tab(address(/git\s+(http:\S+)/, "git", LIB), 1280, 720);
  await until(git, /git VM/);
  await sleep(2500);
  await evaluate(git, "document.querySelector('.xterm-helper-textarea')?.focus()");
  await type(git, `clear; git fetch -q acme && git log --oneline -2 acme/${LIB_BRANCH} && git push origin acme/${LIB_BRANCH}:refs/heads/${LIB_BRANCH}`);
  await press(git, "Enter", "Enter", 13);
  let frame = "";
  for (let i = 0; i < 240 && !frame; i++) {
    const { targetInfos } = (await send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
    const found = targetInfos.find((t) => t.type === "iframe" && /\/embed/.test(t.url));
    if (found) frame = ((await send("Target.attachToTarget", { targetId: found.targetId, flatten: true })) as { sessionId: string }).sessionId;
    else await sleep(250);
  }
  const frameTab = { sessionId: frame };
  await until(frameTab, /commit\(s\) the remote does not have/, 120_000);
  await sleep(1500);
  await shot(git, "git-approve.png");
  // Refused, with a real click: nothing is pushed.
  const refuse = (await evaluate(frameTab, "(() => { const r = document.querySelector('.refuse').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")) as number[];
  const at = (await evaluate(git, "(() => { const r = document.getElementById('frame').getBoundingClientRect(); return [r.x, r.y]; })()")) as number[];
  await click(git, at[0]! + refuse[0]!, at[1]! + refuse[1]!);
  await until(frameTab, /refused/);
  say("the push was refused");
  }

  // ------------------------------------------------------------ the editor
  // (Dark: the workspace file's own setting, which the caller sets; the theme a person picks
  // is kept in their browser.)
  if (only.has("editor")) {
  const editor = await tab(address(/(http:\S+tkn=[0-9a-f]+\S*)/, "editor", "acme/agent-2"), 1280, 760, 1);
  await until(editor, /EXPLORER|Explorer/, 180_000);
  await sleep(5000);
  const palette = async (command: string, then?: string) => {
    await press(editor, "F1", "F1", 112);
    await sleep(600);
    await type(editor, command);
    await sleep(700);
    await press(editor, "Enter", "Enter", 13);
    if (then !== undefined) {
      await sleep(2500);
      await type(editor, then);
      await sleep(700);
      await press(editor, "Enter", "Enter", 13);
    }
    await sleep(1500);
  };
  // The theme picker by its own keys (Cmd-K Cmd-T): the palette's ranking remembers what was
  // picked before. Then the empty secondary side bar, closed.
  await press(editor, "k", "KeyK", 75, 4);
  await press(editor, "t", "KeyT", 84, 4);
  await sleep(2500);
  await type(editor, "Dark Modern");
  await sleep(800);
  await press(editor, "Enter", "Enter", 13);
  await sleep(1500);
  await click(editor, 1257, 53);
  await palette("Terminal: Create New Terminal", "");
  await sleep(12_000);
  await type(editor, "node --version && npm test 2>&1 | grep -E '^# (pass|fail)'");
  await press(editor, "Enter", "Enter", 13);
  await sleep(5000);
  await press(editor, "F1", "F1", 112);
  await sleep(500);
  await press(editor, "Backspace", "Backspace", 8);
  await type(editor, "greet.js");
  await sleep(900);
  await press(editor, "Enter", "Enter", 13);
  await sleep(2500);
  await shot(editor, "editor.png");
  say(`app ${APP}`);
  }
} finally {
  socket.close();
  chrome.kill();
}

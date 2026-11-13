// A short screen recording of the person's part of a push: the git terminal, `git push`, and
// the approval beside it in the same tab (the approval page, framed), one click. On a
// throwaway stack (the fake backend and the stand-in forge of the tests), so the click
// approves nothing real. It is also the check that the framed page arms and signs in a real
// browser: a trusted click, routed into the frame, after the pointer moved onto Approve.
//
//   DESOLATE_TIER=T2 TMPDIR=$HOME/t node tests/v3/demo/record-approval.ts <out.mp4>
//
// Needs Google Chrome and ffmpeg. Chrome is driven over its DevTools protocol (headless),
// and each frame it paints is kept; ffmpeg makes them a video.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootstrap, git, newStack } from "../lib/harness.ts";

const out = path.resolve(process.argv[2] ?? "approval-demo.mp4");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const W = 1280;
const H = 760;

// ---------------------------------------------------------------- the stack
const stack = newStack("demo");
const say = (line: string) => process.stderr.write(`demo: ${line}\n`);
stack.seed("acme/widgets", (dir) => {
  fs.writeFileSync(path.join(dir, "README.md"), "# widgets\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "seed");
});
if (bootstrap(stack).code !== 0) throw new Error("bootstrap failed");
if (stack.quiet("clone", "acme/widgets").code !== 0) throw new Error("clone failed");
const gitUrl = /(http:\S+)/.exec(stack.desolate("git", "acme/widgets").stdout)![1]!;
say("stack up");

// ---------------------------------------------------------------- Chrome, over CDP
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "demo-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9339", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--host-resolver-rules=MAP *.localhost 127.0.0.1", `--window-size=${W},${H}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
let version: { webSocketDebuggerUrl: string } | null = null;
for (let i = 0; i < 50 && !version; i++) {
  await sleep(200);
  version = await fetch("http://127.0.0.1:9339/json/version").then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).catch(() => null);
}
const socket = new WebSocket(version!.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
let nextId = 1;
const pending = new Map<number, (value: Record<string, unknown>) => void>();
const handlers: ((message: { method: string; params: Record<string, unknown>; sessionId?: string }) => void)[] = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; method?: string; params?: Record<string, unknown>; sessionId?: string };
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)!(message.result ?? {});
    pending.delete(message.id);
  } else if (message.method) for (const h of handlers) h(message as { method: string; params: Record<string, unknown>; sessionId?: string });
});
const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const tab = async (url: string) => {
  const { targetId } = (await send("Target.createTarget", { url: "about:blank", newWindow: false })) as { targetId: string };
  const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url }, sessionId);
  return { targetId, sessionId };
};

// Frames: a screenshot of the current tab, about eight a second, with its time.
const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-frames-"));
const frames: { file: string; at: number }[] = [];
let recording: string | null = null;
let filming = true;
const film = async () => {
  while (filming) {
    const started = Date.now();
    if (recording) {
      const shot = (await send("Page.captureScreenshot", { format: "jpeg", quality: 82 }, recording)) as { data?: string };
      if (shot.data) {
        const file = path.join(framesDir, `${String(frames.length).padStart(5, "0")}.jpg`);
        fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
        frames.push({ file, at: started });
      }
    }
    await sleep(Math.max(0, 120 - (Date.now() - started)));
  }
};
const filming$ = film();
const record = async (sessionId: string) => {
  recording = sessionId;
  await send("Target.activateTarget", { targetId: sessionTargets.get(sessionId) });
};
const sessionTargets = new Map<string, string>();

const evaluate = async (sessionId: string, expression: string) =>
  ((await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)) as { result?: { value?: unknown } }).result?.value;
/** A caption across the bottom of the page: for the video only (it is DOM the page did not make).
 *  Never over the approval frame: Chrome counts a frame with anything over any part of it as
 *  covered, and its Approve then does not arm (which is the point). */
const caption = (sessionId: string, text: string) =>
  evaluate(sessionId, `(() => { let c = document.getElementById("demo-caption"); if (!c) { c = document.createElement("div"); c.id = "demo-caption"; c.style.cssText = "position:fixed;left:0;right:" + (document.getElementById("approvals") ? "461px" : "0") + ";bottom:0;padding:14px 20px;background:rgba(20,60,110,.94);color:#fff;font:600 19px system-ui,sans-serif;z-index:99999"; document.body.appendChild(c); } c.textContent = ${JSON.stringify(text)}; })()`);
const textOf = (sessionId: string) => evaluate(sessionId, "document.body.innerText") as Promise<string>;
const until = async (sessionId: string, pattern: RegExp, ms = 60_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (pattern.test(String(await textOf(sessionId)))) return;
  throw new Error(`never saw ${pattern}; the page says: ${String(await textOf(sessionId)).slice(0, 1500)}`);
};
const type = async (sessionId: string, text: string) => {
  for (const ch of text) {
    await send("Input.insertText", { text: ch }, sessionId);
    await sleep(35);
  }
};
const enter = (sessionId: string) => send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, sessionId).then(() => send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sessionId));
const mouseTo = async (sessionId: string, from: [number, number], to: [number, number], steps = 24) => {
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
    await sleep(30);
  }
};

let termSession = "";
try {
  // 1. The git terminal.
  const term = await tab(gitUrl);
  termSession = term.sessionId;
  sessionTargets.set(term.sessionId, term.targetId);
  await record(term.sessionId);
  await until(term.sessionId, /git VM/);
  await sleep(1500);
  await caption(term.sessionId, "1 · desolate git acme/widgets — a shell in the git VM, in your browser (no network, no keys)");
  await send("Runtime.evaluate", { expression: "document.querySelector('.xterm-helper-textarea')?.focus()" }, term.sessionId);
  await sleep(1500);
  await type(term.sessionId, "git log --oneline -3");
  await enter(term.sessionId);
  await sleep(2000);
  await caption(term.sessionId, "2 · once: who you are, for your commits (the git VM keeps it)");
  await type(term.sessionId, "git config --global user.name 'Your Name' && git config --global user.email you@example.com");
  await enter(term.sessionId);
  await sleep(1500);
  await caption(term.sessionId, "3 · commit as usual");
  await type(term.sessionId, "echo 'a small change' > note.txt && git add note.txt && git commit -qm 'A small change' && git log --oneline -2");
  await enter(term.sessionId);
  await sleep(2500);
  await caption(term.sessionId, "4 · git push origin <branch>: the approval opens beside the terminal");
  await type(term.sessionId, "git push origin HEAD:refs/heads/a-small-change");
  await enter(term.sessionId);
  await until(term.sessionId, /handed to the root/);

  // 2. The approval page, framed beside the terminal (its own origin): found as a target of
  // its own, to read where its button is and what it says.
  let frameSession = "";
  for (let i = 0; i < 60 && !frameSession; i++) {
    const { targetInfos } = (await send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
    const frame = targetInfos.find((t) => t.type === "iframe" && /desolate-approve\.localhost:\d+\/embed/.test(t.url));
    if (frame) frameSession = ((await send("Target.attachToTarget", { targetId: frame.targetId, flatten: true })) as { sessionId: string }).sessionId;
    else await sleep(250);
  }
  if (!frameSession) throw new Error("the approval frame never appeared beside the terminal");
  await until(frameSession, /a-small-change/);
  await caption(term.sessionId, "5 · beside it: what the push names, and what it would send (worked out in the root)");
  await until(frameSession, /1 commit\(s\) the remote does not have/);
  await sleep(2500);
  // Approve arms only for a pointer that moves onto it, a moment after the pointer came over
  // the frame (the terminal keeps the focus), and only while the button is visibly unobscured.
  const inFrame = (await evaluate(frameSession, "(() => { const r = document.querySelector('.arm').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")) as [number, number];
  const frameAt = (await evaluate(term.sessionId, "(() => { const r = document.getElementById('frame').getBoundingClientRect(); return [r.x, r.y]; })()")) as [number, number];
  const box: [number, number] = [frameAt[0] + inFrame[0], frameAt[1] + inFrame[1]];
  await caption(term.sessionId, "6 · move onto Approve (it arms only for a pointer that moves onto it), then click");
  await mouseTo(term.sessionId, [frameAt[0] + 60, 120], [frameAt[0] + 80, 160], 10);
  await sleep(1300);
  await mouseTo(term.sessionId, [frameAt[0] + 80, 160], box, 30);
  await sleep(500);
  await mouseTo(term.sessionId, box, [box[0] + 6, box[1] + 2], 6);
  await sleep(700);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box[0] + 6, y: box[1] + 2, button: "left", clickCount: 1 }, term.sessionId);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box[0] + 6, y: box[1] + 2, button: "left", clickCount: 1 }, term.sessionId);
  await until(frameSession, /approved: the push continues/).catch(async (error: Error) => {
    const shot = (await send("Page.captureScreenshot", { format: "png" }, term.sessionId)) as { data?: string };
    if (shot.data) fs.writeFileSync(`${out}.failed.png`, Buffer.from(shot.data, "base64"));
    say(`the button at ${JSON.stringify(box)}; the frame's state: ${JSON.stringify(await evaluate(frameSession, "JSON.stringify({ pointerInside, attentiveSince, now: performance.now(), visibility: VISIBILITY, cards: [...cards.values()].map((c) => ({ visible: c.visible, armedAt: c.armedAt, changedAt: c.changedAt })), focus: document.hasFocus(), visible: document.visibilityState })"))}`);
    throw error;
  });

  // 3. The terminal, in the same tab: pushed.
  await caption(term.sessionId, "7 · pushed: the remote's branch is exactly that commit (desolate events says so too)");
  await until(term.sessionId, /\[new branch\]/, 90_000);
  await sleep(4000);
  filming = false;
  await filming$;
} catch (error) {
  if (termSession) process.stderr.write(`demo: the terminal says: ${String(await textOf(termSession)).slice(-1500)}\n`);
  throw error;
} finally {
  socket.close();
  chrome.kill();
  stack.destroy();
}

// ---------------------------------------------------------------- the video
const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.at ?? f.at + 1500) - f.at) / 1000).toFixed(3)}`).join("\n") + `\nfile '${frames.at(-1)!.file}'\n`;
const listFile = path.join(framesDir, "list.txt");
fs.writeFileSync(listFile, list);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", `fps=25,scale=${W}:-2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
say(`${frames.length} frames -> ${out}`);
fs.rmSync(framesDir, { recursive: true, force: true });
fs.rmSync(profile, { recursive: true, force: true });

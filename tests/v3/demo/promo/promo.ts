// The promo: desolate end to end, for real, filmed. On a stack of its own (DESOLATE_INSTANCE,
// DESOLATE_HOME, DESOLATE_EDITOR_PORT set by the caller), against dummy repositories on
// GitHub. Every command shown ran; its output is what it printed (tokens masked); the camera
// is paused while a command runs, so waits are cut.
//
//   DESOLATE_INSTANCE=promo DESOLATE_HOME=... DESOLATE_EDITOR_PORT=31597 \
//     node tests/v3/demo/promo/promo.ts <owner> <out.mp4>
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, "../../../..");
const CLI = path.join(REPO_ROOT, "release", "cli.sh");
const [owner = "mitdesolate", outArg = "promo.mp4"] = process.argv.slice(2);
const out = path.resolve(outArg);
const APP = `${owner}/desolate-promo-app`;
const LIB = `${owner}/desolate-promo-lib`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1280;
const H = 760;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line: string) => process.stderr.write(`promo: ${line}\n`);

/** What a command printed, safe to show: no token, no colour codes for the replay to choke on. */
const masked = (text: string) => text.replace(/tkn=[0-9a-f]{16,}/g, "tkn=…").replace(/\r/g, "");
/** Run desolate (or anything) on the Mac, for real; its output, masked. */
const sh = (command: string, args: string[], options: { input?: string; allowFail?: boolean } = {}) => {
  const ran = spawnSync(command, args, { encoding: "utf8", input: options.input, env: process.env, timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
  const text = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  if (ran.status !== 0 && !options.allowFail) throw new Error(`${command} ${args.join(" ")} failed (${ran.status}): ${text.slice(-1500)}`);
  return masked(text);
};
/** desolate, its two streams in the order they were written (as a terminal shows them). */
const desolate = (...args: string[]) => sh("bash", ["-c", '"$0" "$@" 2>&1', CLI, ...args]);
/** As the agent, in its workspace's checkout of the app (in its devcontainer). */
const agent = (script: string) => sh(CLI, ["exec", "acme/agent-1", "--checkout", APP, "--", "bash", "-lc", script]);
const BRANCH = "feature/greet-by-name";
/** Poll until a check passes (the camera may be rolling). */
const waitFor = async (check: () => boolean, ms: number, what: string) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(1000)) if (check()) return;
  throw new Error(`never: ${what}`);
};

// ---------------------------------------------------------------- Chrome, over CDP
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "promo-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9341", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--host-resolver-rules=MAP *.localhost 127.0.0.1", `--window-size=${W},${H}`, "--hide-scrollbars", "--allow-file-access-from-files", "about:blank"], { stdio: "ignore" });
let version: { webSocketDebuggerUrl: string } | null = null;
for (let i = 0; i < 50 && !version; i++) {
  await sleep(200);
  version = await fetch("http://127.0.0.1:9341/json/version").then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).catch(() => null);
}
const socket = new WebSocket(version!.webSocketDebuggerUrl);
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
type Tab = { targetId: string; sessionId: string };
const tab = async (url: string): Promise<Tab> => {
  const { targetId } = (await send("Target.createTarget", { url: "about:blank", newWindow: false })) as { targetId: string };
  const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url }, sessionId);
  return { targetId, sessionId };
};
const evaluate = async (t: Tab, expression: string) =>
  ((await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, t.sessionId)) as { result?: { value?: unknown } }).result?.value;
const textOf = (t: Tab) => evaluate(t, "document.body ? document.body.innerText : ''") as Promise<string>;
const until = async (t: Tab, pattern: RegExp, ms = 90_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (pattern.test(String(await textOf(t)))) return;
  throw new Error(`never saw ${pattern}; the page says: ${String(await textOf(t)).slice(-1500)}`);
};

// The camera: a screenshot of the tab on screen, about eight a second, while rolling.
const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), "promo-frames-"));
const frames: { file: string; at: number }[] = [];
let onScreen: Tab | null = null;
let rolling = false;
let filming = true;
let clock = 0; // the video's own time: advances only while rolling
const film = async () => {
  let last = Date.now();
  while (filming) {
    const now = Date.now();
    // (At most one frame's worth: a gap is the event loop held by a command run on the Mac,
    // with the camera off, even if it is rolling again by the time this looks.)
    if (rolling) clock += Math.min(now - last, 250);
    last = now;
    if (rolling && onScreen) {
      const shot = (await send("Page.captureScreenshot", { format: "jpeg", quality: 84 }, onScreen.sessionId)) as { data?: string };
      if (shot.data) {
        const file = path.join(framesDir, `${String(frames.length).padStart(6, "0")}.jpg`);
        fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
        frames.push({ file, at: clock });
      }
    }
    await sleep(Math.max(0, 120 - (Date.now() - now)));
  }
};
const filmed = film();
const show = async (t: Tab) => {
  onScreen = t;
  await send("Target.activateTarget", { targetId: t.targetId });
};
const roll = () => (rolling = true);
const cut = () => (rolling = false);
/** Hold the current picture for a moment. */
const hold = async (ms: number) => {
  roll();
  await sleep(ms);
};
/** A caption across the bottom: for the video only. Never over the approval frame beside the
 *  git terminal (Chrome counts a frame with anything over any part of it as covered, and
 *  its Approve would not arm), and with no shadow (a shadow is drawn over its neighbours). */
const caption = (t: Tab, text: string | null) =>
  evaluate(t, text === null ? `document.getElementById("promo-caption")?.remove()` : `(() => { let c = document.getElementById("promo-caption"); if (!c) { c = document.createElement("div"); c.id = "promo-caption"; document.documentElement.appendChild(c); } const beside = document.getElementById("approvals"); c.style.cssText = "position:fixed;left:0;right:" + (beside && !beside.hidden ? "461px" : "0") + ";bottom:0;padding:12px 20px;background:rgba(18,52,98,.95);color:#fff;font:600 18px -apple-system,system-ui,sans-serif;z-index:2147483647"; c.textContent = ${JSON.stringify(text)}; })()`);
const typeInto = async (t: Tab, text: string) => {
  for (const ch of text) {
    await send("Input.insertText", { text: ch }, t.sessionId);
    await sleep(30);
  }
};
const press = async (t: Tab, key: string, code: string, keyCode: number) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode }, t.sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode }, t.sessionId);
};
const enter = (t: Tab) => send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, t.sessionId).then(() => send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, t.sessionId));
const mouseTo = async (t: Tab, from: [number, number], to: [number, number], steps = 30) => {
  for (let i = 1; i <= steps; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from[0] + ((to[0] - from[0]) * i) / steps, y: from[1] + ((to[1] - from[1]) * i) / steps }, t.sessionId);
    await sleep(30);
  }
};

// ---------------------------------------------------------------- the stage
const stage = await tab(`file://${path.join(HERE, "stage.html")}`);
await sleep(800);
const card = async (title: string, lines: string[], small?: string, ms = 2600) => {
  await show(stage);
  await evaluate(stage, `card(${JSON.stringify(title)}, ${JSON.stringify(lines)}, ${JSON.stringify(small ?? "")})`);
  await hold(ms);
  cut();
};
const terminal = async (title: string, sub: string) => {
  await show(stage);
  await evaluate(stage, `terminal(${JSON.stringify({ title, sub })})`);
  await sleep(300);
};
/** A command, run for real (camera off), then shown typed and printed. */
const replay = async (prompt: string, shown: string, output: string, after = 900) => {
  roll();
  await evaluate(stage, `run(${JSON.stringify(prompt)}, ${JSON.stringify(shown)}, ${JSON.stringify(output)}, 14)`);
  await sleep(after);
  cut();
};
const MAC = "you@mac ~ %";
/** The address a desolate command prints, with its token (never shown on camera). */
const address = (pattern: RegExp, ...args: string[]) => pattern.exec(spawnSync(CLI, args, { encoding: "utf8", env: process.env }).stdout)![1]!;

let prOutput = "";
let listenerPid = 0;
try {
  // ------------------------------------------------------------ 0. what this is
  await card("desolate", ["Coding agents, each in a VM of its own, on your Mac.", "They work in your project's devcontainer. You review, approve with one click, it is pushed."], "All of it ran for real: Lima on an M1, real GitHub repositories. Waits are cut.", 3500);

  // ------------------------------------------------------------ 1. repositories, a domain, a workspace
  await terminal("Terminal on your Mac", "the stack is up (desolate bootstrap, once)");
  await replay(MAC, "desolate doctor | tail -2", desolate("doctor").trim().split("\n").slice(-2).join("\n"));
  await replay(MAC, `desolate clone ${APP}`, desolate("clone", APP));
  await replay(MAC, `desolate clone ${LIB}`, desolate("clone", LIB));
  await replay(MAC, `desolate domain create acme --repo ${APP} --repo ${LIB}`, desolate("domain", "create", "acme", "--repo", APP, "--repo", LIB));
  await replay(MAC, `desolate up acme --name agent-1 --branch ${BRANCH}`, desolate("up", "acme", "--name", "agent-1", "--branch", BRANCH), 2600);

  // ------------------------------------------------------------ 2. the agent, in VSCodium, in its devcontainer
  // (Who the agent commits as: its checkout's own config, set before the camera rolls.)
  agent("git config user.name agent-1 && git config user.email agent-1@acme.invalid");
  const editor = await tab(address(/(http:\S+tkn=[0-9a-f]+\S*)/, "editor", "acme/agent-1"));
  await until(editor, /EXPLORER|Explorer/, 180_000);
  await sleep(6000);
  // (The empty secondary side bar, closed: more room for the code.)
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1257, y: 53, button: "left", clickCount: 1 }, editor.sessionId);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1257, y: 53, button: "left", clickCount: 1 }, editor.sessionId);
  await sleep(800);
  await show(editor);
  await caption(editor, "agent-1's editor: VSCodium, in its VM. Its terminal is inside the project's devcontainer.");
  roll();
  await press(editor, "F1", "F1", 112);
  await sleep(700);
  await typeInto(editor, "Terminal: Create New Terminal");
  await sleep(500);
  await enter(editor);
  await sleep(5000);
  const inTerminal = async (command: string, after: number) => {
    await typeInto(editor, command);
    await enter(editor);
    await sleep(after);
  };
  await inTerminal("node --version && git status -sb | head -1", 2500);
  // The agent's change (made off camera, as an agent would): greet by name, its test, and a
  // banner image, which the repository keeps in LFS.
  agent(`cat > src/greet.js <<'JS'
export const greet = (name = "world") => \`Hello, \${name}. Good to see you.\`;
JS
cat > test/greet.test.js <<'JS'
import assert from "node:assert/strict";
import { test } from "node:test";
import { greet } from "../src/greet.js";

test("greets by name", () => {
  assert.equal(greet("Ada"), "Hello, Ada. Good to see you.");
});

test("greets the world when no one is named", () => {
  assert.equal(greet(), "Hello, world. Good to see you.");
});
JS
python3 -c "import zlib,struct
def p(w,h,c):
  r=b''.join(b'\\x00'+bytes(c)*w for _ in range(h))
  k=lambda t,d: struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
  return b'\\x89PNG\\r\\n\\x1a\\n'+k(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+k(b'IDAT',zlib.compress(r,9))+k(b'IEND',b'')
open('assets/banner.png','wb').write(p(640,160,(230,120,40)))"`);
  // The changed file, in the editor (it reloads from disk); then back to the terminal.
  await press(editor, "F1", "F1", 112);
  await sleep(500);
  await press(editor, "Backspace", "Backspace", 8);
  await typeInto(editor, "src/greet.js");
  await sleep(900);
  await enter(editor);
  await sleep(1500);
  await press(editor, "F1", "F1", 112);
  await sleep(500);
  await typeInto(editor, "Terminal: Focus Terminal");
  await sleep(600);
  await enter(editor);
  await sleep(600);
  await caption(editor, "The agent edits, and runs the project's tests where the project says they run");
  await inTerminal("git status -s && npm test 2>&1 | tail -8", 7000);
  const before = agent("git rev-parse HEAD").trim();
  await caption(editor, "It commits freely: the new banner goes to Git LFS, as the repository says");
  await inTerminal(`git add -A && git commit -qm "Greet by name, and a banner" && git lfs ls-files`, 2500);
  await waitFor(() => agent("git rev-parse HEAD").trim() !== before, 60_000, "the agent's commit");
  await caption(editor, "When it is ready it offers the branch, and says so. Offering is not pushing.");
  await inTerminal(`desolate offer && desolate status set green "ready: greet by name"`, 1500);
  await waitFor(() => new RegExp(BRANCH).test(desolate("offers")), 120_000, "the offer");
  await hold(3500);
  cut();

  // ------------------------------------------------------------ 3. the dashboard
  const dashboard = await tab(address(/dashboard\s+(http:\S+)/, "ui"));
  await until(dashboard, new RegExp(`Offered: .*${BRANCH}`));
  await show(dashboard);
  await caption(dashboard, "The dashboard (desolate ui): each checkout's live branch, and what needs you on top");
  await hold(4000);
  await evaluate(dashboard, `document.querySelector("details.branches summary")?.click()`);
  await sleep(400);
  await evaluate(dashboard, `document.querySelector("details.branches")?.scrollIntoView({ block: "center" })`);
  await caption(dashboard, "Every branch the domain has, offered or not, is the root's to review");
  await hold(3500);
  await evaluate(dashboard, `window.scrollTo(0, 0); [...document.querySelectorAll("button")].find((b) => b.textContent === "Review")?.click()`);
  await until(dashboard, /files? changed/);
  await caption(dashboard, "Review: commits, files and the diff, made by git in the root VM; nothing in it runs");
  await hold(4500);
  await evaluate(dashboard, `document.querySelector("[data-diff]")?.scrollIntoView({ block: "start" })`);
  await hold(3000);
  cut();

  // ------------------------------------------------------------ 4. your own script
  const script = path.join(os.tmpdir(), "open-prs.sh");
  fs.writeFileSync(script, `#!/bin/bash
# A pull request for every branch desolate's pusher pushes.
desolate events | while read -r line; do
  [ "$(jq -r '.source + " " + .type' <<<"$line")" = "pusher pushed" ] || continue
  repo=$(jq -r .repo <<<"$line"); branch=$(jq -r .branch <<<"$line"); commit=$(jq -r .commit <<<"$line")
  title=$(gh api "repos/$repo/commits/$commit" --jq '.commit.message' | head -1)
  gh pr create --repo "$repo" --head "$branch" --title "$title" --body "Pushed through desolate at $commit."
done
`, { mode: 0o755 });
  const scriptReal = path.join(os.tmpdir(), "open-prs-real.sh");
  fs.writeFileSync(scriptReal, fs.readFileSync(script, "utf8").replace("desolate events", `"${CLI}" events`), { mode: 0o755 });
  const prLog = path.join(os.tmpdir(), "open-prs.log");
  fs.writeFileSync(prLog, "");
  const listener = spawn("bash", [scriptReal], { env: process.env, stdio: ["ignore", fs.openSync(prLog, "a"), fs.openSync(prLog, "a")], detached: true });
  listenerPid = listener.pid ?? 0;
  await terminal("Terminal on your Mac", "desolate events: what happens, one JSON line each, for your own scripts");
  await replay(MAC, "cat open-prs.sh", fs.readFileSync(script, "utf8"), 2000);
  await replay(MAC, "./open-prs.sh &", "[1] " + String(listener.pid), 600);

  // ------------------------------------------------------------ 5. the git VM, and one click
  const gitTab = await tab(address(/git\s+(http:\S+)/, "git", APP));
  await until(gitTab, /git VM/);
  await sleep(2500);
  await show(gitTab);
  await send("Runtime.evaluate", { expression: "document.querySelector('.xterm-helper-textarea')?.focus()" }, gitTab.sessionId);
  await caption(gitTab, "Your git (desolate git): no network, no keys. desolate fetch has the root refresh from GitHub.");
  roll();
  const gitCommand = async (command: string, waitFor: RegExp, after = 1500) => {
    await typeInto(gitTab, command);
    await enter(gitTab);
    await until(gitTab, waitFor, 180_000);
    await sleep(after);
  };
  await gitCommand("desolate fetch", /Fetching acme/, 2500);
  await caption(gitTab, "Each domain is a remote: what its workspaces wrote, as acme/<branch>");
  await gitCommand(`git log --oneline -2 acme/${BRANCH} && git diff --stat main acme/${BRANCH}`, /files? changed/, 2500);
  await caption(gitTab, "git push origin: the approval opens beside the terminal");
  await gitCommand(`git push origin acme/${BRANCH}:refs/heads/${BRANCH}`, /handed to the root/, 300);
  // The approval page, framed beside the terminal: found as a target of its own.
  let frame = "";
  for (let i = 0; i < 120 && !frame; i++) {
    const { targetInfos } = (await send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
    const found = targetInfos.find((t) => t.type === "iframe" && /desolate-approve\.localhost:\d+\/embed/.test(t.url));
    if (found) frame = ((await send("Target.attachToTarget", { targetId: found.targetId, flatten: true })) as { sessionId: string }).sessionId;
    else await sleep(250);
  }
  if (!frame) throw new Error("the approval frame never appeared");
  const frameTab: Tab = { targetId: "", sessionId: frame };
  await until(frameTab, new RegExp(BRANCH), 120_000);
  await until(frameTab, /commit\(s\) the remote does not have/, 120_000);
  await caption(gitTab, "What the push names, and what it would send, worked out in the root");
  await hold(4000);
  const inFrame = (await evaluate(frameTab, "(() => { const r = document.querySelector('.arm').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")) as [number, number];
  const frameAt = (await evaluate(gitTab, "(() => { const r = document.getElementById('frame').getBoundingClientRect(); return [r.x, r.y]; })()")) as [number, number];
  const box: [number, number] = [frameAt[0] + inFrame[0], frameAt[1] + inFrame[1]];
  await caption(gitTab, "Approve arms only for a pointer that moves onto it. One click.");
  await mouseTo(gitTab, [frameAt[0] - 200, 300], [frameAt[0] + 80, 200], 14);
  await sleep(1200);
  await mouseTo(gitTab, [frameAt[0] + 80, 200], box, 24);
  await sleep(450);
  await mouseTo(gitTab, box, [box[0] + 6, box[1] + 2], 5);
  await sleep(500);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box[0] + 6, y: box[1] + 2, button: "left", clickCount: 1 }, gitTab.sessionId);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box[0] + 6, y: box[1] + 2, button: "left", clickCount: 1 }, gitTab.sessionId);
  await until(frameTab, /approved: the push continues/);
  await caption(gitTab, "Pushed: the remote's branch is exactly the commit you approved");
  await until(gitTab, /\[new branch\]/, 180_000);
  await hold(3000);
  cut();

  // ------------------------------------------------------------ 6. the pull request
  for (let i = 0; i < 120 && !/github\.com\/.*\/pull\/\d+/.test(fs.readFileSync(prLog, "utf8")); i++) await sleep(1000);
  prOutput = masked(fs.readFileSync(prLog, "utf8"));
  const number = /\/pull\/(\d+)/.exec(prOutput)?.[1];
  await terminal("Terminal on your Mac", "the script heard the pusher, and opened a pull request");
  await replay("", "", prOutput.trim() || "(no pull request yet)", 600);
  if (number) await replay(MAC, `gh pr view ${number} --repo ${APP}`, sh("gh", ["pr", "view", number, "--repo", APP]), 3500);

  // ------------------------------------------------------------ 7. what kept it safe
  await card("What kept it safe", [
    "The agent's VM held no key and reached nothing but its own proxy.",
    "The write key lives in the root VM; only the pusher uses it, for the one push you approved.",
    "The approval is a click on a page your Mac serves; nothing in a VM can make it.",
  ], "desolate · github.com/pmalacho-mit/isolated-devcontainers-suede (v3)", 5500);
} finally {
  // The events listener, whatever happened: it is a process group of its own.
  if (listenerPid)
    try {
      process.kill(-listenerPid);
    } catch {
      /* gone */
    }
  filming = false;
  await filmed;
  socket.close();
  chrome.kill();
}

// ---------------------------------------------------------------- the video
const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.at ?? f.at + 1500) - f.at) / 1000).toFixed(3)}`).join("\n") + `\nfile '${frames.at(-1)!.file}'\n`;
const listFile = path.join(framesDir, "list.txt");
fs.writeFileSync(listFile, list);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", `fps=25,scale=${W}:-2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
say(`${frames.length} frames, ${(clock / 1000).toFixed(0)} s -> ${out}`);
say(`pull request: ${prOutput.trim().split("\n").pop() ?? "none"}`);
fs.rmSync(framesDir, { recursive: true, force: true });
fs.rmSync(profile, { recursive: true, force: true });

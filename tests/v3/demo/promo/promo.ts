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
const desolate = (...args: string[]) => sh(CLI, args);
/** As the agent, in its workspace's checkout of the app. */
const agent = (script: string) => sh(CLI, ["exec", "acme/agent-1", "--checkout", APP, "--", "bash", "-lc", script]);

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
    if (rolling) clock += now - last;
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
const caption = (t: Tab, text: string | null) =>
  evaluate(t, text === null ? `document.getElementById("promo-caption")?.remove()` : `(() => { let c = document.getElementById("promo-caption"); if (!c) { c = document.createElement("div"); c.id = "promo-caption"; c.style.cssText = "position:fixed;left:0;right:0;bottom:0;padding:14px 22px;background:rgba(18,52,98,.95);color:#fff;font:600 19px -apple-system,system-ui,sans-serif;z-index:2147483647;box-shadow:0 -2px 14px rgba(0,0,0,.3)"; document.documentElement.appendChild(c); } c.textContent = ${JSON.stringify(text)}; })()`);
const typeInto = async (t: Tab, text: string) => {
  for (const ch of text) {
    await send("Input.insertText", { text: ch }, t.sessionId);
    await sleep(30);
  }
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
const card = async (title: string, lines: string[], small?: string, ms = 4500) => {
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
const replay = async (prompt: string, shown: string, output: string, after = 1600) => {
  roll();
  await evaluate(stage, `run(${JSON.stringify(prompt)}, ${JSON.stringify(shown)}, ${JSON.stringify(output)})`);
  await sleep(after);
  cut();
};
const MAC = "you@mac ~ %";

let prOutput = "";
let listenerPid = 0;
try {
  // ------------------------------------------------------------ 0. what this is
  await card("desolate", ["Coding agents, each in a VM of its own, on your Mac.", "They commit and offer. You review, approve with one click, and it is pushed."], "Everything here ran for real: Lima on an M1, a real GitHub repository. Waits are cut.", 5500);

  // ------------------------------------------------------------ 1. the stack
  await terminal("Terminal on your Mac", "the stack is up: desolate bootstrap made it (once)");
  await replay(MAC, "desolate doctor", desolate("doctor"), 3500);

  // ------------------------------------------------------------ 2. repositories, a domain, a workspace
  await card("1 · Repositories, a domain, a workspace", ["desolate holds each repository's deploy keys in its root VM, never in a workspace.", "A domain is a trust boundary: its repositories, its rules, its secrets."]);
  await terminal("Terminal on your Mac", "");
  await replay(MAC, `desolate clone ${APP}`, desolate("clone", APP));
  await replay(MAC, `desolate clone ${LIB}`, desolate("clone", LIB));
  await replay(MAC, `desolate domain create acme --title "Acme"`, desolate("domain", "create", "acme", "--title", "Acme"));
  await replay(MAC, `desolate domain acme add --repo ${APP}`, desolate("domain", "acme", "add", "--repo", APP));
  await replay(MAC, `desolate domain acme add --repo ${LIB}`, desolate("domain", "acme", "add", "--repo", LIB));
  await replay(MAC, "desolate up acme --name agent-1", desolate("up", "acme", "--name", "agent-1"), 3000);

  // ------------------------------------------------------------ 3. the agent works
  await card("2 · An agent works in its workspace", ["Its own VM: no keys, no route out but its own proxy.", "It commits freely. When the work is ready it offers it: offering is not pushing."]);
  await terminal("agent-1's shell", "inside its VM, in /workspaces/" + APP);
  const AGENT = "agent@agent-1 $";
  await replay(AGENT, "git switch -c feature/greeting", agent("git switch -c feature/greeting 2>&1"));
  const edit = `cat > src/greet.js <<'JS'
export const greet = (name = "world") => \`Hello, \${name}. Good to see you.\`;
JS
python3 -c "import zlib,struct
def p(w,h,c):
  r=b''.join(b'\\\\x00'+bytes(c)*w for _ in range(h))
  k=lambda t,d: struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
  return b'\\\\x89PNG\\\\r\\\\n\\\\x1a\\\\n'+k(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+k(b'IDAT',zlib.compress(r,9))+k(b'IEND',b'')
open('assets/banner.png','wb').write(p(640,160,(230,120,40)))"`;
  agent(edit);
  await replay(AGENT, "cat src/greet.js; ls assets   # after its edit, and a new banner", agent("cat src/greet.js; ls assets"));
  await replay(AGENT, `git add -A && git commit -m "Greet by name, and a banner"`, agent(`git add -A && git -c user.name="agent-1" -c user.email=agent-1@acme.invalid commit -m "Greet by name, and a banner" 2>&1`));
  await replay(AGENT, "git lfs ls-files", agent("git lfs ls-files"));
  await replay(AGENT, "desolate offer", agent("desolate offer 2>&1"));
  await replay(AGENT, `/desolate/status set green "ready: offered feature/greeting"`, agent(`/desolate/status set green "ready: offered feature/greeting" 2>&1; echo "status: green"`), 2500);

  // ------------------------------------------------------------ 4. the editor
  const editorUrl = /(http:\S+)/.exec(sh(CLI, ["editor", "acme/agent-1"]).replace("tkn=…", ""))?.[1];
  const realEditor = /(http:\S+tkn=[0-9a-f]+\S*)/.exec(spawnSync(CLI, ["editor", "acme/agent-1"], { encoding: "utf8", env: process.env }).stdout)?.[1];
  if (realEditor) {
    const editor = await tab(realEditor);
    await sleep(15_000);
    await show(editor);
    await caption(editor, "You can watch it work in the workspace's own editor: VSCodium, running in its VM, in a tab");
    await hold(5500);
    cut();
  } else say(`no editor address (${editorUrl ?? "none"}): scene skipped`);

  // ------------------------------------------------------------ 5. the dashboard
  const uiUrl = /dashboard\s+(http:\S+)/.exec(spawnSync(CLI, ["ui"], { encoding: "utf8", env: process.env }).stdout)![1]!;
  const dashboard = await tab(uiUrl);
  await until(dashboard, /Offered: .*feature\/greeting/);
  await show(dashboard);
  await caption(dashboard, "3 · The dashboard: every domain and workspace, and what needs you on top");
  await hold(5000);
  await evaluate(dashboard, `[...document.querySelectorAll("button")].find((b) => b.textContent === "Review")?.click()`);
  await until(dashboard, /files? changed/);
  await caption(dashboard, "Review: the commits, the files, the diff, made by git in the root VM; nothing in it runs");
  await hold(6000);
  await evaluate(dashboard, `window.scrollBy(0, 500)`);
  await hold(3500);
  cut();

  // ------------------------------------------------------------ 6. your own script
  await card("4 · Your own scripts hear what happens", ["desolate events: one JSON line per event, each saying who says so.", "This one opens a pull request whenever the pusher says a branch went out."]);
  const script = path.join(os.tmpdir(), "open-prs.sh");
  fs.writeFileSync(script, `#!/bin/bash
# Open a pull request for every branch desolate's pusher reports pushed.
${CLI.replace(os.homedir(), "~")} events | while read -r line; do
  [ "$(jq -r '.source + " " + .type' <<<"$line")" = "pusher pushed" ] || continue
  repo=$(jq -r .repo <<<"$line"); branch=$(jq -r .branch <<<"$line")
  commit=$(jq -r .commit <<<"$line")
  title=$(gh api "repos/$repo/commits/$commit" --jq '.commit.message' | head -1)
  echo "pushed $branch to $repo: opening a pull request"
  gh pr create --repo "$repo" --head "$branch" --title "$title" --body "Pushed through desolate at $commit."
done
`.replace(`${CLI.replace(os.homedir(), "~")} events`, "desolate events"), { mode: 0o755 });
  const scriptReal = path.join(os.tmpdir(), "open-prs-real.sh");
  fs.writeFileSync(scriptReal, fs.readFileSync(script, "utf8").replace("desolate events", `"${CLI}" events`), { mode: 0o755 });
  const prLog = path.join(os.tmpdir(), "open-prs.log");
  fs.writeFileSync(prLog, "");
  const listener = spawn("bash", [scriptReal], { env: process.env, stdio: ["ignore", fs.openSync(prLog, "a"), fs.openSync(prLog, "a")], detached: true });
  listenerPid = listener.pid ?? 0;
  await terminal("Terminal on your Mac", "");
  await replay(MAC, "cat open-prs.sh", fs.readFileSync(script, "utf8"), 2500);
  await replay(MAC, "./open-prs.sh &", "[1] " + String(listener.pid), 1500);

  // ------------------------------------------------------------ 7. the git VM
  await card("5 · Your git, in a browser tab", ["desolate git: bash and git in a VM of its own, in your clones.", "No network, no keys, nothing of the project's that runs. git push asks you."]);
  const gitUrl = /git\s+(http:\S+)/.exec(spawnSync(CLI, ["git", APP], { encoding: "utf8", env: process.env }).stdout)![1]!;
  const gitTab = await tab(gitUrl);
  await until(gitTab, /git VM/);
  await sleep(2500);
  await show(gitTab);
  await send("Runtime.evaluate", { expression: "document.querySelector('.xterm-helper-textarea')?.focus()" }, gitTab.sessionId);
  await caption(gitTab, "git fetch root: what the domains offered, as root/<domain>/<branch>");
  roll();
  const gitCommand = async (command: string, waitFor: RegExp, after = 2200) => {
    await typeInto(gitTab, command);
    await enter(gitTab);
    await until(gitTab, waitFor, 120_000);
    await sleep(after);
  };
  await gitCommand("git fetch root", /\$ git fetch root/, 5000);
  await gitCommand("git log --oneline -3 root/acme/feature/greeting", /Greet by name/);
  await caption(gitTab, "Look at it as you would anywhere: log, diff, show");
  await gitCommand("git diff --stat main root/acme/feature/greeting", /files? changed/, 3500);
  await caption(gitTab, "git push origin <branch>: it waits for you on the approval page");
  await gitCommand("git push origin root/acme/feature/greeting:refs/heads/feature/greeting", /handed to the root/, 2500);
  cut();

  // ------------------------------------------------------------ 8. one click
  const approveUrl = /approvals {4}(http:\S+)/.exec(spawnSync(CLI, ["approve", "--web"], { encoding: "utf8", env: process.env }).stdout)![1]!;
  const page = await tab(approveUrl);
  await until(page, /feature\/greeting/);
  await until(page, /1 commit\(s\) the remote does not have/);
  await show(page);
  await caption(page, "6 · The approval page, served by your Mac: what the push names, and what it would send");
  await hold(6500);
  const box = (await evaluate(page, "(() => { const r = document.querySelector('.arm').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")) as [number, number];
  await caption(page, "Approve arms only when the pointer moves onto it, a moment after the page has your attention: one click");
  await mouseTo(page, [W / 2, 140], box, 40);
  await sleep(700);
  await mouseTo(page, box, [box[0] + 6, box[1] + 2], 6);
  await sleep(1200);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box[0] + 6, y: box[1] + 2, button: "left", clickCount: 1 }, page.sessionId);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box[0] + 6, y: box[1] + 2, button: "left", clickCount: 1 }, page.sessionId);
  await until(page, /approved: the push continues/);
  await hold(2500);
  cut();

  // ------------------------------------------------------------ 9. pushed
  await show(gitTab);
  await caption(gitTab, "7 · Pushed: the remote's branch is exactly the commit you approved");
  await until(gitTab, /\[new branch\]/, 120_000);
  await hold(4000);
  cut();
  for (let i = 0; i < 120 && !/github\.com\/.*\/pull\/\d+/.test(fs.readFileSync(prLog, "utf8")); i++) await sleep(1000);
  prOutput = masked(fs.readFileSync(prLog, "utf8"));
  const number = /\/pull\/(\d+)/.exec(prOutput)?.[1];
  await terminal("Terminal on your Mac", "the script heard the pusher");
  await replay("", "", prOutput || "(no pull request yet)", 2000);
  if (number) await replay(MAC, `gh pr view ${number} --repo ${APP}`, sh("gh", ["pr", "view", number, "--repo", APP]), 4500);

  // ------------------------------------------------------------ 10. what kept it safe
  await card("What kept it safe", [
    "The agent's VM held no key and reached nothing but its proxy.",
    "The write key is in the root VM, and only the pusher can use it, for the one branch you approved.",
    "The approval is a click on a page your Mac serves; nothing in a VM can make it.",
  ], "desolate · github.com/pmalacho-mit/isolated-devcontainers-suede (v3)", 8000);
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

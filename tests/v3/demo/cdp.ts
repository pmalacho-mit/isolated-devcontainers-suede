// Headless Chrome over its DevTools protocol, for the demo recordings and screenshots: open a
// tab, run script in it, wait for text, caption it, and keep every frame it paints as a video.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Tab = { sessionId: string; targetId: string };

export const launch = async (port: number, width: number, height: number) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--host-resolver-rules=MAP *.localhost 127.0.0.1", `--window-size=${width},${height}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let ws = "";
  for (let i = 0; i < 50 && !ws; i++) {
    await sleep(200);
    ws = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).then((j) => j.webSocketDebuggerUrl).catch(() => "");
  }
  if (!ws) throw new Error("Chrome did not start");
  const socket = new WebSocket(ws);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const handlers: ((message: { method: string; params: Record<string, unknown>; sessionId?: string }) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    const waiting = message.id ? pending.get(message.id) : undefined;
    if (waiting) {
      pending.delete(message.id!);
      if (message.error) waiting.reject(new Error(`CDP: ${message.error.message}`));
      else waiting.resolve(message.result ?? {});
    } else if (message.method) for (const handler of handlers) handler(message as { method: string; params: Record<string, unknown>; sessionId?: string });
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const tab = async (url: string, options: { dark?: boolean; scale?: number } = {}): Promise<Tab> => {
    const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    await send("Page.enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: options.scale ?? 1, mobile: false }, sessionId);
    if (options.dark !== false) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
    await send("Page.navigate", { url }, sessionId);
    await send("Target.activateTarget", { targetId });
    return { sessionId, targetId };
  };
  const evaluate = async (t: Tab, expression: string) =>
    ((await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, t.sessionId)) as { result?: { value?: unknown } }).result?.value;
  const until = async (t: Tab, pattern: RegExp, ms = 90_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (pattern.test(String(await evaluate(t, "document.body ? document.body.innerText : ''")))) return;
    throw new Error(`never saw ${pattern}`);
  };
  /** A caption across the bottom: for the video only (DOM the page did not make). */
  const caption = (t: Tab, text: string, color = "rgba(20,60,110,.94)") =>
    evaluate(t, `(() => { let c = document.getElementById("demo-caption"); if (!c) { c = document.createElement("div"); c.id = "demo-caption"; document.body.appendChild(c); } c.style.cssText = "position:fixed;left:0;right:0;bottom:0;padding:14px 20px;background:${color};color:#fff;font:600 19px system-ui,sans-serif;z-index:99999"; c.textContent = ${JSON.stringify(text)}; })()`);
  /** A trusted click, after the pointer moved there as a person's would. */
  const click = async (t: Tab, x: number, y: number) => {
    for (const [fx, fy] of [[x - 40, y - 20], [x, y]] as const) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx, y: fy }, t.sessionId);
    await sleep(300);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, t.sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, t.sessionId);
  };
  /** Click the centre of the first element matching a selector whose text matches. */
  const clickOn = async (t: Tab, selector: string, text?: RegExp) => {
    const at = (await evaluate(t, `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `${text}.test(e.textContent)` : "true"}); if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`)) as number[] | null;
    if (!at) throw new Error(`nothing matches ${selector} ${text ?? ""}`);
    await sleep(300);
    await click(t, at[0]!, at[1]!);
  };

  /** Every frame a tab paints, from now until `save`, as a video at `out`. */
  const record = async (t: Tab) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-frames-"));
    const frames: { file: string; at: number }[] = [];
    handlers.push((message) => {
      if (message.method !== "Page.screencastFrame" || message.sessionId !== t.sessionId) return;
      const file = path.join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
      fs.writeFileSync(file, Buffer.from(String(message.params.data), "base64"));
      frames.push({ file, at: Date.now() });
      void send("Page.screencastFrameAck", { sessionId: message.params.sessionId }, t.sessionId);
    });
    await send("Page.startScreencast", { format: "jpeg", quality: 88, everyNthFrame: 1 }, t.sessionId);
    return {
      save: async (out: string) => {
        const ended = Date.now();
        await send("Page.stopScreencast", {}, t.sessionId);
        // (Chrome sends a frame only when something is painted: each lasts until the next, the
        // last until now.)
        const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.at ?? ended) - f.at) / 1000).toFixed(3)}`).join("\n") + `\nfile '${frames.at(-1)!.file}'\n`;
        fs.writeFileSync(path.join(dir, "list.txt"), list);
        execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "list.txt"), "-vf", `fps=25,scale=${width}:-2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
        fs.rmSync(dir, { recursive: true, force: true });
        return frames.length;
      },
    };
  };
  const close = async () => {
    socket.close();
    chrome.kill();
    await new Promise((resolve) => chrome.once("exit", resolve));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { send, tab, evaluate, until, caption, click, clickOn, record, close };
};

/** Two clips, one after the other, each under a banner that names it (BEFORE / AFTER). */
export const beforeAfter = (before: string, after: string, out: string, labels = ["BEFORE", "AFTER"]) => {
  const banner = (label: string, color: string) => `drawbox=x=0:y=0:w=iw:h=44:color=${color}@0.92:t=fill,drawtext=text='${label}':x=20:y=11:fontsize=24:fontcolor=white:font=Helvetica`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", before, "-i", after, "-filter_complex",
    `[0:v]${banner(labels[0]!, "0x7a2e2e")},setsar=1[a];[1:v]${banner(labels[1]!, "0x2e6b3a")},setsar=1[b];[a][b]concat=n=2:v=1:a=0[v]`,
    "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
};

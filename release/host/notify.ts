// `desolate notify`: macOS notifications for what needs the person, until stopped: a push
// waiting for approval, a branch offered, an agent asking for a human, a push that went out
// or failed. It reads `desolate events` (events.ts) and shows a few of them.
//
// What an agent wrote (a status message, a branch name) is shown as the agent's words, under
// its workspace's name: a notification is not desolate saying so. It is passed to osascript
// as an argument, never as script.
import { spawn } from "node:child_process";
import { printable } from "../shared/text.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke } from "../.suede/nests/dsl.import.meta.vitest.ts";

export type Notice = { title: string; body: string };

const short = (commit: unknown) => String(commit ?? "").slice(0, 12);

/** The notification for an event, or null for one not worth interrupting anyone for. */
export const notice = (e: Record<string, unknown>): Notice | null => {
  const text = (value: unknown, max = 160) => printable(value, max);
  const where = `${text(e.domain, 40)}/${text(e.workspace, 40)}`;
  if (e.source === "root" && e.type === "approval-waiting" && e.repo) return { title: "desolate: a push waits for you", body: `${text(e.repo)} ${text(e.branch)}: approve it beside the git terminal, or desolate approve --web` };
  if (e.source === "root" && e.type === "offered" && e.repo) return { title: `desolate: ${where} offered a branch`, body: `${text(e.repo)} ${text(e.branch)} at ${short(e.commit)}: desolate review, or the dashboard` };
  if (e.source === "root" && e.type === "status" && (e.color === "orange" || e.color === "red")) return { title: `desolate: ${where} ${e.color === "red" ? "failed" : "asks for you"}`, body: `${where} says: ${text(e.message)}` };
  if (e.source === "root" && e.type === "bundle-refused") return { title: `desolate: refused work from ${text(e.domain, 40)}`, body: `${text(e.repo)}: ${text(e.why)}` };
  if (e.source === "pusher" && e.type === "pushed") return { title: "desolate: pushed", body: `${text(e.repo)} ${text(e.branch)} is now ${short(e.commit)}` };
  if (e.source === "pusher" && (e.type === "push-failed" || e.type === "push-uncertain")) return { title: `desolate: a push ${e.type === "push-failed" ? "failed" : "may not have landed"}`, body: `${text(e.repo)} ${text(e.branch)}: ${text(e.error)}` };
  return null;
};

declare namespace notice {
  /** what needs the person interrupts */
  export type Waiting = Expect<Invoke<typeof notice, [e: { source: "root"; type: "approval-waiting"; repo: "acme/widgets"; branch: "issue/12" }]>, "=", { title: "desolate: a push waits for you"; body: "acme/widgets issue/12: approve it beside the git terminal, or desolate approve --web" }>;
  /** an agent's words come under its workspace's name, made printable */
  export type AgentWords = Expect<Invoke<typeof notice, [e: { source: "root"; type: "status"; domain: "dev"; workspace: "w1"; color: "orange"; message: "approve it now\u001b]0;x" }]>, "=", { title: "desolate: dev/w1 asks for you"; body: "dev/w1 says: approve it now?]0;x" }>;
  /** green is not an interruption, and a source cannot claim another's event */
  export type Quiet = [
    Expect<Invoke<typeof notice, [e: { source: "root"; type: "status"; domain: "dev"; workspace: "w1"; color: "green"; message: "done" }]>, "=", null>,
    Expect<Invoke<typeof notice, [e: { source: "pusher"; type: "approval-waiting"; repo: "acme/widgets" }]>, "=", null>,
  ];
}

const show = (n: Notice) => {
  if (process.platform === "darwin")
    spawn("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv) sound name \"Glass\"", "-e", "end run", n.title, n.body], { stdio: "ignore" }).on("error", () => {});
  else spawn("notify-send", [n.title, n.body], { stdio: "ignore" }).on("error", () => {});
};

export const notify = async (out: (line: string) => void) => {
  const { followEvents } = await import("./daemon.ts");
  const said = new Map<string, number>();
  out("desolate notify: notifications for pushes waiting, offers, agents asking for you, and pushes. Ctrl-C stops.");
  await followEvents(0, (line) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const n = notice(event);
    if (!n) return;
    // A workspace's own words (its status), at most once a minute each: an agent flipping
    // its colour must not teach anyone to ignore desolate's notifications.
    if (event.source === "root" && event.type === "status") {
      const key = `${String(event.domain)}/${String(event.workspace)}`;
      if (Date.now() - (said.get(key) ?? 0) < 60_000) return;
      said.set(key, Date.now());
    }
    out(`${new Date().toLocaleTimeString()}  ${n.title}: ${n.body}`);
    show(n);
  }, (resume) => resume());
};

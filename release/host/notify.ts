// `desolate notify`: macOS notifications for what needs the person, until stopped: a push
// waiting for approval, a branch offered, an agent asking for a human, a push that went out
// or failed. It reads `desolate events` (events.ts) and shows a few of them.
//
// What an agent wrote (a status message, a branch name) is shown as the agent's words, under
// its workspace's name: a notification is not desolate saying so. It is passed to osascript
// as an argument, never as script.
import { spawn } from "node:child_process";
import { printable } from "./events.ts";

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

const show = (n: Notice) => {
  if (process.platform === "darwin")
    spawn("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv) sound name \"Glass\"", "-e", "end run", n.title, n.body], { stdio: "ignore" }).on("error", () => {});
  else spawn("notify-send", [n.title, n.body], { stdio: "ignore" }).on("error", () => {});
};

export const notify = async (out: (line: string) => void) => {
  const { followEvents } = await import("./daemon.ts");
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
    out(`${new Date().toLocaleTimeString()}  ${n.title}: ${n.body}`);
    show(n);
  }, (resume) => resume());
};

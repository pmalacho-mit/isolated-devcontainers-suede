// The editor's machine settings that desolate holds: put back at every start, whatever was
// written since (v2's editor-settings.ts, for the workspace's own editor). Everything else
// in the file is the person's.
//
//   node editor-settings.ts <Machine/settings.json> [enter|plain]
//
// "enter": the editor's server runs in the VM, so its terminal goes through enter.sh, which
// enters the project's devcontainer when there is one. "plain": the server runs in the
// devcontainer itself, and its terminal is the container's own shell.
import * as fs from "node:fs";
import * as path from "node:path";

export const HELD: Record<string, unknown> = {
  // The workspace VM is the boundary (P1): everything in it is as trusted as anything else
  // in it, so the editor does not ask. The server runs with --disable-workspace-trust too.
  "security.workspace.trust.enabled": false,
  // Nothing updates itself behind the person's back; extensions come from Open VSX through
  // the domain's proxy, when asked for.
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "terminal.integrated.macOptionClickForcesSelection": true,
};

const TERMINAL = {
  "terminal.integrated.profiles.linux": { desolate: { path: "/desolate/release/workspace/enter.sh", args: ["--here", "--", "bash", "-l"] } },
  "terminal.integrated.defaultProfile.linux": "desolate",
};

export const hold = (text: string | undefined, terminal: "enter" | "plain" | undefined = undefined): string => {
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    // Unreadable (hand-edited into something that is not JSON): start again from what is held.
  }
  if (terminal === "enter") Object.assign(settings, TERMINAL);
  // Only what desolate put there is taken away: a profile of the person's own stays.
  if (terminal === "plain" && settings["terminal.integrated.defaultProfile.linux"] === "desolate") for (const key of Object.keys(TERMINAL)) delete settings[key];
  return JSON.stringify({ ...settings, ...HELD }, null, 2) + "\n";
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: editor-settings.ts <settings.json>");
    process.exit(2);
  }
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = undefined;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const terminal = process.argv[3] === "enter" || process.argv[3] === "plain" ? process.argv[3] : undefined;
  fs.writeFileSync(`${file}.desolate-tmp`, hold(text, terminal), { mode: 0o600 });
  fs.renameSync(`${file}.desolate-tmp`, file);
}

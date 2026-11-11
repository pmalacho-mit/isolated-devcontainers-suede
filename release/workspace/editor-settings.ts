// The editor's machine settings that desolate holds: put back at every start, whatever was
// written since (v2's editor-settings.ts, for the workspace's own editor). Everything else
// in the file is the person's.
//
//   node editor-settings.ts <Machine/settings.json>
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

export const hold = (text: string | undefined): string => {
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    // Unreadable (hand-edited into something that is not JSON): start again from what is held.
  }
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
  fs.writeFileSync(`${file}.desolate-tmp`, hold(text), { mode: 0o600 });
  fs.renameSync(`${file}.desolate-tmp`, file);
}

// The root editor's machine settings that desolate holds (v2's editor-settings.ts, which
// held these for its outer editor): put back at every start. The root's editor is for
// review. Nothing here lets a repository's content run in it.
//
//   node editor-settings.ts <Machine/settings.json>
import * as fs from "node:fs";
import * as path from "node:path";

export const HELD: Record<string, unknown> = {
  // Restricted Mode, and no prompt that would lift it with one click.
  "security.workspace.trust.enabled": true,
  "security.workspace.trust.startupPrompt": "never",
  "security.workspace.trust.emptyWindow": false,
  "security.workspace.trust.banner": "always",
  // A repository's tasks never start by themselves, and it recommends no extensions here.
  "task.allowAutomaticTasks": "off",
  "extensions.ignoreRecommendations": true,
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  // git here is on the root's own clones (P4). It fetches when asked: `git fetch --all`
  // brings every domain's offered work in.
  "git.autofetch": false,
  "git.openRepositoryInParentFolders": "never",
  "git.autoRepositoryDetection": "subFolders",
  "git.repositoryScanMaxDepth": 3,
  // The terminal is the root's: review and push; never a repository's own code.
  "terminal.integrated.profiles.linux": { desolate: { path: "/bin/bash", args: ["-l"] } },
  "terminal.integrated.defaultProfile.linux": "desolate",
};

export const hold = (text: string | undefined): string => {
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    // Unreadable: start again from what is held.
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

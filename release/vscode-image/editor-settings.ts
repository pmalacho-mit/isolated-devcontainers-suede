/**
 * editor-settings.ts -- the OUTER editor's security settings, held at every
 * start (audit M3).
 *
 * `tsx editor-settings.ts <settings.json>`: seeds the file when it is absent,
 * and when it is there puts back every setting below that was changed or
 * removed, leaving the rest of the file -- the person's own settings -- as it
 * was. shell-entry.sh runs this before the server, each start.
 *
 * Why at every start and not once: $HOME is the `vscode-home` VOLUME, which
 * outlives the container, and a compromised editor runs as the user who owns
 * it. Seeded once, workspace trust is one write away from off, for good. Held
 * each start, a restart puts it back -- which is what the README promises a
 * restart does.
 *
 * The terminal profile is held for the same reason: a bash that read
 * ~/.bashrc from that volume would run whatever was left there, in the one
 * container that can reach the deploy keys. `--rcfile /dev/null` reads
 * nothing from $HOME and still reads /etc/bash.bashrc, where the completion
 * and the git guard are (the Dockerfile asserts both).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseJsonc } from "./jsonc.ts";

/** What every start insists on. Values are compared structurally. */
export const HELD: Record<string, unknown> = {
  // ON, and true means the protection EXISTS. False would mean "trust
  // everything", which is the opposite of what it sounds like.
  "security.workspace.trust.enabled": true,
  // Never offer the prompt at startup: a folder stays in Restricted Mode until
  // you deliberately trust it (Workspaces: Manage Workspace Trust).
  "security.workspace.trust.startupPrompt": "never",
  "security.workspace.trust.emptyWindow": false,
  "security.workspace.trust.banner": "always",
  // Terminals are BLOCKED in Restricted Mode by default, because a shell can
  // execute workspace content on startup. This image's shell does none of
  // that, and `desolate` from a terminal is this editor's whole job.
  "terminal.integrated.allowInUntrustedWorkspace": true,
  // A trusted workspace can still declare tasks that run on folderOpen.
  // Nothing here needs them.
  "task.allowAutomaticTasks": "off",
  // This editor is a launcher, not an IDE. Extensions here run beside the
  // agent socket; install them in the project editor instead. (Its
  // extensions directory is a tmpfs besides -- docker-compose.yml.)
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false,
  // No rc file from the home volume (see the header).
  "terminal.integrated.profiles.linux": { desolate: { path: "/bin/bash", args: ["--rcfile", "/dev/null"] } },
  "terminal.integrated.defaultProfile.linux": "desolate",
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `text`, with every held setting at its value. `changed` names the keys that
 * were not: none means the file is left exactly as it was. A file that does
 * not parse is replaced by the seed -- said, since what it held is lost.
 */
export const hold = (text: string | undefined): { text: string; changed: string[]; unreadable: boolean } => {
  if (text === undefined) return { text: seed(), changed: Object.keys(HELD), unreadable: false };
  let settings: unknown;
  try {
    settings = parseJsonc(text);
  } catch {
    return { text: seed(), changed: Object.keys(HELD), unreadable: true };
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings))
    return { text: seed(), changed: Object.keys(HELD), unreadable: true };
  const object = settings as Record<string, unknown>;
  const changed = Object.entries(HELD).filter(([key, value]) => !same(object[key], value)).map(([key]) => key);
  if (!changed.length) return { text, changed, unreadable: false };
  for (const key of changed) object[key] = HELD[key];
  return { text: `${JSON.stringify(object, null, 2)}\n`, changed, unreadable: false };
};

/** The file as first written: the held settings, with a note on what holds them. */
export const seed = () =>
  [
    "{",
    "  // Seeded by shell-entry.sh. Yours to edit -- except the settings",
    "  // editor-settings.ts holds (workspace trust, automatic tasks, extension",
    "  // updates, the terminal profile): those are put back at every start, and",
    "  // the file is rewritten without these comments when one has changed.",
    "  // release/README.md says why.",
    ...JSON.stringify(HELD, null, 2).split("\n").slice(1, -1),
    "}",
    "",
  ].join("\n");

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: editor-settings.ts <settings.json>");
    process.exit(2);
  }
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = undefined;
  }
  const result = hold(text);
  if (result.changed.length) {
    mkdirSync(dirname(file), { recursive: true });
    // Whole, then into place: a server reading a half-written settings file
    // would take it for empty.
    writeFileSync(`${file}.desolate-tmp`, result.text, { mode: 0o600 });
    renameSync(`${file}.desolate-tmp`, file);
    console.error(
      text === undefined
        ? `shell-entry: seeded editor security defaults at ${file}`
        : result.unreadable
          ? `shell-entry: ${file} did not parse; replaced it with the security defaults`
          : `shell-entry: put back ${result.changed.join(", ")} in ${file}`,
    );
  }
}

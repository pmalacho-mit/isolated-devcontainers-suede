/**
 * One-shot local install of a DSL VSCode extension.
 *
 * npm install → bundle (esbuild) → typecheck → package (.vsix) → install into
 * whichever VSCode-family CLI is on PATH. No marketplace, no publisher account.
 *
 * Distribution friction is what kills internal developer tools — not
 * capability. A teammate should be able to clone, run one command, reload the
 * window, and have the tooling.
 *
 * Import from your extension's install.mjs:
 *
 *   import { installExtension } from "../typescript-dsl-suede/vscode-extension/installer.mjs";
 *   await installExtension({
 *     root: path.dirname(fileURLToPath(import.meta.url)),
 *     vsix: "my-dsl.vsix",
 *     hint: "hover a `My.Diagram<...>` type alias in a TypeScript file.",
 *   });
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const shell = process.platform === "win32";

const CLIS = shell
  ? ["code.cmd", "code-insiders.cmd", "codium.cmd", "cursor.cmd"]
  : ["code", "code-insiders", "codium", "cursor"];

function run(root, cmd, args, { allowFail = false } = {}) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell });
  if (result.status !== 0 && !allowFail) {
    console.error(`\n✖ Failed: ${cmd} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
  return result.status === 0;
}

/** First VSCode-family CLI on PATH that answers `--version`. */
export function findEditorCli(candidates = CLIS) {
  return candidates.find(
    (c) => spawnSync(c, ["--version"], { shell, stdio: "ignore" }).status === 0,
  );
}

export async function installExtension({
  root,
  vsix = "extension.vsix",
  install = true,
  installDeps = true,
  buildScript = "build",
  typecheckScript = "typecheck",
  hint,
}) {
  if (!root) throw new Error("installExtension: `root` is required");

  if (installDeps) {
    console.log("▸ Installing build dependencies...");
    run(root, "npm", ["install"]);
  }

  if (buildScript) {
    console.log(
      "\n▸ Bundling extension (vendored library source is compiled in — no parent build needed)...",
    );
    run(root, "npm", ["run", buildScript]);
  }

  if (typecheckScript) {
    console.log("\n▸ Typechecking...");
    run(root, "npm", ["run", typecheckScript]);
  }

  console.log("\n▸ Packaging VSIX...");
  run(root, "npx", [
    "--yes",
    "@vscode/vsce",
    "package",
    "--no-dependencies",
    "-o",
    vsix,
  ]);

  if (!install) {
    console.log(`\n✔ Built ${vsix}.`);
    return { vsix: path.join(root, vsix), cli: undefined };
  }

  const cli = findEditorCli();
  if (!cli) {
    console.log(`\n✔ Built ${vsix}, but no VSCode CLI was found on PATH.`);
    console.log(
      "  Finish manually: Command Palette → “Extensions: Install from VSIX...” →",
    );
    console.log(`  select ${path.join(root, vsix)}`);
    return { vsix: path.join(root, vsix), cli: undefined };
  }

  console.log(`\n▸ Installing into ${cli}...`);
  console.warn(
    `\nNOTE: If the below fails because "Unable to connect to VS Code server", try running in a fresh terminal.\n`,
  );
  run(root, cli, ["--install-extension", path.join(root, vsix), "--force"]);

  console.log(
    "\n✔ Installed. In any open VSCode window run “Developer: Reload Window”",
  );
  if (hint) console.log(`  then ${hint}`);

  return { vsix: path.join(root, vsix), cli };
}

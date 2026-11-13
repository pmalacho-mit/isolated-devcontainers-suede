// Build, package and install. An extension folder copied into place is not an
// installed extension: the editor keeps its own registry, so it has to go in
// through the CLI as a .vsix.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);

const manifest = JSON.parse(
  fs.readFileSync(path.join(scriptDir, "package.json"), "utf8"),
);

const vsix = path.join(scriptDir, `${manifest.name}-${manifest.version}.vsix`);

execFileSync("node", [path.join(scriptDir, "build.mjs")], {
  stdio: "inherit",
  cwd: scriptDir,
});

execFileSync(
  "npx",
  ["--yes", "@vscode/vsce", "package", "--no-dependencies", "-o", vsix],
  { stdio: "inherit", cwd: scriptDir },
);

const cli = ["code", "codium", "code-insiders", "cursor"].find((candidate) => {
  const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
  return probe.status === 0;
});

if (!cli) {
  console.log(`\npackaged → ${vsix}`);
  console.log(
    'install it with: Command Palette → "Extensions: Install from VSIX..."',
  );
  process.exit(0);
}

console.log(`\ninstalling into ${cli}…`);
execFileSync(cli, ["--install-extension", vsix, "--force"], {
  stdio: "inherit",
});
console.log("reload the window to pick it up (Developer: Reload Window)");

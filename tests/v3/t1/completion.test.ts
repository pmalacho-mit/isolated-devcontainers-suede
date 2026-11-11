// T1. Tab completion (release/completion.bash): what it offers, from a fixture home, and
// what it refuses to offer. v2's "completion hardening", for v3's verbs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const SCRIPT = path.resolve(import.meta.dirname, "../../../release/completion.bash");
let home = "";
/** What bash would offer for this command line, with the cursor after the last word. */
const complete = (...words: string[]): string[] => {
  const program = `source "${SCRIPT}"; COMP_WORDS=(desolate ${words.map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(" ")}); COMP_CWORD=${words.length}; _desolate; printf '%s\\n' "\${COMPREPLY[@]}"`;
  const result = spawnSync("bash", ["--norc", "--noprofile", "-c", program], { encoding: "utf8", env: { PATH: process.env.PATH, DESOLATE_HOME: home, HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter(Boolean).sort();
};

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-completion-"));
  for (const [domain, workspaces] of [["dev", ["issue-12", "w1"]], ["docs", ["w1"]]] as [string, string[]][]) {
    fs.mkdirSync(path.join(home, "domains", domain, "inbox", "workspaces"), { recursive: true });
    for (const workspace of workspaces) fs.writeFileSync(path.join(home, "domains", domain, "inbox", "workspaces", `${workspace}.json`), "{}");
  }
  fs.mkdirSync(path.join(home, "mirrors", "acme", "widgets.git"), { recursive: true });
  // Names a program could have chosen. None may reach a command line.
  for (const bad of ["$(touch pwned)", "--all", "has space", "UPPER", "semi;colon", "a\x1b[2Jb"]) {
    fs.mkdirSync(path.join(home, "domains", bad, "inbox", "workspaces"), { recursive: true });
    fs.writeFileSync(path.join(home, "domains", "dev", "inbox", "workspaces", `${bad}.json`), "{}");
  }
  fs.mkdirSync(path.join(home, "domains", "no-inbox"), { recursive: true });
  fs.mkdirSync(path.join(home, "mirrors", "acme", "$(evil).git"), { recursive: true });
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

describe("T1 tab completion", () => {
  it("offers the verbs, and narrows them", () => {
    const verbs = complete("");
    for (const verb of ["bootstrap", "up", "exec", "editor", "push", "approve", "down", "domain"]) assert.ok(verbs.includes(verb), verb);
    assert.deepEqual(complete("ap"), ["approve"]);
    assert.deepEqual(complete("domain", "dev", ""), ["add", "net", "secret", "show"]);
    assert.deepEqual(complete("domain", "dev", "secret", "o"), ["off", "on"]);
    assert.deepEqual(complete("domain", "dev", "net", "re"), ["recommend"]);
  });
  it("offers the domains, workspaces and repositories of this stack", () => {
    assert.deepEqual(complete("up", ""), ["dev", "docs"]);
    assert.deepEqual(complete("exec", "d"), ["dev/issue-12", "dev/w1", "docs/w1"]);
    assert.deepEqual(complete("editor", "dev/i"), ["dev/issue-12"]);
    assert.deepEqual(complete("fetch", ""), ["acme/widgets"]);
    assert.deepEqual(complete("review", "dev", "a"), ["acme/widgets"]);
  });
  it("never offers a name that is not a slug: nothing a program chose reaches the command line", () => {
    const everything = [...complete("up", ""), ...complete("exec", ""), ...complete("rm", ""), ...complete("domain", ""), ...complete("fetch", ""), ...complete("status", "")];
    for (const word of everything) assert.match(word, /^(--json|create|[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?|acme\/widgets)$/, word);
    assert.ok(!fs.existsSync(path.join(home, "pwned")) && !fs.existsSync("pwned"), "and nothing was run to find them");
    assert.ok(!everything.includes("no-inbox"), "a directory that is not a domain the root made is not one");
  });
  it("leaves the command after -- alone", () => {
    assert.deepEqual(complete("exec", "dev/w1", "--", "gi"), []);
  });
});

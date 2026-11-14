// T2 (fake backend). What the root does with what a domain sends it, when the domain is
// hostile. A workspace is root in its own VM: it can put any bytes in a bundle, any file or
// symlink in its outbox, and any tree in a commit. The root must take none of it as
// anything but data.
//
// Every case has a control: the same route, with honest content, works.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
const vms = new Map<string, string>();
const vmOf = (target: string) => {
  if (!vms.has(target)) {
    const list = JSON.parse(stack.quiet("list", "--json").stdout) as { domain: string; workspaces: { workspace: string; vm: string }[] }[];
    for (const d of list) for (const w of d.workspaces) vms.set(`${d.domain}/${w.workspace}`, w.vm);
  }
  return vms.get(target)!;
};
const inWs = (script: string, root = false) => stack.inVm(vmOf("dev/w1"), ["bash", "-lc", `cd /workspaces/acme/widgets && ${script}`], { root });
const ROOT_CLONE = "/desolate/root/acme/widgets";
const inRootClone = (script: string) => stack.inRoot(["bash", "-c", `export GIT_CONFIG_GLOBAL=/var/lib/desolate-root/gitconfig; cd ${ROOT_CLONE} && ${script}`]);
const marker = "/tmp/desolate-pwned";
const pwned = () => stack.inRoot(["bash", "-c", `ls ${marker}* 2>/dev/null | wc -l`], { root: true }).stdout.trim();
const offers = () => JSON.parse(stack.quiet("offers", "--json").stdout) as { branch: string; commit: string }[];
/** Make a branch in the workspace from a script, and offer it. Returns `desolate offer`'s result. */
const offer = (branch: string, make: string) => inWs(`git checkout -q -f main && git clean -fdxq && git checkout -q -B ${branch} && { ${make}; } && desolate offer 2>&1`);
/** The same, for a commit that cannot be checked out (git's porcelain refuses to make it):
 *  the branch is pointed at it, from main, and offered by name. */
const offerCommit = (branch: string, make: string) => inWs(`git checkout -q -f main && git clean -fdxq && { ${make}; } && git branch -f ${branch} $c && desolate offer acme/widgets ${branch} 2>&1`);
const ME = "-c user.name=t -c user.email=t@example.test";

describe("T2: what a hostile domain sends, the root takes as data", () => {
  before(() => {
    stack = newStack("hostile");
    stack.seed("acme/widgets", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# widgets\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/widgets", "--no-domain").code, 0);
    assert.equal(stack.quiet("domain", "create", "dev").code, 0);
    assert.equal(stack.quiet("domain", "dev", "add", "--repo", "acme/widgets").code, 0);
    assert.equal(stack.quiet("up", "dev").code, 0);
  });
  after(() => stack.destroy());

  it("control: an honest branch is offered, reviewed with its diff, and nothing ran", () => {
    stack.step("an honest offer");
    const made = offer("honest", `echo more >> README.md && git ${ME} commit -qam 'an honest change'`);
    assert.equal(made.code, 0, made.stdout);
    assert.ok(offers().some((o) => o.branch === "honest"));
    const shown = stack.desolate("review", "dev", "acme/widgets", "honest", "--diff");
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^diff --git a\/README\.md b\/README\.md$/m);
    assert.match(shown.stdout, /^\+more$/m);
    assert.equal(pwned(), "0");
  });

  it("objects git itself calls dangerous never get a ref in the root: .git in a tree, a .gitmodules that is a symlink or names an option", () => {
    stack.step("trees that attack a checkout");
    // Each is built with plumbing, since git's own porcelain refuses to make them.
    const tree = (entries: string) => `t=$(printf '${entries}' | git mktree --missing) && c=$(git ${ME} commit-tree -m hostile -p HEAD $t)`;
    const blob = "$(echo x | git hash-object -w --stdin)";
    const cases: [string, string][] = [
      ["dot-git", `b=${blob}; inner=$(printf '100644 blob %s\\tconfig\\n' $b | git mktree) && ${tree("040000 tree '$inner'\\t.git\\n")}`],
      ["dot-git-case", `b=${blob}; inner=$(printf '100644 blob %s\\tconfig\\n' $b | git mktree) && ${tree("040000 tree '$inner'\\t.GIT\\n")}`],
      ["gitmodules-symlink", `b=$(printf '/etc/passwd' | git hash-object -w --stdin) && ${tree("120000 blob '$b'\\t.gitmodules\\n")}`],
      ["gitmodules-option", `b=$(printf '[submodule "x"]\\n\\tpath = x\\n\\turl = -u./payload\\n' | git hash-object -w --stdin) && ${tree("100644 blob '$b'\\t.gitmodules\\n")}`],
    ];
    // Each alone: the branch is deleted before the next, so every case is refused for
    // what it is and not for its neighbour.
    for (const [branch, make] of cases) {
      const made = offerCommit(branch, make);
      assert.notEqual(made.code, 0, `${branch}: ${made.stdout}`);
      assert.match(made.stdout, /the root did not take the offer: the root refused this domain's bundle of acme\/widgets: object [0-9a-f]{40}: (hasDotgit|gitmodulesSymlink|gitmodulesUrl)/, `${branch}: the workspace is told why: ${made.stdout}`);
      const there = inRootClone(`git for-each-ref --format='%(refname)' 'refs/remotes/dev/${branch}' 'refs/desolate/' | wc -l; git fetch dev 2>&1 | tail -1`);
      assert.match(there.stdout, /^0\n/, `${branch}: the root has no ref to it`);
      assert.ok(!offers().some((o) => o.branch === branch), `${branch}: and no offer`);
      assert.match(stack.quiet("offers").stdout, /Refused from dev \(acme\/widgets, .*Delete that branch in the workspace/s, `${branch}: and the person is told, where they look for offers`);
      if (branch !== cases.at(-1)![0]) inWs(`git checkout -q -f main && git branch -D ${branch} >/dev/null && desolate sync >/dev/null 2>&1; true`);
    }
    const fetched = inRootClone("git fetch dev 2>&1; git for-each-ref --format='%(refname:short)' refs/remotes/dev");
    assert.match(fetched.stdout, /^dev\/honest$/m, "control: the honest branch is still there, by the same route");
    // While such a branch exists the domain's bundles carry it, so nothing new is taken:
    // an honest branch made now waits, and is told why. Once the branch is gone, it flows.
    const blocked = offer("waits", `echo w >> README.md && git ${ME} commit -qam 'made while the domain was sending dangerous objects'`);
    assert.notEqual(blocked.code, 0, blocked.stdout);
    assert.match(blocked.stdout, /the root refused this domain's bundle.*Nothing new is taken until that branch is deleted here/s, blocked.stdout);
    inWs(`git checkout -q -f main && git branch -D ${cases.at(-1)![0]} >/dev/null`);
    const flows = inWs("git checkout -q waits && desolate offer 2>&1");
    assert.equal(flows.code, 0, flows.stdout);
    assert.ok(offers().some((o) => o.branch === "waits"), "control: with the dangerous branch gone, the same branch is taken");
    assert.doesNotMatch(stack.quiet("offers").stdout, /Refused from/, "and the refusal is no longer shown");
    assert.equal(pwned(), "0");
  });

  it("a tree that plants a repository of its own, or a diff driver, runs nothing when the person looks at it or checks it out", () => {
    stack.step("content that hopes to be run");
    // A directory shaped like a repository's own directory, whose config gives it a work
    // tree and names a program to run on `git status` (fsmonitor): the embedded bare
    // repository trick. A shell prompt that shows git's state is enough to set it off.
    // attributes that ask for an external diff and a filter; a hook; a symlink out of the tree.
    const made = offer("planted", [
      `mkdir -p sub/trap/objects sub/trap/refs/heads hooks`,
      `printf 'ref: refs/heads/main\\n' > sub/trap/HEAD`,
      `printf '[core]\\n\\tbare = false\\n\\tworktree = .\\n\\trepositoryformatversion = 0\\n\\tfsmonitor = "touch ${marker}-fsmonitor; false"\\n\\tpager = "touch ${marker}-pager; cat"\\n[alias]\\n\\tstatus = "!touch ${marker}-alias"\\n' > sub/trap/config`,
      `touch sub/trap/objects/.keep sub/trap/refs/heads/.keep`,
      `printf '* diff=evil filter=evil merge=evil\\n*.md textconv=evil\\n' > .gitattributes`,
      `printf '[diff "evil"]\\n\\tcommand = touch ${marker}-diffdriver\\n\\ttextconv = touch ${marker}-textconv\\n[filter "evil"]\\n\\tsmudge = touch ${marker}-smudge\\n\\tclean = touch ${marker}-clean\\n' > .gitconfig`,
      `printf '#!/bin/sh\\ntouch ${marker}-hook\\n' > hooks/post-checkout && chmod +x hooks/post-checkout`,
      `ln -s /var/lib/desolate-root/keyring out-of-tree`,
      `echo changed >> README.md && git add -A && git ${ME} commit -qm 'planted'`,
    ].join(" && "));
    assert.equal(made.code, 0, made.stdout);
    // What desolate itself does with it: review, and the diff.
    const shown = stack.desolate("review", "dev", "acme/widgets", "planted", "--diff");
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /WARNING: .*changes \.lfsconfig, \.gitattributes or \.gitmodules/);
    assert.match(shown.stdout, /^\+changed$/m, "the diff is git's own, as text");
    assert.equal(pwned(), "0", "review and diff ran nothing of the content's");
    // What a person does in the root's terminal: check the branch out, walk into every
    // directory, and run git there.
    const walked = inRootClone(`git checkout -q dev/planted 2>&1; git status --short | head -3; git diff HEAD~1 --stat | tail -1; git log --oneline -1
      for d in . sub sub/trap hooks; do (cd $d && git status >/dev/null 2>&1; git log -1 --format=%s 2>&1 | head -1; git diff HEAD~1 >/dev/null 2>&1); done
      test -L out-of-tree && echo symlink-is-a-symlink; ls out-of-tree 2>&1 | head -1; git checkout -q main 2>&1`);
    assert.equal(pwned(), "0", `nothing ran: ${walked.stdout}`);
    assert.match(walked.stdout, /symlink-is-a-symlink\nls: cannot open directory 'out-of-tree': Permission denied/, "a symlink out of the tree leads only where the root's user may already go");
    // CONTROL: the planted repository is exactly the kind that would run its config, where
    // git is allowed to find it. With the root's protection switched off for one command, it does.
    const unprotected = inRootClone(`git checkout -q dev/planted && (cd sub/trap && git -c safe.bareRepository=all status >/dev/null 2>&1); git checkout -q main; ls ${marker}-fsmonitor 2>&1`);
    assert.match(unprotected.stdout, new RegExp(`^${marker}-fsmonitor$`, "m"), "control: without safe.bareRepository=explicit the planted config runs, so the empty result above is the setting at work");
    stack.inRoot(["bash", "-c", `rm -f ${marker}*`], { root: true });
  });

  it("the outbox: symlinks, garbage, a file that is swapped: nothing of the root's is read or removed through it", () => {
    stack.step("a hostile outbox");
    const outbox = path.join(stack.home, "domains/dev/outbox");
    const canary = stack.inRoot(["bash", "-c", "echo the-roots-own > /var/lib/desolate/canary.bundle; echo '{\"refs\":{\"stolen\":\"" + "a".repeat(40) + "\"}}' > /var/lib/desolate/refs.json; ls /var/lib/desolate/canary.bundle"]);
    assert.equal(canary.code, 0);
    // From inside the workspace, as root there: a bundle that is a symlink to the root's
    // file; the whole sync directory of a repository replaced by a symlink to the root's
    // state; a request that is a symlink; garbage.
    const planted = inWs(`cd /desolate/outbox && mkdir -p sync/acme requests && rm -rf sync/acme/widgets && ln -s /var/lib/desolate sync/acme/widgets && ln -s /var/lib/desolate/registry.json requests/aa-evil.json && echo not-json > requests/ab-garbage.json && ls -la sync/acme | wc -l`, true);
    assert.equal(planted.code, 0, planted.stderr);
    assert.ok(fs.lstatSync(path.join(outbox, "sync/acme/widgets")).isSymbolicLink(), "control: the symlink is really there, on the host's side of the share");
    const fetched = inRootClone("git fetch dev 2>&1; git for-each-ref --format='%(refname:short)' refs/remotes/dev | sort | tr '\\n' ' '");
    assert.doesNotMatch(fetched.stdout, /stolen/, "a refs list reached through a symlinked directory is not read");
    assert.equal(stack.inRoot(["bash", "-c", "cat /var/lib/desolate/canary.bundle /var/lib/desolate/registry.json | head -c 20"]).stdout.slice(0, 14), "the-roots-own\n", "and the root's own files are still there: nothing was removed through the domain's path");
    // The workspace puts things back; honest work flows again by the same route.
    inWs("rm -f /desolate/outbox/sync/acme/widgets /desolate/outbox/requests/*.json", true);
    const again = offer("after", `echo again >> README.md && git ${ME} commit -qam 'after the attack'`);
    assert.equal(again.code, 0, again.stdout);
    assert.ok(offers().some((o) => o.branch === "after"), "control: the outbox works again for honest work");
    // A bundle in a format a workspace's git does not write by default (v3, which exists
    // to carry capabilities such as a filter that leaves objects out): refused as a whole.
    // The control is the same branch, bundled the ordinary way, just above.
    const v3 = inWs("git bundle create --version=3 -q /desolate/outbox/sync/acme/widgets/zz-v3.bundle after && head -c 16 /desolate/outbox/sync/acme/widgets/zz-v3.bundle");
    assert.match(v3.stdout, /^# v3 git bundle/, v3.stdout + v3.stderr);
    assert.match(inRootClone("git fetch dev 2>&1").stdout, /a bundle from dev was refused and dropped: it is not a bundle a workspace's git writes \(v2\)/);
    assert.ok(!fs.existsSync(path.join(outbox, "sync/acme/widgets/zz-v3.bundle")), "and it is gone from the outbox");
    // That refusal is on record until the domain is whole again, which it is: everything it
    // lists is in the root. The next look clears it.
    inRootClone("git fetch dev 2>&1");
    assert.doesNotMatch(stack.quiet("offers").stdout, /Refused from/);
  });

  it("through all of it the root's own services kept running", () => {
    // None of this ended the root's own services. (It once did: the state service watched
    // a tree in which git's quarantine came and went, on real VMs only. release/docs/incidents.md.)
    assert.equal(stack.inRoot(["bash", "-c", "cat /var/lib/desolate/stated.log /var/lib/desolate/rootd.log | grep -c 'starting it again'; true"]).stdout.trim(), "0", "the state service and rootd ran throughout");
  });

  it("names and messages that try to drive a terminal or an option are shown as text or refused", () => {
    stack.step("hostile names and messages");
    const made = offer("escapes", `echo e >> README.md && git ${ME} commit -qam "$(printf 'title\\033[2J\\033]0;owned\\007 <script>alert(1)</script>')"`);
    assert.equal(made.code, 0, made.stdout);
    const shown = stack.desolate("review", "dev", "acme/widgets", "escapes");
    assert.doesNotMatch(shown.stdout, /\x1b|\x07/, "no escape sequence reaches the person's terminal");
    assert.match(shown.stdout, /title\?\[2J\?\]0;owned\? <script>alert\(1\)<\/script>/);
    const option = inWs(`git branch -f -- '--upload-pack=touch ${marker}-opt' 2>&1; git branch -f 'ok/../../etc' 2>&1; desolate offer -- '--upload-pack=x' 2>&1; true`);
    assert.doesNotMatch(JSON.stringify(offers()), /upload-pack|\.\.\//);
    assert.equal(pwned(), "0", option.stdout);
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-10-hostile-content");
  });
});

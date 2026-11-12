// T2 (fake backend). Phase 5: offers and pushes, and the root's view of every domain.
// Exit criteria of move-to-vms.md section 13.4, phase 5 (all but `upstream`).
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
let commit = "";
let oid = "";
const vms = new Map<string, string>();
const vmOf = (target: string) => {
  if (!vms.has(target)) {
    const list = JSON.parse(stack.quiet("list", "--json").stdout) as { domain: string; workspaces: { workspace: string; vm: string }[] }[];
    for (const d of list) for (const w of d.workspaces) vms.set(`${d.domain}/${w.workspace}`, w.vm);
  }
  return vms.get(target)!;
};
const inWs = (target: string, script: string) => stack.inVm(vmOf(target), ["bash", "-lc", script]);
const WT = "/workspaces/acme/widgets/.worktrees/issue-12";
const ROOT_CLONE = "/desolate/root/acme/widgets";
const inRootClone = (script: string) => stack.inRoot(["bash", "-c", `export GIT_CONFIG_GLOBAL=/var/lib/desolate-root/gitconfig; cd ${ROOT_CLONE} && ${script}`]);
const forgeRefs = (repo: string) => Object.fromEntries(stack.forge("refs", repo).trim().split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]));
const audit = () => (JSON.parse(stack.inRoot(["node", "--disable-warning=ExperimentalWarning", "/desolate/release/root/rootctl.ts"], { input: JSON.stringify({ op: "keys.audit", args: { last: 500 } }) }).stdout).result as { event: string; repo?: string; ref?: string; commit?: string }[]);
/** One request to the keyring's public socket, made by the root's ordinary user. */
const keyring = (request: Record<string, unknown>) =>
  JSON.parse(stack.inRoot(["node", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", 'import { ask } from "/desolate/release/root/keyring-client.ts"; console.log(JSON.stringify(await ask("/run/desolate/keyring/control.sock", JSON.parse(process.argv[1]))));', JSON.stringify(request)]).stdout) as { ok: boolean; error?: string; message?: string; id?: string };
const forgeHasLfs = (repo: string, id: string) => {
  try {
    stack.forge("lfs-has", repo, id);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("T2 phase 5: offers, the root's view, and pushes", () => {
  before(() => {
    stack = newStack("offers");
    stack.seed("acme/widgets", (dir) => {
      git(dir, "lfs", "install", "--local");
      git(dir, "lfs", "track", "*.bin");
      fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(100_000, 7));
      fs.writeFileSync(path.join(dir, "README.md"), "# widgets\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    stack.seed("acme/consumer", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# consumer\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/widgets").code, 0);
    assert.equal(stack.quiet("clone", "acme/consumer", "--no-push").code, 0);
    assert.equal(stack.quiet("domain", "create", "dev").code, 0);
    assert.equal(stack.quiet("domain", "dev", "add", "--repo", "acme/widgets").code, 0);
    assert.equal(stack.quiet("domain", "dev", "add", "--repo", "acme/consumer").code, 0);
    const up = stack.quiet("up", "dev", "--name", "w1", "--checkout", "acme/widgets=worktree:issue/12");
    assert.equal(up.code, 0, up.stderr);
  });
  after(() => stack.destroy());

  it("an agent finishes: commits, a new LFS file, and `desolate offer`", () => {
    stack.step("offer a branch from a workspace");
    const work = inWs("dev/w1", `cd ${WT} && head -c 50000 /dev/urandom > new.bin && echo 'fix #12' >> README.md && git add -A && git commit -qm 'fix: issue 12' && git rev-parse HEAD && sha256sum new.bin | cut -d' ' -f1`);
    assert.equal(work.code, 0, work.stderr);
    [commit, oid] = work.stdout.trim().split("\n") as [string, string];
    const offered = stack.desolate("exec", "dev/w1", "--checkout", "acme/widgets", "--", "desolate", "offer");
    assert.equal(offered.code, 0, offered.stderr);
    assert.match(offered.stdout, /offered acme\/widgets issue\/12 at [0-9a-f]{12}, with 1 LFS object\(s\)/);
    assert.match(offered.stdout, /Offering is not pushing/);
    const offers = stack.desolate("offers");
    assert.match(offers.stdout, /Needs you:\n {2}dev {2}acme\/widgets {2}issue\/12 {2}[0-9a-f]{12} {2}from w1 {2}1 LFS object/);
    assert.equal(forgeRefs("acme/widgets")["issue/12"], undefined, "offering pushed nothing");
    // And it says so, for the person and for a harness: shown, never acted on.
    assert.equal(inWs("dev/w1", `cd ${WT} && /desolate/status set green "ready: fix for issue 12" && /desolate/status note "touches README only"`).code, 0);
    const status = JSON.parse(stack.quiet("status", "dev/w1", "--json").stdout) as { status: { color: string; message: string } };
    assert.deepEqual([status.status.color, status.status.message], ["green", "ready: fix for issue 12"]);
    assert.match(stack.desolate("board", "dev").stdout, /dev\/w1 {2}\[green\] ready: fix for issue 12\n[\s\S]*\| touches README only/);
    assert.equal(forgeRefs("acme/widgets")["issue/12"], undefined, "saying green pushed nothing either");
  });

  it("the root sees every domain's branches with ordinary git, without an offer", async () => {
    stack.step("the root's view");
    const fetched = inRootClone("git fetch --all --quiet && git branch -r --format='%(refname:short)' && git log -1 --format=%s dev/issue/12 && git remote -v | grep dev");
    assert.equal(fetched.code, 0, fetched.stderr);
    assert.match(fetched.stdout, /^dev\/issue\/12$/m);
    assert.match(fetched.stdout, /^dev\/main$/m);
    assert.match(fetched.stdout, /^fix: issue 12$/m);
    assert.match(fetched.stdout, /desolate::dev/);
    // A branch nobody offered arrives too: the workspace's daemon writes it out on its own.
    inWs("dev/w1", `cd ${WT} && git branch experiment && git commit -q --allow-empty -m wip`);
    let seen = false;
    for (let waited = 0; waited < 15_000 && !seen; waited += 1000) {
      await sleep(1000);
      seen = /^dev\/experiment$/m.test(inRootClone("git fetch dev --quiet; git branch -r --format='%(refname:short)'").stdout);
    }
    assert.ok(seen, "an unoffered branch reaches the root's view within seconds");
    // The amended tip: the offer names the commit that was offered, and the branch moved on.
    commit = inWs("dev/w1", `cd ${WT} && git reset -q --hard HEAD~1 && git rev-parse HEAD`).stdout.trim();
    stack.quiet("exec", "dev/w1", "--", "desolate", "sync");
  });

  it("review shows what a push would send", () => {
    stack.step("review");
    const text = stack.desolate("review", "dev", "acme/widgets", "issue/12");
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /a push would send 1 commit\(s\): 2 files changed.*, and 1 LFS object\(s\) first/);
    assert.match(text.stdout, new RegExp(`to push exactly this: desolate push dev acme/widgets issue/12 --expect ${commit}`));
    const json = JSON.parse(stack.quiet("review", "dev", "acme/widgets", "issue/12", "--json").stdout) as { commit: string; files: string[]; pushable: boolean };
    assert.equal(json.commit, commit);
    assert.deepEqual(json.files.sort(), ["README.md", "new.bin"]);
  });

  it("a push is impossible without a person: every automation path is tried, and refused", () => {
    stack.step("automation tries to push");
    // 1. The CLI, driven by a script: no terminal.
    const cli = stack.desolate("push", "dev", "acme/widgets", "issue/12", "--expect", commit);
    assert.equal(cli.code, 78);
    assert.match(cli.stderr, /there is no terminal to ask on/);
    assert.match(cli.stderr, /no person confirmed the push, so nothing was pushed/);
    // 2. Raw git in the root clone: it asks for an approval on the host, none comes, it gives up.
    const raw = inRootClone(`DESOLATE_APPROVAL_WAIT_MS=1500 git push origin ${commit}:refs/heads/issue/12 2>&1`);
    assert.notEqual(raw.code, 0);
    assert.match(raw.stdout, /needs your approval, given on the host, outside this VM/);
    assert.match(raw.stdout, /no person approved the push on the host, so nothing was pushed/);
    // 3. Skipping desolate's hook: straight to the remote's own address, around desolate's
    //    helper and its hook. This user has no way to a write key at all (the pusher does).
    const noVerify = inRootClone(`git push --no-verify "$(git config lfs.pushurl)" ${commit}:refs/heads/issue/12 2>&1`);
    assert.notEqual(noVerify.code, 0);
    assert.match(inRootClone("git config remote.origin.pushurl; git config lfs.pushurl").stdout, /^desolate-push::acme\/widgets\nssh:\/\//, "control: that address is the remote's");
    assert.match(noVerify.stdout, /Permission denied|agent refused|signing failed|Host key verification failed|Could not read from remote/i);
    // 4. Skipping the LFS-first rule changes nothing either.
    assert.notEqual(inRootClone(`git lfs push origin --object-id ${oid} 2>&1`).code, 0);
    // 5. Approving it from inside the root VM. Anyone there may ask the keyring for a
    //    challenge; answering takes the host approver's key, which is not in the VM.
    const challenge = keyring({ op: "challenge", repo: "acme/widgets", ref: "issue/12", commit });
    assert.equal(challenge.ok, true, String(challenge.error));
    assert.match(challenge.message!, new RegExp(`^desolate push approval v2\\nrepo: acme/widgets\\nbranch: issue/12\\ncommit: ${commit}\\nonto: none\\nnonce: [0-9a-f]{32}\\n$`));
    const own = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    const forged = keyring({ op: "approve", message: challenge.message, signature: sign("sha256", Buffer.from(challenge.message!), own).toString("base64") });
    assert.equal(forged.ok, false);
    assert.match(forged.error!, /signature is not the host approver's/);
    assert.equal(keyring({ op: "approve", message: challenge.message, signature: "" }).ok, false, "no signature");
    assert.equal(keyring({ op: "approve", repo: "acme/widgets", ref: "issue/12", commit }).ok, false, "v3's first protocol, with no signature at all");
    //    Swapping in a key of its own: the installed key is root's alone to write.
    const swap = stack.inRoot(["bash", "-c", "echo x > /etc/desolate/approver.pub; echo x > /etc/desolate/other; sudo -n true; ls -ld /etc/desolate /etc/desolate/approver.pub"]);
    assert.match(swap.stderr, /approver\.pub: Permission denied/);
    assert.match(swap.stdout, /^drwxr-xr-x \d+ root root .*\n-rw-r--r-- \d+ root root /);
    //    The write agent's own question ("is there an approval?") is not answerable from outside it.
    assert.notEqual(stack.inRoot(["bash", "-c", `echo '{"op":"consume","repo":"acme/widgets"}' | socat - UNIX-CONNECT:/run/desolate/keyring/internal.sock`]).code, 0);
    // 6. Reaching the write agent at all: its directory is the keyring's and the pusher's.
    const agent = stack.inRoot(["bash", "-c", "ls /run/desolate/keyring-write 2>&1; SSH_AUTH_SOCK=/run/desolate/keyring-write/write-agent.sock ssh-add -l 2>&1; ls -ld /run/desolate/keyring-write"]);
    assert.match(agent.stdout, /cannot open directory '\/run\/desolate\/keyring-write': Permission denied/);
    assert.match(agent.stdout, /Error connecting to agent: Permission denied/);
    assert.match(agent.stdout, /^drwxr-x--- \d+ desolate-keyring desolate-pusher /m, "control: it is there, and whose it is");
    // 7. Asking the pusher to push with no approval, or with one made up.
    const pusher = (request: Record<string, unknown>) =>
      JSON.parse(stack.inRoot(["node", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", 'import { ask } from "/desolate/release/root/keyring-client.ts"; console.log(JSON.stringify(await ask("/run/desolate/pusher/control.sock", JSON.parse(process.argv[1]), 30000)));', JSON.stringify(request)]).stdout) as { ok: boolean; error?: string };
    const madeUp = pusher({ op: "push", approval: "lzz-000000000000", bundle: 0, lfs: [] });
    assert.equal(madeUp.ok, false);
    assert.match(madeUp.error!, /holds no live approval/);
    // The outcome: the remote has nothing, and the audit shows refusals and no signature.
    assert.equal(forgeRefs("acme/widgets")["issue/12"], undefined, "nothing reached the remote");
    assert.equal(forgeHasLfs("acme/widgets", oid), false, "nor its LFS object");
    const entries = audit();
    assert.ok(entries.some((e) => e.event === "refused" && e.repo === "acme/widgets"), "the write key's refused uses are audited");
    assert.equal(entries.filter((e) => e.event === "signed" || e.event === "approved").length, 0, "no approval was filed and nothing was signed");
    // CONTROL: the same request, signed with the approver's key (which this test, being on
    // the host, can read: the terminal approver's documented limit), IS accepted. So the
    // refusals above are about whose key signed, not about the request being malformed.
    const hostKey = createPrivateKey(fs.readFileSync(path.join(stack.home, "approver", "key"), "utf8"));
    const signature = sign("sha256", Buffer.from(challenge.message!), hostKey).toString("base64");
    const real = keyring({ op: "approve", message: challenge.message, signature });
    assert.equal(real.ok, true, String(real.error));
    // A signature approves once: replayed, the challenge is no longer outstanding.
    const replay = keyring({ op: "approve", message: challenge.message, signature });
    assert.equal(replay.ok, false);
    assert.match(replay.error!, /not outstanding/);
    // The audit's F6, with a real approval live: the root's user, as if a bug in what it
    // parses had given it to an attacker, hands the pusher that approval's id and ANOTHER
    // commit's pack (the default branch's). The pusher reads none of it: it asks the forge
    // for the approved update, and the forge, given no such commit, refuses it.
    const before = forgeRefs("acme/widgets");
    const other = inRootClone("git rev-parse main").stdout.trim();
    const swapped = stack.inRoot(["node", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e",
      'import { send } from "/desolate/release/root/send.ts"; console.log(JSON.stringify(await send({ owner: "acme", name: "widgets" }, process.argv[1], process.argv[2])));', real.id!, other]);
    assert.match(swapped.stdout, /the forge (refused the update|could not unpack)/, swapped.stdout + swapped.stderr);
    assert.deepEqual(forgeRefs("acme/widgets"), before, "no ref of the remote moved, and none appeared");
    assert.equal(audit().pop()?.event, "revoked", "and the approval it tried to use is spent");
    assert.equal(keyring({ op: "revoke", id: real.id }).ok, true);
  });

  it("refusals that need no person: --expect, the default branch, a terminal answer that is not the branch", () => {
    stack.step("refusals before and at the prompt");
    const moved = stack.desolate("push", "dev", "acme/widgets", "issue/12", "--expect", "0".repeat(40));
    assert.equal(moved.code, 79);
    assert.match(moved.stderr, /it moved since/);
    const none = stack.desolate("push", "dev", "acme/widgets", "issue/12");
    assert.equal(none.code, 64);
    const main = JSON.parse(stack.quiet("review", "dev", "acme/widgets", "main", "--json").stdout) as { commit: string };
    const def = stack.desolate("push", "dev", "acme/widgets", "main", "--expect", main.commit);
    assert.equal(def.code, 77);
    assert.match(def.stderr, /fix: push a branch and open a pull request; or, to push the default branch itself, add --allow-default/);
    const wrong = stack.person("Type the branch name", "yes", "push", "dev", "acme/widgets", "issue/12", "--expect", commit);
    assert.equal(wrong.code, 78, "a 'yes' is not the branch name");
    assert.equal(forgeRefs("acme/widgets")["issue/12"], undefined);
  });

  it("a person pushes: the prompt names repository, branch and commit; LFS objects go first", () => {
    stack.step("a person pushes");
    const pushed = stack.person("Type the branch name", "issue/12", "push", "dev", "acme/widgets", "issue/12", "--expect", commit);
    assert.equal(pushed.code, 0, pushed.stdout);
    assert.match(pushed.stdout, /this push needs your confirmation\.\s+repository {2}acme\/widgets\s+branch {6}issue\/12\s+commit {6}[0-9a-f]{40}/);
    assert.match(pushed.stdout, /pushed acme\/widgets issue\/12 at [0-9a-f]{40} \(1 commit\(s\), 1 LFS object\(s\) first\)/);
    assert.equal(forgeRefs("acme/widgets")["issue/12"], commit, "the remote has exactly the reviewed commit");
    assert.equal(forgeHasLfs("acme/widgets", oid), true, "the remote serves the new LFS object");
    const access = JSON.parse(stack.forge("access")) as { key?: string; command?: string; lfs?: string }[];
    // (The last of each: the refused attempt above also reached receive-pack.)
    const upload = access.map((e) => e.lfs === "upload").lastIndexOf(true);
    const receive = access.map((e) => /git-receive-pack/.test(e.command ?? "")).lastIndexOf(true);
    assert.ok(upload >= 0 && receive > upload, "the LFS object was uploaded before the commit was pushed");
    assert.ok(access.filter((e) => /receive-pack|upload$/.test(e.command ?? "")).every((e) => e.key === "write:acme/widgets"), "writes used the write key");
    const entries = audit();
    const approved = entries.filter((e) => e.event === "approved").pop();
    assert.deepEqual([approved?.repo, approved?.ref, approved?.commit], ["acme/widgets", "issue/12", commit], "the approval names what was pushed");
    assert.ok(entries.some((e) => e.event === "signed"), "each use of the write key is audited");
    assert.ok(entries.some((e) => e.event === "revoked"), "the approval did not outlive the push");
    assert.doesNotMatch(stack.desolate("offers").stdout, /issue\/12/, "the offer is no longer waiting");
    // The mirror followed: every clone's origin/* now has the branch.
    assert.equal(inWs("dev/w1", "cd /workspaces/acme/widgets && git fetch -q origin && git rev-parse origin/issue/12").stdout.trim(), commit);
    // And the approval is spent: the same push again, by a script, is refused.
    assert.notEqual(inRootClone(`git push --no-verify "$(git config lfs.pushurl)" ${commit}:refs/heads/again 2>&1`).code, 0);
    assert.equal(forgeRefs("acme/widgets")["again"], undefined);
  });

  it("a raw git push in the root's terminal waits for `desolate approve` on the host", async () => {
    stack.step("a raw git push, approved on the host");
    assert.match(stack.desolate("approve").stdout, /nothing is waiting for approval/);
    // The person's `git push` in the root shell, left running as it would be in their terminal.
    inRootClone(`setsid nohup git push origin ${commit}:refs/heads/raw-push >/tmp/raw-push.log 2>&1 </dev/null & sleep 0.2`);
    let waiting = false;
    for (let i = 0; i < 40 && !waiting; i++) {
      waiting = /waiting up to/.test(inRootClone("cat /tmp/raw-push.log").stdout);
      if (!waiting) await sleep(250);
    }
    assert.ok(waiting, "the push is waiting for the host");
    // A script on the host cannot answer it either: no terminal.
    assert.equal(stack.desolate("approve").code, 78);
    assert.equal(forgeRefs("acme/widgets")["raw-push"], undefined);
    const approved = stack.person("Type the branch name", "raw-push", "approve");
    assert.equal(approved.code, 0, approved.stdout);
    assert.match(approved.stdout, /repository {2}acme\/widgets\s+branch {6}raw-push\s+commit {6}[0-9a-f]{40}\s+onto {8}none: the remote has no raw-push yet\s+sends {7}a raw git push from the root's terminal/);
    let landed = false;
    for (let i = 0; i < 80 && !landed; i++) {
      landed = forgeRefs("acme/widgets")["raw-push"] === commit;
      if (!landed) await sleep(250);
    }
    assert.ok(landed, inRootClone("cat /tmp/raw-push.log").stdout);
    const entries = audit();
    const last = entries.filter((e) => e.event === "approved").pop();
    assert.deepEqual([last?.repo, last?.ref, last?.commit], ["acme/widgets", "raw-push", commit]);
    assert.equal(entries.pop()?.event, "revoked", "the approval did not outlive the push");
    // The default branch is not pushed this way, approved or not; and nothing is deleted.
    const def = inRootClone(`DESOLATE_APPROVAL_WAIT_MS=1500 git push origin ${commit}:refs/heads/main 2>&1`);
    assert.match(def.stdout, /main is the default branch/);
    assert.match(inRootClone("DESOLATE_APPROVAL_WAIT_MS=1500 git push origin :refs/heads/raw-push 2>&1").stdout, /deleting a branch on the remote is not something desolate does/);
    assert.equal(forgeRefs("acme/widgets")["raw-push"], commit);
  });

  it("a repository cloned --no-push is never written: there is no key to write it with", () => {
    stack.step("a repository the root cannot push");
    inWs("dev/w1", "cd /workspaces/acme/consumer && git checkout -q -b tweak && echo x >> README.md && git commit -qam tweak");
    assert.equal(stack.quiet("exec", "dev/w1", "--checkout", "acme/consumer", "--", "desolate", "offer").code, 0);
    const review = JSON.parse(stack.quiet("review", "dev", "acme/consumer", "tweak", "--json").stdout) as { commit: string; pushable: boolean };
    assert.equal(review.pushable, false);
    const pushed = stack.person("Type the branch name", "tweak", "push", "dev", "acme/consumer", "tweak", "--expect", review.commit);
    assert.equal(pushed.code, 1);
    assert.match(pushed.stdout, /is not pushable: the root holds no write key for it/);
    assert.equal(inRootClone("cd /desolate/root/acme/consumer && git push --no-verify origin HEAD:refs/heads/x 2>&1").code === 0, false);
    const mirrorRefs = stack.inRoot(["bash", "-c", "git -C /desolate/mirrors/acme/consumer.git for-each-ref --format='%(refname)'"]).stdout.trim();
    assert.equal(mirrorRefs, "refs/heads/main", "nothing was pushed into the mirror either");
    const pushes = JSON.parse(stack.forge("pushes")) as { repo: string }[];
    assert.ok(pushes.every((p) => p.repo !== "acme/consumer"), "the consumer's remote was never written");
    assert.ok(pushes.some((p) => p.repo === "acme/widgets"), "control: the forge does log pushes");
  });

  it("the root never runs git in a domain's repository: a booby-trapped clone and a lying outbox", () => {
    stack.step("a hostile domain repository");
    // The trap: config and hooks in the domain clone that run a command when git works there.
    const trap = inWs("dev/w1", `cd /workspaces/acme/widgets && git config core.fsmonitor 'touch /tmp/PWNED-fsmonitor; false' && git config uploadpack.packObjectsHook 'touch /tmp/PWNED-uploadpack; cat' && git config core.hooksPath /workspaces/acme/widgets/.git/trap-hooks && mkdir -p .git/trap-hooks && for h in post-checkout reference-transaction pre-auto-gc post-index-change; do printf '#!/bin/sh\\ntouch /tmp/PWNED-hook\\n' > .git/trap-hooks/$h; chmod +x .git/trap-hooks/$h; done && git status >/dev/null 2>&1; ls /tmp/PWNED-*`);
    assert.match(trap.stdout, /PWNED-fsmonitor/, "control: the trap fires when git runs in the domain clone (here, in its own workspace)");
    // Then everything the root does with this domain.
    inWs("dev/w1", `cd ${WT} && echo more >> README.md && git commit -qam 'more' && desolate offer`);
    assert.equal(inRootClone("git fetch --all --quiet && git log -1 --format=%s dev/issue/12").stdout.trim(), "more");
    assert.equal(stack.quiet("review", "dev", "acme/widgets", "issue/12").code, 0);
    stack.quiet("push", "dev", "acme/widgets", "issue/12", "--expect", "0".repeat(40));
    const rootTmp = stack.inRoot(["bash", "-c", "ls /tmp/PWNED-* 2>/dev/null; true"], { root: true });
    assert.equal(rootTmp.stdout.trim(), "", "nothing from the domain's config or hooks ran in the root");
    // A lying outbox: ref names that are paths or options, a commit that is not one, a
    // bundle that is a symlink out of the outbox.
    inWs("dev/w1", "pkill -f wsd.ts; true");
    const sync = path.join(stack.home, "domains/dev/outbox/sync/acme/widgets");
    const good = commit;
    fs.writeFileSync(path.join(sync, "refs.json"), JSON.stringify({ refs: { "../../../etc/evil": good, "-oProxyCommand=evil": good, "ok/../../x": good, "notasha": "zz", "honest": good, "refs/heads/double": good } }));
    fs.symlinkSync("/etc/passwd", path.join(sync, "zz-evil.bundle"));
    fs.writeFileSync(path.join(sync, "zy-garbage.bundle"), "this is not a bundle");
    const lied = inRootClone("git fetch dev 2>&1; git for-each-ref --format='%(refname)' refs/remotes/dev refs/desolate; ls /desolate/root/acme/widgets/.git/refs/remotes/dev");
    assert.match(lied.stdout, /^refs\/remotes\/dev\/honest$/m, "control: a well-formed ref from the same list is accepted");
    assert.doesNotMatch(lied.stdout, /evil|notasha|ProxyCommand|refs\/desolate/);
    // The root removes what it finds by NAME, in the directory it checked: the link goes,
    // what it pointed at is never opened, and the person is told something was dropped.
    assert.match(lied.stdout, /2 file\(s\) in dev's outbox were not plain bundle files and were dropped|was refused and dropped/, lied.stdout);
    assert.ok(!fs.existsSync(path.join(sync, "zz-evil.bundle")) && fs.lstatSync(path.join(sync, "zz-evil.bundle"), { throwIfNoEntry: false }) === undefined, "the link itself is gone from the outbox");
    assert.match(stack.inRoot(["bash", "-c", "head -c 5 /etc/passwd; stat -c %h /etc/passwd"], { root: true }).stdout, /^root:1\n$/, "and what it pointed at is as it was");
  });

  it("a person moves work between domains through the root: git push <domain> delivers", () => {
    stack.step("a delivery to another domain");
    assert.equal(stack.quiet("domain", "create", "other").code, 0);
    assert.equal(stack.quiet("domain", "other", "add", "--repo", "acme/widgets").code, 0);
    assert.equal(stack.quiet("up", "other", "--name", "w1").code, 0);
    const delivered = inRootClone(`git push other ${commit}:refs/heads/fix-from-dev 2>&1`);
    assert.equal(delivered.code, 0, delivered.stdout);
    // The workspace's daemon may import it first; either way it is there after a fetch.
    const got = stack.quiet("exec", "other/w1", "--", "desolate", "fetch", "acme/widgets");
    assert.equal(got.code, 0, got.stderr);
    const there = inWs("other/w1", "cd /workspaces/acme/widgets && git rev-parse refs/remotes/root/fix-from-dev && git branch --format='%(refname:short)'");
    assert.equal(there.stdout.split("\n")[0], commit);
    assert.deepEqual(there.stdout.trim().split("\n").slice(1), ["main"], "it arrived as root/<branch>, not over a branch of the domain's own");
    assert.equal(forgeRefs("acme/widgets")["fix-from-dev"], undefined, "a delivery is a local transfer: the remote was not written");
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-04-offers");
  });
});

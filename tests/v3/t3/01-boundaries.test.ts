// T3 (qemu backend: real VMs, under KVM or TCG) and T4 (vz, on a Mac: DESOLATE_TIER=T4).
// The boundaries that need a real VM
// (move-to-vms.md section 13.2): read-only shares against root inside the VM, forced egress
// with root inside the VM, and no cross-domain path. Every negative check sits beside a
// control that shows it would have caught the failure.
//
// Run: tests/v3/run.sh t3   (tens of minutes under TCG: each VM takes minutes to boot)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack, REPO_ROOT } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
let listener: ChildProcess;
let port = 0;
const REAL = process.env.DESOLATE_TIER === "T3" || process.env.DESOLATE_TIER === "T4";
const vms = new Map<string, string>();
const vmOf = (target: string) => {
  if (!vms.has(target)) {
    const list = JSON.parse(stack.quiet("list", "--json").stdout) as { domain: string; workspaces: { workspace: string; vm: string }[] }[];
    for (const d of list) for (const w of d.workspaces) vms.set(`${d.domain}/${w.workspace}`, w.vm);
  }
  return vms.get(target)!;
};
const asRoot = (target: string, script: string) => stack.inVm(vmOf(target), ["bash", "-c", script], { root: true });
const asUser = (target: string, script: string) => stack.inVm(vmOf(target), ["bash", "-c", script]);
const lines = (text: string) => Object.fromEntries(text.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));

describe("T3: boundaries that need a real VM", { skip: REAL ? false : "set DESOLATE_TIER=T3 (tests/v3/run.sh t3), or T4 on a Mac" }, () => {
  before(async () => {
    stack = newStack("t3");
    stack.seed("acme/widgets", (dir) => {
      git(dir, "lfs", "install", "--local");
      git(dir, "lfs", "track", "*.bin");
      fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(50_000, 7));
      fs.writeFileSync(path.join(dir, "README.md"), "# widgets\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    // Something on the host for a VM to try to reach: on every address, so that only the
    // VM's own confinement can be what stops it. In a process of its own: this one blocks
    // while a command runs in a VM, and a listener that cannot answer proves nothing.
    listener = spawn(process.execPath, ["-e", `const s = require("http").createServer((q, r) => r.end("the-host-answered\\n")); s.listen(0, "0.0.0.0", () => console.log(s.address().port));`], { stdio: ["ignore", "pipe", "ignore"] });
    port = await new Promise<number>((resolve) => listener.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
  });
  after(() => {
    listener?.kill();
    stack?.destroy();
  });

  it("T3 bootstrap on real VMs: isolated, and doctor passes", () => {
    stack.step(`bootstrap on the ${stack.backend} backend`);
    const result = bootstrap(stack);
    assert.equal(result.code, 0, result.stderr + result.stdout.slice(-1500));
    assert.doesNotMatch(result.stdout, /NOT ISOLATED/);
    assert.match(result.stdout, new RegExp(`ok {3}backend gives isolation: ${stack.backend}`));
    assert.match(result.stdout, /doctor: all checks passed/);
  });

  it("T3 a repository, a domain, and a workspace in its own VM", () => {
    stack.step("clone, domain, workspace");
    const cloned = stack.desolate("clone", "acme/widgets");
    assert.equal(cloned.code, 0, cloned.stderr);
    assert.equal(stack.desolate("domain", "create", "a").code, 0);
    assert.equal(stack.desolate("domain", "a", "add", "--repo", "acme/widgets").code, 0);
    const up = stack.desolate("up", "a");
    assert.equal(up.code, 0, up.stderr);
    assert.doesNotMatch(up.stdout, /NOT ISOLATED/);
    const work = asUser("a/w1", "cd /workspaces/acme/widgets && git count-objects -v | head -1 && stat -c %s big.bin && git fetch origin && echo x >> README.md && git commit -qam change && git log --oneline | wc -l");
    assert.equal(work.code, 0, work.stderr);
    assert.deepEqual(work.stdout.trim().split("\n"), ["count: 0", "50000", "2"], "the domain clone borrows the mirror over the read-only share; LFS checked out; a commit works");
  });

  it("T3 read-only shares hold against root inside the VM", () => {
    stack.step("root in the VM against the read-only shares");
    const result = asRoot("a/w1", `
      touch /workspaces/planted-control && echo control_write=ok
      for target in /desolate/mirrors/acme/widgets.git /desolate/inbox /desolate/release; do
        n=$(basename $target)
        touch $target/planted-plain 2>/dev/null && echo "plain_$n=WROTE" || echo "plain_$n=refused"
        mount -o remount,rw $target 2>/dev/null; echo "remount_$n=$?"
        touch $target/planted-remount 2>/dev/null && echo "after_remount_$n=WROTE" || echo "after_remount_$n=refused"
      done
      echo x >> /desolate/mirrors/acme/widgets.git/HEAD 2>/dev/null && echo append_head=WROTE || echo append_head=refused
      mkdir -p /mnt/again
      for tag in $(awk '$3=="9p" || $3=="virtiofs" {print $1}' /proc/mounts | sort -u); do
        type=$(awk -v t=$tag '$1==t {print $3; exit}' /proc/mounts)
        opts=$([ $type = 9p ] && echo trans=virtio,version=9p2000.L,rw || echo rw)
        if mount -t $type -o $opts $tag /mnt/again 2>/dev/null; then
          touch /mnt/again/planted-fresh-mount 2>/dev/null && echo "fresh_$tag=WROTE" || echo "fresh_$tag=refused"
          umount /mnt/again
        else echo "fresh_$tag=nomount"; fi
      done
      awk '$3=="9p" || $3=="virtiofs" {print "share_" $1 "=" $2}' /proc/mounts`);
    const got = lines(result.stdout);
    assert.equal(got.control_write, "ok", "control: root can write the share it is given read-write");
    for (const name of ["widgets.git", "inbox", "release"]) {
      assert.equal(got[`plain_${name}`], "refused", `a plain write to ${name}`);
      assert.equal(got[`after_remount_${name}`], "refused", `a write to ${name} after mount -o remount,rw (remount exit ${got[`remount_${name}`]})`);
    }
    assert.equal(got.append_head, "refused");
    // Mounting each share afresh, read-write. Where the transport allows a second mount
    // (virtiofs does; 9p mounts a share once per guest, and says "nomount"), the writable
    // share takes the write, which shows the attempt works; a read-only one never does.
    const tagOf = (mountPoint: string) => Object.entries(got).find(([key, value]) => key.startsWith("share_") && value === mountPoint)![0].slice(6);
    assert.match(got[`fresh_${tagOf("/workspaces")}`] ?? "", /^(WROTE|nomount)$/, "the writable share, mounted afresh");
    for (const mountPoint of ["/desolate/mirrors/acme/widgets.git", "/desolate/inbox", "/desolate/release"])
      assert.notEqual(got[`fresh_${tagOf(mountPoint)}`], "WROTE", `a fresh read-write mount of ${mountPoint} must not take a write`);
    // What the host sees is what counts.
    const planted = (dir: string) => fs.readdirSync(dir).filter((name) => name.startsWith("planted"));
    assert.deepEqual(planted(path.join(stack.home, "mirrors/acme/widgets.git")), [], "nothing was planted in the mirror");
    assert.deepEqual(planted(path.join(stack.home, "domains/a/inbox")), [], "nor in the inbox");
    assert.ok(planted(path.join(stack.home, "domains/a/repos")).includes("planted-control"), "control: a write through the writable share did land on the host, so the empty lists above mean something");
    assert.equal(fs.readFileSync(path.join(stack.home, "mirrors/acme/widgets.git/HEAD"), "utf8").trim(), "ref: refs/heads/main");
  });

  it("T3 the one way out is the workspace's proxy, and it is attributed", () => {
    stack.step("out through the proxy");
    const forge = stack.env.DESOLATE_FORGE_SPEC!.replace(/^.*@/, "").replace(/:\d+$/, "");
    assert.equal(stack.inRoot(["bash", "-c", `printf '%s api.example.test\\n127.0.0.1 loop.example.test\\n' ${forge} >> /etc/hosts`], { root: true }).code, 0);
    const refused = asUser("a/w1", "curl -sS -m 60 http://api.example.test/t3 2>&1");
    assert.match(refused.stdout, /resolves to an internal address/, "control: the same request is refused before the address is allowed");
    assert.equal(stack.desolate("domain", "a", "net", "allow-internal", forge).code, 0);
    const reached = asUser("a/w1", "curl -sS -m 60 http://api.example.test/t3 2>&1; curl -sS -m 60 http://loop.example.test/ 2>&1");
    assert.match(reached.stdout, /upstream http host=api\.example\.test path=\/t3/, "a plain program in the VM reaches an allowed host: through QEMU's guestfwd, the link, and the proxy in the root VM");
    assert.match(reached.stdout, /loop\.example\.test resolves to an internal address \(127\.0\.0\.1\)/);
    const log = JSON.parse(stack.quiet("net", "log", "a", "--json").stdout) as { domain: string; workspace: string; host: string; verdict: string }[];
    assert.ok(log.some((e) => e.domain === "a" && e.workspace === "w1" && e.host === "api.example.test" && e.verdict === "allowed"));
  });

  it("T3 work crosses from a real VM as checked data: an honest offer is taken, a dangerous tree is refused whole, the outbox cannot point the root at its own files", () => {
    stack.step("an offer, and hostile content, over a real share");
    // The root's handling of an outbox leans on what the kernel says about an open
    // directory on the SHARE's filesystem (9p here, virtiofs on a Mac). T2 has the full
    // set of attacks on bind mounts; this is the same route on the real thing.
    const ws = (script: string, root = false) => stack.inVm(vmOf("a/w1"), ["bash", "-lc", `cd /workspaces/acme/widgets && ${script}`], { root });
    const offers = () => JSON.parse(stack.quiet("offers", "--json").stdout) as { branch: string; commit: string }[];
    const honest = ws("git checkout -q -b offered && echo y >> README.md && git commit -qam 'an honest change' && desolate offer 2>&1 && /desolate/status set green 'ready: offered' && git rev-parse HEAD");
    assert.equal(honest.code, 0, honest.stdout + honest.stderr);
    const tip = honest.stdout.trim().split("\n").pop()!;
    assert.ok(offers().some((o) => o.branch === "offered" && o.commit === tip), "control: an honest branch is taken, bundle and all");
    const shown = stack.desolate("review", "a", "acme/widgets", "offered", "--diff");
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^\+y$/m, "and its diff is read in the root");
    assert.match(stack.quiet("status", "a/w1", "--json").stdout, /"color":"green"/, "its status is read through the share");

    // A tree with .git in it, made with plumbing (git's own commands refuse to).
    const hostile = ws(`git checkout -q -f main && b=$(echo x | git hash-object -w --stdin) && inner=$(printf '100644 blob %s\\tconfig\\n' $b | git mktree) && t=$(printf '040000 tree %s\\t.git\\n' $inner | git mktree --missing) && c=$(git commit-tree -m hostile -p HEAD $t) && git branch -f hostile $c && desolate offer acme/widgets hostile 2>&1`);
    assert.notEqual(hostile.code, 0, hostile.stdout);
    assert.match(hostile.stdout + hostile.stderr, /the root refused this domain's bundle of acme\/widgets: .*hasDotgit/, hostile.stdout + hostile.stderr);
    assert.ok(!offers().some((o) => o.branch === "hostile"));
    assert.match(stack.quiet("offers").stdout, /Refused from a \(acme\/widgets/);

    // The outbox, as root in the VM: the repository's sync directory becomes a link to the
    // root's own state, where a file with a bundle's name waits to be "tidied".
    assert.equal(stack.inRoot(["bash", "-c", "echo the-roots-own > /var/lib/desolate/canary.bundle"]).code, 0);
    const planted = ws("git branch -D hostile >/dev/null; cd /desolate/outbox && rm -rf sync/acme/widgets && ln -s /var/lib/desolate sync/acme/widgets && readlink sync/acme/widgets", true);
    assert.equal(planted.stdout.trim(), "/var/lib/desolate", planted.stderr);
    stack.inRoot(["bash", "-c", "export GIT_CONFIG_GLOBAL=/var/lib/desolate-root/gitconfig; cd /desolate/root/acme/widgets && git fetch a 2>&1; true"]);
    assert.equal(stack.inRoot(["cat", "/var/lib/desolate/canary.bundle"]).stdout, "the-roots-own\n", "nothing of the root's was removed through the domain's link");
    // Put back, and with the dangerous branch gone, the domain's work flows again.
    ws("rm -f /desolate/outbox/sync/acme/widgets", true);
    const again = ws("git checkout -q offered && echo z >> README.md && git commit -qam 'after' && desolate offer 2>&1 && git rev-parse HEAD");
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.ok(offers().some((o) => o.branch === "offered" && o.commit === again.stdout.trim().split("\n").pop()), "control: the same route works for honest work afterwards");
    assert.doesNotMatch(stack.quiet("offers").stdout, /Refused from/);
    stack.inRoot(["rm", "-f", "/var/lib/desolate/canary.bundle"]);
    // None of this ended the root's own services. (It once did: the state service watched
    // a tree in which git's quarantine came and went, on real VMs only. release/docs/incidents.md.)
    assert.equal(stack.inRoot(["bash", "-c", "cat /var/lib/desolate/stated.log /var/lib/desolate/rootd.log | grep -c 'starting it again'; true"]).stdout.trim(), "0", "the state service and rootd ran throughout");
  });

  it("T3 the editor runs inside the workspace's VM and answers at its own hostname", async () => {
    stack.step("the editor, in a real VM");
    const shown = stack.desolate("editor", "a/w1");
    assert.equal(shown.code, 0, shown.stderr);
    const url = new URL(shown.stdout.trim());
    const ask = (host: string, cookie: string): Promise<string> =>
      new Promise((resolve) => {
        const socket = net.connect(Number(url.port), "127.0.0.1");
        let data = "";
        socket.setTimeout(120_000, () => socket.destroy());
        socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: ${host}:${url.port}\r\nCookie: vscode-tkn=${cookie}\r\nConnection: close\r\n\r\n`));
        socket.on("data", (chunk) => (data += chunk));
        socket.on("close", () => resolve(data));
        socket.on("error", () => resolve(data || "ERROR"));
      });
    const token = url.searchParams.get("tkn")!;
    const page = await ask(url.hostname, token);
    assert.match(page, /^HTTP\/1\.1 200 /, page.slice(0, 300));
    assert.match(page, /vs\/code\/browser\/workbench\/workbench\.js/, "VSCodium's workbench, served from inside the VM through the forwarder and the gate");
    assert.match(await ask(url.hostname, "0".repeat(48)), /^HTTP\/1\.1 403 /, "control: the editor itself refuses a wrong token");
    assert.match(await ask(url.hostname.replace("-editor-", "-"), token), /^HTTP\/1\.1 421 /, "the dev-server name does not reach the editor");
    const inside = asRoot("a/w1", "ss -ltnH | grep -E ':(31580|31581) ' | awk '{print $4}' | sort");
    assert.deepEqual(inside.stdout.trim().split("\n"), ["127.0.0.1:31580", "127.0.0.1:31581"], "both on the VM's loopback only");
    // The dashboard, from the root VM, through the same port by its own name: the host's
    // daemon has told the root's state service which VMs run and where this editor is.
    // With the dashboard's own credential, as the browser `desolate ui` was opened in has it.
    const ui = new URL((JSON.parse(stack.quiet("ui", "--json").stdout) as { dashboard: string }).dashboard).searchParams.get("tkn")!;
    const uiCookie = `desolate_ui_${createHash("sha256").update(ui).digest("hex").slice(0, 12)}=${ui}`;
    let seen = "";
    for (let i = 0; i < 40 && !/"status":"running"/.test(seen); i++) {
      seen = await new Promise<string>((resolve) => {
        const socket = net.connect(Number(url.port), "127.0.0.1");
        let data = "";
        socket.setTimeout(120_000, () => socket.destroy());
        socket.on("connect", () => socket.write(`GET /state HTTP/1.1\r\nHost: desolate.localhost:${url.port}\r\nCookie: ${uiCookie}\r\nConnection: close\r\n\r\n`));
        socket.on("data", (chunk) => (data += chunk));
        socket.on("close", () => resolve(data));
        socket.on("error", () => resolve(data || "ERROR"));
      });
      if (!/"status":"running"/.test(seen)) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    assert.match(seen, /^HTTP\/1\.1 200 /, seen.slice(0, 200));
    assert.match(seen, new RegExp(`"stack":\\{[^}]*"backend":"${stack.backend}","isolated":true`));
    assert.match(seen, new RegExp(`"workspace":"w1"[^\\]]*\\][^{]*\\{[\\s\\S]*"status":"running"[\\s\\S]*"editor":"http://${url.hostname}:${url.port}/\\?tkn=${token}`), "the dashboard knows the workspace is running, and its editor's address");
  });

  it("T3 a secret is substituted on the way out of a real VM, and its value stays in the root", () => {
    stack.step("a secret, in a real VM");
    const crt = fs.readFileSync(path.join(stack.work, "forge-state", "upstream.crt"), "utf8");
    assert.equal(stack.inRoot(["bash", "-c", "cat > /usr/local/share/ca-certificates/test-upstream.crt && update-ca-certificates >/dev/null 2>&1"], { root: true, input: crt }).code, 0);
    const set = spawnSync(path.join(REPO_ROOT, "release", "cli.sh"), ["domain", "a", "secret", "set", "T3-SECRET-NAME", "--hosts", "api.example.test", "--headers", "authorization"], { env: stack.env, input: "t3-secret-value-41\n", encoding: "utf8" });
    assert.equal(set.status, 0, set.stderr);
    const sent = stack.inVm(vmOf("a/w1"), ["bash", "-lc", "curl -sS -m 120 https://api.example.test/t3-secret -H 'Authorization: Bearer T3-SECRET-NAME' 2>&1"]);
    assert.match(sent.stdout, /upstream https host=api\.example\.test path=\/t3-secret/, sent.stdout);
    const seen = (JSON.parse(stack.forge("upstream")) as { path: string; authorization: string | null }[]).filter((entry) => entry.path === "/t3-secret");
    assert.deepEqual(seen.map((entry) => entry.authorization), ["Bearer t3-secret-value-41"], "the upstream received the value");
    const found = asRoot("a/w1", "grep -rIl t3-secret-value /desolate /workspaces /etc /run /var/lib/desolate /home 2>/dev/null | head -3; echo searched");
    assert.equal(found.stdout.trim(), "searched", "root inside the workspace VM finds the value nowhere");
    assert.equal(stack.quiet("domain", "a", "secret", "rm", "T3-SECRET-NAME").code, 0);
  });

  it("T3 each domain's proxies run as that domain's own user, which reaches no share, not the keyring, and not another domain's secrets", () => {
    // What parses a workspace's traffic is the most exposed code in the root. On vz a share
    // takes a write from any user that reaches it, so the shares are closed to the proxies by
    // a directory that is not a share (root/start.sh); each domain's secrets and its secrets
    // proxy are its own proxies' alone (proxy/as-proxy.ts).
    // A secret, so the domain's secrets proxy runs (the previous test removed its own).
    const set = spawnSync(path.join(REPO_ROOT, "release", "cli.sh"), ["domain", "a", "secret", "set", "T3-HANDOFF-NAME", "--hosts", "api.example.test"], { env: stack.env, input: "t3-handoff-value-77\n", encoding: "utf8" });
    assert.equal(set.status, 0, set.stderr);
    const userOf = (domain: string) => stack.inRoot(["bash", "/desolate/release/root/proxy-user.sh", stack.inRoot(["stat", "-c", "%u", "/var/lib/desolate"], { root: true }).stdout.trim(), domain], { root: true }).stdout.trim();
    const a = userOf("a");
    const other = userOf("t3other");
    assert.match(a, /^dsp-[0-9a-f]{10}$/);
    const users = stack.inRoot(["bash", "-c", "ps -eo user:20,args | grep -E 'proxy/proxy.ts|mitmdump' | grep -v -e grep -e '^root ' | awk '{print $1}' | sort -u"]).stdout.trim();
    assert.equal(users, a, "every proxy running (all of domain a's) is domain a's proxies' user's");
    // A tunnel into domain a's secrets proxy, as its own proxy would open one: to the address
    // the secret's host has here (the forge's stand-in), with or without a's token.
    const script = [
      "import json, socket, sys",
      "d = '/var/lib/desolate-proxies/domains/a/'",
      "port = int(sys.argv[3])",
      "token = open(d + 'link-token').read().strip() if sys.argv[2] == 'token' else ''",
      "s = socket.create_connection(('127.0.0.1', port), timeout=20)",
      "extra = 'X-Desolate-Token: ' + token + '\\r\\n' if token else ''",
      "s.sendall(('CONNECT ' + sys.argv[1] + ':443 HTTP/1.1\\r\\nHost: ' + sys.argv[1] + ':443\\r\\nX-Desolate-Workspace: w1\\r\\nX-Desolate-Host: api.example.test\\r\\n' + extra + '\\r\\n').encode())",
      "print(s.recv(100).split(b' ')[1].decode())",
    ].join("\n");
    stack.inRoot(["bash", "-c", "cat > /tmp/handoff.py && chmod 0644 /tmp/handoff.py"], { root: true, input: script });
    const tried = stack.inRoot(["bash", "-c", `
      address=$(getent ahostsv4 api.example.test | head -1 | cut -d' ' -f1)
      port=$(python3 -c "import json; print(json.load(open('/var/lib/desolate-proxies/domains/a/secrets-proxy.json'))['port'])")
      for p in /desolate/root /desolate/mirrors /desolate/domains; do sudo -n -u ${a} touch $p/proxy-tried 2>/dev/null && echo "share_$p=WROTE" || echo "share_$p=refused"; done
      sudo -n -u ${a} bash -c 'echo "{\\"op\\":\\"list\\"}" | socat - UNIX-CONNECT:/run/desolate/keyring/control.sock' >/dev/null 2>&1 && echo keyring=REACHED || echo keyring=refused
      sudo -n -u ${other} cat /var/lib/desolate-proxies/secrets/a.json >/dev/null 2>&1 && echo other_reads_secrets=REACHED || echo other_reads_secrets=refused
      sudo -n -u "$(stat -c %U /var/lib/desolate)" cat /var/lib/desolate-proxies/secrets/a.json >/dev/null 2>&1 && echo root_user_reads_secrets=REACHED || echo root_user_reads_secrets=refused
      sudo -n -u ${a} cat /var/lib/desolate-proxies/secrets/a.json >/dev/null 2>&1 && echo control_own_reads_secrets=REACHED || echo control_own_reads_secrets=refused
      echo "other_uses_secrets_proxy=$(sudo -n -u ${other} python3 /tmp/handoff.py "$address" none "$port" 2>/dev/null || echo refused)"
      echo "control_own=$(sudo -n -u ${a} python3 /tmp/handoff.py "$address" token "$port" 2>&1 | tail -1)"
      # A workspace's own proxy is a socket only its domain's proxies and the root's user
      # reach: another domain's proxies cannot ask it for this domain's secret hosts.
      sock=$(ls /var/lib/desolate-proxies/out/a/*.sock | head -1)
      sudo -n -u ${other} socat -u /dev/null "UNIX-CONNECT:$sock" 2>/dev/null && echo other_reaches_workspace_proxy=REACHED || echo other_reaches_workspace_proxy=refused
      sudo -n -u "$(stat -c %U /var/lib/desolate)" socat -u /dev/null "UNIX-CONNECT:$sock" 2>/dev/null && echo control_user_reaches_workspace_proxy=REACHED || echo control_user_reaches_workspace_proxy=refused
      touch /desolate/root/user-tried && echo control_share=WROTE && rm -f /desolate/root/user-tried /tmp/handoff.py`], { root: true });
    const got = lines(tried.stdout);
    assert.equal(got.control_share, "WROTE", "control: the root writes the share, so a refusal above is the closed directory");
    assert.equal(got.control_own, "200", "control: domain a's own proxies, with its token, are let into its secrets proxy");
    assert.equal(got.control_own_reads_secrets, "REACHED", "control: domain a's own proxies read its secrets");
    assert.equal(got.control_user_reaches_workspace_proxy, "REACHED", "control: the root's user (the host daemon's way in) reaches a's workspace proxy");
    assert.equal(got.other_uses_secrets_proxy, "403", "another domain's proxies reach it (given the port), and are refused for want of the token");
    for (const [name, verdict] of Object.entries(got)) if (!name.startsWith("control") && name !== "other_uses_secrets_proxy") assert.match(verdict, /^refused/, name);
    assert.equal(stack.quiet("domain", "a", "secret", "rm", "T3-HANDOFF-NAME").code, 0);
  });

  it("T3 the VM layer forwards nothing onto the host by itself: not a loopback listener, not a wildcard one", async () => {
    // Lima forwards a guest's listeners onto the host unless told not to. A workspace's
    // 127.0.0.1 listeners once appeared on the host's 127.0.0.1, around desolate's forwarder
    // and the editor's gate (release/docs/incidents.md).
    const ports = [47611, 47612, 47613];
    const started = asRoot("a/w1", `for spec in "127.0.0.1 ${ports[0]}" "0.0.0.0 ${ports[1]}" ":: ${ports[2]}"; do set -- $spec; (nohup python3 -c "import socket,sys,time; fam=socket.AF_INET6 if ':' in sys.argv[1] else socket.AF_INET; s=socket.socket(fam); s.bind((sys.argv[1], int(sys.argv[2]))); s.listen(); time.sleep(20)" $1 $2 >/dev/null 2>&1 &); done; sleep 1; ss -ltnH | grep -c ':4761'`);
    assert.equal(started.stdout.trim(), "3", "control: the three listeners are there, in the VM");
    await new Promise((resolve) => setTimeout(resolve, 6000));
    // desolate's own forwarder may publish them (that is how a dev server is reached, by the
    // workspace's name); what must not is the VM layer itself.
    const holders = (port: number) =>
      process.platform === "darwin"
        ? spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fc"], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.startsWith("c")).map((l) => l.slice(1))
        : (spawnSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" }).stdout.match(/\(\("([^"]+)"/g) ?? []).map((m) => m.slice(3, -1));
    for (const port of ports) assert.deepEqual(holders(port).filter((name) => /limactl|qemu/.test(name)), [], `nothing of the VM layer listens on the host's port ${port}`);
  });

  it("T3 forced egress: root inside the VM reaches nothing", () => {
    stack.step("root in the VM against the network");
    // The domain's rules now allow nothing, so what is refused below is refused by the proxy
    // (for names) or by the VM's confinement (for everything else): never by luck.
    assert.equal(stack.quiet("domain", "a", "net", "enforce").code, 0);
    const hostAddresses = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a!.address);
    const forge = stack.env.DESOLATE_FORGE_SPEC!.replace(/^.*@/, "");
    const probe = (targets: string) => `
      # REACHED only if the destination itself answered. A 403 whose body begins "desolate:"
      # is desolate's own relay or proxy refusing, which is a refusal.
      try() {
        code=$(curl -s -m 20 -o /tmp/try-body -w '%{http_code}' "$2"); rc=$?
        if [ $rc != 0 ]; then echo "$1=refused (curl exit $rc)"
        elif [ "$code" = 403 ] && head -c 9 /tmp/try-body | grep -q '^desolate:'; then echo "$1=refused (by desolate: $(head -c 80 /tmp/try-body | tr -d '\n'))"
        else echo "$1=REACHED (http $code)"; fi
      }
      ${targets}`;
    const targets = [
      `try gateway http://192.168.5.2:${port}/`,
      ...hostAddresses.map((address, index) => `try host${index} http://${address}:${port}/`),
      `try forge_ssh telnet://${forge}`,
      "try internet_ip http://1.1.1.1/",
      "try internet_name http://example.com/",
    ].join("\n");
    // Control: the same requests from the root VM, whose egress is open, do reach the host.
    const control = lines(stack.inRoot(["bash", "-c", probe(`try gateway http://192.168.5.2:${port}/`)]).stdout);
    assert.match(control.gateway ?? "", /^REACHED/, "control: a VM with open egress reaches the host's listener, so a refusal below is the confinement");
    const first = lines(asRoot("a/w1", probe(targets)).stdout);
    for (const [name, verdict] of Object.entries(first)) assert.match(verdict, /^refused/, `${name}, as root in the workspace`);
    assert.ok(Object.keys(first).length >= 4, "the probe ran");
    // Then root does what root can: new routes, no firewall, a resolver of its choosing.
    const second = lines(asRoot("a/w1", `
      ip route replace default via 192.168.5.2 2>/dev/null; ip addr add 192.168.5.77/24 dev eth0 2>/dev/null
      nft flush ruleset 2>/dev/null; iptables -F 2>/dev/null; iptables -t nat -F 2>/dev/null
      echo nameserver 192.168.5.3 > /etc/resolv.conf
      ${probe(targets)}
      getent hosts example.com >/dev/null 2>&1 && echo dns=REACHED || echo dns=refused
      python3 -c "import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(4); s.sendto(b'x', ('192.168.5.2', ${port})); s.recvfrom(10)" 2>/dev/null && echo udp=REACHED || echo udp=refused`).stdout);
    for (const [name, verdict] of Object.entries(second)) assert.match(verdict, /^refused/, `${name}, after root rewrote routes, flushed the firewall and chose a resolver`);
    // ICMP. An echo carries a payload, so a ping that leaves is a channel. On Lima/vz 2.3
    // the user-mode stack really sends echoes from the host (a documentation address gets
    // no reply, 1.1.1.1 does: docs/v3/decisions.md, section 4.3), so a reply to a workspace
    // means its echo left the Mac. Control: the root VM, whose egress is open, gets one.
    const ping = (where: string) => `ping -c 3 -W 2 1.1.1.1 >/dev/null 2>&1 && echo ${where}=REACHED || echo ${where}=refused`;
    const icmpControl = lines(stack.inRoot(["bash", "-c", ping("icmp")], { root: true }).stdout).icmp ?? "";
    const icmp = lines(asRoot("a/w1", ping("icmp")).stdout).icmp ?? "";
    assert.match(icmp, /^refused/, "ICMP, as root in the workspace");
    if (stack.backend === "vz") assert.match(icmpControl, /^REACHED/, "control: the root VM's ping is answered, so the workspace's silence is its confinement");
    // (qemu: slirp answers echoes only where the host may send them; a sandbox may not.)
    else if (!/^REACHED/.test(icmpControl)) console.log("# ICMP: the root VM's own ping got no answer on this machine, so the refusal above has no control here");
    // And outside the VM, on the qemu backend: the hypervisor that is running is the
    // restricted one, and the root VM's is not (the control).
    if (stack.backend === "qemu") {
      const pid = fs.readFileSync(path.join(stack.home, "lima", vmOf("a/w1"), "qemu.pid"), "utf8").trim();
      assert.match(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"), /restrict=on/);
      const rootPid = fs.readFileSync(path.join(stack.home, "lima", `dsl-${stack.instance}-root`, "qemu.pid"), "utf8").trim();
      assert.doesNotMatch(fs.readFileSync(`/proc/${rootPid}/cmdline`, "utf8"), /restrict=on/, "control: the root VM's network is the unrestricted kind");
    }
  });

  it("T3 two domains: neither can reach the other's work, whatever it writes", () => {
    stack.step("a second domain");
    assert.equal(stack.desolate("domain", "create", "b").code, 0);
    assert.equal(stack.desolate("domain", "b", "add", "--repo", "acme/widgets").code, 0);
    assert.equal(stack.desolate("up", "b").code, 0);
    // Domain a writes into everything it can reach.
    asRoot("a/w1", "echo from-a > /workspaces/poison; echo from-a > /workspaces/acme/widgets/poison; echo from-a > /desolate/outbox/poison; echo from-a > /desolate/mirrors/acme/widgets.git/poison 2>/dev/null; cd /workspaces/acme/widgets && git branch poisoned");
    assert.ok(fs.existsSync(path.join(stack.home, "domains/a/repos/poison")), "control: domain a's writes did land in domain a's own storage");
    const seen = asRoot("b/w1", "ls /workspaces /workspaces/acme/widgets /desolate/outbox /desolate/mirrors/acme/widgets.git 2>/dev/null | grep -c poison; cd /workspaces/acme/widgets && git branch -a | grep -c poisoned; cat .git/objects/info/alternates");
    const [files, branches, alternates] = seen.stdout.trim().split("\n");
    assert.equal(files, "0", "domain b sees none of domain a's files");
    assert.equal(branches, "0", "nor its branches");
    assert.equal(alternates, "/desolate/mirrors/acme/widgets.git/objects", "both borrow the one mirror");
    assert.equal(fs.existsSync(path.join(stack.home, "mirrors/acme/widgets.git/poison")), false, "the shared mirror took nothing from either");
  });

  it("T3 destroy leaves no VM and no process behind", () => {
    stack.step("destroy");
    const result = stack.desolate("destroy", "--all");
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /nothing of this stack is left/);
    assert.equal(fs.existsSync(stack.home), false);
    const left = !fs.existsSync("/proc/self/cmdline") ? [] : fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).filter((pid) => {
      try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(stack.home);
      } catch {
        return false;
      }
    });
    assert.deepEqual(left, [], "no process of this stack is left running");
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript(`${stack.tier.toLowerCase()}-01-boundaries`);
  });
});

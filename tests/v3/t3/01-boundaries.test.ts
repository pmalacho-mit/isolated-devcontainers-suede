// T3 (qemu backend: real VMs, under KVM or TCG). The boundaries that need a real VM
// (move-to-vms.md section 13.2): read-only shares against root inside the VM, forced egress
// with root inside the VM, and no cross-domain path. Every negative check sits beside a
// control that shows it would have caught the failure.
//
// Run: tests/v3/run.sh t3   (tens of minutes under TCG: each VM takes minutes to boot)
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
let listener: http.Server;
let port = 0;
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

describe("T3: boundaries that need a real VM", { skip: process.env.DESOLATE_TIER !== "T3" ? "set DESOLATE_TIER=T3 (tests/v3/run.sh t3)" : false }, () => {
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
    // VM's own confinement can be what stops it.
    listener = http.createServer((_request, response) => response.end("the-host-answered\n"));
    await new Promise<void>((resolve) => listener.listen(0, "0.0.0.0", () => resolve()));
    port = (listener.address() as { port: number }).port;
  });
  after(() => {
    listener?.close();
    stack?.destroy();
  });

  it("T3 bootstrap on real VMs: isolated, and doctor passes", () => {
    stack.step("bootstrap on the qemu backend");
    const result = bootstrap(stack);
    assert.equal(result.code, 0, result.stderr + result.stdout.slice(-1500));
    assert.doesNotMatch(result.stdout, /NOT ISOLATED/);
    assert.match(result.stdout, /ok {3}backend gives isolation: qemu/);
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

  it("T3 forced egress: root inside the VM reaches nothing", () => {
    stack.step("root in the VM against the network");
    // The domain's rules now allow nothing, so what is refused below is refused by the proxy
    // (for names) or by the VM's confinement (for everything else): never by luck.
    assert.equal(stack.quiet("domain", "a", "net", "enforce").code, 0);
    const hostAddresses = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a!.address);
    const forge = stack.env.DESOLATE_FORGE_SPEC!.replace(/^.*@/, "").replace(/:\d+$/, "");
    const probe = (targets: string) => `
      try() { curl -s -m 20 -o /dev/null "$2"; rc=$?; [ $rc = 0 ] && echo "$1=REACHED" || echo "$1=refused (curl exit $rc)"; }
      ${targets}`;
    const targets = [
      `try gateway http://192.168.5.2:${port}/`,
      ...hostAddresses.map((address, index) => `try host${index} http://${address}:${port}/`),
      `try forge_ssh telnet://${forge}:22`,
      "try internet_ip http://1.1.1.1/",
      "try internet_name http://example.com/",
    ].join("\n");
    // Control: the same requests from the root VM, whose egress is open, do reach the host.
    const control = lines(stack.inRoot(["bash", "-c", probe(`try gateway http://192.168.5.2:${port}/`)]).stdout);
    assert.equal(control.gateway, "REACHED", "control: a VM with open egress reaches the host's listener, so a refusal below is the confinement");
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
    // And outside the VM: the hypervisor process that is running is the restricted one.
    const pid = fs.readFileSync(path.join(stack.home, "lima", vmOf("a/w1"), "qemu.pid"), "utf8").trim();
    assert.match(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"), /restrict=on/);
    const rootPid = fs.readFileSync(path.join(stack.home, "lima", `dsl-${stack.instance}-root`, "qemu.pid"), "utf8").trim();
    assert.doesNotMatch(fs.readFileSync(`/proc/${rootPid}/cmdline`, "utf8"), /restrict=on/, "control: the root VM's network is the unrestricted kind");
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
    const left = fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).filter((pid) => {
      try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(stack.home);
      } catch {
        return false;
      }
    });
    assert.deepEqual(left, [], "no process of this stack is left running");
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t3-01-boundaries");
  });
});

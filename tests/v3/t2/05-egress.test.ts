// T2 (fake backend). Section 4.3: a workspace's only way out is its own proxy, which applies
// its DOMAIN's rules, refuses internal addresses, and audits by link. The hypervisor half of
// "nothing else leaves" is in t3; here the workspace is a container with no network at all,
// so what is tested is the proxy, the relay, and the attribution.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
let forge = "";
const vms = new Map<string, string>();
const vmOf = (target: string) => {
  if (!vms.has(target)) {
    const list = JSON.parse(stack.quiet("list", "--json").stdout) as { domain: string; workspaces: { workspace: string; vm: string }[] }[];
    for (const d of list) for (const w of d.workspaces) vms.set(`${d.domain}/${w.workspace}`, w.vm);
  }
  return vms.get(target)!;
};
const inWs = (target: string, script: string, root = false) => stack.inVm(vmOf(target), ["bash", "-c", script], { root });
const curl = (target: string, url: string, extra = "") => inWs(target, `curl -sS -m 15 ${extra} --cacert /workspaces/upstream.crt '${url}' 2>&1`);
type Entry = { domain: string; workspace: string; host: string; port: number; verdict: string; reason?: string };
const log = (domain?: string) => JSON.parse(stack.quiet("net", "log", ...(domain ? [domain] : []), "--json").stdout) as Entry[];

describe("T2 section 4.3: egress through the workspace's own proxy", () => {
  before(() => {
    stack = newStack("egress");
    stack.seed("acme/app", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    forge = stack.env.DESOLATE_FORGE_SPEC!.replace(/^.*@/, "").replace(/:\d+$/, "");
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/app").code, 0);
    for (const domain of ["dev", "two"]) {
      assert.equal(stack.quiet("domain", "create", domain).code, 0);
      assert.equal(stack.quiet("domain", domain, "add", "--repo", "acme/app").code, 0);
      const up = stack.quiet("up", domain);
      assert.equal(up.code, 0, up.stderr.split("\n").filter((line) => !line.startsWith("    at ")).join("\n"));
      fs.copyFileSync(path.join(stack.work, "forge-state", "upstream.crt"), path.join(stack.home, "domains", domain, "repos", "upstream.crt"));
    }
    // Names for the stand-in internet host, as the ROOT resolves them (the proxy resolves,
    // never the workspace); and one name that points at the root's own loopback.
    const hosts = stack.inRoot(["bash", "-c", `printf '%s api.example.test other.example.test\\n127.0.0.1 loop.example.test\\n' ${forge} >> /etc/hosts`], { root: true });
    assert.equal(hosts.code, 0, hosts.stderr);
  });
  after(() => stack.destroy());

  it("a name that resolves to an internal address is refused, with the reason", () => {
    stack.step("internal addresses");
    const refused = curl("dev/w1", "http://api.example.test/hello");
    assert.match(refused.stdout, /desolate: api\.example\.test resolves to an internal address \([\d.]+\), which a workspace is not carried to/);
    const loop = curl("dev/w1", "http://loop.example.test/");
    assert.match(loop.stdout, /resolves to an internal address \(127\.0\.0\.1\)/);
    assert.deepEqual(JSON.parse(stack.forge("upstream")), [], "nothing reached the upstream");
  });

  it("with that one address allowed for the domain, plain programs reach the host: HTTP, and TLS end to end", () => {
    stack.step("reaching a host through the proxy");
    const allowed = stack.desolate("domain", "dev", "net", "allow-internal", forge);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(stack.quiet("domain", "two", "net", "allow-internal", forge).code, 0);
    const plain = curl("dev/w1", "http://api.example.test/hello");
    assert.equal(plain.stdout.trim(), "upstream http host=api.example.test path=/hello");
    const tls = curl("dev/w1", "https://api.example.test/secure");
    assert.equal(tls.stdout.trim(), "upstream https host=api.example.test path=/secure", "TLS runs end to end: the client verified the upstream's own certificate");
    assert.equal(inWs("dev/w1", "env | grep -ci _proxy; true").stdout.trim(), "0", "no proxy setting was needed: the redirect and the relay did it");
    // Still refused, allowed address or not: the root's own loopback, and anything unnamed.
    assert.match(curl("dev/w1", "http://loop.example.test/").stdout, /internal address \(127\.0\.0\.1\)/);
    assert.match(curl("dev/w1", `http://${forge}/`).stdout, /a destination is a hostname: an address alone is not carried/);
    assert.notEqual(curl("dev/w1", `https://${forge}/`, "-k").code, 0, "TLS to an address, with no server name");
    assert.notEqual(curl("dev/w1", "http://api.example.test:8080/").code, 0, "a port other than 80 and 443");
  });

  it("a domain's rules are its own: enforce an allowlist in one, and the other is untouched", () => {
    stack.step("per-domain network rules");
    assert.equal(stack.desolate("domain", "dev", "net", "allow", "api.example.test").code, 0);
    const enforced = stack.desolate("domain", "dev", "net", "enforce");
    assert.match(enforced.stdout, /dev: only these hosts are reachable: api\.example\.test/);
    assert.match(curl("dev/w1", "http://other.example.test/").stdout, /other\.example\.test is not on the domain dev's allowlist/);
    assert.equal(curl("dev/w1", "http://api.example.test/still").stdout.trim(), "upstream http host=api.example.test path=/still", "control: the listed host still answers");
    assert.equal(curl("two/w1", "http://other.example.test/from-two").stdout.trim(), "upstream http host=other.example.test path=/from-two", "the other domain is not enforced");
    const bad = stack.desolate("domain", "dev", "net", "allow", "not a host");
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /fix: for example: api\.example\.com or \*\.example\.com/);
  });

  it("every request is audited by the link it arrived on", () => {
    stack.step("the audit");
    const dev = log("dev");
    assert.ok(dev.length >= 6 && dev.every((e) => e.domain === "dev" && e.workspace === "w1"));
    assert.ok(dev.some((e) => e.verdict === "allowed" && e.host === "api.example.test" && e.port === 443));
    assert.ok(dev.some((e) => e.verdict === "refused" && e.host === "other.example.test" && /allowlist/.test(e.reason ?? "")));
    assert.ok(dev.some((e) => e.verdict === "refused" && e.host === "loop.example.test"));
    const two = log("two");
    assert.ok(two.length >= 1 && two.every((e) => e.domain === "two"));
    assert.match(stack.desolate("net", "log", "two").stdout, /domain=two workspace=w1 {2}allowed {2}other\.example\.test:80/);
    // A workspace cannot name itself: what it says about who it is appears nowhere.
    // (The connection is held open while the proxy answers: a client that closes its side first is hung up on.)
    const forged = inWs("two/w1", `(printf 'CONNECT other.example.test:80 HTTP/1.1\\r\\nX-Desolate-Domain: dev\\r\\nHost: x\\r\\n\\r\\n'; sleep 1; printf 'GET /forged HTTP/1.0\\r\\nHost: other.example.test\\r\\n\\r\\n'; sleep 2) | socat - UNIX-CONNECT:/desolate/link/proxy.sock`);
    assert.match(forged.stdout, /path=\/forged/);
    assert.ok(log().filter((e) => e.host === "other.example.test" && e.verdict === "allowed").every((e) => e.domain === "two"), "the request is attributed to the link's domain, whatever it claimed");
  });

  it("the relay inside the workspace is not the boundary: without it, the proxy still decides", () => {
    stack.step("root in the workspace, without the relay");
    const control = curl("dev/w1", "http://api.example.test/before");
    assert.match(control.stdout, /path=\/before/, "control: the workspace reaches its allowed host before anything is removed");
    const torn = inWs("dev/w1", "kill $(cat /run/desolate/egress.pid); nft flush ruleset; pkill dnsmasq; sleep 0.5; curl -s -m 5 -o /dev/null http://api.example.test/; echo curl=$?; ip -o link | wc -l", true);
    assert.match(torn.stdout, /curl=[1-9]/, "with the relay gone there is no way out at all");
    const connect = (target: string) => inWs("dev/w1", `(printf 'CONNECT ${target} HTTP/1.1\\r\\n\\r\\n'; sleep 2) | socat - UNIX-CONNECT:/desolate/link/proxy.sock | head -3`, true).stdout;
    assert.match(connect("api.example.test:80"), /^HTTP\/1\.1 200 /, "control: the link itself still works for what the domain allows");
    assert.match(connect("other.example.test:80"), /^HTTP\/1\.1 403 [\s\S]*not on the domain dev's allowlist/);
    assert.match(connect("loop.example.test:80"), /^HTTP\/1\.1 403 /);
    assert.match(connect("127.0.0.1:21000"), /^HTTP\/1\.1 403 [\s\S]*a destination is a hostname/);
    assert.match(connect("api.example.test:22"), /^HTTP\/1\.1 403 [\s\S]*only ports 80 and 443/);
    // Starting the workspace again puts the conveniences back.
    assert.equal(stack.quiet("stop", "dev/w1").code, 0);
    assert.equal(stack.quiet("start", "dev/w1").code, 0);
    assert.match(curl("dev/w1", "https://api.example.test/after").stdout, /path=\/after/);
  });

  it("what reached the upstream is only what was allowed", () => {
    const seen = JSON.parse(stack.forge("upstream")) as { host: string; path: string }[];
    assert.ok(seen.length >= 5);
    assert.ok(seen.every((r) => /^(api|other)\.example\.test$/.test(r.host)));
    assert.ok(!seen.some((r) => r.host === "other.example.test" && r.path !== "/from-two" && r.path !== "/forged"), "the enforced domain never reached the host off its list");
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-05-egress");
  });
});

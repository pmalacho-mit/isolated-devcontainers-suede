// T2 (fake backend). Phase 4 (section 4.3): a domain's secrets. A workspace holds a
// secret's NAME; the value is put in its place on the way out, by the domain's secrets
// proxy in the root, only toward the hosts the secret names. The cases are v2's
// (carryover/proxy/test_addon.py), run here end to end through a workspace's own egress:
// redirect -> relay -> link -> its proxy -> the domain's secrets proxy -> a stand-in host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack, REPO_ROOT } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
let forge = "";
const VALUE = "s3cr3t-value-0f9e8d7c";
const TOKEN = "tok-2b4d6f8a-second";
const vms = new Map<string, string>();
const vmOf = (target: string) => {
  if (!vms.has(target)) {
    const list = JSON.parse(stack.quiet("list", "--json").stdout) as { domain: string; workspaces: { workspace: string; vm: string }[] }[];
    for (const d of list) for (const w of d.workspaces) vms.set(`${d.domain}/${w.workspace}`, w.vm);
  }
  return vms.get(target)!;
};
const inWs = (target: string, script: string, root = false) => stack.inVm(vmOf(target), ["bash", "-lc", script], { root });
/** curl as any program in the workspace would run it: the system's trust store, no proxy setting. */
const curl = (target: string, args: string) => inWs(target, `curl -sS -m 20 ${args} 2>&1`);
/** The CLI with a value on stdin: never in an argument. */
const withStdin = (input: string, ...args: string[]) => {
  const result = spawnSync(path.join(REPO_ROOT, "release", "cli.sh"), args, { env: stack.env, input, encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
};
type Seen = { scheme: string; host: string; path: string; authorization: string | null; apiKey: string | null; body: string };
const upstream = () => JSON.parse(stack.forge("upstream")) as Seen[];
const last = () => upstream().pop()!;
type Entry = { domain: string; workspace: string; host: string; verdict: string; reason?: string; secrets?: string[]; via?: string };
const log = (domain: string) => JSON.parse(stack.quiet("net", "log", domain, "--json").stdout) as Entry[];

describe("T2 phase 4: a domain's secrets", () => {
  before(() => {
    stack = newStack("secrets");
    stack.seed("acme/app", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    forge = stack.env.DESOLATE_FORGE_SPEC!.replace(/^.*@/, "").replace(/:\d+$/, "");
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/app", "--no-domain").code, 0);
    const crt = fs.readFileSync(path.join(stack.work, "forge-state", "upstream.crt"), "utf8");
    for (const domain of ["dev", "two"]) {
      assert.equal(stack.quiet("domain", "create", domain).code, 0);
      assert.equal(stack.quiet("domain", domain, "add", "--repo", "acme/app").code, 0);
      assert.equal(stack.quiet("up", domain).code, 0);
      assert.equal(stack.quiet("domain", domain, "net", "allow-internal", forge).code, 0);
      fs.writeFileSync(path.join(stack.home, "domains", domain, "repos", "upstream.crt"), crt);
    }
    // The stand-in internet host, as the ROOT resolves it and as the ROOT trusts it: the
    // secrets proxy checks the upstream's certificate against the root VM's own store.
    const prepared = stack.inRoot(["bash", "-c", `printf '%s api.example.test other.example.test wrong.other.test\\n' ${forge} >> /etc/hosts && cat > /usr/local/share/ca-certificates/test-upstream.crt && update-ca-certificates >/dev/null 2>&1`], { root: true, input: crt });
    assert.equal(prepared.code, 0, prepared.stderr);
  });
  after(() => stack.destroy());

  it("a secret is set with its value on stdin, and names the hosts it may go to", () => {
    stack.step("setting a secret");
    // Before: the name is only a name, and the workspace's TLS is end to end.
    const before = curl("dev/w1", "--cacert /workspaces/upstream.crt https://api.example.test/before -H 'Authorization: Bearer MYAPP-API-KEY'");
    assert.equal(before.stdout.trim(), "upstream https host=api.example.test path=/before");
    assert.equal(last().authorization, "Bearer MYAPP-API-KEY");
    // Refusals: a name that could be matched by accident, no allowlist, an allowlist that pins nothing.
    for (const [args, why] of [
      [["KEY", "--hosts", "api.example.test"], /is not a placeholder name/],
      [["MYAPP-API-KEY"], /names the hosts it may be sent to/],
      [["MYAPP-API-KEY", "--hosts", "*"], /does not pin a destination/],
      [["MYAPP-API-KEY", "--hosts", "*.test"], /does not pin a destination/],
      [["MYAPP-API-KEY", "--hosts", "*example.test"], /does not pin a destination/],
      [["MYAPP-API-KEY", "--hosts", "api.example.test", "--headers", "not a header"], /is not a header name/],
    ] as [string[], RegExp][]) {
      const refused = withStdin(`${VALUE}\n`, "domain", "dev", "secret", "set", ...args);
      assert.notEqual(refused.code, 0, args.join(" "));
      assert.match(refused.stderr, why, args.join(" "));
    }
    assert.match(withStdin("", "domain", "dev", "secret", "set", "MYAPP-API-KEY", "--hosts", "api.example.test").stderr, /a secret's value is one line, and not empty/);
    const set = withStdin(`${VALUE}\n`, "domain", "dev", "secret", "set", "MYAPP-API-KEY", "--hosts", "api.example.test", "--headers", "Authorization");
    assert.equal(set.code, 0, set.stderr);
    assert.match(set.stdout, /MYAPP-API-KEY is held in the root for the domain dev\. Its workspaces send the name; the value is put in its place on the way to: api\.example\.test \(in the header authorization only\)\./);
    assert.match(withStdin(`${TOKEN}\n`, "domain", "dev", "secret", "set", "MYAPP-API-KEY-2", "--hosts", "api.example.test").stderr, /MYAPP-API-KEY-2 and MYAPP-API-KEY overlap/);
    // The spec's own spelling (section 8) does the same thing.
    assert.equal(withStdin(`${TOKEN}\n`, "domain", "dev", "add", "--secret", "MYAPP-TOKEN-TWO", "--hosts", "*.example.test").code, 0);
    const listed = stack.desolate("domain", "dev", "secret", "list");
    assert.equal(listed.stdout.trim(), "MYAPP-API-KEY  ->  api.example.test  (headers: authorization)\nMYAPP-TOKEN-TWO  ->  *.example.test");
    // Nothing that reads prints a value, and no workspace can find one.
    for (const text of [set.stdout, set.stderr, listed.stdout, stack.quiet("domain", "dev", "secret", "list", "--json").stdout]) assert.doesNotMatch(text, new RegExp(`${VALUE}|${TOKEN}`));
    const inbox = inWs("dev/w1", `cat /desolate/inbox/secrets.json; grep -rIl -e '${VALUE}' -e '${TOKEN}' /desolate /workspaces /etc /run 2>/dev/null | head -3; echo searched`, true);
    assert.deepEqual(JSON.parse(inbox.stdout.slice(0, inbox.stdout.lastIndexOf("]") + 1)), [{ name: "MYAPP-API-KEY", hosts: ["api.example.test"], headers: ["authorization"] }, { name: "MYAPP-TOKEN-TWO", hosts: ["*.example.test"], headers: null }], "a workspace is told the names, hosts and headers");
    assert.match(inbox.stdout, /\]\s*searched\s*$/, "no file a workspace can read holds a value");
    assert.match(stack.inRoot(["bash", "-c", "stat -c '%a %U %G' /var/lib/desolate-proxies/secrets/dev.json; grep -c s3cr3t /var/lib/desolate-proxies/secrets/dev.json"], { root: true }).stdout, /^640 root dsp-[0-9a-f]{10}\n1\n$/, "control: the root VM does hold it, in a file root wrote and only this domain's proxies read");
    assert.notEqual(stack.inRoot(["cat", "/var/lib/desolate-proxies/secrets/dev.json"]).code, 0, "and the root's own user, which parses what domains send, cannot read it");
  });

  it("the name becomes the value on the way to the secret's host, in its headers, and nowhere else", () => {
    stack.step("substitution");
    // The running workspace was given the domain's CA when the first secret was set.
    assert.match(inWs("dev/w1", "echo $NODE_EXTRA_CA_CERTS; ls /usr/local/share/ca-certificates/").stdout, /desolate-domain\.crt\ndesolate-domain\.crt/);
    const sent = curl("dev/w1", "https://api.example.test/v1/models -H 'Authorization: Bearer MYAPP-API-KEY'");
    assert.equal(sent.stdout.trim(), "upstream https host=api.example.test path=/v1/models", sent.stdout);
    assert.equal(last().authorization, `Bearer ${VALUE}`, "the upstream received the value");
    // Confined to its header: the same name anywhere else in the request stays a name.
    curl("dev/w1", "'https://api.example.test/v1?key=MYAPP-API-KEY' -H 'X-Api-Key: MYAPP-API-KEY' -d 'key=MYAPP-API-KEY'");
    assert.deepEqual([last().path, last().apiKey, last().body], ["/v1?key=MYAPP-API-KEY", "MYAPP-API-KEY", "key=MYAPP-API-KEY"]);
    // A secret with no header list: path, headers and body.
    curl("dev/w1", "'https://api.example.test/v2?t=MYAPP-TOKEN-TWO' -H 'X-Api-Key: MYAPP-TOKEN-TWO' -d 'token=MYAPP-TOKEN-TWO'");
    assert.deepEqual([last().path, last().apiKey, last().body], [`/v2?t=${TOKEN}`, TOKEN, `token=${TOKEN}`]);
    // Its allowlist is *.example.test: toward other.example.test it goes too; MYAPP-API-KEY does not.
    curl("dev/w1", "https://other.example.test/v3 -H 'Authorization: Bearer MYAPP-API-KEY' -H 'X-Api-Key: MYAPP-TOKEN-TWO'");
    assert.deepEqual([last().host, last().authorization, last().apiKey], ["other.example.test", "Bearer MYAPP-API-KEY", TOKEN], "a name sent toward a host its secret does not list arrives as a name");
    // Never over plaintext: there is no proven destination.
    curl("dev/w1", "http://api.example.test/plain -H 'Authorization: Bearer MYAPP-API-KEY' -H 'X-Api-Key: MYAPP-TOKEN-TWO'");
    assert.deepEqual([last().scheme, last().authorization, last().apiKey], ["http", "Bearer MYAPP-API-KEY", "MYAPP-TOKEN-TWO"]);
    // A server that reflects the value does not hand it to the workspace: body and headers are scrubbed.
    const echoed = curl("dev/w1", "-i https://api.example.test/echo -H 'Authorization: Bearer MYAPP-API-KEY'");
    assert.equal(last().authorization, `Bearer ${VALUE}`, "control: the value did go up");
    assert.match(echoed.stdout, /x-echo: Bearer MYAPP-API-KEY/i);
    assert.match(echoed.stdout, /path=\/echo authorization=Bearer MYAPP-API-KEY/);
    assert.doesNotMatch(echoed.stdout, new RegExp(VALUE));
  });

  it("no proof, no value: a request that names another host, or a connection opened for another name", () => {
    stack.step("requests that lie about where they go");
    const count = upstream().length;
    const host = curl("dev/w1", "https://api.example.test/lie -H 'Host: other.example.test' -H 'Authorization: Bearer MYAPP-API-KEY'");
    assert.match(host.stdout, /desolate: the request names \['other\.example\.test'\] as its destination, not only the TLS destination 'api\.example\.test'; refusing to substitute a secret/);
    // A workspace that speaks to its link itself (it is root in its own VM) can open a
    // tunnel for the secret's host and then speak TLS for another name inside it.
    const tunnel = inWs("dev/w1", `(socat TCP-LISTEN:18080,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/desolate/link/proxy.sock &) ; sleep 0.5; printf 'GET /lie2 HTTP/1.1\\r\\nHost: other.example.test\\r\\nAuthorization: Bearer MYAPP-TOKEN-TWO\\r\\nConnection: close\\r\\n\\r\\n' | timeout 20 openssl s_client -quiet -proxy 127.0.0.1:18080 -connect api.example.test:443 -servername other.example.test 2>/dev/null`);
    assert.match(tunnel.stdout, /403 Forbidden[\s\S]*desolate: this connection was opened for api\.example\.test, not for other\.example\.test/, tunnel.stdout.slice(0, 400));
    // CONTROL: the same hand-made tunnel with the names agreeing is served, value and all.
    const honest = inWs("dev/w1", `printf 'GET /honest HTTP/1.1\\r\\nHost: api.example.test\\r\\nX-Api-Key: MYAPP-TOKEN-TWO\\r\\nConnection: close\\r\\n\\r\\n' | timeout 20 openssl s_client -quiet -proxy 127.0.0.1:18080 -connect api.example.test:443 -servername api.example.test 2>/dev/null`);
    assert.match(honest.stdout, /upstream https host=api\.example\.test path=\/honest/, honest.stdout.slice(0, 400));
    assert.equal(last().apiKey, TOKEN);
    assert.deepEqual(upstream().slice(count).map((seen) => seen.path), ["/honest"], "neither lie reached the upstream at all");
    // The destination is proven by its certificate, checked in the root: a server that
    // cannot show a certificate for the secret's host gets no connection, and so no value.
    // (The stand-in's certificate does not cover wrong.other.test.)
    assert.equal(withStdin("wrong-value-77\n", "domain", "dev", "secret", "set", "MYAPP-WRONG-HOST", "--hosts", "wrong.other.test").code, 0);
    const wrong = curl("dev/w1", "-i https://wrong.other.test/wrong -H 'X-Api-Key: MYAPP-WRONG-HOST'");
    assert.match(wrong.stdout, /502 Bad Gateway[\s\S]*[Cc]ertificate verify failed/, wrong.stdout.slice(0, 500));
    assert.deepEqual(upstream().slice(count).map((seen) => seen.path), ["/honest"], "the server that could not prove its name received nothing");
    assert.equal(stack.quiet("domain", "dev", "secret", "rm", "MYAPP-WRONG-HOST").code, 0);
  });

  it("a secret is its domain's: another domain's workspaces send the name and get no CA", () => {
    stack.step("another domain");
    const other = curl("two/w1", "--cacert /workspaces/upstream.crt https://api.example.test/two -H 'Authorization: Bearer MYAPP-API-KEY' -H 'X-Api-Key: MYAPP-TOKEN-TWO'");
    assert.equal(other.stdout.trim(), "upstream https host=api.example.test path=/two", "its TLS is end to end, with the upstream's own certificate");
    assert.deepEqual([last().authorization, last().apiKey], ["Bearer MYAPP-API-KEY", "MYAPP-TOKEN-TWO"]);
    assert.equal(inWs("two/w1", "cat /desolate/inbox/secrets.json 2>/dev/null; ls /desolate/inbox/ca.pem /usr/local/share/ca-certificates/ 2>&1 | grep -c desolate-domain; true").stdout.trim(), "[]\n0");
    assert.equal(stack.desolate("domain", "two", "secret", "list").stdout.trim().split("\n")[0], "the domain two has no secrets. To add one: set <NAME> --hosts <host>[,...] [--headers <header>[,...]]");
  });

  it("the audit names the workspace and the secret, and holds no value", () => {
    stack.step("the audit");
    const entries = log("dev");
    const substituted = entries.filter((e) => e.verdict === "substituted");
    assert.ok(substituted.length >= 4);
    assert.ok(substituted.every((e) => e.domain === "dev" && e.workspace === "w1"), "attributed by the link the connection arrived on");
    assert.ok(substituted.some((e) => e.host === "api.example.test" && e.secrets?.join() === "MYAPP-API-KEY"));
    assert.ok(entries.some((e) => e.verdict === "leak-suspect" && e.host === "other.example.test" && e.secrets?.join() === "MYAPP-API-KEY"), "the name sent toward a host it is not for is on record");
    assert.ok(entries.some((e) => e.verdict === "refused" && /refusing to substitute a secret/.test(e.reason ?? "")));
    assert.ok(entries.some((e) => e.verdict === "allowed" && e.via === "secrets" && e.host === "api.example.test"));
    assert.ok(log("two").every((e) => e.via === undefined && e.verdict !== "substituted"), "the other domain's connections never went near a secrets proxy");
    const shown = stack.desolate("net", "log", "dev");
    assert.doesNotMatch(shown.stdout + JSON.stringify(entries), new RegExp(`${VALUE}|${TOKEN}`));
    const logs = stack.inRoot(["bash", "-c", `grep -rl -e '${VALUE}' -e '${TOKEN}' /var/lib/desolate/proxy /var/lib/desolate-proxies/out /desolate/domains 2>/dev/null; echo searched`]);
    assert.equal(logs.stdout.trim(), "searched", "no log, audit or inbox file holds a value");
  });

  it("a secret can be switched off, and on for a while: off, its name is refused, never sent in its place", async () => {
    stack.step("switching a secret off and on");
    const count = upstream().length;
    const off = stack.desolate("domain", "dev", "secret", "off", "MYAPP-API-KEY");
    assert.match(off.stdout, /MYAPP-API-KEY is OFF: its value goes nowhere, and a request that carries its name toward api\.example\.test is refused/);
    assert.match(stack.desolate("domain", "dev", "secret", "list").stdout, /^MYAPP-API-KEY {2}-> {2}api\.example\.test {2}\(headers: authorization\) {2}\[OFF\]$/m);
    const refused = curl("dev/w1", "https://api.example.test/off -H 'Authorization: Bearer MYAPP-API-KEY'");
    assert.match(refused.stdout, /desolate: secret \['MYAPP-API-KEY'\] is switched off; on the host: desolate domain dev secret on MYAPP-API-KEY \[--ttl 30m\]/);
    assert.equal(upstream().length, count, "nothing reached the upstream: neither the value nor the name");
    // CONTROL: the other secret, still on, is substituted on the same host; and a request
    // that carries no secret's name goes through.
    curl("dev/w1", "https://api.example.test/still-on -H 'X-Api-Key: MYAPP-TOKEN-TWO'");
    assert.deepEqual([last().path, last().apiKey], ["/still-on", TOKEN]);
    // On for a while.
    const on = stack.desolate("domain", "dev", "secret", "on", "MYAPP-API-KEY", "--ttl", "4s");
    assert.match(on.stdout, /MYAPP-API-KEY is on for \d s more, then off\./);
    curl("dev/w1", "https://api.example.test/on-for-a-while -H 'Authorization: Bearer MYAPP-API-KEY'");
    assert.deepEqual([last().path, last().authorization], ["/on-for-a-while", `Bearer ${VALUE}`]);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    assert.match(curl("dev/w1", "https://api.example.test/expired -H 'Authorization: Bearer MYAPP-API-KEY'").stdout, /is switched off/);
    assert.match(stack.quiet("domain", "dev", "secret", "list").stdout, /MYAPP-API-KEY .*\[OFF\]/, "the list says so too, with nothing having been switched");
    assert.notEqual(last().path, "/expired");
    for (const bad of [["on", "MYAPP-API-KEY", "--ttl", "soon"], ["off", "MYAPP-API-KEY", "--ttl", "5m"], ["on", "NO-SUCH-SECRET"]]) assert.notEqual(stack.quiet("domain", "dev", "secret", ...bad).code, 0, bad.join(" "));
    assert.match(stack.desolate("domain", "dev", "secret", "on", "MYAPP-API-KEY").stdout, /^MYAPP-API-KEY is on\.$/m);
    curl("dev/w1", "https://api.example.test/on-again -H 'Authorization: Bearer MYAPP-API-KEY'");
    assert.deepEqual([last().path, last().authorization], ["/on-again", `Bearer ${VALUE}`]);
    assert.ok(log("dev").some((e) => e.verdict === "refused" && /is switched off/.test(e.reason ?? "") && e.secrets?.join() === "MYAPP-API-KEY"), "the refusal is on record, by name");
  });

  it("fail closed: with the secrets proxy down its hosts are refused, not passed around it; a removed secret is a name again", () => {
    stack.step("the secrets proxy stops; a secret is removed");
    const count = upstream().length;
    // (It runs as the proxies' user under sudo, whose pid is the one recorded: as root, end
    // the proxy itself.)
    assert.equal(stack.inRoot(["bash", "-c", "pkill -TERM -P $(node -e 'console.log(JSON.parse(require(\"fs\").readFileSync(\"/var/lib/desolate-proxies/domains/dev/secrets-proxy.json\")).pid)') && sleep 1"], { root: true }).code, 0);
    const down = curl("dev/w1", "https://api.example.test/down -H 'Authorization: Bearer MYAPP-API-KEY'");
    assert.notEqual(down.code, 0);
    assert.ok(log("dev").some((e) => e.verdict === "refused" && /secrets proxy is not running/.test(e.reason ?? "")), "refused, with the reason on record");
    assert.equal(upstream().length, count, "nothing reached the upstream: not the value, and not the name in its place");
    // A workspace start brings the domain's secrets proxy back.
    assert.equal(stack.quiet("stop", "dev/w1").code, 0);
    assert.equal(stack.quiet("start", "dev/w1").code, 0);
    curl("dev/w1", "https://api.example.test/back -H 'Authorization: Bearer MYAPP-API-KEY'");
    assert.deepEqual([last().path, last().authorization], ["/back", `Bearer ${VALUE}`]);
    assert.match(stack.inRoot(["bash", "-c", "grep -c wrong-value /var/lib/desolate-proxies/secrets/dev.json; true"], { root: true }).stdout, /^0/);
    for (const name of ["MYAPP-API-KEY", "MYAPP-TOKEN-TWO"]) assert.match(stack.desolate("domain", "dev", "secret", "rm", name).stdout, /is no longer held for the domain dev/);
    assert.match(stack.quiet("domain", "dev", "secret", "list").stdout, /has no secrets/);
    assert.equal(stack.inRoot(["bash", "-c", "grep -c s3cr3t /var/lib/desolate-proxies/secrets/dev.json; ls /var/lib/desolate-proxies/domains/dev/secrets-proxy.json 2>&1 | grep -c 'No such file'"], { root: true }).stdout, "0\n1\n", "the value is gone from the root, and the secrets proxy with it");
    const after = curl("dev/w1", "--cacert /workspaces/upstream.crt https://api.example.test/after -H 'Authorization: Bearer MYAPP-API-KEY'");
    assert.equal(after.stdout.trim(), "upstream https host=api.example.test path=/after", "end-to-end TLS again");
    assert.equal(last().authorization, "Bearer MYAPP-API-KEY");
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-07-secrets");
  });
});

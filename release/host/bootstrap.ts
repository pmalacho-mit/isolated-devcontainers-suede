// bootstrap, doctor, destroy (section 13.1).
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { refuse } from "../shared/exit.ts";
import { waitFor } from "../shared/run.ts";
import * as approver from "./approver.ts";
import { INSTANCE, paths, RELEASE_DIR, guest } from "./paths.ts";
import { backend, backendKind, config, ensureHome, pinForge, ROOT_VM, rootctl, rootSpec, saveConfig } from "./stack.ts";
import type { Config, ForgeConfig } from "./stack.ts";
import type { Check } from "./vm/types.ts";

type Out = (line: string) => void;

const githubForge = (): ForgeConfig => ({
  kind: "github",
  ssh: { user: "git", host: "github.com", port: 22 },
  knownHosts: fs.readFileSync(path.join(RELEASE_DIR, "root", "github_known_hosts"), "utf8"),
});

/** `--forge stand-in:ssh://git@host:port --forge-known-hosts <file>`: a local git server
 *  standing in for GitHub, so no test needs the real one (section 13.2). */
export const parseForge = (spec: string | undefined, knownHostsFile: string | undefined): ForgeConfig => {
  if (!spec || spec === "github") return githubForge();
  const match = /^stand-in:ssh:\/\/([a-z_][a-z0-9_-]*)@([A-Za-z0-9.-]+):(\d+)$/.exec(spec);
  if (!match) refuse(`--forge '${spec}' is not understood`, "use --forge github, or --forge stand-in:ssh://git@<host>:<port> --forge-known-hosts <file>");
  if (!knownHostsFile || !fs.existsSync(knownHostsFile)) refuse("a stand-in forge needs its host key", "pass --forge-known-hosts <file> (known_hosts lines for the forge)");
  return { kind: "stand-in", ssh: { user: match![1]!, host: match![2]!, port: Number(match![3]) }, knownHosts: fs.readFileSync(knownHostsFile!, "utf8") };
};

const startRootServices = async () => {
  const uid = process.getuid!();
  const result = await backend().exec(ROOT_VM, ["bash", `${guest.release}/root/start.sh`, String(uid)], { root: true, timeoutMs: 120_000 });
  // start.sh changes the root's user's groups (in desolate-proxy's, out of any that could
  // become root): what the host runs as that user next must have the groups it now has.
  if (result.code === 0) await backend().refreshSessions?.(ROOT_VM, result.stdout.includes("desolate: sessions raised"));
  if (result.code !== 0) refuse(`the root's services did not start: ${(result.stderr || result.stdout).trim().slice(-600)}`, "desolate doctor; the root's own logs are in /var/lib/desolate-root and /var/lib/desolate (desolate root shell)");
};

/** Give the root the approver's PUBLIC key, and the token the host's daemon shows the
 *  root's state service, both as root: files the root VM's ordinary users cannot replace
 *  (the token is theirs to read: the state service runs as one). Returns whether either
 *  changed. */
const installApprover = async (): Promise<boolean> => {
  const pem = approver.publicKey();
  if (!pem) refuse("this stack has no approver key", "desolate bootstrap");
  const made = (name: string) => {
    const file = path.join(paths.state, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
    return fs.readFileSync(file, "utf8").trim();
  };
  const token = made("host-token");
  // The dashboard's credential: the person's browser gets it from `desolate ui`'s address.
  const uiToken = made("ui-token");
  const put = 'put() { new=$(cat); if [ "$new" = "$(cat "$1" 2>/dev/null)" ]; then echo same; else printf "%s\\n" "$new" >"$1.new" && chown "root:$3" "$1.new" && chmod "$2" "$1.new" && mv "$1.new" "$1" && echo changed; fi; }; install -d -m 0755 -o root -g root /etc/desolate; ';
  const group = `$(id -gn "$(getent passwd ${process.getuid!()} | cut -d: -f1)")`;
  const key = await backend().exec(ROOT_VM, ["bash", "-c", `${put}put /etc/desolate/approver.pub 0644 root`], { root: true, input: pem!.trim(), timeoutMs: 60_000 });
  const tok = await backend().exec(ROOT_VM, ["bash", "-c", `${put}put /etc/desolate/host-token 0640 ${group}`], { root: true, input: token, timeoutMs: 60_000 });
  const ui = await backend().exec(ROOT_VM, ["bash", "-c", `${put}put /etc/desolate/ui-token 0640 ${group}`], { root: true, input: uiToken, timeoutMs: 60_000 });
  for (const result of [key, tok, ui]) if (result.code !== 0) throw new Error(`the host's keys were not installed in the root: ${(result.stderr || result.stdout).trim().slice(-300)}`);
  return [key, tok, ui].some((result) => result.stdout.trim() === "changed");
};

/** From a clean machine to a working stack. Idempotent: run twice, the second run changes
 *  nothing and says so. */
export const bootstrap = async (options: { forge?: string; forgeKnownHosts?: string }, out: Out) => {
  const changed: string[] = [];
  const step = (did: boolean, text: string) => {
    out(`${did ? "  + " : "  = "}${text}`);
    if (did) changed.push(text);
  };
  const kind = backendKind();
  out(`desolate bootstrap: backend ${kind}${kind === "fake" ? " (NOT ISOLATED: containers standing in for VMs; tests only)" : ""}, instance ${INSTANCE}`);

  const fresh = !fs.existsSync(paths.state);
  ensureHome();
  step(fresh, `home ${paths.home}`);

  const b = backend();
  const missing = (await b.check()).filter((check) => !check.ok && check.name !== "base image");
  if (missing.length > 0) refuse(`the ${kind} backend is missing: ${missing.map((c) => `${c.name} (${c.detail})`).join("; ")}`, missing.map((c) => c.fix).filter(Boolean).join("; "));

  const before = (await b.check()).find((check) => check.name === "base image")?.ok ?? false;
  await b.ensureImage((line) => out(`    ${line}`));
  step(!before, "base image");

  const existing = config();
  const forge = options.forge ? parseForge(options.forge, options.forgeKnownHosts) : existing?.forge ?? parseForge(undefined, undefined);
  const next: Config = { backend: kind, forge };
  const configChanged = JSON.stringify(existing) !== JSON.stringify(next);
  if (configChanged) saveConfig(next);
  step(configChanged, `config: backend ${kind}, forge ${forge.kind} (${forge.ssh.host}:${forge.ssh.port})`);

  // The approver is made before anything that could push exists.
  step(approver.init((line) => out(`    ${line}`)), `approver (${approver.kind()}): the key that approves pushes, held on this host`);

  const info = await b.info(ROOT_VM);
  if (info.status === "missing") await b.create(rootSpec());
  step(info.status === "missing", `root VM ${ROOT_VM} created`);
  if (info.status !== "running") {
    if (info.status === "suspended") await b.resume(ROOT_VM);
    else await b.start(ROOT_VM);
  }
  step(info.status !== "running", "root VM running");

  const wasUp = await rootctl<{ keyring: boolean }>("ping", {}, { quiet: true, timeoutMs: 30_000 }).then((r) => r.keyring, () => false);
  // The root does not reach the Mac's loopback or private addresses (root/wall.sh), set
  // before its services start. In a test run only: a stand-in forge on the Mac's loopback or
  // a private address is let through. On a real VM a wall that cannot be set stops here, and
  // from then on stops start.sh too.
  {
    const testing = process.env.DESOLATE_TEST_RUN === "1";
    const standIn = forge.kind === "stand-in" && testing ? forge.ssh.host : null;
    const ports = [...(standIn === "192.168.5.2" ? [forge.ssh.port] : []), ...(testing ? (process.env.DESOLATE_TEST_GATEWAY_PORTS ?? "").split(",").filter(Boolean) : [])].map(String);
    const hosts = standIn && standIn !== "192.168.5.2" && /^\d+\.\d+\.\d+\.\d+$/.test(standIn) ? ["--allow-host", standIn] : [];
    const walled = await backend().exec(ROOT_VM, ["bash", `${guest.release}/root/wall.sh`, "set", ...(backend().isolated ? ["--required"] : []), ...hosts, ...ports], { root: true, timeoutMs: 60_000 });
    if (walled.code !== 0 && backend().isolated) refuse(`the root VM could not be walled off from the Mac's loopback: ${(walled.stderr || walled.stdout).trim().slice(-300)}`, "desolate doctor");
  }
  // A root provisioned from an older image than this desolate's (pins.env, a lock or
  // provision.sh changed since): provisioned again, in place, so what is on its disk (keys,
  // secrets) stays. Its services then start again on what it now has.
  if (b.kind !== "fake") {
    const { imageFingerprint, stampOf } = await import("./image.ts");
    const info = await b.exec(ROOT_VM, ["cat", "/opt/desolate/image-info"], { timeoutMs: 30_000 });
    const stamp = stampOf(info.stdout);
    const fingerprint = imageFingerprint();
    if (stamp !== fingerprint) {
      out(`    the root VM was provisioned from ${stamp ? `image ${stamp}` : "an unstamped image"}; this desolate's is ${fingerprint}: provisioning it again, in place (minutes)`);
      const again = await b.exec(ROOT_VM, ["env", "DESOLATE_IMAGE_KIND=vm", `DESOLATE_IMAGE_FINGERPRINT=${fingerprint}`, "bash", `${guest.release}/image/provision.sh`], { root: true, timeoutMs: 3_600_000 });
      if (again.code !== 0) refuse(`provisioning the root VM again failed: ${(again.stderr || again.stdout).trim().split("\n").slice(-5).join(" | ")}`, "desolate bootstrap again (provision.sh is idempotent); desolate doctor");
      await b.exec(ROOT_VM, ["rm", "-f", "/var/lib/desolate-root/code"], { root: true, timeoutMs: 30_000 });
      step(true, `root VM provisioned again: image ${fingerprint}`);
    }
  }
  const waitKeyring = async () => {
    const up = await waitFor(() => rootctl<{ keyring: boolean }>("ping", {}, { quiet: true, timeoutMs: 30_000 }).then((r) => r.keyring), 30_000, 500);
    if (!up) refuse("the root's keyring did not come up", "desolate doctor");
  };
  // Always: start.sh leaves alone what is running, and starts what a newer desolate added.
  await startRootServices();
  await waitKeyring();
  step(!wasUp, "root services: keyring");
  // What a `destroy` kept of the root before (carry.ts): into this root, if it is new.
  {
    const { restoreRootState } = await import("./carry.ts");
    const held = await rootctl<unknown[]>("keys.list", {}, { quiet: true });
    if (await restoreRootState(out, held.length > 0)) {
      await startRootServices();
      await waitKeyring();
      changed.push("root state put back");
    }
  }
  if (configChanged || !wasUp) await rootctl("forge.set", { forge }, { quiet: true });
  // Every time: the pusher's copy is root's, and the host's word (stack.ts, pinForge).
  await pinForge(forge);
  step(await installApprover(), "root: the approver's public key and the host daemon's token");
  // The host daemon carries the dashboard, and tells the root's state service what only
  // the host knows.
  const { ensureDaemon } = await import("./daemon.ts");
  await ensureDaemon();
  const { reconnectRunning } = await import("./workspaces.ts");
  const reconnected = await reconnectRunning();
  if (reconnected > 0) out(`  = running workspaces: ${reconnected}, each with its proxy and link`);
  const { ui } = await import("./daemon.ts");
  out(`  dashboard    ${(await ui()).dashboard}   (and: desolate ui)`);
  {
    // What a new workspace gets, from this Mac (shared/size.ts): said, so it is never hidden.
    const { stackDefaults } = await import("./workspaces.ts");
    const { describe } = await import("../shared/size.ts");
    const os = await import("node:os");
    out(`  workspaces   ${describe(stackDefaults())} each by default (this Mac: ${os.cpus().length} cores, ${Math.round(os.totalmem() / 1024 ** 3)} GB); per domain: desolate domain <d> size, per workspace: desolate up --cpus --memory --disk`);
  }

  out(changed.length === 0 ? "bootstrap: nothing changed; the stack was already up." : `bootstrap: ${changed.length} step(s) done.`);
  const failed = await doctor(out);
  if (failed > 0) refuse(`bootstrap finished, but doctor found ${failed} problem(s)`, "fix what doctor names, then run `desolate bootstrap` again");
};

/** Checks, with v2 preflight's false-pass discipline: a check that could not be asked is a
 *  failure, never a pass, and every failure names the command that fixes it. Returns how
 *  many failed. */
export const doctor = async (out: Out, json = false): Promise<number> => {
  const checks: Check[] = [];
  const kind = backendKind();
  const b = backend();
  checks.push({ name: "home", ok: fs.existsSync(paths.state), detail: paths.home, fix: "desolate bootstrap" });
  checks.push({
    name: "backend gives isolation", ok: b.isolated || process.env.DESOLATE_TEST_RUN === "1",
    detail: b.isolated ? kind : `${kind}: containers stand in for VMs. NOTHING here is isolated${process.env.DESOLATE_TEST_RUN === "1" ? " (allowed: DESOLATE_TEST_RUN=1)" : ""}`,
    fix: "use a real backend: `desolate destroy --all`, then `desolate bootstrap --backend qemu` (Linux) or `--backend vz` (macOS)",
  });
  try {
    checks.push(...(await b.check()));
  } catch (error) {
    checks.push({ name: "backend", ok: false, detail: `could not be checked: ${String(error)}`, fix: "desolate bootstrap" });
  }
  let rootUp = false;
  try {
    rootUp = (await b.info(ROOT_VM)).status === "running";
    checks.push({ name: "root VM running", ok: rootUp, detail: ROOT_VM, fix: "desolate bootstrap" });
  } catch (error) {
    checks.push({ name: "root VM running", ok: false, detail: `could not be asked: ${String(error)}`, fix: "desolate bootstrap" });
  }
  // What only the root can say. If it cannot be asked, each of these is a failure: a probe
  // that did not run is not a probe that found nothing (P6).
  const rootChecks = ["root: keyring answers", "root: the write agent's askpass socket is closed to the root's own user", "root: private keys are unreadable to the root's own user", "root: the root's own user cannot become root", "root: the programs root runs are root's", "root: each domain's proxies run as that domain's own user", "root: secret values are unreadable to the root's own user", "root: git's settings are root's", "root: approver key installed", "root: forge configured", "root: only the pusher reaches the write agent", "root: the reviewer answers", "root: the pusher answers"];
  let asked: Check[] | null = null;
  if (rootUp)
    try {
      asked = await rootctl<Check[]>("doctor", {}, { quiet: true, timeoutMs: 60_000 });
    } catch {
      asked = null;
    }
  // The approver: this host holds it, and the root must have been given the same key.
  const pem = approver.publicKey();
  checks.push({ name: "approver", ok: approver.kind() !== null && pem !== null, detail: pem ? `${approver.kind()}; pushes are approved on this host` : "this stack has no approver key", fix: "desolate bootstrap" });
  if (asked && pem) {
    const installed = asked.find((check) => check.name === "root: approver key installed");
    // Compared as the root stores it: the PEM text and one newline.
    if (installed?.ok && installed.detail !== `sha256 ${approver.fingerprint(pem.trim() + "\n")}`) Object.assign(installed, { ok: false, detail: "the root holds a different approver key than this host's", fix: "desolate bootstrap" });
  }
  if (asked) checks.push(...asked);
  else for (const name of rootChecks) checks.push({ name, ok: false, detail: "could not be asked: the root does not answer", fix: "desolate bootstrap" });
  // The code the root runs is this desolate's: its share of the release is this folder. A
  // VM keeps the folder it was made with, so a stack made from another checkout (moved, or
  // a second clone) runs that one's code whatever this one says.
  if (rootUp) {
    const { codeFiles, differing } = await import("./image.ts");
    const sums = await b.exec(ROOT_VM, ["bash", "-c", 'cd "$1" && shift && sha256sum -- "$@" 2>/dev/null; true', "_", guest.release, ...codeFiles()], { timeoutMs: 60_000 }).catch(() => null);
    const off = sums ? differing(sums.stdout) : null;
    checks.push({
      name: "root: runs this desolate's code", ok: off !== null && off.length === 0,
      detail: off === null ? "could not be asked" : off.length === 0 ? `its share of the release is ${RELEASE_DIR}` : `${off.length} file(s) differ from ${RELEASE_DIR} (${off.slice(0, 3).join(", ")}${off.length > 3 ? ", ..." : ""}): its VMs were made from another checkout of desolate`,
      fix: "run desolate from the checkout the stack was made from; or, to move it to this one: desolate destroy (it keeps keys, secrets and clones), then desolate bootstrap from here",
    });
  }
  // The editors' and dashboard's port is the daemon's, not another program's (another stack's
  // daemon, say): if it is not, every address printed opens someone else's server.
  {
    const { editorPortError } = await import("./daemon.ts");
    const { editorHostPort } = await import("../shared/names.ts");
    const port = editorHostPort();
    const error = await editorPortError().catch(() => null);
    checks.push({
      name: "host daemon holds its port", ok: error === "",
      detail: error === null ? "the host daemon does not answer" : error === "" ? `127.0.0.1:${port}: the dashboard, the editors and the approval page` : `${error}: every address this stack prints would open that program, not this stack's daemon`,
      fix: error === null ? "desolate bootstrap" : `stop what holds port ${port}, or give this stack another: DESOLATE_EDITOR_PORT=<port> desolate bootstrap`,
    });
  }
  // The Mac's loopback, from the root's own user, asked by trying: a listener of doctor's own
  // on the Mac's 127.0.0.1 (so the port certainly answers there), tried at both addresses
  // Lima's network maps to the Mac; and the wall itself, as root.
  if (rootUp && b.isolated) {
    const server = createServer((socket) => socket.end("mac\n"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const tried = await b.exec(ROOT_VM, ["bash", "-c", `for a in 192.168.5.2 192.168.5.3; do timeout 4 bash -c "</dev/tcp/$a/${port}" 2>/dev/null && echo "$a REACHED" || echo "$a refused"; done`], { timeoutMs: 30_000 });
      const wall = await b.exec(ROOT_VM, ["nft", "list", "table", "inet", "desolate_wall"], { root: true, timeoutMs: 30_000 });
      const reached = tried.stdout.split("\n").filter((line) => line.endsWith("REACHED")).map((line) => line.split(" ")[0]);
      const ok = tried.code === 0 && reached.length === 0 && /192\.168\.5\.0\/24 reject/.test(wall.stdout);
      checks.push({ name: "root: the Mac's loopback is walled off", ok, detail: ok ? `the root's own user cannot reach a port that answers on the Mac's 127.0.0.1, at 192.168.5.2 or .3` : reached.length ? `the root's own user reached the Mac's 127.0.0.1 at ${reached.join(", ")}` : "the root VM's wall is not set", fix: "desolate bootstrap" });
    } finally {
      server.close();
    }
  }

  const failed = checks.filter((check) => !check.ok);
  if (json) out(JSON.stringify({ ok: failed.length === 0, backend: kind, isolated: b.isolated, checks }, null, 2));
  else {
    for (const check of checks) out(`  ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}${check.ok || !check.fix ? "" : `\n         fix: ${check.fix}`}`);
    out(failed.length === 0 ? "doctor: all checks passed." : `doctor: ${failed.length} of ${checks.length} checks FAILED.`);
  }
  return failed.length;
};

/** Stop everything, keep everything: every workspace VM, the host daemon, the root VM. The
 *  way back is `desolate bootstrap`, then `desolate start` for each workspace wanted. */
export const down = async (out: Out) => {
  const b = backend();
  const { stopForwarder } = await import("./daemon.ts");
  const vms = await b.list();
  for (const vm of vms.filter((v) => v.name !== ROOT_VM && v.status === "running")) {
    out(`  - stopping ${vm.labels.title ?? vm.name}`);
    await b.stop(vm.name);
    if (vm.labels.domain && vm.labels.workspace) await rootctl("workspace.state", { domain: vm.labels.domain, name: vm.labels.workspace, state: "stopped" }, { quiet: true }).catch(() => {});
  }
  await stopForwarder();
  if (vms.some((v) => v.name === ROOT_VM && v.status === "running")) {
    out("  - stopping the root VM");
    await b.stop(ROOT_VM);
  }
  out("down: nothing of this stack is running; nothing was removed. To come back: desolate bootstrap, then desolate start <domain>/<workspace>.");
};

/** Put the machine back as it was. With --all the home goes too. Returns what is left that
 *  should not be (an empty list is the passing answer; the test asserts it). */
export const destroy = async (options: { all: boolean }, out: Out): Promise<string[]> => {
  const b = backend();
  // Without --all the home stays, and so must what the root holds that is not in it
  // (carry.ts). A root whose state could not be kept is not removed.
  if (!options.all) {
    const { keepRootState } = await import("./carry.ts");
    try {
      await keepRootState(out);
    } catch (error) {
      refuse(`nothing was removed: ${(error as Error).message}`, "desolate doctor; to remove everything anyway, home and keys included: desolate destroy --all");
    }
  }
  const { stopForwarder } = await import("./daemon.ts");
  await stopForwarder();
  for (const vm of await b.list()) {
    out(`  - VM ${vm.name}${vm.labels.title ? ` (${vm.labels.title})` : ""}`);
    await b.destroy(vm.name);
  }
  if (options.all) {
    fs.rmSync(paths.home, { recursive: true, force: true });
    out(`  - ${paths.home}`);
  } else {
    fs.rmSync(paths.run, { recursive: true, force: true });
  }
  const left: string[] = [];
  for (const vm of await b.list()) left.push(`VM ${vm.name}`);
  if (options.all && fs.existsSync(paths.home)) left.push(paths.home);
  out(left.length === 0 ? "destroy: nothing of this stack is left." : `destroy: STILL PRESENT: ${left.join(", ")}`);
  return left;
};

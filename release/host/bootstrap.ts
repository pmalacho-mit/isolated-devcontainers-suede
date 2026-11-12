// bootstrap, doctor, destroy (section 13.1).
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
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
  // Always: start.sh leaves alone what is running, and starts what a newer desolate added.
  {
    await startRootServices();
    const up = await waitFor(() => rootctl<{ keyring: boolean }>("ping", {}, { quiet: true, timeoutMs: 30_000 }).then((r) => r.keyring), 30_000, 500);
    if (!up) refuse("the root's keyring did not come up", "desolate doctor");
  }
  step(!wasUp, "root services: keyring");
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

// The project's devcontainer, inside this workspace's VM (section 4.2, shape A).
//
//   node devcontainer.ts <workspace>      as the workspace's user, after init.ts
//
// The devcontainer CLI runs HERE, against the checkout's own devcontainer.json, with the
// VM's own dockerd. Whatever the spec asks for (privileged, mounts, a Dockerfile, features,
// compose, lifecycle commands) happens inside this VM, so there is no spec policy as v2
// had: the VM is the boundary, and nothing in a spec reaches the VM's shares, link or
// forwarded ports, which are decided outside it (P5).
//
// What desolate adds to the spec, through --override-config (which changes the JSON the
// CLI parses and nothing else: relative paths still resolve beside the project's own file;
// measured in v2 on this CLI version):
//   - /workspaces mounted at /workspaces, and the checkout's own path as the folder: a
//     domain clone borrows the mirror's objects and its worktrees name each other by
//     absolute path, so git works in the container only if paths are the VM's;
//   - the VM's network (--network=host), for a single-container spec: the container's
//     traffic takes the VM's one way out with nothing more to arrange, and a dev server
//     in it is a listener in the VM, which is what the host's forwarder publishes;
//   - the mirrors (read-only), the inbox (read-only), the outbox, desolate's own CLI and
//     status script, the editor's server (read-only), and the trust store that holds the
//     domain's CA.
// A compose spec gets the same, in its primary service (`service`), with two differences:
//   - its network stays its own: the services find each other by name. Instead svcnet.ts
//     runs in the primary service, and the VM's wsd mirrors each of its listeners, and each
//     `forwardPorts` entry written `service:port`, onto the VM's loopback (bridge.ts). The
//     host then forwards them like a single container's; what a service publishes
//     (`ports:`) is docker's own listener in the VM and needs nothing;
//   - the VM's /workspaces is mounted over whatever the project's compose file mounts at
//     /workspaces (compose merges a service's volumes by target), and the folder is the
//     checkout's own path: the domain's worktrees name their .git by the VM's absolute
//     path, so git works in the service only on the VM's paths. A project mount elsewhere
//     (`..:/src`) is kept beside it. The other services get nothing of desolate's.
//
// The environment is the first checkout that has a spec (section 4.5, way 1). It is not
// frozen and its features are not pinned to digests yet.
//
// This never fails the workspace. With no spec, or a spec that does not come up, the
// workspace is the VM itself, and /run/desolate/devcontainer.json says which and why.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { readJson, writeJson } from "../shared/json.ts";
import { parse as parseJsonc } from "../shared/jsonc.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { run, sleep } from "../shared/run.ts";

export const STATE = "/run/desolate/devcontainer.json";
export type State =
  | { state: "none"; why: string }
  | { state: "failed"; why: string; config: string }
  | { state: "up"; containerId: string; remoteUser: string; folder: string; config: string; override: string; checkout: string; hostNetwork: boolean; glibc: boolean; compose: boolean; extensions: string[]; image: string; note?: string;
      /** compose: svcnet.ts's socket in the primary service, when it answers (bridge.ts) */
      bridge?: string;
      /** compose: `forwardPorts` entries naming another service, for bridge.ts */
      forwards?: { port: number; host: string }[] };

/** svcnet.ts's socket: in /run/desolate, which the primary service shares with the VM. */
export const SVCNET = "/run/desolate/svcnet.sock";

export const locate = (dir: string): string | undefined => {
  const nested = path.join(dir, ".devcontainer", "devcontainer.json");
  const flat = path.join(dir, ".devcontainer.json");
  return fs.existsSync(nested) ? nested : fs.existsSync(flat) ? flat : undefined;
};

const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9._-]+)?$/;
/** customizations.vscode.extensions (and any other editor's namespace), valid ids only. */
export const extensionsOf = (spec: Record<string, unknown>): string[] => {
  const ids = new Set<string>();
  const customizations = spec.customizations;
  if (typeof customizations === "object" && customizations !== null)
    for (const namespace of Object.values(customizations as Record<string, unknown>)) {
      const list = (namespace as { extensions?: unknown } | null)?.extensions;
      for (const id of Array.isArray(list) ? list : []) if (typeof id === "string" && EXTENSION_ID.test(id)) ids.add(id);
    }
  return [...ids];
};

const ENV_CA = "/desolate/ca/ca-certificates.crt";
/** Where package managers keep their downloads, in the domain's cache (section 4.7, C4):
 *  what one workspace of a domain fetched, the next finds. Only download caches, never where
 *  a tool installs itself (CARGO_HOME, GOPATH's bin): those belong to the image. */
export const CACHE_ENV: Record<string, string> = {
  npm_config_cache: "/desolate/cache/npm",
  npm_config_store_dir: "/desolate/cache/pnpm",
  YARN_CACHE_FOLDER: "/desolate/cache/yarn",
  PIP_CACHE_DIR: "/desolate/cache/pip",
  UV_CACHE_DIR: "/desolate/cache/uv",
  GOMODCACHE: "/desolate/cache/go-mod",
};
/** The spec desolate hands the CLI: the project's, plus what the header lists. */
export const overrideOf = (spec: Record<string, unknown>, checkout: string, home: string, who: { domain: string; workspace: string } = { domain: "", workspace: "" }): Record<string, unknown> => {
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const env = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  const compose = spec.dockerComposeFile !== undefined;
  // For compose, the CLI writes each mount into its override file as `source:target` and
  // drops every other option, `readonly` among them (read in CLI 0.88.0), so the mode rides
  // in the target, which it copies as it is: `source:target:ro` is compose's own syntax.
  const bind = (source: string, target: string, readonly = false) =>
    compose ? `source=${source},target=${target}${readonly ? ":ro" : ""},type=bind` : `source=${source},target=${target},type=bind${readonly ? ",readonly" : ""}`;
  const ours = [
    bind("/desolate/mirrors", "/desolate/mirrors", true),
    bind("/desolate/inbox", "/desolate/inbox", true),
    bind("/desolate/outbox", "/desolate/outbox"),
    bind("/desolate/release", "/desolate/release", true),
    bind("/run/desolate", "/run/desolate"),
    bind("/opt/desolate/editor", "/opt/desolate/editor", true),
    bind(`${home}/.desolate-editor`, "/desolate/editor-data"),
    bind("/etc/ssl/certs", "/desolate/ca", true),
    bind("/usr/local/bin/node", "/desolate/bin/node", true),
    bind("/desolate/release/workspace/desolate", "/usr/local/bin/desolate", true),
    bind("/desolate/release/workspace/status", "/desolate/status", true),
    bind("/desolate/cache", "/desolate/cache"),
  ];
  const containerEnv = {
    // git in the container: the mirror and the checkouts are owned by the VM's user, which
    // may not be the container's.
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*",
    // The domain's CA (for its secrets' hosts) is in the VM's bundle; tools that take
    // their roots from the environment are pointed at it.
    SSL_CERT_FILE: ENV_CA, NODE_EXTRA_CA_CERTS: ENV_CA, REQUESTS_CA_BUNDLE: ENV_CA, CURL_CA_BUNDLE: ENV_CA, GIT_SSL_CAINFO: ENV_CA,
    DESOLATE_WORKSPACE: "1",
    // Which workspace this is, for `desolate offer` and the rest inside the container (the
    // VM's ~/.desolate/workspace.json is not in the container's home).
    DESOLATE_DOMAIN: who.domain,
    DESOLATE_WORKSPACE_NAME: who.workspace,
    // The domain's package caches (C4), where the container can see them.
    ...CACHE_ENV,
    ...env(spec.containerEnv),
  };
  if (compose) return { ...spec, workspaceFolder: checkout, mounts: [...list(spec.mounts), ...ours, bind("/workspaces", "/workspaces")], containerEnv };
  return {
    ...spec,
    workspaceMount: bind("/workspaces", "/workspaces"),
    workspaceFolder: checkout,
    mounts: [...list(spec.mounts), ...ours],
    runArgs: [...list(spec.runArgs).filter((arg) => typeof arg !== "string" || !/^--net(work)?(=|$)/.test(arg)), "--network=host"],
    containerEnv,
  };
};

/** `forwardPorts` entries that name another compose service (`db:5432`): what bridge.ts
 *  carries there. A bare number, or the primary service's own name, needs nothing: every
 *  listener of the primary service is mirrored already. */
export const forwardsOf = (spec: Record<string, unknown>): { port: number; host: string }[] => {
  const out = new Map<number, string>();
  for (const entry of Array.isArray(spec.forwardPorts) ? spec.forwardPorts : []) {
    const match = typeof entry === "string" ? /^([A-Za-z0-9][A-Za-z0-9._-]{0,62}):(\d{1,5})$/.exec(entry) : null;
    if (!match) continue;
    const [host, port] = [match[1]!, Number(match[2])];
    if (port < 1024 || port > 65535 || host === spec.service || host === "localhost" || host === "127.0.0.1" || out.has(port)) continue;
    out.set(port, host);
  }
  return [...out].map(([port, host]) => ({ port, host }));
};

/** svcnet.ts in the primary service, as the VM's user, with the editor's node (a glibc
 *  program, as the editor's server is). Kept if one already answers. */
const startSvcnet = async (id: string): Promise<boolean> => {
  const answers = () =>
    new Promise<boolean>((resolve) => {
      const conn = net.connect(SVCNET);
      conn.setTimeout(1000, () => conn.destroy());
      conn.on("connect", () => conn.write("L\n"));
      conn.on("data", () => resolve(true));
      conn.on("error", () => resolve(false));
      conn.on("close", () => resolve(false));
    });
  if (await answers()) return true;
  const started = await run("docker", ["exec", "-d", "-u", `${process.getuid!()}:${process.getgid!()}`, id, "/opt/desolate/editor/node", "--disable-warning=ExperimentalWarning", "/desolate/release/workspace/svcnet.ts", SVCNET]);
  if (started.code !== 0) return false;
  for (let i = 0; i < 50; i++) {
    if (await answers()) return true;
    await sleep(100);
  }
  return false;
};

const main = async () => {
  const name = process.argv[2] ?? "";
  const plan = readJson<WorkspacePlan | null>(`/desolate/inbox/workspaces/${name}.json`, null);
  const done = (state: State) => {
    writeJson(STATE, state);
    process.stdout.write(state.state === "up" ? `devcontainer: up (${state.image}, user ${state.remoteUser}${state.compose ? ", compose" : ""})${state.note ? `; note: ${state.note}` : ""}\n` : `devcontainer: ${state.state === "none" ? "none" : "FAILED"}: ${state.why}\n`);
  };
  if (!plan) return done({ state: "none", why: `the root sent no plan for the workspace '${name}'` });
  // The domain's environment: the repository it names, else the first checkout with a spec.
  const checkout = plan.checkouts.find((c) => c.repo === plan.env && locate(c.path) !== undefined) ?? plan.checkouts.find((c) => locate(c.path) !== undefined);
  if (!checkout) return done({ state: "none", why: "no checkout has a devcontainer.json; this workspace is the VM itself" });
  const config = locate(checkout.path)!;
  let spec: Record<string, unknown>;
  try {
    const parsed: unknown = parseJsonc(fs.readFileSync(config, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("it is not an object");
    spec = parsed as Record<string, unknown>;
  } catch (error) {
    return done({ state: "failed", why: `${config} cannot be read: ${(error as Error).message}`, config });
  }
  for (let waited = 0; (await run("docker", ["info"], { timeoutMs: 20_000 })).code !== 0; waited += 500) {
    if (waited > 90_000) return done({ state: "failed", why: "the VM's docker daemon is not answering (see /var/lib/desolate/dockerd.log)", config });
    await sleep(500);
  }
  const home = os.homedir();
  fs.mkdirSync(`${home}/.desolate-editor`, { recursive: true, mode: 0o700 });
  const merged = overrideOf(spec, checkout.path, home, { domain: plan.domain, workspace: plan.workspace });
  const text = JSON.stringify(merged, null, 2);
  const dir = `${home}/.desolate-devcontainer`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const override = path.join(dir, "devcontainer.json");
  // A spec that changed since the container was made gets a new container.
  const digest = createHash("sha256").update(text).digest("hex");
  const changed = fs.existsSync(override) && readJson<string>(path.join(dir, "digest.json"), "") !== digest;
  fs.writeFileSync(override, text);
  writeJson(path.join(dir, "digest.json"), digest);
  // A spec with features makes the CLI write a lockfile beside it, into the checkout, where
  // an agent's `git add -A` takes it (seen in the promo). Unless the project keeps a
  // lockfile of its own (then it is verified, as the project asked), none is written.
  const lockfile = path.join(path.dirname(config), path.basename(config).startsWith(".") ? ".devcontainer-lock.json" : "devcontainer-lock.json");
  const noLockfile = fs.existsSync(lockfile) ? [] : ["--no-lockfile"];
  const up = await run("devcontainer", ["up", "--workspace-folder", checkout.path, "--config", config, "--override-config", override, ...noLockfile, ...(changed ? ["--remove-existing-container"] : [])], { timeoutMs: 3_600_000, env: { ...process.env, DOCKER_BUILDKIT: "1" } });
  fs.writeFileSync(path.join(dir, "up.log"), `${up.stderr}\n${up.stdout}`);
  let result: { outcome?: string; containerId?: string; remoteUser?: string; remoteWorkspaceFolder?: string; message?: string; description?: string } = {};
  try {
    result = JSON.parse(up.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    /* no result line */
  }
  if (up.code !== 0 || result.outcome !== "success" || !result.containerId) {
    // The CLI's own summary is general ("An error occurred setting up the container"); the
    // line that says what happened is docker's or the build's, further up its log.
    const cause = up.stderr.split("\n").map((line) => line.replace(/^\[[^\]]*\]\s*/, "").trim()).filter((line) => /error|denied|not found|no such|failed|refused/i.test(line) && !/^at /.test(line) && !/control manifest/.test(line)).pop();
    const summary = (result.description ?? result.message ?? "devcontainer up failed").replace(/\s+/g, " ");
    return done({ state: "failed", why: `${summary.slice(0, 160)}${cause ? ` (${cause.replace(/\s+/g, " ").slice(0, 240)})` : ""} (the whole log: ${dir}/up.log in the workspace)`, config });
  }
  const id = result.containerId;
  const inspect = await run("docker", ["inspect", "-f", "{{.HostConfig.NetworkMode}} {{.Config.Image}}", id]);
  const [network, image] = inspect.stdout.trim().split(" ");
  // The editor's server is a glibc program: it can run in the container only on glibc.
  const glibc = (await run("docker", ["exec", id, "sh", "-c", "ls /lib/ld-linux-*.so.* /lib64/ld-linux-*.so.* 2>/dev/null | head -1"])).stdout.trim() !== "";
  // A repository that keeps files in Git LFS, in a container without git-lfs: committing such
  // a file fails there ("git-lfs: command not found"). Said, not changed: the environment is
  // the project's.
  let usesLfs = false;
  try {
    usesLfs = /filter=lfs/.test(fs.readFileSync(path.join(checkout.path, ".gitattributes"), "utf8"));
  } catch {
    /* no .gitattributes */
  }
  const lfsMissing = usesLfs && (await run("docker", ["exec", id, "sh", "-c", "git lfs version"])).code !== 0;
  // A compose service's own network, reached from the VM (bridge.ts): its listeners, its
  // `service:port` forwards, and the editor's server when it runs there.
  const compose = spec.dockerComposeFile !== undefined;
  const bridged = compose && network !== "host" && glibc && (await startSvcnet(id));
  // The environment `devcontainer exec` gives a command (remoteEnv, and what its probe of the
  // user's login shell finds), worked out once, here: enter.sh then enters with `docker
  // exec` and this, in 20 ms rather than the CLI's 300 to 400 (measured on the M1), every
  // `desolate exec` and every editor terminal. Made again whenever the container is.
  const probed = await run("devcontainer", ["exec", "--workspace-folder", checkout.path, "--config", config, "--override-config", override, "sh", "-c", "env -0 2>/dev/null || env"], { timeoutMs: 120_000 });
  const execEnv = path.join(dir, "exec-env.json");
  fs.rmSync(execEnv, { force: true });
  if (probed.code === 0) {
    const entries = (probed.stdout.includes("\0") ? probed.stdout.split("\0") : probed.stdout.split("\n"))
      .filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(entry) && !/^(PWD|OLDPWD|SHLVL|_|TERM|HOSTNAME)=/.test(entry));
    fs.writeFileSync(execEnv, JSON.stringify({ containerId: id, user: result.remoteUser ?? "root", env: entries }), { mode: 0o600 });
  }
  const notes = [
    ...(lfsMissing ? ["this repository keeps files in Git LFS and the container has no git-lfs, so committing them fails there; add the feature ghcr.io/devcontainers/features/git-lfs:1 to its devcontainer.json"] : []),
    ...(compose && network !== "host" && !bridged ? [`its service's ports are not forwarded and the editor runs in the VM: ${glibc ? "desolate's port relay did not start in it" : "it is not a glibc container, which desolate's port relay and the editor need"}`] : []),
  ];
  done({ state: "up", containerId: id, remoteUser: result.remoteUser ?? "root", folder: result.remoteWorkspaceFolder ?? checkout.path, config, override, checkout: checkout.path, hostNetwork: network === "host", glibc, compose, extensions: extensionsOf(spec),
    image: (compose ? `service ${String(spec.service)}` : String(spec.image ?? image ?? "built")).slice(0, 120),
    ...(bridged ? { bridge: SVCNET, forwards: forwardsOf(spec) } : {}),
    ...(notes.length ? { note: notes.join("; ") } : {}) });
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();

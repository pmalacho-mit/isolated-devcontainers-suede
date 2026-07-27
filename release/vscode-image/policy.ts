// policy.ts -- the spec policy the broker enforces before starting a project.
//
// Pure and side-effect free ON PURPOSE: everything here is a function of its
// arguments, so tests/unit/broker exercises it without docker, without the
// devcontainer CLI, and without a running stack.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// The editor container can write any /workspaces/<proj>/.devcontainer/
// devcontainer.json and then ask the broker to start that project. So every
// containment property of the stack that is NOT enforced by the kernel is
// enforced here. Five classes of escape were demonstrated against the previous
// version of this policy (see tests/unit/broker/policy.test.ts, which keeps a
// regression case for each):
//
//   1. initializeCommand    -- runs on the machine driving the CLI, i.e. INSIDE
//                              the orchestrator, with DOCKER_HOST set. Arbitrary
//                              code execution against the inner daemon.
//   2. dockerComposeFile    -- compose-mode projects declare privileged / pid:
//                              host / network_mode: host / "/:/host" in the
//                              compose file, which the old policy never read.
//   3. features             -- a devcontainer feature's own metadata injects
//                              privileged, capAdd, securityOpt and mounts. The
//                              old policy only looked at top-level keys.
//   4. JSONC divergence     -- a regex comment-stripper disagreed with the real
//                              parser, so `mounts` could be visible to the CLI
//                              and invisible to the policy.
//   5. runArgs denylist     -- "--network=host" was refused but "--network host",
//                              "--net=host" and "--pid=container:x" were not.
//
// The corresponding structural answers, in the same order: refuse the key;
// refuse the mode; enforce on the CLI's own mergedConfiguration; use a real
// JSONC scanner; allowlist instead of denylist.

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------
/**
 * Strip JSONC comments and trailing commas with a real scanner.
 *
 * The previous implementation was two regexes. It disagreed with the parser the
 * devcontainer CLI actually uses, and the disagreement was exploitable: a `/*`
 * inside a *string* opened a comment for the stripper but not for the CLI, so
 * everything up to the next `*\/` -- including a whole `"mounts"` line --
 * vanished from the policy's view while the CLI still honoured it.
 *
 * A scanner cannot have that class of bug, because it tracks string state.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    // Inside a string: copy verbatim through the closing quote, honouring
    // backslash escapes. Comment starts are just characters in here.
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        if (text[i] === "\\" && i + 1 < n) { out += text[i] + text[i + 1]; i += 2; continue; }
        out += text[i];
        if (text[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }

    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;          // drop to end of line
      continue;
    }

    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;                                          // skip the closing */
      continue;
    }

    out += c;
    i++;
  }

  // Trailing commas: JSONC allows them, JSON.parse does not. Only reached
  // outside strings because the loop above already consumed string bodies --
  // but we re-scan defensively rather than regexing over raw text.
  return removeTrailingCommas(out);
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c; i++;
      while (i < n) {
        if (text[i] === "\\" && i + 1 < n) { out += text[i] + text[i + 1]; i += 2; continue; }
        out += text[i];
        if (text[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") { i++; continue; }   // drop the comma
    }
    out += c;
    i++;
  }
  return out;
}

/** Parse a devcontainer.json (JSONC). Throws on anything unparseable. */
export function parseJsonc(text: string): any {
  return JSON.parse(stripJsonc(text));
}

// ---------------------------------------------------------------------------
// runArgs: ALLOWLIST
// ---------------------------------------------------------------------------
// A denylist has to enumerate every spelling of every dangerous flag, and
// docker accepts many: --network=host, --network host, --net=host, --net host,
// --pid=container:<id>, --uts=host, --cgroupns=host ... all of which the old
// denylist let through. An allowlist fails the other way: an unknown flag is
// refused, and adding one is a reviewed change to this file.

/** Flags that take a value (either "--flag v" or "--flag=v"). */
export const RUNARG_VALUE_FLAGS = new Set([
  "--cap-drop",
  "--security-opt",
  "--pids-limit",
  "--memory", "-m", "--memory-swap", "--memory-reservation",
  "--cpus", "--cpu-shares", "--cpuset-cpus",
  "--shm-size",
  "--ulimit",
  "--label", "-l",
  "--hostname", "-h",
  "--env", "-e",
  "--workdir", "-w",
  "--user", "-u",
  "--stop-signal",
  "--stop-timeout",
  "--tmpfs",
]);

/** Flags that take no value. */
export const RUNARG_BOOL_FLAGS = new Set([
  "--read-only",
  "--init",
  "--interactive", "-i",
  "--tty", "-t",
]);

// --security-opt exists to HARDEN (no-new-privileges:true). These values undo
// the sandbox instead, so they are refused even though the flag is allowed.
const SECURITY_OPT_DENY = [
  /unconfined/i,          // seccomp=unconfined, apparmor=unconfined
  /label\s*=\s*disable/i, // SELinux off
  /^seccomp\s*=\s*[./]/i, // a profile loaded from a project-writable path
];

// ---------------------------------------------------------------------------
// Mounts
// ---------------------------------------------------------------------------
/**
 * The docker-in-docker feature mounts a volume for the nested daemon's
 * /var/lib/docker, named dind-var-lib-docker-<devcontainerId>. That name is
 * outside the project's namespace and the feature -- not the project -- picks
 * it, so the namespace rule cannot see it as legitimate.
 *
 * It is allowed only for projects that opted into privileged mode (see
 * allowPrivileged below), because docker-in-docker implies that opt-in anyway.
 * This is a CODE-level allowance, not a project-controlled one.
 */
const FEATURE_VOLUME_ALLOW = [/^dind-var-lib-docker-/];

/** The read-only public proxy CA. Injected by desolate, never by a project --
 *  but tolerated in project config so a copied devcontainer.json is not a
 *  confusing hard failure. Nothing secret lives there (public cert only). */
const CA_BIND_SOURCE = "/desolate-ca";

/** Split "source=x,target=y,type=volume" into a field map. */
export function parseMountSpec(spec: string): Record<string, string> {
  return Object.fromEntries(
    spec.split(",").map(kv => {
      const i = kv.indexOf("=");
      return i < 0 ? [kv.trim(), ""] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
}

interface NormalMount { type: string; source: string; target: string; raw: string }

/** devcontainer.json accepts mounts as strings OR objects; normalise both. */
export function normalizeMount(m: unknown): NormalMount {
  if (typeof m === "string") {
    const f = parseMountSpec(m);
    return {
      type: f["type"] ?? "",
      source: f["source"] ?? f["src"] ?? "",
      target: f["target"] ?? f["dst"] ?? f["destination"] ?? "",
      raw: m,
    };
  }
  const o = (m ?? {}) as Record<string, unknown>;
  return {
    type: String(o.type ?? ""),
    source: String(o.source ?? o.src ?? ""),
    target: String(o.target ?? o.dst ?? o.destination ?? ""),
    raw: JSON.stringify(m),
  };
}

// ---------------------------------------------------------------------------
// Policy input
// ---------------------------------------------------------------------------
export interface ResolvedSpec {
  /** The raw devcontainer.json, parsed by the SAME parser the CLI uses --
   *  in production this is `devcontainer read-configuration`'s .configuration. */
  configuration: any;
  /** `.mergedConfiguration` from `read-configuration --include-merged-configuration`:
   *  the project's config with every feature's metadata merged in. This is
   *  where feature-injected privileged/capAdd/securityOpt/mounts show up, and
   *  enforcing on it is what makes feature escapes impossible rather than
   *  merely inconvenient. */
  mergedConfiguration?: any;
}

export interface PolicyOptions {
  workspaces?: string;
}

export class PolicyError extends Error {}

const fail = (msg: string): never => { throw new PolicyError(msg); };

/**
 * Throws PolicyError with a specific reason if the project asks for anything
 * outside its own trust domain. Returns silently when the spec is acceptable.
 */
export function enforcePolicy(
  project: string,
  spec: ResolvedSpec,
  opts: PolicyOptions = {},
): void {
  const WORKSPACES = opts.workspaces ?? "/workspaces";
  const cfg = spec.configuration ?? {};
  const merged = spec.mergedConfiguration ?? {};

  // -- 0. Modes we cannot police -------------------------------------------
  // A compose-mode devcontainer's privilege lives in the compose file, which
  // this policy does not read. Rather than pretend to validate it, refuse the
  // mode: everything dangerous (privileged, pid: host, network_mode: host,
  // "/:/host") is expressible there and none of it is visible here.
  if (cfg.dockerComposeFile !== undefined) {
    fail('compose-based devcontainers ("dockerComposeFile") are not supported: ' +
         "their privilege is declared in the compose file, which this policy " +
         "cannot validate. Use an image/Dockerfile devcontainer, and run compose " +
         "INSIDE it with the docker-in-docker feature.");
  }

  // initializeCommand runs on the machine driving the devcontainer CLI. That
  // machine is the orchestrator container, and it holds the inner daemon
  // socket -- so this key is arbitrary code execution against the daemon the
  // editor is not allowed to touch. The in-container lifecycle hooks
  // (onCreate/updateContent/postCreate/postStart/postAttach) are fine and stay
  // allowed: they run inside the project's own container.
  for (const key of ["initializeCommand"]) {
    if (cfg[key] !== undefined || merged[key] !== undefined) {
      fail(`"${key}" is not allowed: it executes on the orchestrator (which holds ` +
           `the inner Docker socket), not inside your container. Use ` +
           `"postCreateCommand" / "onCreateCommand" instead -- those run in the container.`);
    }
  }

  // Arbitrary flags to `docker build` (e.g. --network=host) are as good as
  // arbitrary runArgs.
  if (cfg.build?.options !== undefined) {
    fail('"build.options" is not allowed (arbitrary docker build flags)');
  }

  // appPort makes the inner daemon publish inside dind's namespace, which is
  // exactly where desolate's relays bind.
  if (cfg.appPort !== undefined) {
    fail('remove "appPort"; declare customizations.desolate.ports instead');
  }

  // -- 1. Privilege ---------------------------------------------------------
  // Explicit opt-in, in the project's own config, because the docker-in-docker
  // feature legitimately needs it. This is NOT a boundary against a compromised
  // editor (which can write the opt-in itself) -- it exists so that privilege
  // is never inherited SILENTLY from a third-party feature, and so that
  // `git log` shows which projects are in the escalated tier.
  const allowPrivileged = cfg.customizations?.desolate?.allowPrivileged === true;

  if (merged.privileged === true || cfg.privileged === true) {
    if (!allowPrivileged) {
      fail("this spec requests a PRIVILEGED container (often pulled in by a " +
           "feature such as docker-in-docker). Privileged containers can reach " +
           "sibling projects' data on the inner daemon. If that is intended, " +
           'declare it explicitly: "customizations": { "desolate": ' +
           '{ "allowPrivileged": true } }');
    }
  }

  const capAdd: string[] = [...(merged.capAdd ?? []), ...(cfg.capAdd ?? [])].map(String);
  if (capAdd.length && !allowPrivileged) {
    fail(`capability additions are not allowed (requested: ${capAdd.join(", ")}). ` +
         "Add them via an explicit allowPrivileged opt-in if genuinely required.");
  }

  for (const so of [...(merged.securityOpt ?? []), ...(cfg.securityOpt ?? [])].map(String)) {
    if (SECURITY_OPT_DENY.some(re => re.test(so))) {
      fail(`securityOpt '${so}' is not allowed (it weakens the sandbox)`);
    }
  }

  // -- 2. Mounts ------------------------------------------------------------
  // Enforced over the MERGED mount list, so a feature cannot smuggle one in.
  const projectMounts = (cfg.mounts ?? []).map(normalizeMount);
  const mergedMounts = (merged.mounts ?? []).map(normalizeMount);
  const projectRaw = new Set(projectMounts.map(m => `${m.type}|${m.source}|${m.target}`));

  for (const m of [...projectMounts, ...mergedMounts]) {
    const key = `${m.type}|${m.source}|${m.target}`;
    const fromFeature = !projectRaw.has(key);
    const origin = fromFeature ? "a feature" : "this project";

    if (m.type === "bind" && m.source === CA_BIND_SOURCE) continue;  // public CA, read-only

    if (m.type !== "volume") {
      fail(`mount type '${m.type}' requested by ${origin} is not allowed ` +
           `(volumes only -- a bind mount reaches the inner daemon's filesystem, ` +
           `where every other project lives): ${m.raw}`);
    }

    if (m.source === project || m.source.startsWith(`${project}-`)) continue;

    if (fromFeature && allowPrivileged && FEATURE_VOLUME_ALLOW.some(re => re.test(m.source))) {
      continue;   // e.g. dind-var-lib-docker-<id>, for an opted-in DinD project
    }

    fail(`volume '${m.source}' (requested by ${origin}) is outside this project's ` +
         `namespace -- a project may only mount volumes named '${project}' or '${project}-*'`);
  }

  // -- 3. runArgs -----------------------------------------------------------
  const runArgs: string[] = [...(cfg.runArgs ?? []), ...(merged.runArgs ?? [])].map(String);
  for (let i = 0; i < runArgs.length; i++) {
    const arg = runArgs[i];
    if (!arg.startsWith("-")) {
      fail(`runArgs entry '${arg}' is not a flag; bare values are only allowed ` +
           `immediately after an allowed value-taking flag`);
    }
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;

    if (RUNARG_BOOL_FLAGS.has(flag)) {
      if (inlineValue !== undefined && !/^(true|false)$/i.test(inlineValue)) {
        fail(`runArgs '${arg}' is not allowed (${flag} takes no value)`);
      }
      continue;
    }

    if (!RUNARG_VALUE_FLAGS.has(flag)) {
      fail(`runArgs flag '${flag}' is not on the allowlist. Allowed: ` +
           `${[...RUNARG_VALUE_FLAGS, ...RUNARG_BOOL_FLAGS].sort().join(" ")}. ` +
           `(Namespace, device, privilege and mount flags are deliberately absent -- ` +
           `they would let a project out of its own container.)`);
    }

    // Consume the value, whether inline or as the next entry, so it is never
    // mistaken for a flag on the next iteration.
    let value: string;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      value = runArgs[i + 1] ?? "";
      if (value === "" || value.startsWith("-")) {
        fail(`runArgs '${flag}' expects a value`);
      }
      i++;
    }

    if (flag === "--security-opt" && SECURITY_OPT_DENY.some(re => re.test(value))) {
      fail(`--security-opt '${value}' is not allowed (it weakens the sandbox)`);
    }
    if (flag === "--tmpfs" && !value.startsWith("/")) {
      fail(`--tmpfs '${value}' must be an absolute in-container path`);
    }
  }

  // -- 4. workspaceMount ----------------------------------------------------
  // A substring check would be unsound: "source=/,target=/workspaces/foo"
  // mentions the project while mounting the inner daemon's root.
  const wsMount = cfg.workspaceMount ?? merged.workspaceMount;
  if (typeof wsMount === "string") {
    const f = parseMountSpec(wsMount);
    const own = `${WORKSPACES}/${project}`;
    const src = f["source"] ?? f["src"] ?? "";
    const dst = f["target"] ?? f["dst"] ?? f["destination"] ?? "";
    if (src !== own || dst !== own) {
      fail(`workspaceMount must bind exactly ${own} (got source='${src}' target='${dst}')`);
    }
  }
}

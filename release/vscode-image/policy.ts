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
 * The docker-in-docker feature mounts volumes for the nested daemon's state:
 * dind-var-lib-docker-<devcontainerId> for /var/lib/docker, and
 * dind-var-lib-containerd-<devcontainerId> for /var/lib/containerd. Those names
 * are outside the project's namespace and the feature -- not the project --
 * picks them, so the namespace rule cannot see them as legitimate.
 *
 * They are allowed only for projects that opted into privileged mode (see
 * allowPrivileged below), because docker-in-docker implies that opt-in anyway.
 * This is a CODE-level allowance, not a project-controlled one.
 *
 * The `-<devcontainerId>` suffix is what keeps this safe: the CLI substitutes a
 * value it derives from the workspace folder, so one project cannot name
 * another's. The trailing `-` is therefore load-bearing -- a bare
 * `dind-var-lib-docker` (no suffix) is NOT this feature's volume and stays
 * refused.
 */
const FEATURE_VOLUME_ALLOW = [
  /^dind-var-lib-docker-/,
  /^dind-var-lib-containerd-/,
];

/** The read-only public proxy CA. Injected by desolate, never by a project --
 *  but tolerated in project config so a copied devcontainer.json is not a
 *  confusing hard failure. Nothing secret lives there (public cert only). */
const CA_BIND_SOURCE = "/desolate-ca";

/** A project name usable as a docker object name.
 *
 *  Projects may be nested one level -- `owner/repo` -- so that repositories from
 *  different owners can share a repo name. Docker volume and container names
 *  cannot contain `/`, so everything that becomes a docker object goes through
 *  here, and both sides of the volume-namespace check below must use the SAME
 *  encoding or a project would fail to mount its own volumes.
 *
 *  `__` rather than `_`, so `a/b` and `a_b` do not collide. A directory named
 *  literally `a__b` still would; that is documented rather than defended
 *  against, because project names come from directories a human made. */
export const volumeNamespace = (project: string): string => project.replace(/\//g, "__");

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
   *  merely inconvenient.
   *
   *  REQUIRED, not optional -- it used to be `mergedConfiguration?: any` with a
   *  `?? {}` default at the top of enforcePolicy, and that combination was a
   *  quiet fail-OPEN in a design that is fail-closed everywhere else. With merged
   *  absent the policy still ran, still returned successfully, and no longer
   *  saw ANY feature-injected privilege, capability or mount -- i.e. it reverted
   *  to the strength it had before the E3 escape was fixed, with nothing said.
   *  It is also the only thing that normalises types (see TRUTHINESS below), so
   *  losing it re-opens the string-typed `privileged` bypass too. */
  mergedConfiguration: any;
}

export interface PolicyOptions {
  workspaces?: string;
  /** Every project directory currently under `workspaces`, used to settle
   *  volume-namespace collisions. Optional so the policy stays pure and
   *  testable; when absent the prefix rule alone applies, which is the old
   *  (looser) behaviour. The broker always supplies it. */
  projects?: string[];
}

export class PolicyError extends Error {}

const fail = (msg: string): never => { throw new PolicyError(msg); };

// ---------------------------------------------------------------------------
// TRUTHINESS, not equality
// ---------------------------------------------------------------------------
// The devcontainer CLI decides these by plain JS truthiness -- from its bundle:
//     privileged&&d.push("--privileged")
// so `"privileged": "true"` (a STRING) yields a privileged container. The policy
// tested `=== true`, which is false for a string, so the two disagreed about the
// same spec -- and a disagreement between "what the policy saw" and "what gets
// started" is the definition of a bypass here.
//
// It was not exploitable, purely because mergedConfiguration normalises the type
// before we see it (measured: configuration reports 'true' the string, merged
// reports the boolean). But that made a load-bearing protection depend on an
// undocumented normalisation in someone else's tool. Matching the CLI's own rule
// removes the dependency: anything the CLI would act on, we act on.
//
// Note `"false"` is TRUTHY in JS, so it requires the opt-in too. That is correct
// -- the CLI would make such a container privileged.
const truthy = (v: unknown): boolean => Boolean(v);

/** Normalise a field the spec allows as either a scalar or a list.
 *
 *  Spreading these blind was its own bug: `[...(cfg.capAdd ?? [])]` on the string
 *  "SYS_ADMIN" spreads into ELEVEN single characters, and `(cfg.mounts ?? [])
 *  .map(...)` on a string throws "cfg.mounts.map is not a function" -- both
 *  fail-closed, but reported as gibberish. The CLI itself coerces a lone string
 *  to a one-element array (measured: capAdd 'SYS_ADMIN' -> ['SYS_ADMIN']), so
 *  match that, and refuse only types the CLI would not accept either. */
function asList(value: unknown, key: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];      // as the CLI coerces it
  return fail(`"${key}" must be a string or an array (got ${typeof value})`);
}

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

  // FAIL CLOSED on a missing merged config rather than defaulting it to {}.
  // Enforcing on mergedConfiguration is what makes a feature unable to smuggle
  // in privilege, capabilities or mounts; running without it is not a degraded
  // check, it is a different and much weaker policy. If we cannot see what the
  // features contribute, we do not get to approve the spec. (broker.ts refuses to
  // accept a read-configuration result that lacks the key, so reaching this is a
  // programming error rather than a spec someone wrote -- which is exactly why it
  // should be loud.)
  if (spec.mergedConfiguration === undefined || spec.mergedConfiguration === null) {
    fail("internal: the resolved spec carries no mergedConfiguration, so " +
         "feature-injected privilege, capabilities and mounts are invisible -- " +
         "refusing to approve it. Resolve with " +
         "`read-configuration --include-merged-configuration`.");
  }
  const merged = spec.mergedConfiguration;

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

  // truthy, not `=== true`: the CLI acts on truthiness, so `"privileged": "true"`
  // starts a privileged container. See the note on `truthy` above.
  if (truthy(merged.privileged) || truthy(cfg.privileged)) {
    if (!allowPrivileged) {
      fail("this spec requests a PRIVILEGED container (often pulled in by a " +
           "feature such as docker-in-docker). Privileged containers can reach " +
           "sibling projects' data on the inner daemon. If that is intended, " +
           'declare it explicitly: "customizations": { "desolate": ' +
           '{ "allowPrivileged": true } }');
    }
  }

  const capAdd: string[] = [...asList(merged.capAdd, "capAdd"),
                            ...asList(cfg.capAdd, "capAdd")].map(String);
  if (capAdd.length && !allowPrivileged) {
    fail(`capability additions are not allowed (requested: ${capAdd.join(", ")}). ` +
         "Add them via an explicit allowPrivileged opt-in if genuinely required.");
  }

  for (const so of [...asList(merged.securityOpt, "securityOpt"),
                    ...asList(cfg.securityOpt, "securityOpt")].map(String)) {
    if (SECURITY_OPT_DENY.some(re => re.test(so))) {
      fail(`securityOpt '${so}' is not allowed (it weakens the sandbox)`);
    }
  }

  // -- 2. Mounts ------------------------------------------------------------
  // Enforced over the MERGED mount list, so a feature cannot smuggle one in.
  const projectMounts = asList(cfg.mounts, "mounts").map(normalizeMount);
  const mergedMounts = asList(merged.mounts, "mounts").map(normalizeMount);
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

    // A project owns `<project>` and `<project>-*` -- but a bare prefix test is
    // not enough, because project names can prefix each other. With projects
    // `web` and `web-api`, `web-api-secrets` starts with `web-`, so `web` could
    // mount it: exactly the volume the README tells you to keep a database
    // password in. `web`/`web-api` is an ordinary way to name two services, so
    // this is not an exotic collision.
    //
    // Resolve it by longest claim: among the projects that actually exist, the
    // one with the longest matching prefix owns the volume. `web-api` beats
    // `web` for `web-api-secrets`, so `web` is refused.
    const ns = volumeNamespace(project);
    if (m.source === ns || m.source.startsWith(`${ns}-`)) {
      const owner = (opts.projects ?? [])
        .map(p => ({ project: p, ns: volumeNamespace(p) }))
        .filter(o => m.source === o.ns || m.source.startsWith(`${o.ns}-`))
        .sort((a, b) => b.ns.length - a.ns.length)[0];
      if (owner === undefined || owner.project === project) continue;
      fail(`volume '${m.source}' (requested by ${origin}) belongs to project ` +
           `'${owner.project}', not '${project}' -- '${ns}-*' also matches names ` +
           `that start with '${ns}-', and the longer project owns them`);
    }

    if (fromFeature && allowPrivileged && FEATURE_VOLUME_ALLOW.some(re => re.test(m.source))) {
      continue;   // e.g. dind-var-lib-docker-<id>, for an opted-in DinD project
    }

    // The single most likely way a NESTED project trips this rule, and the
    // hardest to guess from the message alone: `${localWorkspaceFolderBasename}`
    // expands to the LAST path segment only, so the standard
    //   "source=${localWorkspaceFolderBasename}-node_modules,..."
    // idiom from Microsoft's own docs yields 'suede-node_modules' for
    // 'pmalacho-mit/suede' -- a name outside the project's namespace, and one
    // that two different owners' same-named repos would both claim. Refusing is
    // correct (that shared volume is exactly the cross-project leak this rule
    // exists to stop), but saying only "outside your namespace" sends people
    // hunting through a devcontainer.json that looks textbook.
    const base = project.split("/").pop()!;
    const looksLikeBasenameIdiom =
      project.includes("/") && (m.source === base || m.source.startsWith(`${base}-`));

    fail(`volume '${m.source}' (requested by ${origin}) is outside this project's ` +
         `namespace -- a project may only mount volumes named ` +
         `'${volumeNamespace(project)}' or '${volumeNamespace(project)}-*'` +
         (project.includes("/")
           ? ` (a nested project '${project}' owns the '${volumeNamespace(project)}' namespace,` +
             ` because docker names cannot contain '/')`
           : "") +
         (looksLikeBasenameIdiom
           ? `.\n      This looks like '\${localWorkspaceFolderBasename}', which expands to ` +
             `'${base}'\n      -- the last path segment only, so the owner is dropped and two owners' ` +
             `\n      '${base}' repos would both claim '${m.source}'. Name it explicitly instead:` +
             `\n        "source=${volumeNamespace(project)}-${m.source.startsWith(`${base}-`) ? m.source.slice(base.length + 1) : "data"},..."`
           : ""));
  }

  // -- 3. runArgs -----------------------------------------------------------
  const runArgs: string[] = [...asList(cfg.runArgs, "runArgs"),
                             ...asList(merged.runArgs, "runArgs")].map(String);
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
  //
  // SOURCE and TARGET are not the same kind of check, and conflating them was a
  // bug for nested projects. The source is the security-relevant half -- it is
  // what decides which of the inner daemon's directories enters the container --
  // so it must be exactly this project's own directory, no alternatives.
  //
  // The target is where that directory appears inside the container, and there
  // are two legitimate answers, because the devcontainer CLI derives its own
  // default from ${localWorkspaceFolderBasename} -- the LAST path segment only.
  // For 'pmalacho-mit/suede' that is /workspaces/suede, not
  // /workspaces/pmalacho-mit/suede. Demanding the mirrored path refused a nested
  // project for writing out the CLI's own default verbatim, while the identical
  // mount created implicitly (the CLI derives it; the spec never names it) was
  // never checked at all. Accept both spellings; desolate mirrors the outer path
  // for nested projects, and a project that prefers the basename default is not
  // reaching outside itself by saying so.
  const wsMount = cfg.workspaceMount ?? merged.workspaceMount;
  if (typeof wsMount === "string") {
    const f = parseMountSpec(wsMount);
    const own = `${WORKSPACES}/${project}`;
    const basename = `${WORKSPACES}/${project.split("/").pop()}`;
    const src = f["source"] ?? f["src"] ?? "";
    const dst = f["target"] ?? f["dst"] ?? f["destination"] ?? "";
    if (src !== own) {
      fail(`workspaceMount must have source=${own} exactly (got source='${src}') -- ` +
           `the source decides which of the inner daemon's directories enters ` +
           `your container`);
    }
    if (dst !== own && dst !== basename) {
      fail(`workspaceMount target must be ${own}` +
           (basename === own ? "" : ` or ${basename}`) +
           ` (got target='${dst}')`);
    }
  }
}

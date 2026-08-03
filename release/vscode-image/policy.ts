// policy.ts -- the spec policy the broker enforces before starting a project.
//
// Pure and side-effect free (so it's easy to test)
import { posix } from "node:path";
import type { ResolvedSpec } from "./devcontainer.ts";
import { volumeNamespace } from "./projects.ts";
import {
  isWithin,
  type ItemFromSet,
  type JSONValue,
  nonNullObject,
  readonlySet,
} from "./utils.ts";

const allowlist = (() => {
  /** Flags that take a value (either "--flag v" or "--flag=v"). */
  const values = new Set([
    "--cap-drop",
    "--security-opt",
    "--pids-limit",
    "--memory",
    "-m",
    "--memory-swap",
    "--memory-reservation",
    "--cpus",
    "--cpu-shares",
    "--cpuset-cpus",
    "--shm-size",
    "--ulimit",
    "--label",
    "-l",
    "--hostname",
    "-h",
    "--env",
    "-e",
    "--workdir",
    "-w",
    "--user",
    "-u",
    "--stop-signal",
    "--stop-timeout",
    "--tmpfs",
  ] as const);

  return {
    runargs: {
      values: readonlySet(values),
      bools: readonlySet(
        new Set([
          "--read-only",
          "--init",
          "--interactive",
          "-i",
          "--tty",
          "-t",
        ] as const),
      ),
      deny: {
        "--security-opt": [
          /unconfined/i, // seccomp=unconfined, apparmor=unconfined
          /label\s*=\s*disable/i, // SELinux off
          /^seccomp\s*=\s*[./]/i, // a profile loaded from a project-writable path
        ],
      } satisfies Partial<Record<ItemFromSet<typeof values>, RegExp[]>>,
    },
    featureVolumes: [
      /**
       * The docker-in-docker feature mounts volumes for the nested daemon's state:
       * dind-var-lib-docker-<devcontainerId> for /var/lib/docker, and
       * dind-var-lib-containerd-<devcontainerId> for /var/lib/containerd.
       *
       * The `-<devcontainerId>` suffix is what keeps this safe: the CLI substitutes a
       * value it derives from the workspace folder, so one project cannot name
       * another's. The trailing `-` is therefore load-bearing -- a bare
       * `dind-var-lib-docker` (no suffix) is NOT this feature's volume and stays
       * refused.
       */
      ...[/^dind-var-lib-docker-/, /^dind-var-lib-containerd-/],
    ],
  } as const;
})();

/** The read-only public proxy CA. Injected by desolate, never by a project --
 *  but tolerated in project config so a copied devcontainer.json is not a
 *  confusing hard failure. Nothing secret lives there (public cert only). */
const CA_BIND_SOURCE = "/desolate-ca";

interface NormalMount {
  type: string;
  source: string;
  target: string;
  raw: string;
}

export const mount = {
  /** Split "source=x,target=y,type=volume" into a field map. */
  parse: (spec: string) =>
    Object.fromEntries(
      spec.split(",").map((kv) => {
        const index = kv.indexOf("=");
        return index < 0
          ? [kv.trim(), ""]
          : [kv.slice(0, index).trim(), kv.slice(index + 1).trim()];
      }),
    ),
  /** devcontainer.json accepts mounts as strings OR objects; normalize both. */
  normalize: (query: unknown): NormalMount => {
    if (typeof query === "string") {
      const spec = mount.parse(query);
      return {
        type: spec["type"] ?? "",
        source: spec["source"] ?? spec["src"] ?? "",
        target: spec["target"] ?? spec["dst"] ?? spec["destination"] ?? "",
        raw: query,
      };
    }
    const obj = (query ?? {}) as Record<string, unknown>;
    return {
      type: String(obj.type ?? ""),
      source: String(obj.source ?? obj.src ?? ""),
      target: String(obj.target ?? obj.dst ?? obj.destination ?? ""),
      raw: JSON.stringify(query),
    };
  },
  identity: ({ type, source, target }: NormalMount) =>
    `${type}|${source}|${target}`,
  requiresOwnership: (project: string, { source }: NormalMount) => {
    const namespace = volumeNamespace(project);
    return source === namespace || source.startsWith(`${namespace}-`);
  },
  /** Which project owns this volume name.
   *
   *  A bare prefix test is not enough, because project names can prefix each
   *  other: `web-api-secrets` starts with `web-`, so `web` would otherwise
   *  reach the volume the README tells you to keep `web-api`'s password in.
   *  The LONGEST matching claim wins, so `web-api` beats `web`. */
  owner: (projects: string[], mounted: NormalMount) =>
    projects
      .filter((project) => mount.requiresOwnership(project, mounted))
      .sort((a, b) => volumeNamespace(b).length - volumeNamespace(a).length)
      .at(0),
  /** The public proxy CA, which desolate injects into every project. */
  isPublicCa: ({ type, source }: NormalMount) =>
    type === "bind" && source === CA_BIND_SOURCE,
  /** e.g. dind-var-lib-docker-<id>, for an opted-in docker-in-docker project. */
  isFeatureVolume: ({ source }: NormalMount) =>
    allowlist.featureVolumes.some((regex) => regex.test(source)),
};

export class PolicyError extends Error {}

const format = {
  /**
   * Reflow a message written across source lines onto one line.
   *
   * Only the line breaks and the indentation that follows them are touched, so
   * spacing the author wrote WITHIN a line -- around an interpolation, inside
   * quotes -- survives verbatim.
   * @param strings
   * @param values
   * @returns
   */
  single: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings
        .reduce(
          (result, current, index) =>
            result + String(values[index - 1]) + current,
        )
        .replace(/\s*\n\s*/g, " ")
        .trim(),
    {
      withLeadingSpace: (strings: TemplateStringsArray, ...values: unknown[]) =>
        " " + format.single(strings, ...values),
    },
  ),
};

/**
 * @throws A PolicyError witht the template strings formatted as a single line.
 * @param strings
 * @param values
 */
const fail = (strings: TemplateStringsArray, ...values: unknown[]): never => {
  throw new PolicyError(format.single(strings, ...values));
};

const reader = ({ configuration, mergedConfiguration }: ResolvedSpec) => {
  if (!nonNullObject(mergedConfiguration))
    fail`
      internal: the resolved spec carries no mergedConfiguration, so
      feature-injected privilege, capabilities, and mounts are invisible --
      refusing to approve it. There must've been an issue with
      \`read-configuration --include-merged-configuration\`.`;

  if (!nonNullObject(configuration))
    fail`
      internal: the resolved spec carries no configuration, so the keys a
      project declared cannot be told apart from the ones a feature injected
      -- refusing to approve it.`;

  const read = <T extends JSONValue = JSONValue>(
    key: string,
  ): T | undefined => {
    if (
      mergedConfiguration[key] === undefined &&
      configuration[key] !== undefined
    )
      return fail`
        internal: this project declares "${key}", but the CLI's
        \`mergedConfiguration\` does not carry it -- the merged shape has changed
        (renamed or reshaped), so this policy would be enforcing on a key that
        no longer exists. Refusing to approve it.`;

    return mergedConfiguration[key] as T;
  };

  const desolate = (key: string) =>
    nonNullObject(configuration.customizations) &&
    "desolate" in configuration.customizations &&
    nonNullObject(configuration.customizations.desolate)
      ? configuration.customizations.desolate[key]
      : undefined;

  const asList = (value: JSONValue | undefined, key: string) => {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return [value]; // as the CLI coerces it
    return fail`"${key}" must be a string or an array (got ${typeof value})`;
  };

  return Object.assign(read, {
    asList: <T extends JSONValue = JSONValue>(key: string) =>
      asList(read(key), key) as T[],
    /** Read value off configuration (instead of using merged, the source of truth) */
    unsafe: Object.assign((key: string) => configuration[key], {
      asList: <T extends JSONValue = JSONValue>(key: string) =>
        asList(configuration[key], key) as T[],
    }),
    truthy: (key: string) => Boolean(read(key)),
    /**
     * desolate customizations are read from the raw configuration (unmerged)
     */
    desolate,
  });
};

type Payload = Readonly<{
  project: string;
  workspaces: string;
  projects: string[];
  read: ReturnType<typeof reader>;
  namespace: string;
}>;

const helpers = {
  allowPrivileged: ({ read }: Pick<Payload, "read">) =>
    read.desolate("allowPrivileged") === true,
  disallowedSecurityOption: (option: string) =>
    allowlist.runargs.deny["--security-opt"].some((regex) =>
      regex.test(option),
    ),
  basename: (payloadOrProject: Pick<Payload, "project"> | string) =>
    (typeof payloadOrProject === "string"
      ? payloadOrProject
      : payloadOrProject.project
    )
      .split("/")
      .pop()!,
  /**
   * Refuse a volume outside the project's namespace, with the two hints that make
   * the refusal actionable.
   */
  refuseForeignVolume: (
    { project, namespace }: Pick<Payload, "project" | "namespace">,
    mounted: NormalMount,
    origin: string,
  ): never => {
    const basename = helpers.basename(project);

    const nested = project.includes("/")
      ? format.single.withLeadingSpace`
          (a nested project '${project}' owns the '${namespace}' namespace, 
          because docker names cannot contain '/')`
      : "";

    const suffix = mounted.source.startsWith(`${basename}-`)
      ? mounted.source.slice(basename.length + 1)
      : "data";

    const idiom =
      project.includes("/") &&
      (mounted.source === basename || mounted.source.startsWith(`${basename}-`))
        ? format.single.withLeadingSpace`
            This looks like '\${localWorkspaceFolderBasename}', which expands to 
            '${basename}' -- the last path segment only, so the owner is dropped 
            and two owners' '${basename}' repos would both claim '${mounted.source}'. 
            Name it explicitly instead: "source=${namespace}-${suffix},..."`
        : "";

    return fail`
      volume '${mounted.source}' (requested by ${origin}) is outside this project's
      namespace -- a project may only mount volumes named '${namespace}' or
      '${namespace}-*'${nested}.${idiom}`;
  },
  ensureMountIsWithinNamespace: (
    payload: Payload,
    mounted: NormalMount,
    fromFeature: boolean,
  ) => {
    const { project, projects, namespace } = payload;
    const origin = fromFeature ? "a feature" : "this project";

    if (mount.isPublicCa(mounted)) return;

    if (mounted.type !== "volume")
      return fail`
        mount type '${mounted.type}' requested by ${origin} is not allowed
        (volumes only -- a bind mount reaches the inner daemon's filesystem,
        where every other project lives): ${mounted.raw}`;

    if (mount.requiresOwnership(project, mounted)) {
      const owner = mount.owner(projects, mounted);
      if (owner === undefined || owner === project) return;

      return fail`
        volume '${mounted.source}' (requested by ${origin}) belongs to project
        '${owner}', not '${project}' -- '${namespace}-*' also matches names that
        start with '${namespace}-', and the longer project owns them`;
    }

    if (
      fromFeature &&
      helpers.allowPrivileged(payload) &&
      mount.isFeatureVolume(mounted)
    )
      return;

    return helpers.refuseForeignVolume(payload, mounted, origin);
  },
  /**
   * The directory the CLI resolves this spec's relative paths against.
   *
   * Ground truth, from `read-configuration`, for the same reason the rest of
   * this file enforces on `mergedConfiguration`: deriving it here would be a
   * guess about which layout the CLI picked, and the CLI is the one that
   * resolves `build.context`. It cannot be spoofed by writing `configFilePath`
   * into devcontainer.json -- the CLI overwrites the key with the path it
   * actually read (measured on @devcontainers/cli 0.88.0) -- and it is checked
   * against the project anyway, so a future CLI that stopped overwriting it
   * would fail closed here rather than open somewhere else.
   */
  configDirectory: ({ read, project, workspaces }: Payload) => {
    const declared = read<{ fsPath?: string }>("configFilePath") ?? null;
    const file =
      nonNullObject(declared) && typeof declared.fsPath === "string"
        ? declared.fsPath
        : undefined;

    if (!file)
      return fail`
        internal: the resolved spec does not say which file the CLI read
        ("configFilePath"), so there is no way to tell what a relative
        "build.context" would resolve to -- refusing to approve it`;

    const directory = posix.dirname(file);
    const root = posix.join(workspaces, project);
    if (!isWithin(root, directory))
      return fail`
        internal: the CLI read this project's configuration from '${file}',
        which is outside '${root}' -- refusing to approve it`;

    return { directory, root };
  },
  runArgs: {
    /**
     * Parse the name of an arg, and extract it's inline value (e.g. flag=value)
     * if it exists
     * @param arg
     * @returns
     */
    parse: (arg: string) => {
      const equals = arg.indexOf("=");
      return {
        flag: equals >= 0 ? arg.slice(0, equals) : arg,
        inline: equals >= 0 ? arg.slice(equals + 1) : undefined,
      };
    },
    /**
     * Read `runArgs` as the (flag, value) pairs it denotes, refusing any flag that
     * is not on the allowlist and any allowed flag whose value is missing.
     * @param args
     * @throws if flag is not on allowlist or was provided incorrectly
     * (e.g. a value flag with no value, or a boolean flag with a value)
     */
    *allowedPairs(args: string[]) {
      const { values, bools } = allowlist.runargs;

      for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (!arg.startsWith("-"))
          fail`
            runArgs entry '${arg}' is not a flag; bare values are only allowed
            immediately after an allowed value-taking flag`;

        const { flag, inline } = helpers.runArgs.parse(arg);

        if (bools.has(flag as ItemFromSet<typeof bools>)) {
          if (inline !== undefined && !/^(true|false)$/i.test(inline))
            fail`runArgs '${arg}' is not allowed (${flag} takes no value)`;
          continue;
        }

        if (!values.has(flag as ItemFromSet<typeof values>))
          fail`
            runArgs flag '${flag}' is not on the allowlist. Allowed:
            ${[...values, ...bools].sort().join(" ")}.
            (Namespace, device, privilege and mount flags are deliberately absent
            -- they would let a project out of its own container.)`;

        if (inline !== undefined) {
          yield { flag, value: inline };
          continue;
        }

        const next = args[index + 1] ?? "";
        if (next === "" || next.startsWith("-"))
          fail`runArgs '${flag}' expects a value`;
        index++; // the value is consumed here, so it is never read as a flag
        yield { flag, value: next };
      }
    },
  },
};

type Check = (payload: Payload) => void;

const checks = {
  noCompose: ({ read }) => {
    if (read("dockerComposeFile") !== undefined)
      return fail`
        compose-based devcontainers ("dockerComposeFile") are not supported:
        their privilege is declared in the compose file, which this policy
        cannot validate. Use an image/Dockerfile devcontainer, and run compose
        INSIDE it with the docker-in-docker feature.
      `;
  },
  noInitializeCommand: ({ read }) => {
    if (read("initializeCommand") !== undefined)
      return fail`
        "initializeCommand" is not allowed: it executes on the orchestrator (which holds
        the inner Docker socket), not inside your container. Use
        "postCreateCommand" / "onCreateCommand" instead -- those run in the container.`;
  },
  noBuildOptions: ({ read }) => {
    if (read<{ options: any }>("build")?.options !== undefined)
      return fail`"build.options" is not allowed (arbitrary docker build flags)`;
  },
  noAppPorts: ({ read }) => {
    if (read("appPort") !== undefined)
      return fail`Remove "appPort"; declare \`customizations.desolate.ports\` instead`;
  },
  privilegeMustBeExplicit: (payload) => {
    if (payload.read.truthy("privileged"))
      if (!helpers.allowPrivileged(payload))
        return fail`
          this spec requests a PRIVILEGED container (often pulled in by a
          feature such as docker-in-docker). Privileged containers can reach
          sibling projects' data on the inner daemon. 
          If that is intended, declare it explicitly: 
          "customizations": { "desolate": { "allowPrivileged": true } }`;
  },
  capAddsOnlyWhenPrivileged: (payload) => {
    const capAdd = payload.read.asList("capAdd").map(String);
    if (capAdd.length && !helpers.allowPrivileged(payload))
      return fail`
        capability additions are not allowed (requested: ${capAdd.join(", ")}).
        Add them via an explicit allowPrivileged opt-in if genuinely required.`;
  },
  securityOptKeepsTheSandbox: ({ read }) => {
    for (const option of read.asList("securityOpt").map(String))
      if (helpers.disallowedSecurityOption(option))
        return fail`securityOpt '${option}' is not allowed (it weakens the sandbox)`;
  },
  mountsStayInOwnNamespace: (payload) => {
    const { read } = payload;

    // Raw, not merged: whatever the merged view carries that the project did not
    // write itself is a feature's, and only a feature gets the dind allowance.
    const writtenByProject = new Set(
      read.unsafe.asList("mounts").map(mount.normalize).map(mount.identity),
    );

    for (const mounted of read.asList("mounts").map(mount.normalize))
      helpers.ensureMountIsWithinNamespace(
        payload,
        mounted,
        !writtenByProject.has(mount.identity(mounted)),
      );
  },
  runArgsOnAllowlist: ({ read }) => {
    const args = read.asList("runArgs").map(String);
    for (const { flag, value } of helpers.runArgs.allowedPairs(args)) {
      if (flag === "--security-opt" && helpers.disallowedSecurityOption(value))
        return fail`--security-opt '${value}' is not allowed (it weakens the sandbox)`;

      if (flag === "--tmpfs" && !value.startsWith("/"))
        return fail`--tmpfs '${value}' must be an absolute in-container path`;
    }
  },
  buildPathsStayInOwnProject: (payload) => {
    const { read } = payload;

    const build = read<{ context?: string; dockerfile?: string }>("build") ?? null;
    const declared: [key: string, value: JSONValue | undefined][] = [
      ["build.context", nonNullObject(build) ? build.context : undefined],
      ["build.dockerfile", nonNullObject(build) ? build.dockerfile : undefined],
      // The pre-"build" spelling. The CLI still accepts it, and a rule that
      // only knew the modern one would be a rule with a synonym for a bypass.
      ["context", read("context")],
      ["dockerFile", read("dockerFile")],
    ];

    if (declared.every(([, value]) => value === undefined)) return;

    const { directory, root } = helpers.configDirectory(payload);

    for (const [key, value] of declared) {
      if (value === undefined) continue;
      if (typeof value !== "string")
        return fail`"${key}" must be a string (got ${typeof value})`;

      // The CLI resolves these against the directory the config was READ from
      // -- the live project, not the snapshot -- so ".." is the project root
      // for a .devcontainer/ layout and /workspaces for a flat one. Both are
      // spelled the same way in the file, which is why the base comes from the
      // CLI rather than from a guess about the layout.
      const resolved = posix.resolve(directory, value);
      if (!isWithin(root, resolved))
        return fail`
          "${key}" is '${value}', which resolves to '${resolved}' -- outside
          this project's folder ('${root}'). The build context is read from
          disk and shipped to the daemon, so a path that leaves the project
          copies somebody else's files into an image this project owns:
          '"context": "../.."' is every sibling project's source code. Keep
          build inputs inside the project.`;
    }
  },
  workspaceMountIsOwnFolder: ({ read, project, workspaces }) => {
    const declared = read("workspaceMount");
    if (!declared) return;

    const mounted = mount.normalize(declared);
    const full = `${workspaces}/${project}`;
    const fromWorkspaces = `${workspaces}/${helpers.basename(project)}`;

    if (mounted.source !== full)
      return fail`
        workspaceMount must have source=${full} exactly (got
        source='${mounted.source}') -- the source decides which of the inner
        daemon's directories enters your container`;

    if (mounted.target !== full && mounted.target !== fromWorkspaces) {
      const options =
        fromWorkspaces === full ? full : `${full} or ${fromWorkspaces}`;
      return fail`
        workspaceMount target must be ${options} (got target='${mounted.target}')`;
    }
  },
} satisfies Record<string, Check>;

const checker = (
  ...[project, spec, workspaces, projects]: Parameters<typeof enforcePolicy>
) => {
  const namespace = volumeNamespace(project);
  const read = reader(spec);
  const payload: Payload = { project, workspaces, projects, namespace, read };
  return Object.entries(checks).reduce(
    (acc, [key, check]) => {
      acc[key as keyof typeof checks] = check.bind(null, payload);
      return acc;
    },
    {} as Record<keyof typeof checks, () => void>,
  );
};

/**
 * Throws PolicyError with a specific reason if the project asks for anything
 * outside its own trust domain. Returns silently when the spec is acceptable.
 * @param project // todo
 * @param spec // todo
 * @param workspaces //todo
 * @param projects //todo
 * @throws PolicyError with a specific reason if the project asks for anything
 * outside its own trust domain.
 * @returns nothing (when the spec is acceptable)
 */
export function enforcePolicy(
  project: string,
  spec: ResolvedSpec,
  workspaces: string,
  projects: string[],
): void {
  const checks = checker(project, spec, workspaces, projects);

  checks.noCompose();
  checks.noInitializeCommand();
  checks.noBuildOptions();
  checks.noAppPorts();
  checks.privilegeMustBeExplicit();
  checks.capAddsOnlyWhenPrivileged();
  checks.securityOptKeepsTheSandbox();
  checks.mountsStayInOwnNamespace();
  checks.runArgsOnAllowlist();
  checks.buildPathsStayInOwnProject();
  checks.workspaceMountIsOwnFolder();
}

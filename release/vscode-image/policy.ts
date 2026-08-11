// What a project may ask for in its devcontainer.json, and nothing else.
//
// Pure and side-effect free.
import { posix } from "node:path";
import type { ResolvedSpec } from "./devcontainer.ts";
import type { Target } from "./projects.ts";
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
    /** Avoid dangerous mounts like:
     * - `volume-driver=local`
     * - `volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/` */
    mountFields: {
      type: ["type"],
      source: ["source", "src"],
      target: ["target", "dst", "destination"],
      readonly: ["readonly", "ro"],
      consistency: ["consistency"],
    } as const,
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

type MountField = keyof (typeof allowlist)["mountFields"];

export const mount = {
  aliases: new Map(
    Object.entries(allowlist.mountFields).flatMap(([canonical, spellings]) =>
      spellings.map((spelling) => [spelling, canonical as MountField] as const),
    ),
  ) as ReadonlyMap<string, MountField>,
  /**
   * Split "source=x,target=y,type=volume" into a field map keyed by CANONICAL
   * name, refusing any field docker understands and this policy does not.
   *
   * @throws PolicyError on an unknown, unparseable or quoted field.
   */
  parse: (spec: string): Partial<Record<MountField, string>> => {
    if (spec.includes('"'))
      fail`
        mount '${spec}' contains a double quote. Docker parses a --mount as CSV,
        where a quoted field may contain the comma this policy reads as a field
        separator -- so the two would not necessarily see the same mount.
        Refusing rather than parsing it a second way.`;

    const fields: Partial<Record<MountField, string>> = {};

    for (const field of spec.split(",")) {
      const index = field.indexOf("=");
      const spelling = (index < 0 ? field : field.slice(0, index))
        .trim()
        .toLowerCase();

      if (!spelling)
        return fail`
          mount '${spec}' has an empty field (a stray or trailing comma).
          Refusing rather than guessing which field was meant.`;

      const canonical = mount.aliases.get(spelling);
      if (!canonical)
        return fail`
          mount field '${spelling}' (in '${spec}') is not on the allowlist.
          Allowed: ${[...mount.aliases.keys()].sort().join(" ")}.
          (Driver and driver-option fields are deliberately absent: they can
          turn a volume named inside this project's namespace into a bind mount
          of the inner daemon's filesystem, where every other project lives.)`;

      // Last wins, as docker does.
      fields[canonical] = index < 0 ? "" : field.slice(index + 1).trim();
    }

    return fields;
  },
  /** devcontainer.json accepts mounts as strings OR objects; normalize both.
   *
   *  The object branch reads `type`/`source`/`target` and nothing else, because
   *  that is exactly what the CLI rebuilds an object mount from. A `src` key on
   *  an object is dropped by the CLI, so reading it here would have this policy
   *  approving a mount docker never receives.
   *
   *  @throws PolicyError if a string mount cannot be parsed (see `parse`). */
  normalize: (query: unknown): NormalMount => {
    if (typeof query === "string") {
      const fields = mount.parse(query);
      return {
        type: fields.type ?? "",
        source: fields.source ?? "",
        target: fields.target ?? "",
        raw: query,
      };
    }
    const obj = (query ?? {}) as Record<string, unknown>;
    return {
      type: String(obj.type ?? ""),
      source: String(obj.source ?? ""),
      target: String(obj.target ?? ""),
      raw: JSON.stringify(query),
    };
  },
  identity: ({ type, source, target }: NormalMount) =>
    `${type}|${source}|${target}`,
  requiresOwnership: (namespace: string, { source }: NormalMount) =>
    source === namespace || source.startsWith(`${namespace}-`),
  /** Which target owns this volume name.
   *
   *  A bare prefix test is not enough, because namespaces can prefix each
   *  other: `web-api-secrets` starts with `web-`, so `web` would otherwise
   *  reach the volume the README tells you to keep `web-api`'s password in.
   *  The LONGEST matching claim wins, so `web-api` beats `web`.
   *
   *  That same rule is what keeps a worktree out of its project's volumes and
   *  vice versa: `acme__widgets--wt--feature` is longer than `acme__widgets`,
   *  so the worktree wins its own names and the project keeps the rest. */
  owner: (targets: Target[], mounted: NormalMount) =>
    targets
      .filter(({ namespace }) => mount.requiresOwnership(namespace, mounted))
      .sort((a, b) => b.namespace.length - a.namespace.length)
      .at(0),
  /** The public proxy CA, which desolate injects into every project. */
  isPublicCa: ({ type, source }: NormalMount) =>
    type === "bind" && source === CA_BIND_SOURCE,
  /** e.g. dind-var-lib-docker-<id>, for an opted-in docker-in-docker project. */
  isFeatureVolume: ({ source }: NormalMount) =>
    allowlist.featureVolumes.some((regex) => regex.test(source)),
};

export const feature = {
  /**
   * Where the CLI will look for this feature, judged by the SHAPE of its id.
   *
   * An allowlist of the two remote spellings, for the same reason `runArgs` is
   * an allowlist: the interesting answer is "somewhere on this filesystem",
   * and a denylist of the path spellings the CLI understands today
   * (`./x`, `../x`, `/x`) is a list that a future CLI can quietly extend.
   * Anything not recognisably remote is `unknown`, and refused.
   */
  origin: (id: string) => {
    if (/^https:\/\//i.test(id)) return "tarball" as const;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(id)) return "other-scheme" as const;
    if (/^[.~/]/.test(id)) return "local" as const;
    // <registry>/<namespace>/<name>[:tag|@digest]. Not validated further --
    // what matters here is only that it is neither a path nor a URL, so the
    // CLI fetches it over the network instead of reading a directory the
    // editor can rewrite.
    if (/^[^\s]+\/[^\s]+$/.test(id)) return "registry" as const;
    return "unknown" as const;
  },
};

export const image = (() => {
  // Docker's own reference grammar, transcribed:
  //   [<host>[:<port>]/]<path>[/<path>...][:<tag>][@<algo>:<hex>]
  // The host is only a host when a `/` follows it, which is what tells
  // `localhost:5000/base` (a registry and a port) from `node:22` (an image and
  // a tag) -- the one ambiguity in the grammar, and the one a looser rule gets
  // wrong in the direction of accepting `node:22:22`.
  const host = String.raw`[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]+)?`;
  const path = String.raw`[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*`;
  const tag = String.raw`[\w][\w.-]{0,127}`;
  const digest = String.raw`[a-z0-9]+:[a-fA-F0-9]{32,}`;

  const reference = new RegExp(
    `^(?:${host}/)?${path}(?:/${path})*(?::${tag})?(?:@${digest})?$`,
  );

  return {
    /**
     * Does this parse as an image reference?
     *
     * Shape only. What a registry actually serves cannot be known here, and the
     * job of this rule is not isolation -- unlike mounts and ports, a shadowed
     * tag lives in the project's OWN inner daemon, which is per-project and
     * disposable, so a bad entry can only cost the project that wrote it. The
     * job is to name the typo here, where the message can quote the key, rather
     * than three minutes later in a log file inside a container.
     *
     * A path (`./base`, `/opt/img`) and a URL are the two category errors worth
     * refusing by name, and the grammar above refuses both on its own: a
     * leading `.` or `/` is not a host, and `//` is not a separator docker
     * accepts anywhere.
     */
    isReference: (candidate: string) => reference.test(candidate),
  };
})();

/** Each one is a pull and a build at container start, run one after another
 *  before the project's own builds can work. A list this long is a mistake
 *  worth catching; the number itself is not sacred. */
const MAX_SHADOW_IMAGES = 32;

export class PolicyError extends Error {}

const format = {
  /**
   * Reflow a message written across source lines onto one line.
   *
   * Only the line breaks and the indentation that follows them are touched, so
   * spacing the author wrote WITHIN a line -- around an interpolation, inside
   * quotes -- survives verbatim.
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

/** @throws PolicyError carrying the template strings reflowed onto one line. */
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
  target: Target;
  /** Every target that could contest a volume namespace, so a volume can be
   *  awarded to the longest claim rather than the first. */
  targets: Target[];
  read: ReturnType<typeof reader>;
}>;

const helpers = {
  allowPrivileged: ({ read }: Pick<Payload, "read">) =>
    read.desolate("allowPrivileged") === true,
  disallowedSecurityOption: (option: string) =>
    allowlist.runargs.deny["--security-opt"].some((regex) =>
      regex.test(option),
    ),
  /** The repository's own directory name -- what `${localWorkspaceFolderBasename}`
   *  expands to for a project, and the owner-less half of a nested name. */
  basename: ({ project }: Target) => project.split("/").pop()!,
  /**
   * Where a target's own folder may appear INSIDE its container.
   *
   * A worktree has no choice: its `.git` is a file naming an absolute path, and
   * that path's `commondir` names another, so anywhere but its own is a
   * container where git does not work at all. A root target may also take the
   * CLI's default of `<workspaces>/<basename>`, which is what it got before
   * nesting existed.
   */
  workspaceMountTargets: (target: Target) =>
    target.worktree
      ? [target.dir]
      : [
          ...new Set([
            target.dir,
            posix.join(target.workspaces, helpers.basename(target)),
          ]),
        ],
  /**
   * Refuse a volume outside the target's namespace, with the two hints that make
   * the refusal actionable.
   */
  refuseForeignVolume: (
    { target }: Pick<Payload, "target">,
    mounted: NormalMount,
    origin: string,
  ): never => {
    const { project, namespace } = target;
    const basename = helpers.basename(target);

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
    const { target, targets } = payload;
    const { namespace } = target;
    const origin = fromFeature ? "a feature" : "this project";

    if (mount.isPublicCa(mounted)) return;

    if (mounted.type !== "volume")
      return fail`
        mount type '${mounted.type}' requested by ${origin} is not allowed
        (volumes only -- a bind mount reaches the inner daemon's filesystem,
        where every other project lives): ${mounted.raw}`;

    if (mount.requiresOwnership(namespace, mounted)) {
      const owner = mount.owner(targets, mounted);
      if (owner === undefined || owner.namespace === namespace) return;

      return fail`
        volume '${mounted.source}' (requested by ${origin}) belongs to project
        '${owner.name}', not '${target.name}' -- '${namespace}-*' also matches
        names that start with '${namespace}-', and the longer project owns them`;
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
   * against the target anyway, so a future CLI that stopped overwriting it
   * would fail closed here rather than open somewhere else.
   *
   * The boundary is the TARGET's directory, not its project's: a worktree reads
   * its own devcontainer.json and builds from its own tree, and a build context
   * reaching up through `.worktrees/..` would be every sibling branch's source.
   */
  configDirectory: ({ read, target }: Payload) => {
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
    const root = target.dir;
    if (!isWithin(root, directory))
      return fail`
        internal: the CLI read this project's configuration from '${file}',
        which is outside '${root}' -- refusing to approve it`;

    return { directory, root };
  },
  runArgs: {
    parse: (arg: string) => {
      const equals = arg.indexOf("=");
      return {
        flag: equals >= 0 ? arg.slice(0, equals) : arg,
        inline: equals >= 0 ? arg.slice(equals + 1) : undefined,
      };
    },
    /**
     * Read `runArgs` as the (flag, value) pairs it denotes.
     *
     * @throws PolicyError on a flag that is not on the allowlist, a
     * value-taking flag with no value, or a boolean flag carrying one.
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
  featuresMustBeFetched: ({ read }) => {
    const declared = read("features");
    if (declared === undefined) return;

    if (!nonNullObject(declared))
      return fail`"features" must be an object mapping feature ids to options`;

    for (const id of Object.keys(declared)) {
      const origin = feature.origin(id);
      if (origin === "registry" || origin === "tarball") continue;

      if (origin === "local")
        return fail`
          local feature '${id}' is not allowed. Its
          devcontainer-feature.json is read from your project TWICE -- once
          when this policy resolves the spec, and again when the container is
          built -- and only the first read is the one that was checked.
          Anything able to write the project in between decides what the
          second read says, and feature metadata is exactly where
          "privileged", "capAdd", "securityOpt" and "mounts" are allowed to
          come from. Publish the feature and reference it by registry
          instead: "ghcr.io/<owner>/<repo>/<feature>:<version>".`;

      return fail`
        feature '${id}' is not a feature this policy can classify (expected
        "<registry>/<namespace>/<name>:<version>" or an "https://" tarball).
        It is refused rather than guessed at, because the alternative reading
        -- a path into the project -- is one the editor can rewrite after this
        check has passed.`;
    }
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

    const build =
      read<{ context?: string; dockerfile?: string }>("build") ?? null;
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
  /**
   * `customizations.desolate.shadowImages` -- base images whose tag desolate
   * points at a CA-trusting derivative inside this project's own daemon, so
   * that builds which cannot take a build context (an SDK posting to the Engine
   * API: dockerode, docker-py, testcontainers) still reach the internet.
   *
   * Read raw, like every other desolate customization: it is ours, not the
   * CLI's, so it never appears in the merged configuration.
   */
  shadowImagesAreImages: ({ read }) => {
    const declared = read.desolate("shadowImages");
    if (declared === undefined || declared === null) return;

    if (!Array.isArray(declared))
      return fail`
        "customizations.desolate.shadowImages" must be an array of image
        references (got ${typeof declared}), e.g. ["node:22-bookworm-slim"]`;

    if (declared.length > MAX_SHADOW_IMAGES)
      return fail`
        "customizations.desolate.shadowImages" lists ${declared.length} images;
        ${MAX_SHADOW_IMAGES} is the most this will apply. Each one is pulled and
        rebuilt inside the container at start.`;

    for (const entry of declared) {
      if (typeof entry !== "string" || entry.trim() === "")
        return fail`
          every "customizations.desolate.shadowImages" entry must be a non-empty
          image reference (got ${JSON.stringify(entry)})`;

      if (!image.isReference(entry))
        return fail`
          "${entry}" is not an image reference. shadowImages names the images a
          build says \`FROM\` -- "node:22-bookworm-slim",
          "ghcr.io/owner/base:1.2" -- not a path, a URL or a Dockerfile.`;
    }
  },
  /**
   * The source is compared for EQUALITY against a path computed from the
   * target -- never parsed out of the spec, and never prefix-matched. A prefix
   * rule here would accept `/workspaces/acme/widgets-evil` for `acme/widgets`,
   * and it would do so for every project at once, worktree or not.
   *
   * Resolving first is what makes the equality meaningful rather than textual:
   * docker resolves the path it is handed, so `.worktrees/feature/../../other`
   * has to be measured as the directory it denotes.
   */
  workspaceMountIsOwnFolder: ({ read, target }) => {
    const declared = read("workspaceMount");
    if (!declared) return;

    const mounted = mount.normalize(declared);

    if (posix.resolve(mounted.source) !== target.dir)
      return fail`
        workspaceMount must have source=${target.dir} exactly (got
        source='${mounted.source}') -- the source decides which of the inner
        daemon's directories enters your container`;

    const allowed = helpers.workspaceMountTargets(target);
    if (!allowed.includes(posix.resolve(mounted.target)))
      return fail`
        workspaceMount target must be ${allowed.join(" or ")} (got
        target='${mounted.target}')`;
  },
} satisfies Record<string, Check>;

const checker = (
  ...[target, spec, targets]: Parameters<typeof enforcePolicy>
) => {
  const payload: Payload = { target, targets, read: reader(spec) };
  return Object.entries(checks).reduce(
    (acc, [key, check]) => {
      acc[key as keyof typeof checks] = check.bind(null, payload);
      return acc;
    },
    {} as Record<keyof typeof checks, () => void>,
  );
};

/**
 * Returns silently when the spec is acceptable.
 *
 * @param targets every target that could contest a volume namespace, so a
 * volume can be awarded to the longest claim rather than the first.
 * @throws PolicyError with a specific reason if the project asks for anything
 * outside its own trust domain.
 */
export function enforcePolicy(
  target: Target,
  spec: ResolvedSpec,
  targets: Target[],
): void {
  const checks = checker(target, spec, targets);

  checks.noCompose();
  checks.noInitializeCommand();
  checks.noBuildOptions();
  checks.noAppPorts();
  checks.featuresMustBeFetched();
  checks.privilegeMustBeExplicit();
  checks.capAddsOnlyWhenPrivileged();
  checks.securityOptKeepsTheSandbox();
  checks.mountsStayInOwnNamespace();
  checks.runArgsOnAllowlist();
  checks.buildPathsStayInOwnProject();
  checks.shadowImagesAreImages();
  checks.workspaceMountIsOwnFolder();
}

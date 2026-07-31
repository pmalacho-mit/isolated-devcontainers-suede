// policy.ts -- the spec policy the broker enforces before starting a project.
//
// Pure and side-effect free (so it's easy to test)
import { ResolvedSpec } from "./devcontainer.ts";
import { list as listProjects, volumeNamespace } from "./projects.ts";
import {
  type ItemFromSet,
  JSONValue,
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

const mount = {
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
};

export class PolicyError extends Error {}

const fail = (...msgs: string[]): never => {
  throw new PolicyError(msgs.join(" "));
};

const reader = ({ configuration, mergedConfiguration }: ResolvedSpec) => {
  const read = <T extends JSONValue = JSONValue>(
    key: string,
  ): T | undefined => {
    if (
      mergedConfiguration[key] === undefined &&
      configuration[key] !== undefined
    )
      return fail(
        `internal: this project declares "${key}", but the CLI's`,
        `mergedConfiguration does not carry it -- the merged shape has changed`,
        `(renamed or reshaped), so this policy would be enforcing on a key that`,
        `no longer exists. Refusing to approve it.`,
      );
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
    return fail(`"${key}" must be a string or an array (got ${typeof value})`);
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
    desolate: Object.assign(desolate, {
      truthy: (key: string) => Boolean(desolate(key)),
    }),
  });
};

/**
 * Throws PolicyError with a specific reason if the project asks for anything
 * outside its own trust domain. Returns silently when the spec is acceptable.
 */
export function enforcePolicy(
  project: string,
  spec: ResolvedSpec,
  /**
   * Optional so the policy stays pure and testable
   */
  opts?: {
    workspaces?: string;
    /**
     * @default projects.ts::list(workspaces)
     */
    projects?: string[];
  },
): void {
  const namespace = volumeNamespace(project);
  const workspaces = opts?.workspaces ?? "/workspaces";
  const projects = opts?.projects ?? listProjects(workspaces);
  const read = reader(spec);

  if (read("dockerComposeFile"))
    return fail(
      'compose-based devcontainers ("dockerComposeFile") are not supported:',
      "their privilege is declared in the compose file, which this policy",
      "cannot validate. Use an image/Dockerfile devcontainer, and run compose",
      "INSIDE it with the docker-in-docker feature.",
    );

  if (read("initializeCommand"))
    return fail(
      `"initializeCommand" is not allowed: it executes on the orchestrator (which holds ` +
        `the inner Docker socket), not inside your container. Use ` +
        `"postCreateCommand" / "onCreateCommand" instead -- those run in the container.`,
    );

  if (read<{ options: any }>("build")?.options !== undefined)
    return fail(
      '"build.options" is not allowed (arbitrary docker build flags)',
    );

  if (read("appPort") !== undefined)
    return fail(
      'remove "appPort"; declare customizations.desolate.ports instead',
    );

  const allowPrivileged = read.desolate.truthy("allowPrivileged");

  if (read.truthy("privileged"))
    if (!allowPrivileged)
      return fail(
        "this spec requests a PRIVILEGED container (often pulled in by a " +
          "feature such as docker-in-docker). Privileged containers can reach " +
          "sibling projects' data on the inner daemon. If that is intended, " +
          'declare it explicitly: "customizations": { "desolate": ' +
          '{ "allowPrivileged": true } }',
      );

  const capAdd = read.asList("capAdd").map(String);
  if (capAdd.length && !allowPrivileged)
    return fail(
      `capability additions are not allowed (requested: ${capAdd.join(", ")}). ` +
        "Add them via an explicit allowPrivileged opt-in if genuinely required.",
    );

  for (const option of read.asList("securityOpt").map(String))
    if (
      allowlist.runargs.deny["--security-opt"].some((regex) =>
        regex.test(option),
      )
    )
      return fail(
        `securityOpt '${option}' is not allowed (it weakens the sandbox)`,
      );

  const writtenByProject = new Set(
    read.unsafe.asList("mounts").map(mount.normalize).map(mount.identity),
  );

  for (const mounted of read.asList("mounts").map(mount.normalize)) {
    const fromFeature = !writtenByProject.has(mount.identity(mounted));
    const origin = fromFeature ? "a feature" : "this project";

    if (mounted.type === "bind" && mounted.source === CA_BIND_SOURCE) continue; // public CA, read-only

    if (mounted.type !== "volume")
      return fail(
        `mount type '${mounted.type}' requested by ${origin} is not allowed`,
        `(volumes only -- a bind mount reaches the inner daemon's filesystem,`,
        `where every other project lives): ${mounted.raw}`,
      );

    if (mount.requiresOwnership(project, mounted)) {
      const owner = projects
        .map((project) => ({ project, namespace: volumeNamespace(project) }))
        .filter(({ project }) => mount.requiresOwnership(project, mounted))
        .sort((a, b) => b.namespace.length - a.namespace.length)
        .at(0);

      if (owner === undefined || owner.project === project) continue;

      return fail(
        `volume '${mounted.source}' (requested by ${origin}) belongs to project`,
        `'${owner.project}', not '${project}' -- '${namespace}-*' also matches names`,
        `that start with '${namespace}-', and the longer project owns them`,
      );
    }

    if (
      fromFeature &&
      allowPrivileged &&
      allowlist.featureVolumes.some((regex) => regex.test(mounted.source))
    )
      continue; // e.g. dind-var-lib-docker-<id>, for an opted-in DinD project

    const base = project.split("/").pop()!;
    const isNested = project.includes("/");
    const looksLikeBasenameIdiom =
      isNested &&
      (mounted.source === base || mounted.source.startsWith(`${base}-`));

    fail(
      `volume '${mounted.source}' (requested by ${origin}) is outside this project's`,
      `namespace -- a project may only mount volumes named`,
      `'${volumeNamespace(project)}' or '${volumeNamespace(project)}-*'`,
      ...(isNested
        ? [
            `(a nested project '${project}' owns the '${volumeNamespace(project)}' namespace,`,
            `because docker names cannot contain '/')`,
          ]
        : []),
      ...(looksLikeBasenameIdiom
        ? [
            `
      This looks like '\${localWorkspaceFolderBasename}', which expands to '${base}'      
      -- the last path segment only, so the owner is dropped and two owners' 
      '${base}' repos would both claim '${mounted.source}'. Name it explicitly instead:
       "source=${volumeNamespace(project)}-${mounted.source.startsWith(`${base}-`) ? mounted.source.slice(base.length + 1) : "data"},..."`,
          ]
        : []),
    );
  }

  const runArgs = read.asList("runArgs").map(String);
  for (let i = 0; i < runArgs.length; i++) {
    const { runargs: allowed } = allowlist;
    const arg = runArgs[i];
    if (!arg.startsWith("-"))
      return fail(
        `runArgs entry '${arg}' is not a flag; bare values are only allowed`,
        `immediately after an allowed value-taking flag`,
      );

    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;

    type Bool = ItemFromSet<typeof allowed.bools>;

    if (allowed.bools.has(flag as Bool)) {
      if (inlineValue !== undefined && !/^(true|false)$/i.test(inlineValue))
        return fail(`runArgs '${arg}' is not allowed (${flag} takes no value)`);

      continue;
    }

    type Value = ItemFromSet<typeof allowed.values>;

    if (!allowed.values.has(flag as Value))
      return fail(
        `runArgs flag '${flag}' is not on the allowlist. Allowed:`,
        `${[...allowed.values, ...allowed.bools].sort().join(" ")}.`,
        `(Namespace, device, privilege and mount flags are deliberately absent --`,
        `they would let a project out of its own container.)`,
      );

    let value: string;
    if (inlineValue !== undefined) value = inlineValue;
    else {
      value = runArgs[i + 1] ?? "";
      if (value === "" || value.startsWith("-"))
        return fail(`runArgs '${flag}' expects a value`);
      i++;
    }

    if (
      flag === "--security-opt" &&
      allowed.deny["--security-opt"].some((regex) => regex.test(value))
    )
      return fail(
        `--security-opt '${value}' is not allowed (it weakens the sandbox)`,
      );

    if (flag === "--tmpfs" && !value.startsWith("/"))
      return fail(`--tmpfs '${value}' must be an absolute in-container path`);
  }

  const wsMount = read("workspaceMount");
  if (wsMount) {
    const mounted = mount.normalize(wsMount);
    const own = `${workspaces}/${project}`;
    const basename = `${workspaces}/${project.split("/").pop()}`;
    if (mounted.source !== own)
      return fail(
        `workspaceMount must have source=${own} exactly (got source='${mounted.source}')`,
        `-- the source decides which of the inner daemon's directories enters `,
        `your container`,
      );

    if (mounted.target !== own && mounted.target !== basename)
      return fail(
        `workspaceMount target must be ${own}` +
          (basename === own ? "" : ` or ${basename}`),
        `(got target='${mounted.target}')`,
      );
  }
}

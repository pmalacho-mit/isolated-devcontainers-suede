/**
 * docker.ts -- every docker invocation desolate makes, as one named operation
 * each.
 *
 * The commands are built here rather than at the call sites for
 * readability and testability.
 */

/** How a command reaches the world. The two shapes differ in what they return,
 *  not in what they run: `output` is for queries, `status` for effects. */
export interface Runner {
  /** stdout, trimmed. "" when the command failed. */
  output: (argv: string[]) => string;
  /** Exit status. `quiet` suppresses the command's stdout. */
  status: (argv: string[], quiet?: boolean) => number;
  /** Feed `input` on stdin. Returns the failure's own output when it fails, so
   *  a build error can be quoted back rather than reduced to a status. */
  build: (argv: string[], input: string) => { ok: boolean; output: string };
}

export interface NetworkAttachment {
  network: string;
  ip: string;
}

const nonEmptyLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** Read (network, ip) PAIRS from one template, deliberately. */
const NETWORKS_TEMPLATE =
  '{{range $n, $c := .NetworkSettings.Networks}}{{$n}}\t{{$c.IPAddress}}{{"\\n"}}{{end}}';

export const parseNetworkAttachments = (text: string): NetworkAttachment[] => {
  const attachments: NetworkAttachment[] = [];
  for (const line of nonEmptyLines(text)) {
    const [network, ip = ""] = line.split("\t");
    if (network) attachments.push({ network, ip });
  }
  return attachments;
};

/** The two labels the devcontainer CLI stamps a project's container with. It
 *  finds that container again by matching BOTH, and so does this file. */
export const IDENTITY_LABELS = {
  workspace: "devcontainer.local_folder",
  config: "devcontainer.config_file",
} as const;

export interface WorkspaceCandidate {
  id: string;
  /** "" when the container carries no config_file label at all. */
  configFile: string;
}

/** Only a constant label NAME is interpolated here -- never a caller's value.
 *  A path with a quote in it would break the template open, which is why the
 *  config file is compared in TypeScript below rather than passed to --filter. */
const WORKSPACE_CANDIDATES_TEMPLATE = `{{.ID}}\t{{.Label "${IDENTITY_LABELS.config}"}}`;

export const parseWorkspaceCandidates = (
  text: string,
): WorkspaceCandidate[] => {
  const candidates: WorkspaceCandidate[] = [];
  for (const line of nonEmptyLines(text)) {
    const [id, configFile = ""] = line.split("\t");
    if (id) candidates.push({ id, configFile: configFile.trim() });
  }
  return candidates;
};

/**
 * Which of the containers claiming a workspace folder is actually this
 * project's.
 *
 * The workspace label ALONE is not an identity. It is written by the CLI before
 * it appends the project's own runArgs, so a project used to be able to stamp a
 * sibling's folder onto its container and be mistaken for it -- policy.ts now
 * refuses `--label`, and this is the second lock. A container naming a
 * DIFFERENT config file is somebody else's; one naming none is ours from before
 * the label existed.
 *
 * `configFile` is optional for when a caller genuinely does not know
 * which config a running container was created from; there the first match is
 * still the best available answer.
 */
export const selectWorkspaceContainer = (
  candidates: WorkspaceCandidate[],
  configFile?: string,
): string => {
  if (!configFile) return candidates[0]?.id ?? "";
  return (
    candidates.find((c) => c.configFile === configFile)?.id ??
    candidates.find((c) => !c.configFile)?.id ??
    ""
  );
};

export interface Mount {
  source: string;
  destination: string;
}

const MOUNTS_TEMPLATE =
  '{{range .Mounts}}{{.Source}}\t{{.Destination}}{{"\\n"}}{{end}}';

export const parseMounts = (text: string): Mount[] => {
  const mounts: Mount[] = [];
  for (const line of nonEmptyLines(text)) {
    const [source, destination = ""] = line.split("\t");
    if (source) mounts.push({ source, destination });
  }
  return mounts;
};

export const createDocker = (run: Runner) => {
  const query = (...argv: string[]) => run.output(argv);
  const effect = (...argv: string[]) => run.status(argv);

  const container = {
    /** The devcontainer's container id for a workspace folder ("" if none).
     *
     *  Pass `configFile` -- the path handed to `--override-config` -- wherever
     *  it is known: it is the half of the CLI's identity that a project could
     *  not forge even when it could still set labels. */
    forWorkspace: (
      dir: string,
      { includeStopped = false, configFile = "" } = {},
    ) =>
      selectWorkspaceContainer(
        parseWorkspaceCandidates(
          // No `-q`: it is shorthand for `--format {{.ID}}` and would drop the
          // config-file column this lookup is built on.
          query(
            "ps",
            ...(includeStopped ? ["-a"] : []),
            "--filter",
            `label=${IDENTITY_LABELS.workspace}=${dir}`,
            "--format",
            WORKSPACE_CANDIDATES_TEMPLATE,
          ),
        ),
        configFile,
      ),
    namesWithLabel: (label: string) =>
      nonEmptyLines(
        query(
          "ps",
          "-a",
          "--filter",
          `label=${label}`,
          "--format",
          "{{.Names}}",
        ),
      ),
    /** `{{.Names}}\t{{.Ports}}` for every RUNNING container. */
    publishedPortsTable: () =>
      query("ps", "--format", "{{.Names}}\t{{.Ports}}"),
    networks: (cid: string) =>
      parseNetworkAttachments(query("inspect", "-f", NETWORKS_TEMPLATE, cid)),
    state: (name: string) => query("inspect", "-f", "{{.State.Status}}", name),
    logsTail: (name: string, lines: number) =>
      query("logs", "--tail", String(lines), name),
    /** Every (source, destination) bind the container was created with.
     *
     *  No value is interpolated into the template. The broker validates project
     *  names, but `cli.sh desolate` is a direct path where a quote in a path
     *  would break the template open -- so the whole table is read and matched
     *  in TypeScript instead. */
    mounts: (cid: string) =>
      parseMounts(query("inspect", "-f", MOUNTS_TEMPLATE, cid)),
    remove: (names: string[]) =>
      names.length ? effect("rm", "-f", ...names) : 0,
    stop: (cid: string) => effect("stop", cid),
    execAsRoot: (cid: string, argv: string[], { quiet = true } = {}) =>
      run.status(["exec", "-u", "0", cid, ...argv], quiet),
  };

  const volume = {
    label: (name: string, label: string) =>
      query("volume", "inspect", name, "-f", `{{index .Labels "${label}"}}`),
    mountpoint: (name: string) =>
      query("volume", "inspect", name, "-f", "{{.Mountpoint}}"),
    /** The `o=` the daemon actually stored, for comparing against the one a
     *  fresh create would use. */
    options: (name: string) =>
      query("volume", "inspect", name, "-f", '{{index .Options "o"}}'),
    create: (name: string, labels: Record<string, string> = {}) =>
      effect(
        "volume",
        "create",
        ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
        name,
      ),
    createOverlay: (
      name: string,
      options: string,
      labels: Record<string, string>,
    ) =>
      effect(
        "volume",
        "create",
        "--driver",
        "local",
        "--opt",
        "type=overlay",
        "--opt",
        "device=overlay",
        "--opt",
        `o=${options}`,
        ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
        name,
      ),
    remove: (names: string[]) =>
      names.length ? effect("volume", "rm", "-f", ...names) : 0,
  };

  const image = {
    /** "" when the image is not present locally. */
    id: (tag: string) => query("image", "inspect", "-f", "{{.Id}}", tag),
    pull: (tag: string) => run.status(["pull", tag], true),
    /** The image's declared USER, or "root" when it declares none.
     *
     *  A derived image has to restore it: building as root and leaving it there
     *  breaks the devcontainer CLI's assumptions about the image user. */
    user: (tag: string) =>
      query("image", "inspect", "-f", "{{.Config.User}}", tag) || "root",
    /** Build from a Dockerfile fed on stdin, so nothing is written to disk. */
    build: (tag: string, dockerfile: string, context: string) =>
      run.build(["build", "-t", tag, "-f", "-", context], dockerfile),
  };

  return {
    container,
    volume,
    image,
    /** Run a throwaway helper container against one volume. */
    inVolume: (
      helperImage: string,
      volumeName: string,
      target: string,
      argv: string[],
    ) =>
      run.status(
        ["run", "--rm", "-v", `${volumeName}:${target}`, helperImage, ...argv],
        true,
      ),
    relay: {
      /** Mac:hostPort -> (daemon #0 range publish) -> dind ns:hostPort ->
       *  (this relay's publish on daemon #1) -> socat -> devcontainer IP.
       *  The relay joins the devcontainer's own network so `ip` is routable. */
      start: (spec: {
        image: string;
        name: string;
        label: string;
        network: string;
        hostPort: number;
        targetIp: string;
        targetPort: number;
      }) =>
        effect(
          "run",
          "-d",
          "--restart",
          "unless-stopped",
          "--name",
          spec.name,
          "--label",
          spec.label,
          "--network",
          spec.network,
          "-p",
          `${spec.hostPort}:${spec.hostPort}`,
          spec.image,
          `tcp-listen:${spec.hostPort},fork,reuseaddr`,
          `tcp:${spec.targetIp}:${spec.targetPort}`,
        ),
    },
  };
};

export type Docker = ReturnType<typeof createDocker>;

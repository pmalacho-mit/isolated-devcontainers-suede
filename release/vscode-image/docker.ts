/**
 * docker.ts -- every docker invocation desolate makes, as one named operation
 * each.
 *
 * The commands are built here rather than at the call sites for
 * readability and testability.
 */
import type { RunOptions } from "./utils.ts";

/** How a command reaches the world. The two shapes differ in what they return,
 *  not in what they run: `output` is for queries, `status` for effects. */
export interface Runner {
  /** stdout, trimmed. "" when the command failed. */
  output: (argv: string[]) => string;
  /** Exit status; a bound that fires reports as a non-zero one. */
  status: (argv: string[], options?: RunOptions) => number;
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

/** What each of the project's own containers gets before it is killed. */
const GRACE_SECONDS = 10;
/** How long the project's daemon gets to exit after its SIGTERM. */
const DAEMON_EXIT_SECONDS = 10;
/** The cap on a whole quiesce program, applied where that program runs. */
const QUIESCE_SECONDS = 30;

/**
 * What a devcontainer with a daemon of its own is asked to do before it is
 * stopped, as two shell programs. Programs rather than argv because both are
 * loops over what they find inside the container.
 */
const QUIESCE = {
  /** Empty is not a failure: `docker stop` with no arguments is an error, and
   *  a project that is simply running nothing must not report as one. */
  containers: `ids=$(docker ps -q); [ -z "$ids" ] || docker stop --time ${GRACE_SECONDS} $ids`,
  /** SIGTERM, then wait for the process to actually be gone -- an exit is the
   *  only evidence that its overlay mounts came down with it. */
  daemon: [
    "pkill -TERM dockerd 2>/dev/null",
    `i=0; while pgrep -x dockerd >/dev/null 2>&1; do` +
      ` [ "$i" -lt ${DAEMON_EXIT_SECONDS} ] || exit 1; sleep 1; i=$((i+1)); done`,
  ].join("; "),
} as const;

/** Every exec into a devcontainer that is on its way down is bounded TWICE:
 *  `timeout` caps the program where it runs, and this caps an exec that never
 *  gets that far. A devcontainer whose daemon is already hung can hang the exec
 *  itself, and `desolate --stop` must not inherit that. */
const EXEC_MS = { quiesce: 45_000, probe: 10_000 } as const;

const capped = (program: string) => [
  "timeout",
  String(QUIESCE_SECONDS),
  "sh",
  "-c",
  program,
];

export const createDocker = (run: Runner) => {
  const query = (...argv: string[]) => run.output(argv);
  const effect = (...argv: string[]) => run.status(argv);

  const container = {
    /** The devcontainer's container id for a workspace folder ("" if none).
     *
     *  `configFile` is the second half of the CLI's identity, and the half a
     *  project could not forge even when it could still set labels -- so pass
     *  it wherever it is known. It is the config the CLI STAMPS, which is the
     *  one inside the workspace folder whatever `--override-config` said; see
     *  `labelledConfig`. Passing an override path matches nothing. */
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
    /** The workspace folder of every RUNNING devcontainer, in ONE call.
     *
     *  For finding which of many targets are up, where asking per target would
     *  be a `docker ps` per directory on disk. It is a listing and not an
     *  identity -- `forWorkspace` pairs this label with the config-file one
     *  because either alone could once be claimed by a sibling -- so anything
     *  that ACTS on what this finds looks it up there first. */
    runningWorkspaceFolders: () =>
      new Set(
        nonEmptyLines(
          query(
            "ps",
            "--filter",
            `label=${IDENTITY_LABELS.workspace}`,
            "--format",
            `{{.Label "${IDENTITY_LABELS.workspace}"}}`,
          ),
        ),
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
    /** Run something as root in the container and WAIT for it.
     *
     *  There is deliberately no detached (`exec -d`) sibling: work slow enough
     *  to want backgrounding is work that can still hold mounts when the
     *  container is stopped, and a container stopped that way cannot be stopped
     *  at all. */
    execAsRoot: (
      cid: string,
      argv: string[],
      { quiet = true, timeoutMs }: RunOptions = {},
    ) => run.status(["exec", "-u", "0", cid, ...argv], { quiet, timeoutMs }),

    /** Whether the container has a docker CLI, and so a daemon of its own --
     *  which is what the docker-in-docker feature installs.
     *
     *  Bounded, because one of the two questions this answers is asked of a
     *  container that is being stopped, and a container that cannot answer at
     *  all is one there is no daemon to talk to either way. */
    hasDockerCli: (cid: string) =>
      container.execAsRoot(
        cid,
        ["sh", "-c", "command -v docker >/dev/null 2>&1"],
        { timeoutMs: EXEC_MS.probe },
      ) === 0,

    /** Ask the container's own daemon to put its containers away, so their
     *  mount namespaces are gone before the container holding them is stopped. */
    stopInnerContainers: (cid: string) =>
      container.execAsRoot(cid, capped(QUIESCE.containers), {
        timeoutMs: EXEC_MS.quiesce,
      }),

    /** ...and then to stop itself, so the mounts IT holds come down too. */
    stopInnerDaemon: (cid: string) =>
      container.execAsRoot(cid, capped(QUIESCE.daemon), {
        timeoutMs: EXEC_MS.quiesce,
      }),
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
    pull: (tag: string) => run.status(["pull", tag], { quiet: true }),
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
        { quiet: true },
      ),
    relay: {
      /** Mac:hostPort -> (daemon #0 range publish) -> dind ns:hostPort ->
       *  (this relay's publish on daemon #1) -> socat -> devcontainer IP.
       *  The relay joins the devcontainer's own network so `ip` is routable.
       *
       *  NO RESTART POLICY, deliberately. What this starts is socat pointed at
       *  an ADDRESS, read once when the relay was created, and that address
       *  means something only while the devcontainer it came from is up on that
       *  network. `unless-stopped` outlived both: on a daemon restart docker
       *  brought every relay back BEFORE -- and independently of -- the
       *  devcontainers they dial, so each one failed, restarted and added its
       *  own churn to the startup reconciliation; and a devcontainer recreated
       *  on a different address left the old relay forwarding a host port to
       *  whatever now holds the old one, which is worse than a dead port.
       *  Nothing needs the policy: `--stop` removes a target's relays and every
       *  start replaces them. */
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

      /** True when something answers through this relay's own listener.
       *
       *  Runs INSIDE the relay, over the inner daemon's unix socket, because
       *  the orchestrator has no IP path to the container world -- that is the
       *  containment boundary, and a probe that needs to cross it is a probe
       *  that fails as soon as the boundary is real.
       *
       *  Any status line counts, 401 and 403 included: the editor answers
       *  tokenless requests with one, and the question here is whether it
       *  answered at all. socat is the fallback because it is the one program
       *  the relay image is guaranteed to carry; a bare TCP connect proves
       *  less, but proves it without depending on the image's busybox. */
      answers: (name: string, port: number) =>
        run.status(
          [
            "exec",
            name,
            "sh",
            "-c",
            `if command -v wget >/dev/null 2>&1; then ` +
              `wget -S -O /dev/null -T 2 http://127.0.0.1:${port}/ 2>&1 | grep -q 'HTTP/'; ` +
              `else socat -T 2 /dev/null TCP:127.0.0.1:${port}; fi`,
          ],
          { quiet: true },
        ) === 0,
    },
  };
};

export type Docker = ReturnType<typeof createDocker>;

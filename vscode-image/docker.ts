/**
 * docker.ts -- every docker invocation desolate makes, as one named operation
 * each.
 *
 * The commands are built here rather than at the call sites for two reasons.
 * The first is readability: `docker.relay.start(...)` says what is happening
 * where a fourteen-element string array does not. The second is that these
 * argv arrays are a contract with a program this repo does not control, and
 * getting one subtly wrong fails at runtime inside a container -- a `readonly`
 * key in a --mount spec once broke every start, and a template that emitted no
 * separator once produced `--network audit-n1audit-n2`. Building them behind
 * an injectable runner is what lets those shapes be asserted without a daemon.
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

/** Read (network, ip) PAIRS from one template, deliberately.
 *
 *  Two templates that each range over .NetworkSettings.Networks and emit no
 *  separator produce concatenated garbage the moment a container is on more
 *  than one network -- measured on a two-network container, network came back
 *  as "audit-n1audit-n2" and ip as "172.18.0.2172.19.0.2". Taking [0] did not
 *  help, because that is a single line. Pairing them also keeps the name and
 *  the address CONSISTENT: a relay joins one network and dials one address,
 *  and they have to be the same network or the address is not routable. */
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
    /** The devcontainer's container id for a workspace folder ("" if none). */
    forWorkspace: (dir: string, { includeStopped = false } = {}) =>
      nonEmptyLines(
        query(
          "ps",
          includeStopped ? "-aq" : "-q",
          "--filter",
          `label=devcontainer.local_folder=${dir}`,
        ),
      )[0] ?? "",
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

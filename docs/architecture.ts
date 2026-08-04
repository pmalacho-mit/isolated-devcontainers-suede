/**
 * The architecture of `desolate`, as TypeScript types.
 *
 * Diagrams here are written at three resolutions, coarse first, so a reader can
 * stop as soon as they have what they came for:
 *
 *   Overview           where everything runs -- five boxes, no detail
 *   Boundaries         what separates each layer from the next
 *   HostSurfaces       what your Mac can reach, and what it deliberately cannot
 *   EgressPath         how a packet leaves a container
 *   BrokerFlow         the editor asks, the orchestrator acts (sequence)
 *   SecretSubstitution placeholder out, real value only toward one host (sequence)
 *
 * The pieces are declared once, below, and reused across all six. Coarse
 * diagrams pass a label of `false` (bare name); detailed ones let the type
 * expand into the node, so the annotations live in the type rather than beside
 * it. Render with:
 *
 *   ./docs/typescript2mermaid-suede/cli.sh docs/architecture.ts
 *   ./docs/typescript2mermaid-suede/cli.sh docs/architecture.ts --embed release/README.md
 *
 * Label text avoids `<`, `>` and `|`: Mermaid parses labels as HTML, so
 * `/workspaces/<project>` would render as `/workspaces/` with a dropped tag.
 */
import type { Flowchart, Sequence } from "./typescript2mermaid-suede/index.js";

/** One tab. The whole interface. */
type Browser = {
  opens: "127.0.0.1:3000, with a token";
};

/** The one host-reachable surface. */
type EditorPort = {
  bind: "127.0.0.1:3000";
  gate: "VSCODE_TOKEN";
};

/** The second surface, and only once a project is running. */
type DevServerPorts = {
  range: "8080-8119";
  allocated: "one per declared port";
};

/** `./cli.sh observe` -- the inner daemon, viewed without publishing anything. */
type ObserveCommand = {
  reaches: "a unix socket over colima ssh";
  port: never;
};

/** The Mac's own daemon socket -- what the Red Guild escape chain needs. */
type HostDockerSocket = {
  path: "/var/run/docker.sock";
  mountedInto: "NOWHERE";
};

/** The trust root. Nothing below it is trusted. */
type MacOS = {
  role: "trust root";
};

/** Ubuntu, real kernel -- which is why sysbox can install here. */
type ColimaVM = { runs: "sysbox, the egress proxy, and the stack" };

/** The inner Docker daemon's container. */
type Dind = {
  runtime: "sysbox-runc";
  containerRoot: "an unprivileged VM user";
};

/** Your project. */
type Devcontainer = { workspace: "one directory under /workspaces" };

/** Anything the project runs itself, on its own daemon. */
type Level3Container = { example: "FastAPI, from a compose.yml" };

/* -- beside dind, on the editor bridge -------------------------------------- */

/** VSCodium's reh-web server: a universal file editor with no daemon access. */
type Editor = { serves: "/workspaces"; dockerAccess: never };

/** Holds the socket; serves the broker. */
type Orchestrator = {
  holds: "the inner daemon socket";
  serves: "the broker";
};

/** The only container with raw private keys. No network, no /workspaces. */
type Keyring = { holds: "the deploy keys"; handsOut: "an agent socket only" };

/** The inner daemon's socket. Exactly one container holds it. */
type InnerDockerSocket = { holders: "the orchestrator, and nothing else" };

/** The devcontainer CLI, driven by the orchestrator. */
type DevcontainerCLI = { resolves: "mergedConfiguration -- features included" };

/** `policy.ts`: pure, unit-tested, and the reason a narrow API is not theater. */
type SpecPolicy = {
  refuses: "initializeCommand, compose mode, unknown runArgs";
};

/** socat, one per declared container port. */
type Relay = { forwards: "an allocated host port to a container port" };

/* -- the egress layer ------------------------------------------------------ */

/** The forward chain: default-deny, so there is one way out. */
type Nftables = { redirects: "80 and 443 to the proxy, 53 to the resolver" };

/** mitmproxy in transparent mode. */
type EgressProxy = { on: ":18080"; substitutes: "placeholder for real value" };

/** dnsmasq, VM-local. */
type Resolver = { on: ":5353"; logs: "every query" };

/** SECRETS LIVE HERE ONLY: VM disk, below the sysbox boundary. */
type ProxySecrets = { path: "/etc/desolate-proxy/settings.json"; mode: "0600" };

/** A host on that secret's allowlist -- the only place the real value goes. */
type AllowedHost = { example: "api.openai.com"; requires: "SNI matching Host" };

/** Anywhere else. */
type BlockedHost = { gets: "403, and the attempt is logged" };

/** Everything beyond the VM. */
type Internet = { reachable: "through the proxy, or not at all" };

/* ========================================================================== */
/* Resolution 1: at a glance                                                  */
/* ========================================================================== */

/**
 * Where everything runs. Five boxes and five arrows -- the shape of the thing,
 * with every annotation deliberately left out.
 *
 * Subgraphs come first in every body below: a node lands in whichever statement
 * first mentions it, so an edge written above its subgraph would pull that node
 * out of the box.
 */
export type Overview = Flowchart.Diagram<
  "topdown",
  [
    Flowchart.Subgraph<
      "your Mac",
      [
        Flowchart.Node<Browser, "stadium", false>,
        Flowchart.Subgraph<
          "Colima VM",
          [
            Flowchart.Node<EgressProxy, "hexagon", false>,
            Flowchart.Subgraph<
              "devnet -- the editor world",
              [
                Flowchart.Node<Editor, "subroutine", false>,
                Flowchart.Node<Orchestrator, "subroutine", false>,
                Flowchart.Node<Keyring, "subroutine", false>,
              ]
            >,
            Flowchart.Subgraph<
              "dindnet -- dind, unprivileged via sysbox",
              [Flowchart.Node<Devcontainer, "rectangle", false>]
            >,
          ]
        >,
      ]
    >,
    Flowchart.Node<Internet, "circle", false>,
    Flowchart.Connect<Browser, Editor, "3000, token-gated">,
    Flowchart.Connect<Editor, Orchestrator, "one broker op">,
    Flowchart.Connect<Editor, Keyring, "a unix socket, never a key">,
    Flowchart.Connect<Orchestrator, Devcontainer, "starts it">,
    Flowchart.Connect<Devcontainer, EgressProxy, "all egress", "thick">,
    Flowchart.Connect<EgressProxy, Internet>,
  ]
>;

/**
 * The same nesting read as containment: what separates each layer from the
 * next, strongest boundary first. Escape anywhere lands one box to the left.
 */
export type Boundaries = Flowchart.Diagram<
  "leftright",
  [
    Flowchart.Node<MacOS, "stadium", false>,
    Flowchart.Node<ColimaVM, "rectangle", false>,
    Flowchart.Node<Dind, "rectangle", false>,
    Flowchart.Node<Devcontainer, "rectangle", false>,
    Flowchart.Node<Level3Container, "rounded", false>,

    Flowchart.Connect<MacOS, ColimaVM, "a real VM -- strongest", "thick">,
    Flowchart.Connect<ColimaVM, Dind, "sysbox: a user namespace", "thick">,
    Flowchart.Connect<Dind, Devcontainer, "namespaces -- the weakest">,
    Flowchart.Connect<Devcontainer, Level3Container, "its own inner daemon">,

    Flowchart.DefineClass<
      "strong",
      "fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px"
    >,
    Flowchart.DefineClass<
      "weak",
      "fill:#fff8e1,stroke:#f9a825,stroke-width:2px"
    >,
    Flowchart.ApplyClass<[MacOS, ColimaVM], "strong">,
    Flowchart.ApplyClass<[Devcontainer, Level3Container], "weak">,
  ]
>;

/* ========================================================================== */
/* Resolution 2: the two things people get wrong                              */
/* ========================================================================== */

/**
 * What the Mac can reach. Two loopback surfaces, one socket path that does not
 * exist, and one that is never mounted -- the crossed edges are the point.
 */
export type HostSurfaces = Flowchart.Diagram<
  "topdown",
  [
    Flowchart.Subgraph<
      "your Mac",
      [
        Flowchart.Node<Browser, "stadium">,
        Flowchart.Node<ObserveCommand, "stadium">,
        Flowchart.Node<EditorPort, "hexagon">,
        Flowchart.Node<DevServerPorts, "hexagon">,
        Flowchart.Node<HostDockerSocket, "database">,
      ]
    >,
    Flowchart.Subgraph<
      "in the Colima VM",
      [
        Flowchart.Node<Editor, "subroutine">,
        Flowchart.Node<Orchestrator, "subroutine">,
        Flowchart.Node<Relay, "rounded">,
        Flowchart.Node<InnerDockerSocket, "database">,
        Flowchart.Node<Devcontainer>,
      ]
    >,

    Flowchart.Connect<Browser, EditorPort, "the one surface">,
    Flowchart.Connect<EditorPort, Editor>,
    Flowchart.Connect<Browser, DevServerPorts, "once a project runs", "dotted">,
    Flowchart.Connect<DevServerPorts, Relay>,
    Flowchart.Connect<Relay, Devcontainer>,
    Flowchart.Connect<
      ObserveCommand,
      Orchestrator,
      "no port involved",
      "dotted"
    >,
    Flowchart.Connect<Orchestrator, InnerDockerSocket, "sole holder", "thick">,
    Flowchart.Connect<
      Editor,
      InnerDockerSocket,
      "no mount, no DOCKER_HOST",
      "cross"
    >,
    Flowchart.Connect<
      HostDockerSocket,
      InnerDockerSocket,
      "never mounted, at any level",
      "cross"
    >,

    Flowchart.DefineClass<
      "severed",
      "fill:#ffebee,stroke:#c62828,stroke-width:2px,stroke-dasharray:5 4"
    >,
    Flowchart.ApplyClass<[HostDockerSocket], "severed">,
  ]
>;

/**
 * How a packet leaves a container. The forward chain is default-deny, so the
 * proxy is not a convention a container can decline.
 */
export type EgressPath = Flowchart.Diagram<
  "leftright",
  [
    Flowchart.Subgraph<
      "in the Colima VM",
      [
        Flowchart.Node<Nftables, "diamond">,
        Flowchart.Node<EgressProxy, "hexagon">,
        Flowchart.Node<Resolver, "hexagon">,
        Flowchart.Node<ProxySecrets, "database">,
      ]
    >,
    Flowchart.Node<Devcontainer>,
    Flowchart.Node<AllowedHost, "circle">,
    Flowchart.Node<BlockedHost, "circle">,
    Flowchart.Node<Internet, "circle">,

    Flowchart.Connect<Devcontainer, Nftables, "every packet", "thick">,
    Flowchart.Connect<Nftables, EgressProxy, "80, 443">,
    Flowchart.Connect<Nftables, Resolver, "53">,
    Flowchart.Connect<Nftables, Internet, "anything else, and QUIC", "cross">,
    Flowchart.Connect<
      EgressProxy,
      ProxySecrets,
      "reads, per request",
      "dotted"
    >,
    Flowchart.Connect<EgressProxy, AllowedHost, "the real value">,
    Flowchart.Connect<EgressProxy, BlockedHost, "refused", "cross">,

    Flowchart.DefineClass<
      "secret",
      "fill:#fff8e1,stroke:#f9a825,stroke-width:2px"
    >,
    Flowchart.ApplyClass<[ProxySecrets], "secret">,
  ]
>;

/* ========================================================================== */
/* Resolution 3: the two flows worth following step by step                   */
/* ========================================================================== */

/**
 * Privilege separation, as it actually plays out. The editor never touches the
 * daemon; it sends one of five ops and the orchestrator does the rest -- and
 * validates the spec first, because the editor can edit `devcontainer.json`.
 */
export type BrokerFlow = Sequence.Diagram<
  [
    Sequence.Participant<Editor, "vscode: editor">,
    Sequence.Participant<Orchestrator, "orchestrator: broker">,
    Sequence.Participant<DevcontainerCLI, "devcontainer CLI">,
    Sequence.Participant<SpecPolicy, "policy.ts">,
    Sequence.Participant<Devcontainer, "your project">,

    Sequence.NoteRight<Editor, "no socket, no DOCKER_HOST">,
    // No activation boxes: Mermaid walks both `alt` branches in order, so an
    // activation opened before one and closed inside each is closed twice.
    Sequence.Message<Editor, Orchestrator, "desolate myproject">,
    Sequence.NoteOver<
      [Editor, Orchestrator],
      "a unix socket, five ops: start, rebuild, stop, ports, list"
    >,
    Sequence.Message<Orchestrator, DevcontainerCLI, "resolve the real spec">,
    Sequence.Reply<
      DevcontainerCLI,
      Orchestrator,
      "mergedConfiguration -- what features actually asked for"
    >,
    Sequence.Message<Orchestrator, SpecPolicy, "check mounts, runArgs, hooks">,
    Sequence.Alternative<
      "refused",
      [
        Sequence.Reply<SpecPolicy, Orchestrator, "the rule it broke">,
        Sequence.Reply<Orchestrator, Editor, "error -- nothing was started">,
      ],
      "allowed",
      [
        Sequence.Reply<SpecPolicy, Orchestrator, "ok">,
        Sequence.NoteRight<
          Orchestrator,
          "snapshots the approved spec somewhere the editor cannot write, then starts from that copy"
        >,
        Sequence.Message<
          Orchestrator,
          Devcontainer,
          "up, plus a relay per port"
        >,
        Sequence.Reply<Orchestrator, Editor, "the URL to open">,
      ]
    >,
  ]
>;

/**
 * Why a compromised project leaks a placeholder and nothing else. The real
 * value is read in the VM, used once, and scrubbed out of the response.
 */
export type SecretSubstitution = Sequence.Diagram<
  [
    Sequence.Participant<Devcontainer, "your code">,
    Sequence.Participant<EgressProxy, "proxy, in the VM">,
    Sequence.Participant<ProxySecrets, "settings.json, 0600">,
    Sequence.Participant<AllowedHost, "api.openai.com">,
    Sequence.Participant<BlockedHost, "attacker.example">,

    Sequence.NoteLeft<Devcontainer, "holds only MYAPP-OPENAI-KEY">,
    Sequence.Message<
      Devcontainer,
      EgressProxy,
      "GET over TLS, Authorization: Bearer MYAPP-OPENAI-KEY"
    >,
    Sequence.Alternative<
      "SNI matches Host, and that host is on this secret's allowlist",
      [
        Sequence.Message<EgressProxy, ProxySecrets, "look up the placeholder">,
        Sequence.Reply<ProxySecrets, EgressProxy, "the real key, VM-side only">,
        Sequence.Message<EgressProxy, AllowedHost, "same request, real key">,
        Sequence.Reply<AllowedHost, EgressProxy, "response">,
        Sequence.Reply<
          EgressProxy,
          Devcontainer,
          "response, scrubbed of the real key"
        >,
      ],
      "anywhere else, including a spoofed Host header",
      [
        Sequence.Lost<EgressProxy, BlockedHost, "nothing is sent">,
        Sequence.Reply<EgressProxy, Devcontainer, "403, logged">,
      ]
    >,
  ]
>;

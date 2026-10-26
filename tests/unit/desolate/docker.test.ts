/// <reference types="node" />
// The argv desolate hands to the docker CLI.
//
// These arrays are a contract with a program this repo does not control. Every
// case below is a shape that has broken, or would break, at runtime inside a
// container -- which is the only place the real CLI would have told us.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import {
  RECLAIMED,
  STATUS_RAN,
  createDocker,
  reclaimArgv,
  parseMounts,
  parseWorktreeChanges,
  relayWithFallback,
  parseNetworkAttachments,
  parseWorkspaceCandidates,
  selectWorkspaceContainer,
  type Runner,
} from "../../../release/vscode-image/docker.ts";

/** A runner that records instead of running, and replays canned output. */
const recorder = (outputs: string[] = []) => {
  const calls: string[][] = [];
  const built: string[] = [];
  const queue = [...outputs];
  const runner: Runner = {
    output: (argv) => {
      calls.push(argv);
      return queue.shift() ?? "";
    },
    status: (argv) => {
      calls.push(argv);
      return 0;
    },
    build: (argv, input) => {
      calls.push(argv);
      built.push(input);
      return { ok: true, output: "" };
    },
  };
  return { runner, calls, built, docker: createDocker(runner) };
};

describe("container queries", () => {
  test("a workspace folder is matched by the CLI's own labels", () => {
    const { docker, calls } = recorder(["abc123\t/tmp/spec.json\n"]);
    assert.equal(docker.container.forWorkspace("/workspaces/myapp"), "abc123");
    assert.deepEqual(calls[0], [
      "ps",
      "--filter",
      "label=devcontainer.local_folder=/workspaces/myapp",
      "--format",
      '{{.ID}}\t{{.Label "devcontainer.config_file"}}',
    ]);
  });

  test("every running devcontainer's folder comes back in ONE call", () => {
    // `--list` and `--stop all` ask about every target there is, and asking per
    // directory would be a `docker ps` per project on disk.
    const { docker, calls } = recorder(["/workspaces/a\n/workspaces/b\n"]);
    const folders = docker.container.runningWorkspaceFolders();
    assert.deepEqual(calls[0], [
      "ps",
      "--filter",
      "label=devcontainer.local_folder",
      "--format",
      '{{.Label "devcontainer.local_folder"}}',
    ]);
    assert.deepEqual([...folders], ["/workspaces/a", "/workspaces/b"]);
  });

  test("...running only: a stopped container is not something that is up", () => {
    // No -a. `--stop all` acting on exited containers would "stop" what is
    // already stopped and report it as work.
    const { docker, calls } = recorder();
    docker.container.runningWorkspaceFolders();
    assert.ok(!calls[0].includes("-a"), `${calls[0]}`);
  });

  test("-q is never passed: it would drop the config-file column", () => {
    // `docker ps -q` is shorthand for `--format {{.ID}}` and overrides an
    // explicit --format, which would leave every container looking like one
    // that carries no config_file label -- i.e. like a match.
    const { docker, calls } = recorder();
    docker.container.forWorkspace("/w/a");
    assert.ok(!calls[0].includes("-q"));
  });

  test("includeStopped adds -a", () => {
    // --rebuild has to find a STOPPED container to remove it; without -a the
    // stale container survives the rebuild.
    const { docker, calls } = recorder();
    docker.container.forWorkspace("/w/a", { includeStopped: true });
    assert.equal(calls[0][1], "-a");
  });

  test("no match yields an empty string, not undefined", () => {
    const { docker } = recorder([""]);
    assert.equal(docker.container.forWorkspace("/w/a"), "");
  });

  test("the first id wins when several match and no config is known", () => {
    const { docker } = recorder(["one\t/a.json\ntwo\t/b.json\n"]);
    assert.equal(docker.container.forWorkspace("/w/a"), "one");
  });
});

describe("which container actually belongs to a workspace", () => {
  // E10's second lock. The workspace label alone is a CLAIM: the CLI writes it
  // before it appends the project's own runArgs, so a project that could set
  // `--label` could stamp a sibling's folder onto its container and be handed
  // that sibling's editor session. policy.ts refuses the flag; this makes the
  // lookup itself insist on the half of the identity a project never chose.
  //
  // The paths below are WORKSPACE paths, and that is not cosmetic. These
  // fixtures used to name /tmp/desolate-specs/..., i.e. the snapshot desolate
  // passes to --override-config -- and the CLI does not label with that. It
  // labels with the config inside the workspace folder, whatever it was told to
  // read (measured; see labelledConfig in devcontainer.ts). Every caller was
  // handing this function the snapshot path, so it matched nothing and a
  // running container reported as absent: "devcontainer is not running after
  // up". A fixture that agrees with the code and not with the CLI is how that
  // survived a green suite.
  const candidates = [
    {
      id: "impostor",
      configFile: "/workspaces/attacker/.devcontainer/devcontainer.json",
    },
    {
      id: "genuine",
      configFile: "/workspaces/victim/.devcontainer/devcontainer.json",
    },
  ];

  test("the container naming OUR config file wins, whatever its position", () => {
    assert.equal(
      selectWorkspaceContainer(
        candidates,
        "/workspaces/victim/.devcontainer/devcontainer.json",
      ),
      "genuine",
    );
  });

  test("a container naming a DIFFERENT config file is not ours", () => {
    assert.equal(
      selectWorkspaceContainer(
        [candidates[0]],
        "/workspaces/victim/.devcontainer/devcontainer.json",
      ),
      "",
    );
  });

  test("a container with no config label at all is ours (pre-label vintage)", () => {
    assert.equal(
      selectWorkspaceContainer(
        [{ id: "old", configFile: "" }],
        "/workspaces/victim/.devcontainer/devcontainer.json",
      ),
      "old",
    );
  });

  test("with no config file known, the first match is the best answer", () => {
    // `desolate --stop` genuinely does not know which config a running
    // container was created from.
    assert.equal(selectWorkspaceContainer(candidates), "impostor");
    assert.equal(selectWorkspaceContainer([]), "");
  });

  test("a missing label column parses as empty, not as the id", () => {
    assert.deepEqual(parseWorkspaceCandidates("abc\t\ndef\t/c.json\n"), [
      { id: "abc", configFile: "" },
      { id: "def", configFile: "/c.json" },
    ]);
  });
});

describe("network attachments", () => {
  test("are read as pairs from a single template", () => {
    const { docker, calls } = recorder(["netA\t172.18.0.2\nnetB\t172.19.0.2\n"]);
    assert.deepEqual(docker.container.networks("cid"), [
      { network: "netA", ip: "172.18.0.2" },
      { network: "netB", ip: "172.19.0.2" },
    ]);
    // One template, tab-separated, newline-terminated. Two separate templates
    // that each range and emit no separator concatenate into garbage.
    const template = calls[0][2];
    assert.match(template, /\{\{range \$n, \$c := \.NetworkSettings\.Networks\}\}/);
    assert.ok(template.includes("\t"), "the pair separator is missing");
    assert.ok(template.includes('{{"\\n"}}'), "the record separator is missing");
  });

  test("a two-network container never yields a concatenated name", () => {
    // The measured failure: network -> "audit-n1audit-n2", which the relay then
    // passed to --network and socat got blamed for the error.
    const pairs = parseNetworkAttachments("audit-n1\t172.18.0.2\naudit-n2\t172.19.0.2\n");
    assert.equal(pairs.length, 2);
    for (const { network, ip } of pairs) {
      assert.doesNotMatch(network, /audit-n1audit-n2/);
      assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
    }
  });

  test("a network with no address is kept, so the caller can say so", () => {
    // recreateRelays picks the first attachment WITH an ip and reports all of
    // them when none has one; dropping them here would print "none".
    assert.deepEqual(parseNetworkAttachments("bridge\t\n"), [
      { network: "bridge", ip: "" },
    ]);
  });

  test("no networks yields an empty list", () => {
    assert.deepEqual(parseNetworkAttachments(""), []);
  });
});

describe("volumes", () => {
  test("overlay creation carries the driver, both opts and the key label", () => {
    const { docker, calls } = recorder();
    docker.volume.createOverlay("myapp-vscode-server", "lowerdir=/a,upperdir=/b/upper,workdir=/b/work", {
      "desolate.overlay.key": "deadbeef",
    });
    assert.deepEqual(calls[0], [
      "volume",
      "create",
      "--driver",
      "local",
      "--opt",
      "type=overlay",
      "--opt",
      "device=overlay",
      "--opt",
      "o=lowerdir=/a,upperdir=/b/upper,workdir=/b/work",
      "--label",
      "desolate.overlay.key=deadbeef",
      "myapp-vscode-server",
    ]);
  });

  test("the options string is passed as ONE argv element", () => {
    // It contains commas and '='. Splitting it, or letting a shell see it,
    // produces a volume the daemon accepts and overlayfs then ignores.
    const { docker, calls } = recorder();
    docker.volume.createOverlay("v", "lowerdir=/a,upperdir=/b/upper,workdir=/b/work", {});
    const optionArgs = calls[0].filter((a) => a.startsWith("o="));
    assert.equal(optionArgs.length, 1);
    assert.match(optionArgs[0], /^o=lowerdir=.*,upperdir=.*,workdir=.*$/);
  });

  test("removing nothing runs nothing", () => {
    // `docker volume rm -f` with no names is an error, and it would be reached
    // whenever a project has no volumes yet.
    const { docker, calls } = recorder();
    assert.equal(docker.volume.remove([]), 0);
    assert.equal(docker.container.remove([]), 0);
    assert.deepEqual(calls, []);
  });

  test("removing several passes them as separate arguments", () => {
    const { docker, calls } = recorder();
    docker.volume.remove(["a", "b"]);
    assert.deepEqual(calls[0], ["volume", "rm", "-f", "a", "b"]);
  });

  test("label and option lookups use the field they claim to", () => {
    const { docker, calls } = recorder(["", "", ""]);
    docker.volume.label("v", "desolate.overlay.key");
    docker.volume.mountpoint("v");
    docker.volume.options("v");
    assert.equal(calls[0].at(-1), '{{index .Labels "desolate.overlay.key"}}');
    assert.equal(calls[1].at(-1), "{{.Mountpoint}}");
    assert.equal(calls[2].at(-1), '{{index .Options "o"}}');
  });
});

describe("relays", () => {
  const spec = {
    image: "alpine/socat",
    name: "desolate-relay-myapp-8081",
    label: "desolate.relay=myapp",
    network: "myapp_devcontainer_default",
    hostPort: 8081,
    targetIp: "172.18.0.3",
    targetPort: 5173,
  };

  test("publishes the host port and dials the container port", () => {
    // The two are different numbers. Publishing the target, or dialling the
    // host port, yields a relay that starts and answers nothing.
    const { docker, calls } = recorder();
    docker.relay.start(spec);
    const argv = calls[0];
    assert.deepEqual(argv.slice(-2), [
      "tcp-listen:8081,fork,reuseaddr",
      "tcp:172.18.0.3:5173",
    ]);
    assert.equal(argv[argv.indexOf("-p") + 1], "8081:8081");
  });

  test("joins the same network the address came from", () => {
    const { docker, calls } = recorder();
    docker.relay.start(spec);
    assert.equal(calls[0][calls[0].indexOf("--network") + 1], spec.network);
  });

  test("is labelled so the project's own relays can be found again", () => {
    const { docker, calls } = recorder();
    docker.relay.start(spec);
    assert.equal(calls[0][calls[0].indexOf("--label") + 1], "desolate.relay=myapp");
  });

  test("carries no restart policy at all", () => {
    // A relay is socat pointed at an ADDRESS, captured when the relay was
    // created. `unless-stopped` outlives what makes that address true: docker
    // brings every relay back on a daemon restart, BEFORE and independently of
    // the devcontainers they dial, so each one fails, restarts, and adds its
    // own churn to the startup reconciliation. Worse, a devcontainer recreated
    // on a different address leaves the old relay forwarding a host port to
    // whatever now holds the old one -- a live port pointing somewhere nobody
    // chose. `--stop` removes relays explicitly and every start replaces them,
    // so nothing needs the policy.
    const { docker, calls } = recorder();
    docker.relay.start(spec);
    assert.ok(!calls[0].includes("--restart"), `${calls[0]}`);
    assert.ok(!calls[0].includes("unless-stopped"), `${calls[0]}`);
  });

  test("the readiness probe runs INSIDE the relay, not across a bridge", () => {
    // The whole point: `docker exec` travels the inner daemon's unix socket,
    // so the probe needs no IP route from the editor world to the container
    // world. A probe that dialled dind by name or address would pass only
    // while the lateral wall was down.
    const { docker, calls } = recorder();
    docker.relay.answers("desolate-relay-myapp-8081", 8081);
    const argv = calls[0];
    assert.equal(argv[0], "exec");
    assert.equal(argv[1], "desolate-relay-myapp-8081");
    assert.ok(
      argv.at(-1)!.includes("127.0.0.1:8081"),
      "the probe must dial the relay's own listener on loopback",
    );
    assert.ok(
      !argv.some((a) => /(^|[^\w])dind([^\w]|$)/.test(a)),
      "the probe must not name dind at all",
    );
  });

  test("any HTTP status counts as an answer, 401 and 403 included", () => {
    // the editor server replies 403 to a tokenless request. Treating that as
    // unreachable would fail every start with the editor working perfectly.
    const { docker, calls } = recorder();
    docker.relay.answers("desolate-relay-myapp-8081", 8081);
    const script = calls[0].at(-1)!;
    assert.ok(script.includes("HTTP/"), "matches on the status line, not the exit code");
    assert.ok(script.includes("socat"), "falls back to a TCP connect without busybox");
  });

  test("the socat arguments come after the image, never before", () => {
    const { docker, calls } = recorder();
    docker.relay.start(spec);
    const argv = calls[0];
    assert.ok(argv.indexOf(spec.image) < argv.length - 2, "image is not before its command");
    assert.ok(argv.indexOf("--name") < argv.indexOf(spec.image), "flags must precede the image");
  });
});

describe("exec and helper containers", () => {
  test("execAsRoot targets uid 0 explicitly", () => {
    // install-ca.sh writes to the system trust store; the devcontainer's
    // default user is usually not root.
    const { docker, calls } = recorder();
    docker.container.execAsRoot("cid", ["/desolate-ca/install-ca.sh"]);
    assert.deepEqual(calls[0], ["exec", "-u", "0", "cid", "/desolate-ca/install-ca.sh"]);
  });

  test("the docker-in-docker probe is one exec, spelled once", () => {
    // "does this container have a daemon of its own" is asked wherever a tag or
    // a build has to land inside it. Spelled at each call site it would drift.
    const { docker, calls } = recorder();
    docker.container.hasDockerCli("cid");
    assert.deepEqual(calls[0], [
      "exec",
      "-u",
      "0",
      "cid",
      "sh",
      "-c",
      "command -v docker >/dev/null 2>&1",
    ]);
  });

  test("nothing execs detached", () => {
    // There is no `docker exec -d` in desolate, and that is load-bearing. A
    // detached exec has no lifecycle relationship to anything, so work that
    // holds mounts -- the shadowImages job runs a nested image build, which
    // does -- can still be in flight when the container is stopped. The kernel
    // then cannot tear the mount namespace down, the container's init never
    // reports an exit, and the daemon supervising it waits for that exit
    // forever: the whole stack becomes unstoppable, including `docker stop`.
    const source = fs.readFileSync(
      new URL("../../../release/vscode-image/docker.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /"exec",\s*"-d"/);
  });

  test("a helper mounts exactly one volume and is removed", () => {
    const { docker, calls } = recorder();
    docker.inVolume("alpine:3", "myapp-ca-data", "/d", ["sh", "-c", "mkdir -p /d/upper /d/work"]);
    assert.deepEqual(calls[0], [
      "run",
      "--rm",
      "-v",
      "myapp-ca-data:/d",
      "alpine:3",
      "sh",
      "-c",
      "mkdir -p /d/upper /d/work",
    ]);
  });

  test("a helper never receives a bind mount of a shared directory", () => {
    // -v <name>:<target> is a named volume; -v /path:<target> is a bind, and a
    // bind of /server-dist or /desolate-ca is the poisonable shape.
    const { docker, calls } = recorder();
    docker.inVolume("alpine:3", "myapp-vscode-server", "/vscode-server", ["test", "-e", "/x"]);
    const mount = calls[0][calls[0].indexOf("-v") + 1];
    assert.doesNotMatch(mount, /^\//, `'${mount}' is a host path, not a named volume`);
  });
});

describe("mounts", () => {
  test("no value is interpolated into the template", () => {
    // The broker validates project names, but `cli.sh desolate` is a direct
    // path: a quote in a path would close the Go template and the daemon would
    // evaluate whatever followed. The whole table is read and matched in
    // TypeScript instead, so the template is a constant.
    const { docker, calls } = recorder([""]);
    docker.container.mounts("cid");
    const template = calls[0][2];
    assert.doesNotMatch(template, /if eq/, "the template branches on a value");
    for (const hostile of ['"', "'", "$(id)", "{{", "}}"])
      assert.ok(!template.includes(hostile) || template.startsWith("{{range"),
        `template carries ${hostile}`);
    // ... and the only argument after it is the container id.
    assert.deepEqual(calls[0].slice(0, 2), ["inspect", "-f"]);
    assert.equal(calls[0][3], "cid");
    assert.equal(calls[0].length, 4);
  });

  test("a path containing a quote is matched as data, not as template syntax", () => {
    const weird = `/workspaces/it's "quoted"`;
    const mounts = parseMounts(`${weird}\t/w\n/other\t/o\n`);
    assert.deepEqual(mounts, [
      { source: weird, destination: "/w" },
      { source: "/other", destination: "/o" },
    ]);
  });

  test("a mount with no destination is dropped by the caller, not here", () => {
    assert.deepEqual(parseMounts("/src\t\n"), [{ source: "/src", destination: "" }]);
  });

  test("no mounts yields an empty list", () => {
    assert.deepEqual(parseMounts(""), []);
  });
});

describe("images", () => {
  test("a base image declaring no USER is reported as root", () => {
    // Building as root and leaving it there breaks the devcontainer CLI's
    // assumptions; the derived image has to restore what the base declared.
    const { docker } = recorder([""]);
    assert.equal(docker.image.user("alpine:3"), "root");
  });

  test("a declared USER is preserved", () => {
    const { docker } = recorder(["1000"]);
    assert.equal(docker.image.user("some/image"), "1000");
  });

  test("the build reads its Dockerfile from stdin, never from disk", () => {
    // Writing it out would put a file the editor could race into the build.
    const { docker, calls, built } = recorder();
    docker.image.build("desolate-ca/base:abc", "FROM alpine\n", "/desolate-ca");
    assert.deepEqual(calls[0], ["build", "-t", "desolate-ca/base:abc", "-f", "-", "/desolate-ca"]);
    assert.deepEqual(built, ["FROM alpine\n"]);
  });

  test("the build context is the CA directory, so ca.pem is COPYable", () => {
    const { docker, calls } = recorder();
    docker.image.build("t", "FROM alpine", "/desolate-ca");
    assert.equal(calls[0].at(-1), "/desolate-ca");
  });
});

describe("a worktree's sandbox", () => {
  const spec = {
    image: "alpine/git@sha256:abc",
    label: "desolate.worktree-sandbox=acme/widgets@alpha",
    dir: "/workspaces/acme/widgets/.worktrees/alpha",
    mounts: ["type=bind,source=/workspaces/acme/widgets,target=/workspaces/acme/widgets"],
    seconds: 600,
  };
  const argvFor = (op: "checkout" | "changes") => {
    const { runner, calls } = recorder();
    const docker = createDocker(runner);
    if (op === "checkout") docker.checkoutWorktree({ ...spec, caFile: "/desolate-ca/ca.pem" });
    else docker.worktreeChanges(spec);
    return calls[0];
  };

  for (const op of ["checkout", "changes"] as const) {
    test(`${op}: as the editor user, gone when it exits, labelled for a sweep`, () => {
      const argv = argvFor(op);
      assert.deepEqual(argv.slice(0, 2), ["run", "--rm"]);
      assert.equal(argv[argv.indexOf("--user") + 1], "1000:1000");
      assert.equal(argv[argv.indexOf("--label") + 1], spec.label);
    });

    test(`${op}: exactly the mounts it was handed, and nothing privileged`, () => {
      const argv = argvFor(op);
      const given = argv.flatMap((word, i) => (word === "--mount" ? [argv[i + 1]] : []));
      assert.deepEqual(given, spec.mounts);
      for (const flag of ["--privileged", "--cap-add", "-v", "--volume", "--network"])
        assert.ok(!argv.includes(flag), `${flag} in ${argv}`);
      assert.ok(argv.indexOf("--workdir") < argv.indexOf(spec.image), "flags must precede the image");
    });
  }

  test("checkout is bounded from inside, and trusts the proxy for lfs", () => {
    const argv = argvFor("checkout");
    assert.equal(argv[argv.indexOf("--entrypoint") + 1], "timeout");
    assert.deepEqual(argv.slice(argv.indexOf(spec.image) + 1), [
      "600",
      "git",
      "-c",
      "http.sslCAInfo=/desolate-ca/ca.pem",
      "checkout",
      "--force",
    ]);
  });

  test("the changes check prints its marker only after a clean, silent git status", () => {
    const script = argvFor("changes").at(-1)!;
    assert.match(script, /^timeout 600 git status --porcelain --ignore-submodules=none /);
    assert.match(script, /\[ "\$ran" = 0 \] && \[ ! -s \/tmp\/warnings \] && echo desolate-status-ran/);
  });
});

describe("reading the changes check", () => {
  test("clean is the marker and nothing after it", () => {
    assert.deepEqual(parseWorktreeChanges(STATUS_RAN), []);
  });

  test("each changed or untracked path is one line", () => {
    assert.deepEqual(parseWorktreeChanges(`${STATUS_RAN}\n M src/app.ts\n?? notes.txt`), [
      " M src/app.ts",
      "?? notes.txt",
    ]);
  });

  test("no marker is not clean: the check did not run", () => {
    for (const text of ["", "fatal: not a git repository", "Unable to find image"])
      assert.equal(parseWorktreeChanges(text), null, text);
  });
});

describe("a project dind's create argv", () => {
  const spec = {
    name: "desolate-dind-acme__widgets",
    label: "desolate.dind=acme/widgets",
    network: "br-d-3f2a9c1e5b",
    runtime: "sysbox-runc" as const,
    image: "docker:29-dind",
    project: "acme/widgets",
    volumes: {
      data: "dind-data-acme__widgets",
      workspaces: "desolate_workspaces",
      sockets: "desolate_dind-sockets",
      socketSubpath: "acme__widgets",
      serverDist: "desolate_server-dist",
      health: "desolate_inner-health",
    },
    caDirectory: "/var/lib/desolate-proxy/public",
    limits: { memory: "4g", pids: 4096, cpus: "4" },
    daemonJson: '{"builder":{"gc":{"enabled":true,"defaultKeepStorage":"20GB"}}}',
  };
  const argvFor = (overrides: Partial<typeof spec> | { runtime: "runc" } = {}) => {
    const { runner, calls } = recorder();
    createDocker(runner).dind.create({ ...spec, ...overrides } as any);
    return calls[0];
  };
  const mounts = (argv: string[]) => argv.flatMap((word, i) => (word === "--mount" ? [argv[i + 1]] : []));

  test("publishes nothing and has no restart policy", () => {
    const argv = argvFor();
    for (const flag of ["-p", "--publish", "-P", "--publish-all", "--restart"])
      assert.ok(!argv.includes(flag), `${flag} in ${argv}`);
  });

  test("runs under sysbox and is NOT privileged", () => {
    const argv = argvFor();
    assert.equal(argv[argv.indexOf("--runtime") + 1], "sysbox-runc");
    assert.ok(!argv.includes("--privileged"));
    assert.ok(!argv.some((word) => word.startsWith("--cap-add")));
  });

  test("runc means privileged, and is spelled that way rather than hidden", () => {
    const argv = argvFor({ runtime: "runc" });
    assert.ok(argv.includes("--privileged"));
    assert.ok(!argv.includes("--runtime"));
  });

  test("sees ONE project, at its own path, as a subpath of the workspaces volume", () => {
    const workspace = mounts(argvFor()).filter((m) => m.includes("desolate_workspaces"));
    assert.deepEqual(workspace, [
      "type=volume,source=desolate_workspaces,target=/workspaces/acme/widgets,volume-subpath=acme/widgets",
    ]);
  });

  test("listens in its own directory of the shared sockets volume", () => {
    assert.ok(mounts(argvFor()).includes(
      "type=volume,source=desolate_dind-sockets,target=/run/dind-sock,volume-subpath=acme__widgets",
    ));
  });

  test("keeps its images in a volume of its own, and mounts the rest read-only", () => {
    const all = mounts(argvFor());
    assert.ok(all.includes("type=volume,source=dind-data-acme__widgets,target=/var/lib/docker"));
    for (const shared of ["desolate_server-dist", "desolate_inner-health", "/var/lib/desolate-proxy/public"])
      assert.match(all.find((m) => m.includes(shared))!, /,readonly$/, shared);
  });

  test("is bounded: memory, pids and cpus", () => {
    const argv = argvFor();
    assert.equal(argv[argv.indexOf("--memory") + 1], "4g");
    assert.equal(argv[argv.indexOf("--pids-limit") + 1], "4096");
    assert.equal(argv[argv.indexOf("--cpus") + 1], "4");
  });

  test("dockerd listens on the socket the devcontainer binds, for the editor's group", () => {
    const argv = argvFor();
    const daemon = argv.slice(argv.indexOf("dockerd"));
    assert.deepEqual(daemon, [
      "dockerd",
      "--host=unix:///run/dind-sock/docker.sock",
      "--group=1000",
      "--default-ulimit=nofile=65536:524288",
    ]);
    // and the alias docker-outside-of-docker's own mount takes its source from
    assert.match(argv[argv.indexOf("-c") + 1], /ln -sf \/run\/dind-sock\/docker\.sock \/var\/run\/docker\.sock/);
  });

  test("carries its daemon.json in, for the BuildKit GC", () => {
    const argv = argvFor();
    assert.ok(argv.includes(`DESOLATE_DAEMON_JSON=${spec.daemonJson}`));
  });

  test("is labelled so a sweep that knows no targets finds it", () => {
    const argv = argvFor();
    assert.equal(argv[argv.indexOf("--label") + 1], "desolate.dind=acme/widgets");
  });
});

describe("a relay that falls back to the project's dind", () => {
  test("tries the devcontainer, then the dind, at the same port -- quoted for socat's parser", () => {
    assert.equal(
      relayWithFallback("172.17.0.5", "172.17.0.1", 8000),
      'system:"socat - TCP:172.17.0.5:8000,connect-timeout=2 || exec socat - TCP:172.17.0.1:8000"',
    );
  });

  test("nothing but addresses and a port reaches the shell it runs in", () => {
    for (const [first, then, port] of [
      ["172.17.0.5; rm -rf /", "172.17.0.1", 8000],
      ["172.17.0.5", "$(id)", 8000],
      ["172.17.0.5", "172.17.0.1", 0],
      ["172.17.0.5", "172.17.0.1", 8000.5],
      ["999.1.1.1", "172.17.0.1", 8000],
    ] as const)
      assert.throws(() => relayWithFallback(first, then, port), /refusing/, JSON.stringify([first, then, port]));
  });

  test("relay.start uses it only when asked", () => {
    const base = { image: "alpine/socat", name: "r", label: "l", network: "bridge", hostPort: 8082, targetIp: "172.17.0.5", targetPort: 8000 };
    const { runner, calls } = recorder();
    const docker = createDocker(runner);
    docker.relay.start(base);
    docker.relay.start({ ...base, fallbackIp: "172.17.0.1" });
    assert.equal(calls[0].at(-1), "tcp:172.17.0.5:8000");
    assert.match(calls[1].at(-1)!, /^system:"socat - TCP:172\.17\.0\.5:8000.* TCP:172\.17\.0\.1:8000"$/);
  });
});

describe("reclaiming root-owned files (#15)", () => {
  const argv = reclaimArgv("img@sha256:x", "/workspaces/acme/widgets", ".worktrees/wip/out", 1000);
  const flag = (name: string) => argv.flatMap((arg, i) => (arg === name ? [argv[i + 1]] : []));

  test("mounts the PROJECT root, and reaches the path inside it", () => {
    assert.deepEqual(flag("--mount"), ["type=bind,source=/workspaces/acme/widgets,target=/w"]);
    assert.equal(argv.at(-1), "/w/.worktrees/wip/out");
  });

  test("runs as root with no network and only what a chown needs", () => {
    assert.deepEqual(flag("--network"), ["none"]);
    assert.deepEqual(flag("--user"), ["0:0"]);
    assert.deepEqual(flag("--cap-drop"), ["ALL"]);
    assert.deepEqual(flag("--cap-add").sort(), ["CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH"]);
    assert.ok(argv.includes("no-new-privileges"));
  });

  test("changes links, not what they name, and takes the path as an argument, never as script", () => {
    const script = argv[argv.indexOf("-c") + 1];
    assert.match(script, /chown -R -h 1000:1000 -- "\$1"/);
    assert.doesNotMatch(script, /\.worktrees|widgets/);
  });

  test("a run that did not finish is null, not zero", () => {
    assert.equal(recorder([`${RECLAIMED} 3`]).docker.reclaim("i", "/p", ".", 1000), 3);
    assert.equal(recorder([""]).docker.reclaim("i", "/p", ".", 1000), null);
    assert.equal(recorder(["chown: /w/x: Operation not permitted"]).docker.reclaim("i", "/p", ".", 1000), null);
  });
});

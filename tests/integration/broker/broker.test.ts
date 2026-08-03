/// <reference types="node" />
// // Integration test for the load-bearing path: a client speaking the broker's
// wire protocol over its unix socket, exactly as `desolate` does from inside
// the editor container.
//
// Unlike tests/unit/broker, nothing here is stubbed on the policy side. The
// real broker.ts runs, snapshots the real files, shells out to the real
// @devcontainers/cli for `read-configuration --include-merged-configuration`,
// and enforces on what the CLI reports. That matters: the escapes this guards
// against were all cases where the policy's picture of a project and the CLI's
// picture disagreed, and only a test that consults both can see that.
//
// The one thing that IS stubbed is the runner. desolate.ts needs a whole inner
// daemon, a seeded /server-dist and socat relays; none of that is needed to
// answer the question this file asks, which is "does anything hostile ever
// reach the runner at all". The stub records its argv and exits 0.
//
// Requires: node >= 22.18, and `devcontainer` on PATH.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
// Shipped code lives under release/; this harness lives outside it.
const RELEASE = path.join(REPO, "release");
const BROKER = path.join(RELEASE, "vscode-image", "broker.ts");

let tmp: string;
let workspaces: string;
let socket: string;
let specDir: string;
let runnerLog: string;
let broker: ChildProcess;

/** Speak the protocol the editor speaks: one JSON line in, JSON lines out. */
function ask(req: unknown, timeoutMs = 180_000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    const msgs: any[] = [];
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("broker timeout"));
    }, timeoutMs);
    conn.on("connect", () => conn.write(JSON.stringify(req) + "\n"));
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) {
          try {
            msgs.push(JSON.parse(line));
          } catch {
            msgs.push({ raw: line });
          }
        }
      }
    });
    conn.on("close", () => {
      clearTimeout(timer);
      resolve(msgs);
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const result = (msgs: any[]) => msgs.find((m) => m.ok !== undefined) ?? {};
const errorOf = (msgs: any[]) => String(result(msgs).error ?? "");

function project(
  name: string,
  devcontainerJson: string,
  extra: Record<string, string> = {},
) {
  const dir = path.join(workspaces, name, ".devcontainer");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "devcontainer.json"), devcontainerJson);
  for (const [rel, body] of Object.entries(extra)) {
    const p = path.join(workspaces, name, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return path.join(workspaces, name);
}

/** argv of every runner invocation since the last reset. */
function runnerInvocations(): string[][] {
  if (!fs.existsSync(runnerLog)) return [];
  return fs
    .readFileSync(runnerLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
const resetRunner = () => fs.writeFileSync(runnerLog, "");

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-it-"));
  workspaces = path.join(tmp, "workspaces");
  specDir = path.join(tmp, "specs");
  socket = path.join(tmp, "desolate.sock");
  runnerLog = path.join(tmp, "runner.log");
  fs.mkdirSync(workspaces, { recursive: true });
  resetRunner();

  // Stub runner: record argv, succeed. Reaching it at all is the failure signal
  // for every hostile case below.
  const stub = path.join(tmp, "stub-runner.ts");
  fs.writeFileSync(
    stub,
    `import * as fs from "node:fs";\n` +
      `fs.appendFileSync(${JSON.stringify(runnerLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
      `console.log("stub runner ok");\n`,
  );

  // The broker spawns the runner with `tsx`; on a modern node a shim that just
  // calls node keeps the test free of that dependency.
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "tsx"), '#!/bin/sh\nexec node "$@"\n', {
    mode: 0o755,
  });

  broker = spawn("node", [BROKER], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DESOLATE_WORKSPACES: workspaces,
      DESOLATE_BROKER: socket,
      DESOLATE_SPECS: specDir,
      DESOLATE_RUNNER: stub,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  broker.stderr?.on("data", (d) => process.stderr.write(`[broker] ${d}`));

  for (let i = 0; i < 100 && !fs.existsSync(socket); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(fs.existsSync(socket), "broker socket never appeared");
});

after(() => {
  broker?.kill("SIGTERM");
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ===========================================================================
describe("hostile specs never reach the runner", () => {
  // ===========================================================================

  test("E1: initializeCommand", async () => {
    project(
      "evil-init",
      JSON.stringify({
        image: "alpine:3",
        initializeCommand: "touch /tmp/desolate-integration-pwned",
      }),
    );
    fs.rmSync("/tmp/desolate-integration-pwned", { force: true });
    resetRunner();
    const msgs = await ask({ op: "start", project: "evil-init" });
    assert.equal(
      result(msgs).ok,
      false,
      "broker accepted an initializeCommand spec",
    );
    assert.match(errorOf(msgs), /initializeCommand/);
    assert.deepEqual(
      runnerInvocations(),
      [],
      "runner was invoked for a rejected spec",
    );
    assert.ok(
      !fs.existsSync("/tmp/desolate-integration-pwned"),
      "initializeCommand EXECUTED -- the orchestrator is compromised",
    );
  });

  test("E2: compose mode", async () => {
    project(
      "evil-compose",
      JSON.stringify({
        dockerComposeFile: "docker-compose.yml",
        service: "app",
        workspaceFolder: "/work",
      }),
      {
        ".devcontainer/docker-compose.yml":
          "services:\n  app:\n    image: alpine:3\n    privileged: true\n" +
          "    pid: host\n    network_mode: host\n    volumes:\n      - /:/host\n",
      },
    );
    resetRunner();
    const msgs = await ask({ op: "start", project: "evil-compose" });
    assert.equal(result(msgs).ok, false);
    assert.match(errorOf(msgs), /dockerComposeFile/);
    assert.deepEqual(runnerInvocations(), []);
  });

  test("E3: privilege injected by a local feature", async () => {
    project(
      "evil-feature",
      JSON.stringify({
        image: "alpine:3",
        features: { "./evilfeat": {} },
      }),
      {
        ".devcontainer/evilfeat/devcontainer-feature.json": JSON.stringify({
          id: "evilfeat",
          version: "1.0.0",
          name: "evil",
          privileged: true,
          capAdd: ["SYS_ADMIN"],
          securityOpt: ["seccomp=unconfined"],
          mounts: [{ source: "/", target: "/host", type: "bind" }],
        }),
        ".devcontainer/evilfeat/install.sh": "#!/bin/sh\nexit 0\n",
      },
    );
    resetRunner();
    const msgs = await ask({ op: "start", project: "evil-feature" });
    assert.equal(
      result(msgs).ok,
      false,
      "feature-injected privilege was accepted",
    );
    assert.deepEqual(runnerInvocations(), []);
  });

  test("E4: JSONC divergence -- mounts hidden from a regex, visible to the CLI", async () => {
    // The exact document that defeated the previous parser.
    project(
      "evil-jsonc",
      `{
  "image": "alpine:3",
  "name": "a/*",
  "mounts": ["source=victim-secrets,target=/steal,type=volume"],
  "postCreateCommand": "*/ id"
}`,
    );
    resetRunner();
    const msgs = await ask({ op: "start", project: "evil-jsonc" });
    assert.equal(result(msgs).ok, false, "the hidden mount was accepted");
    assert.match(errorOf(msgs), /namespace|visible to|different shape/);
    assert.deepEqual(runnerInvocations(), []);
  });

  test("variable substitution in mounts is NOT a parser disagreement", async () => {
    // The devcontainer CLI substitutes ${...} in .configuration, so the CLI's
    // value and our parse of the file legitimately differ. Comparing values
    // therefore refused the standard node_modules idiom -- straight out of
    // Microsoft's own docs -- with a message blaming comments. The cross-check
    // compares PRESENCE and SHAPE instead, which substitution cannot change.
    project(
      "subst-mounts",
      `{
  "image": "alpine:3",
  "mounts": ["source=\${localWorkspaceFolderBasename}-node_modules,target=\${containerWorkspaceFolder}/node_modules,type=volume"]
}`,
    );
    resetRunner();
    const msgs = await ask({ op: "start", project: "subst-mounts" });
    // It may still be refused by the VOLUME NAMESPACE rule (the substituted
    // name belongs to this project, so it should not be) -- but never by the
    // cross-check, which is what this pins.
    assert.doesNotMatch(
      errorOf(msgs) ?? "",
      /visible to|different shape/,
      "substitution was mistaken for a parser disagreement",
    );
  });

  test("E5: runArgs namespace escapes in every spelling", async () => {
    for (const runArgs of [
      ["--network", "host"],
      ["--net=host"],
      ["--pid=container:desolate-orchestrator"],
      ["--uts=host"],
      ["-v", "/:/host"],
      ["--privileged"],
    ]) {
      project("evil-runargs", JSON.stringify({ image: "alpine:3", runArgs }));
      resetRunner();
      const msgs = await ask({ op: "start", project: "evil-runargs" });
      assert.equal(
        result(msgs).ok,
        false,
        `runArgs ${JSON.stringify(runArgs)} reached the runner`,
      );
      assert.deepEqual(runnerInvocations(), []);
    }
  });

  test("another project's volume, declared directly", async () => {
    project(
      "evil-mount",
      JSON.stringify({
        image: "alpine:3",
        mounts: ["source=victim-secrets,target=/steal,type=volume"],
      }),
    );
    resetRunner();
    const msgs = await ask({ op: "start", project: "evil-mount" });
    assert.equal(result(msgs).ok, false);
    assert.match(errorOf(msgs), /namespace/);
  });

  test("E10: volume-opt -- a bind of dind's filesystem named as a volume", async () => {
    // The CLI hands a STRING mount to `docker run --mount` unchanged, and the
    // `local` driver turns type=none,o=bind,device=/ into a bind of the inner
    // daemon's root. Source and type both look correct to a policy that reads
    // only source and type, which is why this has to be proven against the real
    // merged configuration and not just the unit fixture.
    for (const mount of [
      "type=volume,source=evil-esc,target=/esc,volume-driver=local,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/",
      "type=volume,source=evil-esc,target=/esc,volume-opt=device=/var/lib/docker",
    ]) {
      project("evil-esc", JSON.stringify({ image: "alpine:3", mounts: [mount] }));
      resetRunner();
      const msgs = await ask({ op: "start", project: "evil-esc" });
      assert.equal(result(msgs).ok, false, `${mount} reached the runner`);
      assert.match(errorOf(msgs), /not on the allowlist/);
      assert.deepEqual(runnerInvocations(), []);
    }
  });

  test("E11: src= after source= -- the mount docker makes is not the one checked", async () => {
    for (const [name, config] of [
      [
        "evil-alias",
        {
          image: "alpine:3",
          mounts: ["type=volume,source=evil-alias-ok,target=/c,src=victim-secrets"],
        },
      ],
      [
        "evil-wsmount",
        {
          image: "alpine:3",
          workspaceFolder: "/workspaces/evil-wsmount",
          workspaceMount:
            "source=/workspaces/evil-wsmount,target=/workspaces/evil-wsmount,type=bind,src=/workspaces",
        },
      ],
    ] as const) {
      project(name, JSON.stringify(config));
      resetRunner();
      const msgs = await ask({ op: "start", project: name });
      assert.equal(result(msgs).ok, false, `${name} reached the runner`);
      assert.deepEqual(runnerInvocations(), []);
    }
  });

  test("E12: --label -- claiming another project's container identity", async () => {
    for (const runArgs of [
      ["--label", "devcontainer.local_folder=/workspaces/victim"],
      ["-l", "devcontainer.config_file="],
    ]) {
      project("evil-label", JSON.stringify({ image: "alpine:3", runArgs }));
      resetRunner();
      const msgs = await ask({ op: "start", project: "evil-label" });
      assert.equal(
        result(msgs).ok,
        false,
        `runArgs ${JSON.stringify(runArgs)} reached the runner`,
      );
      assert.deepEqual(runnerInvocations(), []);
    }
  });
});

// ===========================================================================
describe("request-level validation", () => {
  // ===========================================================================

  test("path traversal and absolute paths are refused", async () => {
    for (const p of ["../etc", "/etc", "a/../../etc", "..", ".", "", "-rf"]) {
      const msgs = await ask({ op: "start", project: p });
      assert.equal(
        result(msgs).ok,
        false,
        `project name ${JSON.stringify(p)} was accepted`,
      );
    }
  });

  test("a symlink out of /workspaces is refused", async () => {
    // The regex cannot catch this -- "escape" is a perfectly legal name. It is
    // the realpath comparison that does, and that comparison is what allows
    // nested `owner/repo` projects without needing a second case.
    fs.symlinkSync(os.tmpdir(), path.join(workspaces, "escape"));
    resetRunner();
    const msgs = await ask({ op: "start", project: "escape" });
    assert.equal(
      result(msgs).ok,
      false,
      "a symlink out of /workspaces was accepted",
    );
    assert.match(errorOf(msgs), /exact path|direct child/);
    assert.deepEqual(runnerInvocations(), [], "the runner was invoked anyway");
  });

  test("a nested owner/repo project is accepted", async () => {
    // The other half of the same change: one level of nesting is legal, so
    // `cli.sh repo add owner/repo` can clone to /workspaces/owner/repo.
    fs.mkdirSync(path.join(workspaces, "acme", "widgets", ".devcontainer"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(
        workspaces,
        "acme",
        "widgets",
        ".devcontainer",
        "devcontainer.json",
      ),
      JSON.stringify({ image: "alpine:3" }),
    );
    resetRunner();
    const msgs = await ask({ op: "start", project: "acme/widgets" });
    assert.equal(
      result(msgs).ok,
      true,
      errorOf(msgs) ?? "nested project was refused",
    );
  });

  test("two levels of nesting are refused", async () => {
    fs.mkdirSync(path.join(workspaces, "a", "b", "c"), { recursive: true });
    const msgs = await ask({ op: "start", project: "a/b/c" });
    assert.equal(result(msgs).ok, false, "a/b/c was accepted");
  });

  test("unknown ops are refused", async () => {
    for (const op of ["exec", "run", "delete", "", null, 42]) {
      const msgs = await ask({ op, project: "ok-project" });
      assert.equal(
        result(msgs).ok,
        false,
        `op ${JSON.stringify(op)} was accepted`,
      );
    }
  });

  test("oversized requests are refused rather than buffered", async () => {
    const msgs = await ask({ op: "start", project: "x".repeat(8000) });
    assert.equal(result(msgs).ok, false);
  });

  test("list returns project names only", async () => {
    project("ok-project", JSON.stringify({ image: "alpine:3" }));
    const msgs = await ask({ op: "list" });
    assert.equal(result(msgs).ok, true);
    assert.ok(result(msgs).projects.includes("ok-project"));
  });
});

// ===========================================================================
describe("a legitimate project starts, from a frozen copy", () => {
  // ===========================================================================

  test("benign spec reaches the runner", async () => {
    project(
      "ok-project",
      JSON.stringify({
        image: "alpine:3",
        runArgs: [
          "--security-opt",
          "no-new-privileges:true",
          "--cap-drop",
          "ALL",
          "--pids-limit",
          "1024",
        ],
        mounts: ["source=ok-project-data,target=/data,type=volume"],
        customizations: { desolate: { ports: [5173] } },
      }),
    );
    resetRunner();
    const msgs = await ask({ op: "start", project: "ok-project" });
    assert.equal(
      result(msgs).ok,
      true,
      `benign project was refused: ${errorOf(msgs)}`,
    );
    const calls = runnerInvocations();
    assert.equal(
      calls.length,
      1,
      "runner should have been invoked exactly once",
    );
    assert.ok(calls[0].includes("ok-project"));
  });

  test("TOCTOU: the runner gets the validated copy, not the live file", async () => {
    // The attack this closes: the editor writes a benign devcontainer.json, asks
    // the broker to start it, and swaps in a hostile one while the policy check
    // is still running. Without a snapshot the check describes a file that no
    // longer exists by the time the container is created.
    const dir = project("toctou", JSON.stringify({ image: "alpine:3" }));
    resetRunner();
    const msgs = await ask({ op: "start", project: "toctou" });
    assert.equal(result(msgs).ok, true, errorOf(msgs));

    const calls = runnerInvocations();
    const idx = calls[0].indexOf("--config");
    assert.ok(idx >= 0, "runner was not pinned to a snapshot with --config");
    const snapshot = calls[0][idx + 1];

    // The snapshot must live outside the editor-writable workspace tree.
    assert.ok(
      !snapshot.startsWith(workspaces),
      `snapshot ${snapshot} is inside the editor-writable workspace`,
    );

    // Now do what the attacker would: rewrite the project file post-validation.
    fs.writeFileSync(
      path.join(dir, ".devcontainer", "devcontainer.json"),
      JSON.stringify({ image: "alpine:3", runArgs: ["--privileged"] }),
    );

    const frozen = JSON.parse(fs.readFileSync(snapshot, "utf8"));
    assert.equal(
      frozen.runArgs,
      undefined,
      "the snapshot followed the live file -- TOCTOU window is open",
    );
  });

  test("E13: TOCTOU through a symlinked devcontainer.json", async () => {
    // The same attack as above, wearing one layer of indirection -- and it used
    // to work, because `fs.cpSync(..., {dereference: true})` does not
    // dereference: it wrote a symlink into the snapshot still pointing at the
    // project. Every read after the "freeze" -- the policy's own
    // read-configuration, and later `devcontainer up` -- followed the link back
    // to a file the project can rewrite at any moment.
    const dir = project("toctou-link", JSON.stringify({ image: "alpine:3" }));
    const live = path.join(dir, "live-spec.json");
    fs.writeFileSync(live, JSON.stringify({ image: "alpine:3" }));
    const config = path.join(dir, ".devcontainer", "devcontainer.json");
    fs.rmSync(config);
    fs.symlinkSync(live, config);

    resetRunner();
    const msgs = await ask({ op: "start", project: "toctou-link" });
    assert.equal(result(msgs).ok, true, errorOf(msgs));

    const calls = runnerInvocations();
    const snapshot = calls[0][calls[0].indexOf("--config") + 1];
    assert.ok(
      !fs.lstatSync(snapshot).isSymbolicLink(),
      "the snapshot is a symlink back into the project -- it froze nothing",
    );

    fs.writeFileSync(
      live,
      JSON.stringify({ image: "alpine:3", runArgs: ["--privileged"] }),
    );
    assert.equal(
      JSON.parse(fs.readFileSync(snapshot, "utf8")).runArgs,
      undefined,
      "the snapshot followed the link -- TOCTOU window is open",
    );
  });

  test("local features are snapshotted too, not just the json", async () => {
    // A config can point at ./myfeature, whose metadata carries privilege of
    // its own. Freezing only devcontainer.json would leave that swappable.
    project(
      "feat-snap",
      JSON.stringify({ image: "alpine:3", features: { "./feat": {} } }),
      {
        ".devcontainer/feat/devcontainer-feature.json": JSON.stringify({
          id: "feat",
          version: "1.0.0",
          name: "harmless",
        }),
        ".devcontainer/feat/install.sh": "#!/bin/sh\nexit 0\n",
      },
    );
    resetRunner();
    const msgs = await ask({ op: "start", project: "feat-snap" });
    assert.equal(result(msgs).ok, true, errorOf(msgs));
    const calls = runnerInvocations();
    const snapshot = calls[0][calls[0].indexOf("--config") + 1];
    assert.ok(
      fs.existsSync(
        path.join(path.dirname(snapshot), "feat", "devcontainer-feature.json"),
      ),
      "the local feature was not copied into the snapshot",
    );
  });
});

// ===========================================================================
describe("preconditions", () => {
  // ===========================================================================
  test("the devcontainer CLI is on PATH (the policy's ground truth)", () => {
    const v = execFileSync("devcontainer", ["--version"], {
      encoding: "utf8",
    }).trim();
    assert.match(v, /\d+\.\d+/);
  });
});

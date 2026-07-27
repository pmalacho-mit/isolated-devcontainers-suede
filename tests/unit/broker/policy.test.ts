/// <reference types="node" />
// Unit tests for the broker's spec policy.
//
// Every case under "demonstrated escapes" corresponds to an attack that was
// executed successfully against the previous policy, in this repo, with the
// real @devcontainers/cli. They are regression tests, not hypotheticals: if one
// of them starts passing again, that escape is live.
//
// Runs on plain node (>= 22.18 strips types natively); no build, no deps.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  enforcePolicy,
  parseJsonc,
  stripJsonc,
  normalizeMount,
  type ResolvedSpec,
} from "../../../release/vscode-image/policy.ts";

const PROJECT = "myapp";

/** Build a ResolvedSpec the way `devcontainer read-configuration
 *  --include-merged-configuration` reports one. */
function spec(configuration: any, mergedConfiguration: any = {}): ResolvedSpec {
  return { configuration, mergedConfiguration };
}

function refuses(cfg: ResolvedSpec, match: RegExp | string) {
  assert.throws(
    () => enforcePolicy(PROJECT, cfg, { workspaces: "/workspaces" }),
    (err: Error) => {
      const m =
        typeof match === "string"
          ? err.message.includes(match)
          : match.test(err.message);
      assert.ok(
        m,
        `error message did not match ${match}\n  actual: ${err.message}`,
      );
      return true;
    },
  );
}

function allows(cfg: ResolvedSpec) {
  enforcePolicy(PROJECT, cfg, { workspaces: "/workspaces" });
}

// ===========================================================================
describe("demonstrated escapes (regression)", () => {
  // ===========================================================================

  test("E1: initializeCommand -- code execution on the orchestrator", () => {
    // Verified: the devcontainer CLI runs this with /bin/sh on the machine
    // driving it. That machine is the orchestrator, and it has DOCKER_HOST
    // pointed at the inner daemon. Confirmed by observing the marker file and
    // the inherited DOCKER_HOST in a real `devcontainer up`.
    refuses(
      spec({ image: "x", initializeCommand: "id > /tmp/pwned" }),
      /initializeCommand/,
    );
    refuses(
      spec({ image: "x", initializeCommand: ["sh", "-c", "id"] }),
      /initializeCommand/,
    );
    // ... but the in-container hooks stay allowed; they are the project's own turf.
    allows(
      spec({
        image: "x",
        postCreateCommand: "npm ci",
        onCreateCommand: "echo hi",
        postStartCommand: "echo hi",
        postAttachCommand: "echo hi",
        updateContentCommand: "echo hi",
      }),
    );
  });

  test("E2: compose mode -- privilege declared where the policy cannot see it", () => {
    // Verified: a devcontainer.json with only dockerComposeFile/service/
    // workspaceFolder passed every old check, and produced a container with
    // Privileged=true PidMode=host NetworkMode=host Binds=[/:/host:rw].
    refuses(
      spec({
        dockerComposeFile: "docker-compose.yml",
        service: "app",
        workspaceFolder: "/work",
      }),
      /dockerComposeFile/,
    );
    refuses(
      spec({ dockerComposeFile: ["a.yml", "b.yml"], service: "app" }),
      /dockerComposeFile/,
    );
  });

  test("E3: features -- privilege injected by feature metadata", () => {
    // Verified: a local ./evilfeat with privileged/capAdd/securityOpt/mounts in
    // its devcontainer-feature.json produced
    //   --privileged --cap-add SYS_ADMIN --security-opt seccomp=unconfined
    //   --mount type=bind,src=/,dst=/host
    // while the project's own devcontainer.json declared none of it.
    // The policy now enforces on mergedConfiguration, where features land.
    const featureMerged = {
      privileged: true,
      capAdd: ["SYS_ADMIN"],
      securityOpt: ["seccomp=unconfined"],
      mounts: [
        { source: "/", target: "/host", type: "bind" },
        { source: "victim-secrets", target: "/steal", type: "volume" },
      ],
    };
    refuses(
      spec({ image: "x", features: { "./evilfeat": {} } }, featureMerged),
      /PRIVILEGED/,
    );
    // even with the privilege opt-in, the bind mount and the foreign volume stay refused
    refuses(
      spec(
        { image: "x", customizations: { desolate: { allowPrivileged: true } } },
        { mounts: [{ source: "/", target: "/host", type: "bind" }] },
      ),
      /bind/,
    );
    refuses(
      spec(
        { image: "x", customizations: { desolate: { allowPrivileged: true } } },
        {
          mounts: [
            { source: "victim-secrets", target: "/steal", type: "volume" },
          ],
        },
      ),
      /outside this project's namespace/,
    );
    refuses(
      spec(
        { image: "x", customizations: { desolate: { allowPrivileged: true } } },
        { securityOpt: ["apparmor=unconfined"] },
      ),
      /weakens the sandbox/,
    );
  });

  test("E4: JSONC divergence -- hide a key from the policy, keep it for the CLI", () => {
    // Verified against the real CLI. This exact document made the old regex
    // stripper see {"image","workspaceFolder","name"} -- no mounts, no runArgs --
    // while `devcontainer read-configuration` reported both.
    const payload = `{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
  "workspaceFolder": "/workspaces/evil",
  "name": "a/*",
  "mounts": ["source=victim-secrets,target=/steal,type=volume"],
  "runArgs": ["--privileged"],
  "postCreateCommand": "*/ id"
}`;
    const parsed = parseJsonc(payload);
    // The scanner must see the SAME thing the CLI does.
    assert.equal(parsed.name, "a/*");
    assert.deepEqual(parsed.mounts, [
      "source=victim-secrets,target=/steal,type=volume",
    ]);
    assert.deepEqual(parsed.runArgs, ["--privileged"]);
    assert.equal(parsed.postCreateCommand, "*/ id");
    // ... and having seen it, must refuse it.
    refuses(spec(parsed), /outside this project's namespace/);
  });

  test("E5: runArgs -- every alternate spelling of a namespace escape", () => {
    // Verified: all of these were ACCEPTED by the old denylist, which matched
    // only the literal strings "--network=host", "--pid=host", etc.
    const escapes = [
      ["--network", "host"],
      ["--net=host"],
      ["--net", "host"],
      ["--userns", "host"],
      ["--ipc", "host"],
      ["--pid=container:desolate-orchestrator"],
      ["--network=container:victim"],
      ["--cgroupns=host"],
      ["--uts=host"],
      ["--device-cgroup-rule", "a *:* rwm"],
      ["--privileged"],
      ["--cap-add=SYS_ADMIN"],
      ["--device", "/dev/kmsg"],
      ["-v", "/:/host"],
      ["--volume=/:/host"],
      ["--mount", "type=bind,src=/,dst=/host"],
      ["--pid", "host"],
      ["--userns=host"],
      ["--ipc=host"],
      ["--network=host"],
    ];
    for (const runArgs of escapes) {
      assert.throws(
        () => enforcePolicy(PROJECT, spec({ image: "x", runArgs })),
        (err: Error) => err.name === "PolicyError" || err instanceof Error,
        `runArgs ${JSON.stringify(runArgs)} was ACCEPTED -- namespace escape is live`,
      );
    }
  });

  test("E5b: a permissive seccomp profile from a project-writable path", () => {
    refuses(
      spec({
        image: "x",
        runArgs: ["--security-opt", "seccomp=./permissive.json"],
      }),
      /weakens the sandbox/,
    );
    refuses(
      spec({ image: "x", runArgs: ["--security-opt=seccomp=unconfined"] }),
      /weakens the sandbox/,
    );
    refuses(
      spec({ image: "x", runArgs: ["--security-opt", "label=disable"] }),
      /weakens the sandbox/,
    );
  });
});

// ===========================================================================
describe("mounts", () => {
  // ===========================================================================

  test("a project may mount only its own volume namespace", () => {
    allows(
      spec({ image: "x", mounts: ["source=myapp,target=/data,type=volume"] }),
    );
    allows(
      spec({
        image: "x",
        mounts: ["source=myapp-secrets,target=/secrets,type=volume"],
      }),
    );
    refuses(
      spec({ image: "x", mounts: ["source=other,target=/steal,type=volume"] }),
      /outside this project's namespace/,
    );
    // prefix collision: "myapp2" must not pass as "myapp"+"-"
    refuses(
      spec({ image: "x", mounts: ["source=myapp2,target=/steal,type=volume"] }),
      /outside this project's namespace/,
    );
  });

  test("bind mounts are refused, except the read-only public CA", () => {
    refuses(
      spec({ image: "x", mounts: ["source=/,target=/host,type=bind"] }),
      /bind/,
    );
    refuses(
      spec({
        image: "x",
        mounts: ["source=/workspaces,target=/all,type=bind"],
      }),
      /bind/,
    );
    allows(
      spec({
        image: "x",
        mounts: ["source=/desolate-ca,target=/desolate-ca,type=bind"],
      }),
    );
  });

  test("object-form mounts are normalised the same way as string-form", () => {
    refuses(
      spec({
        image: "x",
        mounts: [{ source: "other", target: "/steal", type: "volume" }],
      }),
      /outside this project's namespace/,
    );
    allows(
      spec({
        image: "x",
        mounts: [{ source: "myapp-db", target: "/db", type: "volume" }],
      }),
    );
    // A source containing a comma must not be able to forge a later field.
    const m = normalizeMount({ source: "x,type=volume", type: "bind" });
    assert.equal(m.type, "bind");
  });

  test("the docker-in-docker volume is allowed only for an opted-in project", () => {
    const dind = {
      mounts: [
        {
          source: "dind-var-lib-docker-abc123",
          target: "/var/lib/docker",
          type: "volume",
        },
      ],
      privileged: true,
    };
    refuses(spec({ image: "x" }, dind), /PRIVILEGED/);
    allows(
      spec(
        { image: "x", customizations: { desolate: { allowPrivileged: true } } },
        dind,
      ),
    );
    // and it must still be a volume, not a bind
    refuses(
      spec(
        { image: "x", customizations: { desolate: { allowPrivileged: true } } },
        {
          privileged: true,
          mounts: [
            {
              source: "/var/lib/docker",
              target: "/var/lib/docker",
              type: "bind",
            },
          ],
        },
      ),
      /bind/,
    );
  });
});

// ===========================================================================
describe("workspaceMount", () => {
  // ===========================================================================

  test("must bind exactly this project's own folder", () => {
    allows(
      spec({
        image: "x",
        workspaceMount:
          "source=/workspaces/myapp,target=/workspaces/myapp,type=bind",
      }),
    );
    // The unsound substring check this replaced would have accepted this:
    refuses(
      spec({
        image: "x",
        workspaceMount: "source=/,target=/workspaces/myapp,type=bind",
      }),
      /workspaceMount must bind exactly/,
    );
    refuses(
      spec({
        image: "x",
        workspaceMount:
          "source=/workspaces/other,target=/workspaces/other,type=bind",
      }),
      /workspaceMount must bind exactly/,
    );
  });
});

// ===========================================================================
describe("runArgs allowlist", () => {
  // ===========================================================================

  test("the hardening flags real projects use are allowed", () => {
    // example-project/.devcontainer/devcontainer.json, verbatim.
    allows(
      spec({
        image: "x",
        runArgs: [
          "--security-opt",
          "no-new-privileges:true",
          "--cap-drop",
          "ALL",
          "--pids-limit",
          "1024",
        ],
      }),
    );
    allows(
      spec({
        image: "x",
        runArgs: ["--memory=2g", "--cpus", "2", "--shm-size=512m", "--init"],
      }),
    );
    allows(
      spec({
        image: "x",
        runArgs: ["--ulimit", "nofile=4096:4096", "--read-only"],
      }),
    );
  });

  test("an unknown flag is refused rather than assumed harmless", () => {
    refuses(
      spec({ image: "x", runArgs: ["--some-new-docker-flag", "value"] }),
      /allowlist/,
    );
  });

  test("a bare value cannot be smuggled in as if it were a flag's argument", () => {
    refuses(spec({ image: "x", runArgs: ["host"] }), /not a flag/);
    // --read-only takes no value, so "host" that follows is a bare token
    refuses(
      spec({ image: "x", runArgs: ["--read-only", "host"] }),
      /not a flag/,
    );
  });

  test("a value-taking flag must actually get a value", () => {
    refuses(spec({ image: "x", runArgs: ["--cap-drop"] }), /expects a value/);
    refuses(
      spec({ image: "x", runArgs: ["--cap-drop", "--pids-limit"] }),
      /expects a value/,
    );
  });

  test("--tmpfs must be an absolute in-container path", () => {
    allows(spec({ image: "x", runArgs: ["--tmpfs", "/scratch"] }));
    refuses(spec({ image: "x", runArgs: ["--tmpfs", "relative"] }), /absolute/);
  });
});

// ===========================================================================
describe("other refused keys", () => {
  // ===========================================================================

  test("appPort collides with the relay bind", () => {
    refuses(spec({ image: "x", appPort: 8000 }), /appPort/);
    refuses(spec({ image: "x", appPort: [8000, 8001] }), /appPort/);
  });

  test("build.options is arbitrary docker build flags", () => {
    refuses(
      spec({
        build: { dockerfile: "Dockerfile", options: ["--network=host"] },
      }),
      /build.options/,
    );
    allows(spec({ build: { dockerfile: "Dockerfile", args: { X: "1" } } }));
  });
});

// ===========================================================================
describe("JSONC scanner", () => {
  // ===========================================================================

  test("comment characters inside strings are data, not comments", () => {
    assert.deepEqual(
      parseJsonc('{"a": "http://x//y", "b": "p/*q", "c": "r*/s"}'),
      { a: "http://x//y", b: "p/*q", c: "r*/s" },
    );
  });

  test("real comments are stripped", () => {
    assert.deepEqual(
      parseJsonc(`{
      // line comment
      "a": 1, /* block
                 comment */
      "b": 2
    }`),
      { a: 1, b: 2 },
    );
  });

  test("escaped quotes do not end a string early", () => {
    assert.deepEqual(parseJsonc('{"a": "he said \\"/*\\" ok", "b": 1}'), {
      a: 'he said "/*" ok',
      b: 1,
    });
  });

  test("trailing commas are tolerated (JSONC allows them, JSON.parse does not)", () => {
    assert.deepEqual(parseJsonc('{"a": [1, 2,], "b": 2,}'), {
      a: [1, 2],
      b: 2,
    });
    // ... but a comma inside a string is left alone
    assert.deepEqual(parseJsonc('{"a": "x,]"}'), { a: "x,]" });
  });

  test("stripping never invents or destroys structure", () => {
    const src = '{"url": "https://example.com/a//b", "glob": "**/*.ts"}';
    assert.equal(
      JSON.stringify(JSON.parse(stripJsonc(src))),
      JSON.stringify(JSON.parse(src)),
    );
  });

  test("unparseable input throws rather than yielding a partial config", () => {
    assert.throws(() => parseJsonc('{"a": }'));
    assert.throws(() => parseJsonc("not json at all"));
  });
});

// ===========================================================================
describe("the repo's own example projects satisfy the policy", () => {
  // ===========================================================================
  // If a fix to the policy breaks the shipped examples, that is a bug in the
  // fix, and this catches it before anyone tries to start them.
  //
  // Shipped code lives under release/. The examples are not currently part of
  // that tree, so each case skips rather than fails when its fixture is
  // absent -- a packaging gap should not read as a policy regression.

  const exampleUrl = (name: string) =>
    new URL(
      `../../../samples/${name}/.devcontainer/devcontainer.json`,
      import.meta.url,
    );

  const readExample = async (t: any, name: string) => {
    const fs = await import("node:fs");
    const url = exampleUrl(name);
    if (!fs.existsSync(url)) {
      t.skip(`no samples/${name}/ in this tree`);
      return null;
    }
    return parseJsonc(fs.readFileSync(url, "utf8"));
  };

  test("example-project", async (t) => {
    const cfg = await readExample(t, "example-project");
    if (!cfg) return;
    enforcePolicy("example-project", spec(cfg), { workspaces: "/workspaces" });
  });

  test("sample-fastapi (docker-in-docker, privilege opted in)", async (t) => {
    const cfg = await readExample(t, "sample-fastapi");
    if (!cfg) return;
    // What the docker-in-docker feature contributes, per its published metadata.
    const merged = {
      privileged: true,
      init: true,
      mounts: [
        {
          source: "dind-var-lib-docker-0123456789",
          target: "/var/lib/docker",
          type: "volume",
        },
      ],
    };
    enforcePolicy("sample-fastapi", spec(cfg, merged), {
      workspaces: "/workspaces",
    });
  });

  test("sample-fastapi WITHOUT the opt-in is refused", async (t) => {
    const cfg = await readExample(t, "sample-fastapi");
    if (!cfg) return;
    delete cfg.customizations.desolate.allowPrivileged;
    assert.throws(() =>
      enforcePolicy("sample-fastapi", spec(cfg, { privileged: true })),
    );
  });
});

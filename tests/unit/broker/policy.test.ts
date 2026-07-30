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

import { enforcePolicy, parseJsonc, stripJsonc, normalizeMount, type ResolvedSpec, volumeNamespace } from "../../../release/vscode-image/policy.ts";

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

  test("E6: the policy and the CLI must not disagree about TYPES", () => {
    // Measured against the real CLI, both halves:
    //
    //   * its bundle decides privilege by truthiness -- `privileged&&d.push(
    //     "--privileged")` -- so "privileged": "true", the STRING, starts a
    //     privileged container.
    //   * the policy tested `=== true`, which a string fails.
    //
    // It was saved only by mergedConfiguration normalising the type on the way in
    // (configuration reports 'true', merged reports the boolean), i.e. by an
    // undocumented detail of someone else's tool. Test the policy directly, with
    // the un-normalised value in BOTH places, so the guarantee is the policy's own.
    for (const value of ["true", "false", 1, "yes", {}]) {
      refuses(spec({ image: "x", privileged: value }), /PRIVILEGED/);
      refuses(spec({ image: "x" }, { privileged: value }), /PRIVILEGED/);
    }
    // Falsy stays allowed -- the CLI would not add the flag either.
    for (const value of [false, 0, "", null, undefined]) {
      allows(spec({ image: "x", privileged: value }));
    }
    // A scalar where a list is expected must not be spread into CHARACTERS.
    // `[...(cfg.capAdd ?? [])]` on "SYS_ADMIN" used to yield 11 single letters,
    // so the refusal named 'S, Y, S, _, A, D, M, I, N' -- fail-closed, reported
    // as gibberish. The CLI coerces this to ['SYS_ADMIN'], so we do too.
    refuses(spec({ image: "x", capAdd: "SYS_ADMIN" }), /requested: SYS_ADMIN\)/);
    refuses(
      spec({ image: "x", securityOpt: "seccomp=unconfined" }),
      /weakens the sandbox/,
    );
    // And a type the CLI would not accept either says so plainly, rather than
    // throwing "cfg.mounts.map is not a function".
    refuses(spec({ image: "x", mounts: 42 }), /"mounts" must be a string or an array/);
  });

  test("E7: a spec without mergedConfiguration is refused, not silently trusted", () => {
    // mergedConfiguration used to be optional on ResolvedSpec with a `?? {}`
    // default, so a spec missing it was approved by a policy that could not see a
    // single feature-injected privilege, capability or mount -- E3, silently
    // un-checked, with a successful return. Fail closed instead.
    for (const missing of [undefined, null]) {
      assert.throws(
        () =>
          enforcePolicy(
            PROJECT,
            { configuration: { image: "x" }, mergedConfiguration: missing } as ResolvedSpec,
            { workspaces: "/workspaces" },
          ),
        /no mergedConfiguration/,
      );
    }
    // An EMPTY merged config is a real answer (a project with no features) and
    // stays allowed -- absent and empty are not the same thing.
    allows(spec({ image: "x" }, {}));
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

  test("the docker-in-docker volumes are allowed only for an opted-in project", () => {
    // BOTH of them. The feature mounts /var/lib/docker AND /var/lib/containerd;
    // allowing only the first refused every real docker-in-docker project with a
    // namespace error naming a volume the project never asked for.
    const dind = {
      mounts: [
        {
          source: "dind-var-lib-docker-abc123",
          target: "/var/lib/docker",
          type: "volume",
        },
        {
          source: "dind-var-lib-containerd-abc123",
          target: "/var/lib/containerd",
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
      /source=\/workspaces\/myapp exactly/,
    );
    refuses(
      spec({
        image: "x",
        workspaceMount:
          "source=/workspaces/other,target=/workspaces/other,type=bind",
      }),
      /source=\/workspaces\/myapp exactly/,
    );
  });

  test("a nested project may use EITHER the mirrored path or the CLI's default", () => {
    // The devcontainer CLI derives its default target from
    // ${localWorkspaceFolderBasename} -- the last segment only -- so for
    // 'pmalacho-mit/suede' it mounts at /workspaces/suede. Demanding the
    // mirrored path refused a project for writing out the CLI's own default,
    // while the very same mount created implicitly was never checked.
    const nested = "pmalacho-mit/suede";
    const src = "/workspaces/pmalacho-mit/suede";
    for (const target of [src, "/workspaces/suede"]) {
      enforcePolicy(
        nested,
        spec({ image: "x", workspaceMount: `source=${src},target=${target},type=bind` }),
        { workspaces: "/workspaces" },
      );
    }
    // The source half stays exact -- that is the half that decides what enters
    // the container. A sibling owner's repo is not reachable by either spelling.
    assert.throws(
      () =>
        enforcePolicy(
          nested,
          spec({
            image: "x",
            workspaceMount:
              "source=/workspaces/other-owner/suede,target=/workspaces/suede,type=bind",
          }),
          { workspaces: "/workspaces" },
        ),
      /source=\/workspaces\/pmalacho-mit\/suede exactly/,
    );
    // And an unrelated target is still refused.
    assert.throws(
      () =>
        enforcePolicy(
          nested,
          spec({ image: "x", workspaceMount: `source=${src},target=/host,type=bind` }),
          { workspaces: "/workspaces" },
        ),
      /workspaceMount target must be/,
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
        {
          source: "dind-var-lib-containerd-0123456789",
          target: "/var/lib/containerd",
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

test("a project cannot reach a sibling whose name it prefixes", () => {
  // `<project>-*` also matches a LONGER project's name. With projects `web`
  // and `web-api`, `web-api-secrets` starts with `web-`, so the bare prefix
  // rule let `web` mount it -- and that is exactly where the README tells you
  // to keep a local-only database password. `web`/`web-api` is an ordinary way
  // to name two services, not a contrived collision.
  const siblings = { workspaces: "/workspaces", projects: ["web", "web-api"] };
  const vol = (source: string) => ({
    mounts: [{ source, target: "/x", type: "volume" }],
  });

  // the longer project owns them
  assert.throws(
    () => enforcePolicy("web", spec({ image: "x" }, vol("web-api")), siblings),
    /belongs to project 'web-api'/,
  );
  assert.throws(
    () => enforcePolicy("web", spec({ image: "x" }, vol("web-api-secrets")), siblings),
    /belongs to project 'web-api'/,
  );

  // ...and still owns its own
  enforcePolicy("web-api", spec({ image: "x" }, vol("web-api-secrets")), siblings);
  enforcePolicy("web-api", spec({ image: "x" }, vol("web-api")), siblings);

  // the shorter project keeps everything genuinely its own
  enforcePolicy("web", spec({ image: "x" }, vol("web")), siblings);
  enforcePolicy("web", spec({ image: "x" }, vol("web-assets")), siblings);
});

test("volumes desolate injects for a project are still its own", () => {
  // The overlay views are named <project>-vscode-server / -desolate-ca, and
  // must not be mistaken for a sibling's just because siblings exist.
  const siblings = { workspaces: "/workspaces", projects: ["web", "web-api"] };
  for (const v of ["web-vscode-server", "web-vscode-server-data", "web-desolate-ca"]) {
    enforcePolicy("web", spec({ image: "x" }, { mounts: [{ source: v, target: "/x", type: "volume" }] }), siblings);
  }
});

test("nested projects own a volume namespace with '/' encoded", () => {
  // Docker volume names cannot contain '/', so `acme/widgets` owns the
  // `acme__widgets` namespace. policy.ts and desolate.ts must agree on that
  // encoding or a project could not mount its own volumes.
  const siblings = { workspaces: "/workspaces", projects: ["acme/widgets", "other/widgets"] };
  const vol = (source: string) => ({ mounts: [{ source, target: "/x", type: "volume" }] });

  enforcePolicy("acme/widgets", spec({ image: "x" }, vol("acme__widgets")), siblings);
  enforcePolicy("acme/widgets", spec({ image: "x" }, vol("acme__widgets-secrets")), siblings);
  // desolate's own injected volumes for a nested project
  enforcePolicy("acme/widgets", spec({ image: "x" }, vol("acme__widgets-vscode-server")), siblings);

  // the same repo name under a DIFFERENT owner is a different namespace
  assert.throws(
    () => enforcePolicy("acme/widgets", spec({ image: "x" }, vol("other__widgets-secrets")), siblings),
    /outside this project's namespace|belongs to project/,
  );
  // and the un-encoded form is not this project's either
  assert.throws(
    () => enforcePolicy("acme/widgets", spec({ image: "x" }, vol("widgets-secrets")), siblings),
    /outside this project's namespace/,
  );
});

test("volumeNamespace is stable and collision-resistant", () => {
  assert.equal(volumeNamespace("flat"), "flat");
  assert.equal(volumeNamespace("acme/widgets"), "acme__widgets");
  // '/' -> '__' rather than '_', so these stay distinct
  assert.notEqual(volumeNamespace("a/b"), volumeNamespace("a_b"));
});

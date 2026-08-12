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
  feature,
  mount,
} from "../../../release/vscode-image/policy.ts";
import type { ResolvedSpec } from "../../../release/vscode-image/devcontainer.ts";
import {
  list as listTargets,
  target,
  volumeNamespace,
  type Target,
} from "../../../release/vscode-image/projects.ts";
import { parse as parseJsonc, strip as stripJsonc } from "../../../release/vscode-image/jsonc.ts";

const PROJECT = "myapp";

const WORKSPACES = "/workspaces";

/** The target a name denotes in the default workspace. */
const named = (project: string, worktree?: string) =>
  target(WORKSPACES, project, worktree);

/** The trailing (targets) argument of enforcePolicy. */
type EnforceArgs = [targets: Target[]];

/** enforcePolicy options for a workspace holding exactly one project.
 *
 *  Every case that is not ABOUT the volume-namespace rule wants this: the
 *  options are required precisely so the policy never reads a real /workspaces,
 *  and a test that let it would depend on whatever directories the machine
 *  running it happens to have. Cases that ARE about the rule name their own
 *  siblings instead. */
const alone = (project: string): EnforceArgs => [[named(project)]];

/** Build a ResolvedSpec the way `devcontainer read-configuration
 *  --include-merged-configuration` reports one.
 *
 *  The second argument is the FEATURE (or image) metadata, not a literal merged
 *  object. Measured against @devcontainers/cli 0.88.0, mergedConfiguration is
 *  `{...configuration, ...folded metadata}`: the project's own keys are spread
 *  in first, then every metadata entry is folded over the metadata keys
 *  (privileged/init by OR, capAdd/securityOpt/mounts by union). Handing the
 *  policy a merged object written by hand is how a fixture drifts into a spec
 *  the CLI would never emit -- raw declaring a key, merged empty -- which is
 *  exactly the spec that would make a merged-only policy look safe when it is
 *  not.
 *
 *  What this deliberately does NOT copy is the CLI's type normalisation
 *  ("true" -> true, "SYS_ADMIN" -> ["SYS_ADMIN"]). E6 exists to prove the policy
 *  holds without leaning on it, so values reach merged verbatim. */
function spec(
  configuration: any,
  feature: any = {},
  /** Which project's config this is, i.e. where the CLI read it from. */
  project: string = PROJECT,
): ResolvedSpec {
  // The CLI reports where it read the file, and overwrites the key if a
  // project writes its own (measured on 0.88.0). It is what `build.context`
  // resolves against, so a fixture without it is not a spec the CLI emits.
  configuration = {
    configFilePath: {
      $mid: 1,
      fsPath: `/workspaces/${project}/.devcontainer/devcontainer.json`,
      path: `/workspaces/${project}/.devcontainer/devcontainer.json`,
      scheme: "vscode-fileHost",
    },
    ...configuration,
  };

  const declaredByBoth = (key: string) =>
    configuration?.[key] !== undefined && feature?.[key] !== undefined;
  const asList = (v: any) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

  const mergedConfiguration: any = { ...configuration, ...feature };
  for (const key of ["capAdd", "securityOpt", "mounts"])
    if (declaredByBoth(key))
      mergedConfiguration[key] = [
        ...asList(configuration[key]),
        ...asList(feature[key]),
      ];
  for (const key of ["privileged", "init"])
    if (declaredByBoth(key))
      mergedConfiguration[key] =
        Boolean(configuration[key]) || Boolean(feature[key]);

  // customizations are not merged but RESHAPED: one array of contributions per
  // namespace, the project's and a feature's indistinguishable once inside it.
  // Modelled here because it is the reason the allowPrivileged opt-in is read
  // from the raw config -- see "a feature cannot grant itself privilege" below.
  if (configuration?.customizations || feature?.customizations) {
    const namespaces = new Set([
      ...Object.keys(configuration?.customizations ?? {}),
      ...Object.keys(feature?.customizations ?? {}),
    ]);
    mergedConfiguration.customizations = Object.fromEntries(
      [...namespaces].map((ns) => [
        ns,
        [configuration?.customizations?.[ns], feature?.customizations?.[ns]]
          .filter((c) => c !== undefined),
      ]),
    );
  }

  return { configuration, mergedConfiguration };
}

function refuses(cfg: ResolvedSpec, match: RegExp | string) {
  assert.throws(
    () => enforcePolicy(named(PROJECT), cfg, ...alone(PROJECT)),
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
  enforcePolicy(named(PROJECT), cfg, ...alone(PROJECT));
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
    //
    // The id is a REGISTRY one, because the local spelling is refused outright
    // now (see "features must be fetched, not read from the project"). This
    // case is still the one that matters: a published feature's metadata lands
    // in merged the same way, and merged is what is enforced on.
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
      spec(
        {
          image: "x",
          features: { "ghcr.io/attacker/features/evilfeat:1": {} },
        },
        featureMerged,
      ),
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
        () => enforcePolicy(named(PROJECT), spec({ image: "x", runArgs }), ...alone(PROJECT)),
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
            named(PROJECT),
            // `as unknown as` deliberately: the whole point of the case is a
            // value the type says cannot arrive, and does, from the CLI.
            { configuration: { image: "x" }, mergedConfiguration: missing } as unknown as ResolvedSpec,
            ...alone(PROJECT),
          ),
        /no mergedConfiguration/,
      );
    }
    // An EMPTY merged config is a real answer (a project with no features) and
    // stays allowed -- absent and empty are not the same thing.
    allows(spec({ image: "x" }, {}));
  });

  test("E8: a feature cannot grant itself the privilege opt-in", () => {
    // The policy enforces on mergedConfiguration, but reads the allowPrivileged
    // opt-in from the RAW config, and this is why. Merged reshapes
    // customizations into one array of contributions per namespace, so a feature
    // that ships "customizations": {"desolate": {"allowPrivileged": true}} in its
    // own metadata lands in the very same place the project's opt-in would. Read
    // there, the feature demanding the privilege would also be authorising it.
    refuses(
      spec(
        { image: "x" },
        {
          privileged: true,
          customizations: { desolate: { allowPrivileged: true } },
        },
      ),
      /PRIVILEGED/,
    );
    // ... while the project's own opt-in still works, same feature present.
    allows(
      spec(
        { image: "x", customizations: { desolate: { allowPrivileged: true } } },
        { privileged: true },
      ),
    );
  });

  test("E9: a merged config that LOST a key the project declared is refused", () => {
    // Every rule reads mergedConfiguration, which makes one failure mode fatal:
    // if the CLI renames or reshapes a key (postCreateCommand ->
    // postCreateCommands, entrypoint -> entrypoints, customizations -> arrays),
    // the rule that reads the old name silently checks nothing at all and the
    // spec sails through. Raw is the witness that the key was declared.
    const declaredThenLost: [string, any][] = [
      ["runArgs", ["--privileged"]],
      ["mounts", ["source=other,target=/steal,type=volume"]],
      ["initializeCommand", "id > /tmp/pwned"],
    ];
    for (const [key, value] of declaredThenLost) {
      assert.throws(
        () =>
          enforcePolicy(
            named(PROJECT),
            { configuration: { image: "x", [key]: value }, mergedConfiguration: { image: "x" } },
            ...alone(PROJECT),
          ),
        new RegExp(`declares "${key}"`),
        `merged silently dropped "${key}" and the policy approved the spec`,
      );
    }
  });

  test("E10: volume-opt -- a bind of dind's filesystem wearing a volume's name", () => {
    // Verified against docker 29: the `local` driver takes
    // type=none,o=bind,device=<path> and produces a BIND MOUNT of <path>, and
    // the devcontainer CLI passes a STRING mount to `docker run --mount`
    // byte-for-byte (its merge step parses one only to de-duplicate by target,
    // then returns the original). A policy that reads type/source/target sees
    // a well-behaved volume inside the project's own namespace and approves it,
    // while the container comes up holding /run/inner/docker.sock, /workspaces
    // and every other project's volume directory.
    //
    // This is the one that made the overlayfs work in overlay.ts moot: the
    // LOWER is unwritable, but every project's upper is an ordinary directory
    // under /var/lib/docker/volumes, and a file written into a sibling's upper
    // shadows the lower it was protecting.
    const escapes = [
      "type=volume,source=myapp-esc,target=/esc,volume-driver=local,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/",
      "type=volume,source=myapp-esc,target=/esc,volume-opt=device=/var/lib/docker",
      "type=volume,source=myapp-esc,target=/esc,volume-driver=local",
      // A field this policy has no opinion on is still a field it cannot see.
      "type=volume,source=myapp-ok,target=/ok,volume-nocopy=true",
      "type=volume,source=myapp-ok,target=/ok,bind-propagation=rshared",
    ];
    for (const mounts of [escapes.map((m) => [m]), [escapes]].flat())
      refuses(spec({ image: "x", mounts }), /not on the allowlist/);

    // The fields a project legitimately needs still work.
    allows(spec({ image: "x", mounts: ["type=volume,source=myapp-db,target=/db,readonly"] }));
    allows(
      spec({
        image: "x",
        mounts: ["type=volume,src=myapp-db,dst=/db,consistency=cached,ro"],
      }),
    );
  });

  test("E11: source/src and target/dst -- the same mount read two ways", () => {
    // Verified against docker 29:
    //
    //   docker run --mount 'type=volume,source=probe-a,src=probe-b,target=/m' ...
    //
    // mounts probe-B. Docker assigns Source once per field as it walks the
    // spec, so the LAST spelling wins; this policy read `source ?? src`, so the
    // canonical name won wherever it appeared. Every check below then ran
    // against a mount docker was never going to make.
    //
    // Two exploits, and the second is the sharper one: workspaceMount is
    // likewise handed to `docker run --mount` verbatim, so the check that
    // insists a project binds its OWN folder was reading a different string
    // from the one that decided what got mounted.
    refuses(
      spec({
        image: "x",
        mounts: ["type=volume,source=myapp-cache,target=/c,src=victim-secrets"],
      }),
      /belongs to project 'victim'|outside this project's namespace/,
    );
    refuses(
      spec({
        image: "x",
        workspaceFolder: "/workspaces/myapp",
        workspaceMount:
          "source=/workspaces/myapp,target=/workspaces/myapp,type=bind,src=/workspaces",
      }),
      /workspaceMount must have source=/,
    );
    refuses(
      spec({
        image: "x",
        workspaceFolder: "/workspaces/myapp",
        workspaceMount:
          "source=/workspaces/myapp,target=/workspaces/myapp,type=bind,dst=/",
      }),
      /workspaceMount target must be/,
    );
    // A quoted field is where the two parsers differ again: docker splits a
    // --mount as CSV, so `"a,b"` is ONE field. Refused rather than re-implemented.
    refuses(
      spec({
        image: "x",
        mounts: ['type=volume,source="myapp-ok,src=victim-secrets",target=/c'],
      }),
      /double quote/,
    );
  });

  test("E12: --label -- stamping another project's identity onto this container", () => {
    // Verified against docker 29 and @devcontainers/cli 0.88.0: the CLI emits
    // its identity labels (devcontainer.local_folder, devcontainer.config_file)
    // BEFORE it appends the project's runArgs, and docker takes the last of a
    // duplicated label key. So a project could claim a sibling's folder, and
    // `desolate <sibling>` would find the impostor by label, start it, exec the
    // editor into it with the sibling's connection token, and point the
    // sibling's relays at it. The user gets an IDE that looks like the victim
    // project and is entirely the attacker's.
    //
    // An EMPTY config_file is part of it: the CLI falls back to a
    // local-folder-only match and accepts a container carrying no config label.
    const claims = [
      ["--label", "devcontainer.local_folder=/workspaces/victim"],
      ["-l", "devcontainer.local_folder=/workspaces/victim"],
      ["--label=devcontainer.config_file="],
      ["--label", "anything=at-all"],
    ];
    for (const runArgs of claims)
      refuses(spec({ image: "x", runArgs }), /not on the allowlist/);
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
    const m = mount.normalize({ source: "x,type=volume", type: "bind" });
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
    const nested = named("pmalacho-mit/suede");
    const src = "/workspaces/pmalacho-mit/suede";
    for (const where of [src, "/workspaces/suede"]) {
      enforcePolicy(
        nested,
        spec({ image: "x", workspaceMount: `source=${src},target=${where},type=bind` }),
        ...alone(PROJECT),
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
          ...alone(PROJECT),
        ),
      /source=\/workspaces\/pmalacho-mit\/suede exactly/,
    );
    // And an unrelated target is still refused.
    assert.throws(
      () =>
        enforcePolicy(
          nested,
          spec({ image: "x", workspaceMount: `source=${src},target=/host,type=bind` }),
          ...alone(PROJECT),
        ),
      /workspaceMount target must be/,
    );
  });
});

// ===========================================================================
describe("a worktree target", () => {
  // ===========================================================================
  // The only step of this feature that WIDENS what a spec may ask for. What
  // widened is which directory `target.dir` is -- the comparison itself is
  // still equality against a value computed here, never one parsed out of the
  // spec, and never a prefix test.

  const project = named("acme/widgets");
  const feature = named("acme/widgets", "feature123");
  const sibling = named("acme/widgets", "other");
  const family: EnforceArgs = [[project, feature, sibling]];

  const bind = (source: string, target = source) =>
    spec({
      image: "x",
      workspaceMount: `source=${source},target=${target},type=bind`,
    });

  const refusedFor = (target: Target, cfg: ResolvedSpec, match: RegExp) =>
    assert.throws(() => enforcePolicy(target, cfg, ...family), match);

  test("binds its own directory, mirrored inside and out", () => {
    // Not a preference: its `.git` file and the project's `commondir` record
    // absolute paths, so any other destination is a container where git is dead.
    const dir = "/workspaces/acme/widgets/.worktrees/feature123";
    assert.equal(feature.dir, dir);
    enforcePolicy(feature, bind(dir), ...family);
  });

  test("may not bind its own PROJECT's folder", () => {
    // The project root is the root target's mount, and mounting it here would
    // put a second copy of every filename in this container -- which is the
    // ergonomic problem worktrees exist to solve.
    refusedFor(feature, bind("/workspaces/acme/widgets"), /exactly/);
  });

  test("may not bind a SIBLING worktree", () => {
    refusedFor(
      feature,
      bind("/workspaces/acme/widgets/.worktrees/other"),
      /exactly/,
    );
  });

  test("may not traverse out of .worktrees, however it is spelled", () => {
    // Each of these RESOLVES somewhere else, which is why the comparison
    // resolves before it compares rather than matching the text.
    for (const source of [
      "/workspaces/acme/widgets/.worktrees/feature123/../other",
      "/workspaces/acme/widgets/.worktrees/feature123/../../../other/repo",
      "/workspaces/acme/widgets/.worktrees/feature123/..",
      "/workspaces/acme/widgets/.worktrees",
    ])
      refusedFor(feature, bind(source), /exactly/);
  });

  test("a project may not bind a worktree's folder either", () => {
    refusedFor(
      project,
      bind("/workspaces/acme/widgets/.worktrees/feature123"),
      /exactly/,
    );
  });

  test("does not take the CLI's basename default as a mount target", () => {
    // `/workspaces/widgets` is a legitimate alternative for the PROJECT, and it
    // would break git here. A worktree gets exactly one accepted destination.
    refusedFor(feature, bind(feature.dir, "/workspaces/widgets"), /target must be/);
    refusedFor(feature, bind(feature.dir, "/workspaces/acme/widgets"), /target must be/);
  });

  test("owns its own volumes, and neither its project nor a sibling", () => {
    const vol = (source: string) =>
      spec({ image: "x" }, { mounts: [{ source, target: "/x", type: "volume" }] });

    enforcePolicy(feature, vol("acme__widgets--wt--feature123"), ...family);
    enforcePolicy(feature, vol("acme__widgets--wt--feature123-vscode-server"), ...family);

    // The editor server is EXECUTED in every container. A worktree reaching the
    // main tree's overlay would be running code there on the next start.
    refusedFor(feature, vol("acme__widgets-vscode-server"), /outside this project's namespace/);
    refusedFor(feature, vol("acme__widgets--wt--other-vscode-server"), /outside this project's namespace/);

    // ...and the project cannot reach into a worktree's, which is the same rule
    // read the other way: the longer namespace owns the name.
    refusedFor(project, vol("acme__widgets--wt--feature123-vscode-server"), /belongs to project/);
  });

  test("the mask desolate adds to the PROJECT passes the re-check", () => {
    // desolate derives the spec and then hands it back to this policy, so a
    // rewrite the policy would refuse is a project that can never start. The
    // mask is a runArg because the CLI refuses a tmpfs as a `--mount`.
    enforcePolicy(
      project,
      spec({
        image: "x",
        runArgs: ["--tmpfs", "/workspaces/acme/widgets/.worktrees"],
      }, {}, "acme/widgets"),
      ...family,
    );
  });

  test("builds from its own tree only", () => {
    // `../..` out of a worktree is every sibling branch's source, shipped into
    // an image this target owns.
    const build = (context: string) =>
      spec(
        { image: "x", build: { context } },
        {},
        "acme/widgets/.worktrees/feature123",
      );

    // Relative paths resolve against the .devcontainer directory, so one `..`
    // is still inside the worktree.
    enforcePolicy(feature, build("."), ...family);
    enforcePolicy(feature, build(".."), ...family);
    refusedFor(feature, build("../../other"), /outside/);
    refusedFor(feature, build("../../.."), /outside/);
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
describe("shadowImages", () => {
  // ===========================================================================
  // Base images whose tag desolate points at a CA-trusting derivative, inside
  // the project's OWN inner daemon, so that builds which cannot be handed a
  // build context (an SDK posting to the Engine API) still reach the internet.
  //
  // Nothing here is an isolation rule and it should not be read as one: that
  // daemon is per-project and disposable, so a bad entry costs the project that
  // wrote it and nobody else. These cases are about failing where the message
  // can quote the key, instead of in a background log inside a container.

  const shadowing = (shadowImages: any) =>
    spec({ image: "x", customizations: { desolate: { shadowImages } } });

  test("image references are accepted, in the spellings docker accepts", () => {
    allows(shadowing(["node:22-bookworm-slim"]));
    allows(shadowing(["alpine"]));
    allows(shadowing(["ghcr.io/owner/base:1.2.3"]));
    allows(shadowing(["localhost:5000/team/base:dev"]));
    allows(
      shadowing([
        "node@sha256:0000000000000000000000000000000000000000000000000000000000000000",
      ]),
    );
    allows(shadowing([])); // declared and empty is a no-op, not an error
    allows(spec({ image: "x" })); // and absent is the normal case
  });

  test("a path or a URL is the category error worth naming", () => {
    // Both are what somebody reaches for when they think this key names a
    // Dockerfile or a registry endpoint. Either would reach `docker pull` as a
    // reference it cannot resolve, minutes later and out of sight.
    refuses(shadowing(["./base"]), /not an image reference/);
    refuses(shadowing(["../images/base"]), /not an image reference/);
    refuses(shadowing(["/opt/base:latest"]), /not an image reference/);
    refuses(shadowing(["https://example.com/base"]), /not an image reference/);
    refuses(shadowing(["docker-image://node:22"]), /not an image reference/);
    refuses(shadowing(["node:22:22"]), /not an image reference/);
  });

  test("the key is a list of non-empty strings", () => {
    refuses(shadowing("node:22-bookworm-slim"), /must be an array/);
    refuses(shadowing({ image: "node:22" }), /must be an array/);
    refuses(shadowing([""]), /non-empty image reference/);
    refuses(shadowing(["   "]), /non-empty image reference/);
    refuses(shadowing([42]), /non-empty image reference/);
    refuses(shadowing([null]), /non-empty image reference/);
  });

  test("a list long enough to be a mistake is refused as one", () => {
    // Each entry is a pull and a rebuild at container start, run one after the
    // other before the project's own builds work.
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `base${i}:latest`);
    allows(shadowing(many(32)));
    refuses(shadowing(many(33)), /33 images/);
  });

  test("a feature cannot declare it -- it is read from the project's own file", () => {
    // Same rule as allowPrivileged, and for the same reason: desolate
    // customizations are read RAW. A key a third-party feature could set is a
    // key that runs `docker pull` on a name the project never wrote.
    allows(
      spec(
        { image: "x" },
        { customizations: { desolate: { shadowImages: ["./not-an-image"] } } },
      ),
    );
  });
});

// ===========================================================================
describe("features must be fetched, not read from the project", () => {
  // ===========================================================================
  // E15, demonstrated against @devcontainers/cli 0.88.0. A local feature's
  // devcontainer-feature.json is read TWICE: once by `read-configuration`,
  // which is what this policy enforces on, and again when the container is
  // built. Both reads hit the live project -- the snapshot copy is never
  // consulted, because --override-config changes which JSON is read, not where
  // relative paths resolve from.
  //
  // With a benign metadata file at validation time and a hostile one swapped in
  // afterwards, `devcontainer up` ran:
  //
  //     --privileged --cap-add SYS_ADMIN --security-opt seccomp=unconfined
  //     --mount type=bind,src=/,dst=/host
  //
  // while the validated snapshot still said "harmless". That is E3 again,
  // reached around the check rather than through it. The window is the whole
  // resolve-enforce-spawn-build sequence, and a failed attempt costs nothing.
  //
  // So the shape of the id is the rule: a feature has to be something the CLI
  // FETCHES, not something it reads out of a directory the editor can rewrite.

  test("a local feature is refused", () => {
    for (const id of ["./feat", "../feat", "/opt/feat", "./a/b", "~/feat"])
      refuses(spec({ image: "x", features: { [id]: {} } }), /local feature/);
  });

  test("a published feature is still allowed", () => {
    allows(
      spec({
        image: "x",
        features: { "ghcr.io/devcontainers/features/docker-in-docker:2": {} },
      }),
    );
    allows(
      spec({
        image: "x",
        features: {
          "ghcr.io/devcontainers/features/git@sha256:0000000000000000000000000000000000000000000000000000000000000000":
            {},
        },
      }),
    );
    allows(
      spec({
        image: "x",
        features: { "https://example.com/feature.tgz": {} },
      }),
    );
  });

  test("an id that is neither is refused rather than guessed at", () => {
    // Fail closed on the classification itself. If a future CLI grows another
    // spelling for "read this off disk", it lands here instead of through.
    refuses(spec({ image: "x", features: { feat: {} } }), /can classify/);
    refuses(
      spec({ image: "x", features: { "file://feat": {} } }),
      /can classify/,
    );
    refuses(
      spec({ image: "x", features: { "http://example.com/f.tgz": {} } }),
      /can classify/,
    );
  });

  test("the classifier itself", () => {
    assert.equal(feature.origin("./feat"), "local");
    assert.equal(feature.origin("../../feat"), "local");
    assert.equal(feature.origin("/abs/feat"), "local");
    assert.equal(feature.origin("ghcr.io/o/r/f:1"), "registry");
    assert.equal(feature.origin("https://x/f.tgz"), "tarball");
    assert.equal(feature.origin("http://x/f.tgz"), "other-scheme");
    assert.equal(feature.origin("feat"), "unknown");
  });

  test("no features key means nothing to check", () => {
    allows(spec({ image: "alpine:3" }));
    allows(spec({ image: "alpine:3", features: {} }));
  });
});

// ===========================================================================
describe("build inputs stay inside the project", () => {
  // ===========================================================================
  // DEMONSTRATED, against @devcontainers/cli 0.88.0 and a real daemon: a
  // project whose devcontainer.json said
  //
  //     { "build": { "dockerfile": "Dockerfile", "context": "../.." } }
  //
  // with `COPY victim/secrets.env /stolen` in its Dockerfile produced an image
  // holding a SIBLING PROJECT's file. Every key in that config is legal, so
  // nothing else in this policy looks at it.
  //
  // The snapshot does not help here, and that surprised us: --override-config
  // changes which JSON the CLI reads, not where relative paths resolve from.
  // `configFilePath` still names the file in /workspaces, and the context is
  // read from there -- so this is about the LIVE project directory.

  /** A spec whose config was read from the nested (.devcontainer/) layout. */
  const nested = (build: any) => spec({ build });

  /** ...and from the flat one, where the base directory is the project root
   *  and the very same "context": ".." means one level higher. */
  const flat = (build: any) =>
    spec({
      build,
      configFilePath: {
        fsPath: `/workspaces/${PROJECT}/.devcontainer.json`,
        path: `/workspaces/${PROJECT}/.devcontainer.json`,
        scheme: "vscode-fileHost",
      },
    });

  test("a context reaching /workspaces is refused", () => {
    refuses(nested({ dockerfile: "Dockerfile", context: "../.." }), /outside/);
    refuses(nested({ context: "../../other-project" }), /outside/);
    refuses(nested({ context: "/workspaces" }), /outside/);
    refuses(nested({ context: "/" }), /outside/);
  });

  test("a context reaching the project ROOT is fine -- it is the common idiom", () => {
    // .devcontainer/devcontainer.json + "context": ".." is how most projects
    // build from their repo root. Refusing it would push people to copy files
    // into .devcontainer/ instead, which is worse and teaches nothing.
    allows(nested({ dockerfile: "Dockerfile", context: ".." }));
    allows(nested({ dockerfile: "../Dockerfile", context: ".." }));
    allows(nested({ dockerfile: "Dockerfile", context: "." }));
    allows(nested({ dockerfile: "Dockerfile", context: "./sub" }));
    allows(nested({ dockerfile: "Dockerfile" }));
  });

  test("the same '..' is refused in the flat layout, where it means more", () => {
    // The string in the file is identical; only the directory the CLI read it
    // from differs. This is why the base is taken from the CLI's own report
    // instead of being derived from the project name.
    allows(flat({ dockerfile: "Dockerfile", context: "." }));
    refuses(flat({ dockerfile: "Dockerfile", context: ".." }), /outside/);
  });

  test("a dockerfile outside the project is refused", () => {
    // Also demonstrated: the built image came from ../../Dockerfile.evil.
    refuses(nested({ dockerfile: "../../Dockerfile.evil" }), /outside/);
    refuses(nested({ dockerfile: "/etc/passwd" }), /outside/);
  });

  test("the legacy top-level spelling is refused too", () => {
    // A synonym the CLI still honours is a bypass if the policy only knows the
    // modern one.
    refuses(spec({ image: "x", context: "../.." }), /outside/);
    refuses(spec({ image: "x", dockerFile: "../../Dockerfile" }), /outside/);
  });

  test("a project whose name is a prefix of another is not inside it", () => {
    // /workspaces/myapp-secrets starts with /workspaces/myapp as a string, so
    // a containment test without the separator would let this through.
    refuses(nested({ context: "../../myapp-secrets" }), /outside/);
    // ...while a directory of that name INSIDE the project is the project's own.
    allows(nested({ context: "../myapp-secrets" }));
  });

  test("a non-string path is refused rather than coerced", () => {
    refuses(nested({ context: ["../.."] }), /must be a string/);
  });

  test("no build key means nothing to check", () => {
    allows(spec({ image: "alpine:3" }));
  });

  test("a spec that does not say where it was read from is refused", () => {
    // Fail closed: without configFilePath there is no way to know what ".."
    // resolves to, and guessing the layout is how a check becomes decorative.
    const blind: ResolvedSpec = {
      configuration: { build: { context: ".." } },
      mergedConfiguration: { build: { context: ".." } },
    };
    refuses(blind, /configFilePath/);
  });

  test("a config claimed to live outside the project is refused", () => {
    const elsewhere = spec({
      build: { context: "." },
      configFilePath: {
        fsPath: "/tmp/lie/devcontainer.json",
        path: "/tmp/lie/devcontainer.json",
        scheme: "vscode-fileHost",
      },
    });
    refuses(elsewhere, /outside/);
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
    enforcePolicy(named("example-project"), spec(cfg), ...alone("example-project"));
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
    enforcePolicy(named("sample-fastapi"), spec(cfg, merged), ...alone("sample-fastapi"));
  });

  test("sample-fastapi WITHOUT the opt-in is refused", async (t) => {
    const cfg = await readExample(t, "sample-fastapi");
    if (!cfg) return;
    delete cfg.customizations.desolate.allowPrivileged;
    assert.throws(() =>
      enforcePolicy(
        named("sample-fastapi"),
        spec(cfg, { privileged: true }),
        ...alone("sample-fastapi"),
      ),
    );
  });
});

test("a project cannot reach a sibling whose name it prefixes", () => {
  // `<project>-*` also matches a LONGER project's name. With projects `web`
  // and `web-api`, `web-api-secrets` starts with `web-`, so the bare prefix
  // rule let `web` mount it -- and that is exactly where the README tells you
  // to keep a local-only database password. `web`/`web-api` is an ordinary way
  // to name two services, not a contrived collision.
  const siblings: EnforceArgs = [[named("web"), named("web-api")]];
  const vol = (source: string) => ({
    mounts: [{ source, target: "/x", type: "volume" }],
  });

  // the longer project owns them
  assert.throws(
    () => enforcePolicy(named("web"), spec({ image: "x" }, vol("web-api")), ...siblings),
    /belongs to project 'web-api'/,
  );
  assert.throws(
    () => enforcePolicy(named("web"), spec({ image: "x" }, vol("web-api-secrets")), ...siblings),
    /belongs to project 'web-api'/,
  );

  // ...and still owns its own
  enforcePolicy(named("web-api"), spec({ image: "x" }, vol("web-api-secrets")), ...siblings);
  enforcePolicy(named("web-api"), spec({ image: "x" }, vol("web-api")), ...siblings);

  // the shorter project keeps everything genuinely its own
  enforcePolicy(named("web"), spec({ image: "x" }, vol("web")), ...siblings);
  enforcePolicy(named("web"), spec({ image: "x" }, vol("web-assets")), ...siblings);
});

test("volumes desolate injects for a project are still its own", () => {
  // The overlay views are named <project>-vscode-server / -desolate-ca, and
  // must not be mistaken for a sibling's just because siblings exist.
  const siblings: EnforceArgs = [[named("web"), named("web-api")]];
  for (const v of ["web-vscode-server", "web-vscode-server-data", "web-desolate-ca"]) {
    enforcePolicy(named("web"), spec({ image: "x" }, { mounts: [{ source: v, target: "/x", type: "volume" }] }), ...siblings);
  }
});

test("nested projects own a volume namespace with '/' encoded", () => {
  // Docker volume names cannot contain '/', so `acme/widgets` owns the
  // `acme__widgets` namespace. policy.ts and desolate.ts must agree on that
  // encoding or a project could not mount its own volumes.
  const siblings: EnforceArgs = [[named("acme/widgets"), named("other/widgets")]];
  const vol = (source: string) => ({ mounts: [{ source, target: "/x", type: "volume" }] });

  enforcePolicy(named("acme/widgets"), spec({ image: "x" }, vol("acme__widgets")), ...siblings);
  enforcePolicy(named("acme/widgets"), spec({ image: "x" }, vol("acme__widgets-secrets")), ...siblings);
  // desolate's own injected volumes for a nested project
  enforcePolicy(named("acme/widgets"), spec({ image: "x" }, vol("acme__widgets-vscode-server")), ...siblings);

  // the same repo name under a DIFFERENT owner is a different namespace
  assert.throws(
    () => enforcePolicy(named("acme/widgets"), spec({ image: "x" }, vol("other__widgets-secrets")), ...siblings),
    /outside this project's namespace|belongs to project/,
  );
  // and the un-encoded form is not this project's either
  assert.throws(
    () => enforcePolicy(named("acme/widgets"), spec({ image: "x" }, vol("widgets-secrets")), ...siblings),
    /outside this project's namespace/,
  );
});

test("volumeNamespace is stable and collision-resistant", () => {
  assert.equal(volumeNamespace("flat"), "flat");
  assert.equal(volumeNamespace("acme/widgets"), "acme__widgets");
  // '/' -> '__' rather than '_', so these stay distinct
  assert.notEqual(volumeNamespace("a/b"), volumeNamespace("a_b"));
  // '__' is reserved for that encoding, so a name that could forge a nesting is
  // refused outright rather than silently mapped onto 'a/b'.
  assert.throws(() => volumeNamespace("a__b"), /double underscore/);
  assert.throws(() => volumeNamespace("owner/re__po"), /double underscore/);
});

test("a name volumeNamespace cannot encode is excluded from the project list", async () => {
  // Refusing the name is right; refusing it from inside the LIST is not. The
  // list is mapped through volumeNamespace once per project being checked, so a
  // throw there took down every unrelated project in the workspace -- and the
  // editor can create the directory that triggers it. `list` omits such names,
  // and the broker refuses them at validate, so only the offender is affected.
  const fs = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const ws = fs.mkdtempSync(join(tmpdir(), "desolate-projects-"));
  for (const name of ["myapp", "evil__dir", "owner"]) {
    fs.mkdirSync(join(ws, name, ".devcontainer"), { recursive: true });
    fs.writeFileSync(join(ws, name, ".devcontainer/devcontainer.json"), "{}");
  }
  fs.mkdirSync(join(ws, "owner-with-kids", "re__po"), { recursive: true });

  const targets = listTargets(ws);
  const names = targets.map(({ name }) => name).sort();
  assert.ok(!names.includes("evil__dir"), `list leaked an unencodable name: ${names}`);
  assert.ok(!names.includes("owner-with-kids/re__po"), `list leaked a nested unencodable name: ${names}`);
  assert.ok(names.includes("myapp"));

  // and the innocent neighbour still starts, which is the whole point
  enforcePolicy(
    target(ws, "myapp"),
    spec({ image: "x", mounts: ["source=myapp-data,target=/d,type=volume"] }),
    targets,
  );
});

test("the privilege opt-in must be exactly true, not merely truthy", () => {
  // Boolean("false") is true. The opt-in is not a boundary against a hostile
  // editor (it can write `true` itself) -- it exists so privilege is never
  // inherited by accident, and a typo silently granting it defeats that.
  for (const value of ["false", "0", "no", 0, 1, [], {}, null]) {
    const cfg = spec({
      image: "x",
      privileged: true,
      customizations: { desolate: { allowPrivileged: value } },
    });
    assert.throws(
      () => enforcePolicy(named(PROJECT), cfg, ...alone(PROJECT)),
      /PRIVILEGED/,
      `allowPrivileged: ${JSON.stringify(value)} was accepted as an opt-in`,
    );
  }
  enforcePolicy(
    named(PROJECT),
    spec({
      image: "x",
      privileged: true,
      customizations: { desolate: { allowPrivileged: true } },
    }),
    ...alone(PROJECT),
  );
});

test("keys that are refused outright are refused by PRESENCE, not truthiness", () => {
  // A falsy value is still a declaration. These two moved to a truthy test
  // during a rewrite, which let `""` and `0` through -- harmless in practice
  // (no falsy value names a compose file or a command) but the wrong rule: the
  // rest of this policy refuses anything it cannot classify.
  for (const key of ["dockerComposeFile", "initializeCommand"])
    for (const value of ["", 0, false, null])
      assert.throws(
        () => enforcePolicy(named(PROJECT), spec({ image: "x", [key]: value }), ...alone(PROJECT)),
        new RegExp(key),
        `${key}: ${JSON.stringify(value)} was accepted`,
      );
});

/// <reference types="node" />
// The two judgements dind.ts makes, as opposed to the names it composes (those
// are pinned as literals in naming.test.ts):
//
//   - which specs need a daemon of their own, which decides provisioning AND
//     whether a devcontainer may hold a docker socket at all;
//   - which bind sources name such a socket.
//
// Both are allowlists, so the cases that matter most are the ones just OUTSIDE
// them. A miss here does not fail: it hands a devcontainer the shared daemon,
// where every other project lives.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { target } from "../../../release/vscode-image/projects.ts";
import * as dind from "../../../release/vscode-image/dind.ts";

const DOCKER_IN_DOCKER = "ghcr.io/devcontainers/features/docker-in-docker:2";
const DOCKER_OUTSIDE =
  "ghcr.io/devcontainers/features/docker-outside-of-docker:1";

describe("which specs need a daemon of their own", () => {
  test("docker-outside-of-docker does", () => {
    assert.equal(dind.isRequiredBy([DOCKER_OUTSIDE]), true);
  });

  test("docker-in-docker does NOT -- it is refused, not provisioned for", () => {
    // A daemon inside the devcontainer is the --privileged shape v2 removes.
    // Provisioning a project dind for it as well would hand a socket to a
    // container that is about to be refused anyway.
    assert.equal(dind.isRequiredBy([DOCKER_IN_DOCKER]), false);
    assert.equal(
      dind.isRequiredBy(["ghcr.io/devcontainers/features/docker-in-docker"]),
      false,
    );
  });

  test("it is found among the features a real project declares", () => {
    assert.equal(
      dind.isRequiredBy([
        "ghcr.io/devcontainers/features/git-lfs:1",
        DOCKER_OUTSIDE,
        "ghcr.io/guiyomh/features/vim:0",
      ]),
      true,
    );
  });

  test("a version is optional, and a digest is accepted in its place", () => {
    assert.equal(
      dind.isRequiredBy(["ghcr.io/devcontainers/features/docker-outside-of-docker"]),
      true,
    );
    assert.equal(
      dind.isRequiredBy([`${DOCKER_OUTSIDE.split(":")[0]}@sha256:${"a".repeat(64)}`]),
      true,
    );
  });

  test("a project declaring no features needs none", () => {
    assert.equal(dind.isRequiredBy([]), false);
    assert.equal(
      dind.isRequiredBy(["ghcr.io/devcontainers/features/python:latest"]),
      false,
    );
  });

  // The id is matched from its start, so a name that merely CONTAINS the
  // feature's cannot claim a daemon -- `evil.io/.../docker-in-docker` is a
  // stranger's feature, and a substring rule would provision for it.
  test("a lookalike id does not claim a daemon", () => {
    for (const id of [
      "evil.io/devcontainers/features/docker-in-docker:2",
      "ghcr.io/attacker/features/docker-outside-of-docker:1",
      "ghcr.io/devcontainers/features/docker-in-docker-plus:1",
      "ghcr.io/devcontainers/features/docker-outside-of-docker-plus:1",
      "https://example.com/docker-in-docker.tgz",
      "./docker-in-docker",
    ])
      assert.equal(dind.isRequiredBy([id]), false, id);
  });
});

describe("which bind sources name a project daemon's socket", () => {
  test("the path it listens on, and the one the feature binds", () => {
    assert.equal(dind.socket.isNamedBy("/run/dind-sock/docker.sock"), true);
    assert.equal(dind.socket.isNamedBy("/var/run/docker.sock"), true);
    assert.equal(dind.socket.path, "/run/dind-sock/docker.sock");
    assert.equal(dind.socket.alias, "/var/run/docker.sock");
  });

  test("nothing that merely starts or ends with one", () => {
    for (const source of [
      "/var/run/docker.sock.evil",
      "/run/dind-sock/docker.sock/..",
      "/run/dind-sock",
      "/evil/var/run/docker.sock",
      "/var/run/docker.socket",
      "",
    ])
      assert.equal(dind.socket.isNamedBy(source), false, source);
  });
});

describe("the per-project bridge", () => {
  // Linux silently REJECTS an interface name longer than IFNAMSIZ-1, so a
  // bridge that is one character too long is a project that does not start and
  // says nothing about why.
  test("fits an interface name, however long the namespace", () => {
    const long = target("/workspaces", `${"a".repeat(64)}/${"b".repeat(64)}`);
    for (const named of [target("/workspaces", "myapp"), long])
      assert.equal(dind.bridge(named).length, 15, dind.bridge(named));
  });

  test("differs per target, and is stable for one", () => {
    const flat = target("/workspaces", "myapp");
    const nested = target("/workspaces", "acme/widgets");
    assert.notEqual(dind.bridge(flat), dind.bridge(nested));
    assert.equal(dind.bridge(flat), dind.bridge(target("/workspaces", "myapp")));
  });

  test("a worktree is on its project's, because it is on its project's dind", () => {
    assert.equal(
      dind.bridge(target("/workspaces", "acme/widgets")),
      dind.bridge(target("/workspaces", "acme/widgets", "feature123")),
    );
  });

  // The hash is over the PROJECT namespace, so two projects whose names differ
  // only past the point a worktree marker would sit still land apart.
  test("two projects do not collide through the worktree encoding", () => {
    assert.notEqual(
      dind.bridge(target("/workspaces", "acme/widgets")),
      dind.bridge(target("/workspaces", "acme/widgets-wt")),
    );
  });
});

// Issue #50. A devcontainer on a project daemon reaches it by the socket the
// feature binds in, not by the feature's socat relay, which cuts attached
// `docker run` output off after a 0.5s pause. The rule is applied twice, to the
// spec desolate starts (addDirectSocket) and to `desolate exec`
// (dockerHostForExec), which is a plain `docker exec` and sees no remoteEnv.
describe("pointing a project's docker at its daemon's socket (not the relay)", () => {
  const url = "unix:///var/run/docker-host.sock";

  test("the socket is the one policy lets a project daemon's devcontainer bind", () => {
    assert.equal(dind.directSocket.path, "/var/run/docker-host.sock");
    assert.equal(dind.directSocket.url, url);
    assert.equal(dind.directSocket.variable, "DOCKER_HOST");
  });

  describe("the spec it starts", () => {
    test("a spec with no remoteEnv gets one", () => {
      const spec: Record<string, unknown> = { image: "x" };
      assert.equal(dind.addDirectSocket(spec), true);
      assert.deepEqual(spec.remoteEnv, { DOCKER_HOST: url });
    });

    test("the project's other remoteEnv stays, beside it", () => {
      const spec: Record<string, unknown> = { remoteEnv: { SSH_AUTH_SOCK: "", POETRY: "true" } };
      assert.equal(dind.addDirectSocket(spec), true);
      assert.deepEqual(spec.remoteEnv, { SSH_AUTH_SOCK: "", POETRY: "true", DOCKER_HOST: url });
    });

    test("what the project declares wins, whatever it is -- that is the way out", () => {
      for (const own of ["unix:///var/run/docker.sock", "tcp://elsewhere:2375", "", null]) {
        const spec: Record<string, unknown> = { remoteEnv: { DOCKER_HOST: own } };
        assert.equal(dind.addDirectSocket(spec), false, String(own));
        assert.deepEqual(spec.remoteEnv, { DOCKER_HOST: own });
      }
    });

    test("a DOCKER_HOST in containerEnv is the project's too, and gets no second one", () => {
      const spec: Record<string, unknown> = { containerEnv: { DOCKER_HOST: "unix:///var/run/docker.sock" } };
      assert.equal(dind.addDirectSocket(spec), false);
      assert.equal(spec.remoteEnv, undefined);
    });

    test("a containerEnv without it does not stop it", () => {
      const spec: Record<string, unknown> = { containerEnv: { OPENAI_API_KEY: "SAMPLE-OPENAI-KEY" } };
      assert.equal(dind.addDirectSocket(spec), true);
      assert.deepEqual(spec.containerEnv, { OPENAI_API_KEY: "SAMPLE-OPENAI-KEY" });
    });

    test("a remoteEnv that is not an object is left for the CLI and the policy", () => {
      for (const odd of ["DOCKER_HOST=x", ["DOCKER_HOST=x"], 7, null]) {
        const spec: Record<string, unknown> = { remoteEnv: odd };
        assert.equal(dind.addDirectSocket(spec), false, JSON.stringify(odd));
        assert.deepEqual(spec.remoteEnv, odd);
      }
    });

    test("a key merely INHERITED as DOCKER_HOST is not a declaration", () => {
      // JSON.parse makes own properties only; this is the case `in` would get wrong.
      const spec: Record<string, unknown> = { remoteEnv: Object.create({ DOCKER_HOST: "inherited" }) };
      assert.equal(dind.addDirectSocket(spec), true);
      assert.equal((spec.remoteEnv as Record<string, unknown>).DOCKER_HOST, url);
    });

    test("it adds nothing but that one variable, with no project data in it", () => {
      const spec: Record<string, unknown> = { image: "x", name: "$(touch /tmp/pwn)", features: {} };
      const before = JSON.stringify(spec);
      dind.addDirectSocket(spec);
      delete spec.remoteEnv;
      assert.equal(JSON.stringify(spec), before);
    });
  });

  describe("`desolate exec`, a plain docker exec", () => {
    const label = (...entries: object[]) => JSON.stringify(entries);

    test("a container made before desolate added it still gets it", () => {
      assert.equal(dind.dockerHostForExec(label({ remoteUser: "vscode" }, { postCreateCommand: "x" }), ["PATH=/bin"]), url);
    });

    test("a container desolate made carries it in its label, and gets that", () => {
      assert.equal(dind.dockerHostForExec(label({ remoteUser: "vscode" }, { remoteEnv: { DOCKER_HOST: url } }), []), url);
    });

    test("what the project declared is what it gets: the same as its terminals", () => {
      const own = "unix:///var/run/docker.sock";
      assert.equal(dind.dockerHostForExec(label({ remoteEnv: { DOCKER_HOST: own } }), []), own);
    });

    test("the last remoteEnv to declare it wins, as the CLI merges them", () => {
      const got = dind.dockerHostForExec(
        label({ remoteEnv: { DOCKER_HOST: "unix:///first" } }, { remoteEnv: { OTHER: "1" } }, { remoteEnv: { DOCKER_HOST: "unix:///last" } }),
        [],
      );
      assert.equal(got, "unix:///last");
    });

    test("one the container's own environment has is left alone", () => {
      assert.equal(dind.dockerHostForExec(label({}), ["A=1", "DOCKER_HOST=tcp://x:1"]), undefined);
      // a name that merely starts the same is not it
      assert.equal(dind.dockerHostForExec(label({}), ["DOCKER_HOST_EXTRA=1"]), url);
    });

    test("a project that blanked or nulled it is not handed one", () => {
      assert.equal(dind.dockerHostForExec(label({ remoteEnv: { DOCKER_HOST: "" } }), []), undefined);
      assert.equal(dind.dockerHostForExec(label({ remoteEnv: { DOCKER_HOST: null } }), []), undefined);
    });

    test("an absent or unreadable label is the case of a container made before", () => {
      assert.equal(dind.dockerHostForExec("", []), url);
      assert.equal(dind.dockerHostForExec("{not json", []), url);
      assert.equal(dind.dockerHostForExec("null", []), url);
      assert.equal(dind.dockerHostForExec(JSON.stringify({ remoteEnv: "x" }), []), url);
    });

    test("a single object label (not a list) reads the same way", () => {
      assert.equal(dind.dockerHostForExec(JSON.stringify({ remoteEnv: { DOCKER_HOST: "unix:///one" } }), []), "unix:///one");
    });
  });
});

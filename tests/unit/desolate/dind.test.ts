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
  test("the two docker features do", () => {
    assert.equal(dind.isRequiredBy([DOCKER_IN_DOCKER]), true);
    assert.equal(dind.isRequiredBy([DOCKER_OUTSIDE]), true);
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
      dind.isRequiredBy(["ghcr.io/devcontainers/features/docker-in-docker"]),
      true,
    );
    assert.equal(
      dind.isRequiredBy([`${DOCKER_IN_DOCKER.split(":")[0]}@sha256:${"a".repeat(64)}`]),
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

/// <reference types="node" />
// Every docker object and state file a target owns is named from its namespace.
//
// A target with no worktree must keep the names it has always had. Nothing
// errors when one of them moves: `devcontainer up` simply creates fresh
// volumes, the editor-server overlay is orphaned, the saved port map no longer
// matches, and dev-server URLs move. The stack comes up looking healthy, having
// silently lost every existing user's state.
//
// So the expectations here are LITERALS. Deriving them by calling the same
// function under test would encode whatever the code currently produces, which
// is the one thing this file exists to refuse.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  target,
  volumeNamespace,
} from "../../../release/vscode-image/projects.ts";
import * as relay from "../../../release/vscode-image/relays.ts";
import {
  SHARED_DIRECTORIES,
  overlayVolumes,
} from "../../../release/vscode-image/overlay.ts";
import { stateFile } from "../../../release/vscode-image/state.ts";

const WORKSPACES = "/workspaces";

const flat = target(WORKSPACES, "myapp");
const nested = target(WORKSPACES, "acme/widgets");

describe("a target with no worktree is named exactly as it was", () => {
  test("the volume namespace", () => {
    assert.equal(flat.namespace, "myapp");
    assert.equal(nested.namespace, "acme__widgets");
    assert.equal(volumeNamespace("acme/widgets"), "acme__widgets");
  });

  test("the volumes desolate injects", () => {
    assert.deepEqual(overlayVolumes(nested, "vscode-server"), {
      view: "acme__widgets-vscode-server",
      data: "acme__widgets-vscode-server-data",
    });
    assert.deepEqual(overlayVolumes(nested, "desolate-ca"), {
      view: "acme__widgets-desolate-ca",
      data: "acme__widgets-desolate-ca-data",
    });
    // and those two are the whole set, so no third volume appears unannounced
    assert.deepEqual(
      SHARED_DIRECTORIES.map(({ name }) => name),
      ["vscode-server", "desolate-ca"],
    );
  });

  test("the relay containers and the label that finds them", () => {
    assert.equal(relay.name(flat, 8081), "desolate-relay-myapp-8081");
    assert.equal(
      relay.name(nested, 8081),
      "desolate-relay-acme__widgets-8081",
    );
    assert.equal(relay.label(flat), "desolate.relay=myapp");
    assert.equal(relay.label(nested), "desolate.relay=acme/widgets");
  });

  test("the state files under /workspaces/.desolate", () => {
    assert.equal(
      stateFile(nested, "ports"),
      "/workspaces/.desolate/acme__widgets.ports",
    );
    assert.equal(
      stateFile(nested, "spec"),
      "/workspaces/.desolate/acme__widgets.spec",
    );
    assert.equal(
      stateFile(nested, "token"),
      "/workspaces/.desolate/acme__widgets.token",
    );
  });

  test("the directory it is started from", () => {
    assert.equal(flat.dir, "/workspaces/myapp");
    assert.equal(nested.dir, "/workspaces/acme/widgets");
    assert.equal(nested.projectDir, "/workspaces/acme/widgets");
  });
});

describe("a worktree target is named apart from its project", () => {
  const worktree = target(WORKSPACES, "acme/widgets", "feature123");

  test("its namespace extends the project's, and cannot be the project's", () => {
    assert.equal(worktree.namespace, "acme__widgets--wt--feature123");
    assert.notEqual(worktree.namespace, nested.namespace);
  });

  test("it is written and printed with an '@'", () => {
    assert.equal(worktree.name, "acme/widgets@feature123");
    assert.equal(relay.label(worktree), "desolate.relay=acme/widgets@feature123");
  });

  test("it lives under the project's .worktrees, which stays the mount source", () => {
    assert.equal(worktree.dir, "/workspaces/acme/widgets/.worktrees/feature123");
    assert.equal(worktree.projectDir, "/workspaces/acme/widgets");
  });

  test("a digit-bearing name does not eat the relay's trailing port", () => {
    const name = relay.name(worktree, 8082);
    assert.equal(name, "desolate-relay-acme__widgets--wt--feature123-8082");
    assert.equal(relay.hostPort(name), 8082);
  });
});

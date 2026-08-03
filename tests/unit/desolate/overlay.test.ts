/// <reference types="node" />
// Per-project views of the shared directories.
//
// These assertions used to live in tests/static/01-syntax.sh as greps for
// identifier names, which passed for a while against nothing but a stale
// comment. The invariants are about VALUES, so they are checked as values here.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CA_DIR,
  SERVER_DST,
  SERVER_SRC,
  SHARED_DIRECTORIES,
  overlayOptions,
  overlayVolumes,
} from "../../../release/vscode-image/overlay.ts";
import { enforcePolicy } from "../../../release/vscode-image/policy.ts";
import { volumeNamespace } from "../../../release/vscode-image/projects.ts";

describe("both shared directories get a view", () => {
  test("the editor server is one of them", () => {
    // EXECUTED by every project: a shared writable copy lets any project
    // overwrite the binary every other project runs.
    const entry = SHARED_DIRECTORIES.find((d) => d.lower === SERVER_SRC);
    assert.ok(entry, `no overlay for ${SERVER_SRC}`);
    assert.equal(entry.target, SERVER_DST);
  });

  test("the proxy CA dir is one of them", () => {
    // Higher impact than the server: install-ca.sh is executed as root in every
    // devcontainer AND in dind's entrypoint.
    const entry = SHARED_DIRECTORIES.find((d) => d.lower === CA_DIR);
    assert.ok(entry, `no overlay for ${CA_DIR}`);
    assert.equal(entry.target, CA_DIR);
  });

  test("nothing else is smuggled into the list", () => {
    assert.deepEqual(
      SHARED_DIRECTORIES.map((d) => d.lower).sort(),
      [CA_DIR, SERVER_SRC].sort(),
    );
  });

  test("every entry carries a proof path under its own target", () => {
    // `docker volume create` is lazy and succeeds without mounting anything;
    // the proof path is what a real mount is verified with.
    for (const { name, target, proof } of SHARED_DIRECTORIES)
      assert.ok(proof.startsWith(`${target}/`), `${name}: proof '${proof}' is outside '${target}'`);
  });

  test("every entry carries an identity file and both explanatory strings", () => {
    for (const entry of SHARED_DIRECTORIES) {
      assert.ok(entry.identityFile.startsWith(`${entry.lower}/`), entry.name);
      assert.ok(entry.missing.length > 0, entry.name);
      assert.ok(entry.why.length > 0, entry.name);
    }
  });
});

describe("the volumes a view is made of", () => {
  test("are named inside the project's own policy namespace", () => {
    // desolate injects these mounts and the derived spec is re-checked against
    // the policy, so a name outside the namespace would refuse every start.
    for (const project of ["myapp", "owner/repo"])
      for (const { name } of SHARED_DIRECTORIES) {
        const { view, data } = overlayVolumes(project, name);
        const namespace = volumeNamespace(project);
        for (const volume of [view, data])
          assert.ok(
            volume === namespace || volume.startsWith(`${namespace}-`),
            `${volume} is outside '${namespace}-*'`,
          );
      }
  });

  test("the policy actually accepts them", () => {
    // The real check, rather than a restatement of the naming rule: hand the
    // policy the mounts desolate injects and require that they pass.
    for (const project of ["myapp", "owner/repo"]) {
      const mounts = SHARED_DIRECTORIES.flatMap(({ name, target }) => {
        const { view } = overlayVolumes(project, name);
        return [`source=${view},target=${target},type=volume`];
      });
      const configuration = { image: "x", mounts };
      enforcePolicy(
        project,
        { configuration, mergedConfiguration: { ...configuration } },
        "/workspaces",
        [project],
      );
    }
  });

  test("a longer sibling project cannot claim them", () => {
    // `web` and `web-vscode-server` would otherwise contest the same volume.
    const { view } = overlayVolumes("web", "vscode-server");
    assert.equal(view, "web-vscode-server");
    const configuration = {
      image: "x",
      mounts: [`source=${view},target=${SERVER_DST},type=volume`],
    };
    assert.throws(
      () =>
        enforcePolicy(
          "web",
          { configuration, mergedConfiguration: { ...configuration } },
          "/workspaces",
          ["web", "web-vscode-server"],
        ),
      /belongs to project 'web-vscode-server'/,
    );
  });

  test("view and data are distinct", () => {
    const { view, data } = overlayVolumes("myapp", "vscode-server");
    assert.notEqual(view, data);
    assert.equal(data, `${view}-data`);
  });
});

describe("overlay options", () => {
  test("name all three overlayfs directories", () => {
    assert.equal(
      overlayOptions("/server-dist", "/var/lib/docker/volumes/x/_data"),
      "lowerdir=/server-dist,upperdir=/var/lib/docker/volumes/x/_data/upper," +
        "workdir=/var/lib/docker/volumes/x/_data/work",
    );
  });

  test("upper and work are siblings under the data volume, never under the lower", () => {
    // An upper inside the lower is a write path back into the shared original,
    // which is the whole thing this design exists to prevent.
    const options = overlayOptions("/server-dist", "/data/mp");
    const fields = Object.fromEntries(
      options.split(",").map((kv) => kv.split("=") as [string, string]),
    );
    assert.equal(fields.lowerdir, "/server-dist");
    for (const key of ["upperdir", "workdir"])
      assert.ok(
        !fields[key].startsWith("/server-dist"),
        `${key}=${fields[key]} sits inside the lower`,
      );
  });

  test("is deterministic, so a cache hit compares equal", () => {
    // ensureVolume accepts a cached view only when the stored options string
    // equals the one it would build now.
    assert.equal(overlayOptions("/a", "/b"), overlayOptions("/a", "/b"));
  });
});

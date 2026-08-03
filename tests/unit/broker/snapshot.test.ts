/// <reference types="node" />
// The spec snapshot -- the TOCTOU defence.
//
// Validating a devcontainer.json means nothing unless the file that is
// VALIDATED is the file that is STARTED. /workspaces is writable by the editor
// and by each project's own container, so a spec checked in place can be
// swapped between the check and `devcontainer up`.
//
// tests/integration/broker proves the broker starts from the copy. These cases
// cover the copying itself, because both entry points now share it: the broker
// (from the editor) and desolate.ts (from `cli.sh desolate`, which used to
// validate the live file and start from it).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  snapshot,
  SNAPSHOT_DIRECTORY_MODE,
} from "../../../release/vscode-image/snapshot.ts";

/** A throwaway /workspaces + spec directory pair. */
const sandbox = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-snapshot-"));
  const workspaces = path.join(root, "workspaces");
  const specs = path.join(root, "specs");
  fs.mkdirSync(workspaces, { recursive: true });
  fs.mkdirSync(specs, { recursive: true });
  return {
    workspaces,
    specs,
    /** Write `files` (relative path -> contents) into project `name`. */
    project: (name: string, files: Record<string, string>) => {
      for (const [relative, contents] of Object.entries(files)) {
        const file = path.join(workspaces, name, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
      }
    },
  };
};

const NESTED = ".devcontainer/devcontainer.json";

describe("the spec snapshot", () => {
  test("returns the COPY's path, not the project's", () => {
    const box = sandbox();
    box.project("myapp", { [NESTED]: '{"image":"alpine:3"}' });

    const frozen = snapshot("myapp", box);

    assert.equal(frozen, path.join(box.specs, "myapp", "devcontainer.json"));
    assert.equal(fs.readFileSync(frozen, "utf8"), '{"image":"alpine:3"}');
  });

  test("a later edit to the live file does not reach the copy", () => {
    // The whole point. Everything after the snapshot -- the policy check, the
    // resolve, `devcontainer up` -- reads the copy.
    const box = sandbox();
    box.project("myapp", { [NESTED]: '{"image":"alpine:3"}' });

    const frozen = snapshot("myapp", box);
    box.project("myapp", {
      [NESTED]: '{"image":"alpine:3","privileged":true}',
    });

    assert.equal(fs.readFileSync(frozen, "utf8"), '{"image":"alpine:3"}');
  });

  test("the whole .devcontainer directory comes along", () => {
    // The CLI resolves build.dockerfile, build.context and local ./features
    // relative to the config file. Copying the json alone would leave those
    // resolving back into editor-writable state.
    const box = sandbox();
    box.project("myapp", {
      [NESTED]: '{"build":{"dockerfile":"Dockerfile"}}',
      ".devcontainer/Dockerfile": "FROM alpine:3\n",
      ".devcontainer/myfeature/devcontainer-feature.json": '{"id":"mine"}',
    });

    snapshot("myapp", box);

    const copy = path.join(box.specs, "myapp");
    assert.equal(fs.readFileSync(path.join(copy, "Dockerfile"), "utf8"), "FROM alpine:3\n");
    assert.ok(
      fs.existsSync(path.join(copy, "myfeature", "devcontainer-feature.json")),
      "a local feature was left behind in the project",
    );
  });

  test("E13: devcontainer.json itself as a symlink does not defeat the freeze", () => {
    // The sharpest shape of it, and the one that made this a total bypass
    // rather than an edge case. `fs.cpSync(..., {dereference: true})` does NOT
    // dereference -- measured on node 24.18, it writes a symlink into the
    // destination still pointing at the original -- so a project whose
    // devcontainer.json was a link had its spec read live at every step. The
    // policy validated one document and `devcontainer up` read whatever had
    // replaced it in between.
    const box = sandbox();
    box.project("myapp", { "live/spec.json": '{"image":"alpine:3"}' });
    fs.mkdirSync(path.join(box.workspaces, "myapp", ".devcontainer"));
    fs.symlinkSync(
      path.join(box.workspaces, "myapp", "live", "spec.json"),
      path.join(box.workspaces, "myapp", ".devcontainer", "devcontainer.json"),
    );

    const frozen = snapshot("myapp", box);

    fs.writeFileSync(
      path.join(box.workspaces, "myapp", "live", "spec.json"),
      '{"image":"alpine:3","privileged":true}',
    );
    assert.equal(
      fs.readFileSync(frozen, "utf8"),
      '{"image":"alpine:3"}',
      "the validated spec was swapped out from under the snapshot",
    );
  });

  test("a symlink cycle is refused rather than recursed forever", () => {
    const box = sandbox();
    box.project("myapp", { [NESTED]: "{}" });
    const dir = path.join(box.workspaces, "myapp", ".devcontainer");
    fs.symlinkSync(dir, path.join(dir, "self"));

    assert.throws(() => snapshot("myapp", box), /symlink cycle|levels deep/);
  });

  test("a link pointing nowhere is refused, not copied as a dangling link", () => {
    const box = sandbox();
    box.project("myapp", { [NESTED]: "{}" });
    fs.symlinkSync(
      "/nonexistent/target",
      path.join(box.workspaces, "myapp", ".devcontainer", "dangling"),
    );

    assert.throws(() => snapshot("myapp", box), /refusing to snapshot/);
  });

  test("a symlink is dereferenced, not carried over as a link", () => {
    // A link copied AS a link still points at the live tree, so the copy would
    // be a copy in name only.
    const box = sandbox();
    box.project("myapp", { [NESTED]: "{}" });
    const outside = path.join(box.workspaces, "elsewhere.json");
    fs.writeFileSync(outside, '{"image":"from-outside"}');
    fs.symlinkSync(outside, path.join(box.workspaces, "myapp", ".devcontainer", "linked.json"));

    snapshot("myapp", box);

    const copied = path.join(box.specs, "myapp", "linked.json");
    assert.ok(!fs.lstatSync(copied).isSymbolicLink(), "the snapshot kept a symlink");
    fs.writeFileSync(outside, '{"image":"swapped"}');
    assert.equal(fs.readFileSync(copied, "utf8"), '{"image":"from-outside"}');
  });

  test("the flat .devcontainer.json layout is snapshotted too", () => {
    const box = sandbox();
    box.project("myapp", { ".devcontainer.json": '{"image":"alpine:3"}' });

    const frozen = snapshot("myapp", box);

    assert.equal(fs.readFileSync(frozen, "utf8"), '{"image":"alpine:3"}');
  });

  test("a stale copy from a previous run is replaced, not merged into", () => {
    // A file the project has since DELETED must not survive in the copy we
    // start from -- a removed local feature that still resolves is a feature
    // still running.
    const box = sandbox();
    box.project("myapp", {
      [NESTED]: "{}",
      ".devcontainer/gone.json": "{}",
    });
    snapshot("myapp", box);

    fs.rmSync(path.join(box.workspaces, "myapp", ".devcontainer", "gone.json"));
    snapshot("myapp", box);

    assert.ok(!fs.existsSync(path.join(box.specs, "myapp", "gone.json")));
  });

  test("the copy is owner-only", () => {
    // Anything able to write here can swap a validated spec for one that never
    // was, after the check has passed.
    const box = sandbox();
    box.project("myapp", { [NESTED]: "{}" });

    snapshot("myapp", box);

    const mode = fs.statSync(path.join(box.specs, "myapp")).mode & 0o777;
    assert.equal(mode, SNAPSHOT_DIRECTORY_MODE);
  });

  test("a project with no spec throws rather than returning a path to nothing", () => {
    const box = sandbox();
    box.project("myapp", { "README.md": "no devcontainer here" });

    assert.throws(() => snapshot("myapp", box), /no devcontainer\.json/);
  });
});

describe("the node behaviour snapshot.ts works around", () => {
  // This suite tests NODE, not us, and that is deliberate: snapshot.ts hand-rolls
  // a recursive copy instead of calling fs.cpSync, which is a cost (30 lines of
  // filesystem code this repo now owns) that is only justified while the reason
  // holds. If node fixes this, these cases fail and the workaround can go.
  //
  // Why not the alternatives, recorded here so the decision is not re-litigated
  // from scratch:
  //
  //   `filter: () => true`  -- works (see below), but only because the filter is
  //                            what selects the JS implementation. A security
  //                            boundary resting on a no-op argument that steers
  //                            code-path selection is one upstream can remove
  //                            without touching any documented behaviour.
  //   `cp -RL` / `rsync -aL`-- both correct, and both shell out. Neither refuses
  //                            a fifo, socket or device, which a directory we
  //                            are about to hand to `devcontainer up` should.
  //                            rsync is also not installed by default anywhere.
  //   fs-extra              -- correct, and a dependency. `release/` ships no
  //                            package.json at all; adding npm install to the
  //                            trust root of a sandbox is the wrong direction.
  const tree = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-nodecp-"));
    fs.mkdirSync(path.join(root, "src", "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "target.txt"), "ORIGINAL");
    fs.symlinkSync(
      path.join(root, "target.txt"),
      path.join(root, "src", "sub", "deep.txt"),
    );
    return root;
  };
  const nestedLinkSurvived = (options: object) => {
    const root = tree();
    fs.cpSync(path.join(root, "src"), path.join(root, "dst"), options);
    return fs
      .lstatSync(path.join(root, "dst", "sub", "deep.txt"))
      .isSymbolicLink();
  };

  test("cpSync ignores dereference for entries inside a directory", () => {
    assert.equal(
      nestedLinkSurvived({ recursive: true, dereference: true }),
      true,
      "node now dereferences nested symlinks -- snapshot.ts's hand-rolled copy " +
        "may no longer be needed; re-read its header before removing it",
    );
  });

  test("...unless a filter is passed, which selects the JS implementation", () => {
    // copyDir() delegates to fsBinding.cpSyncCopyDir when `!opts.filter`, and
    // that C++ path is the one that drops `dereference` on the floor. This case
    // is what proves the cause, rather than leaving it as "cpSync is broken".
    assert.equal(
      nestedLinkSurvived({
        recursive: true,
        dereference: true,
        filter: () => true,
      }),
      false,
      "the JS path no longer honours dereference either -- the diagnosis in " +
        "snapshot.ts's header is out of date",
    );
  });
});

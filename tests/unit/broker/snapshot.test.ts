/// <reference types="node" />
// The snapshot's containment rule, exercised against a real filesystem.
//
// Freezing a spec means DEREFERENCING the project's symlinks, and that happens
// in the orchestrator -- the container holding the inner Docker socket. A link
// out of the project is therefore a file read performed on the project's behalf
// against files the project cannot reach itself. Nothing in the spec policy can
// see it: every key in devcontainer.json is legal, and the read is in the
// filesystem underneath it. (What the LIVE build context may reach is a
// separate rule, in policy.ts -- see snapshot.ts's header for why these are two
// different trees.)
//
// These use real symlinks rather than mocks, because the thing under test is
// what the kernel does when the copy follows one.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ContainmentError,
  resolveWithin,
  snapshotDirectory,
  snapshotFile,
  snapshot,
  SNAPSHOT_DIRECTORY_MODE,
} from "../../../release/vscode-image/snapshot.ts";
import { target } from "../../../release/vscode-image/projects.ts";

/** A workspaces root with `victim/` (the secret) and `project/` (the attacker). */
function scratch() {
  // realpath: on macOS os.tmpdir() is itself a symlink (/var -> /private/var),
  // and a containment check that compared unresolved paths would refuse
  // everything here for the wrong reason.
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "desolate-snap-")),
  );
  const project = path.join(tmp, "workspaces", "project");
  const config = path.join(project, ".devcontainer");
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(
    path.join(config, "devcontainer.json"),
    '{"image":"alpine"}',
  );
  fs.mkdirSync(path.join(tmp, "workspaces", "sibling"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "workspaces", "sibling", "keys"),
    "sibling-secret",
  );
  fs.writeFileSync(path.join(tmp, "id_ed25519"), "PRIVATE KEY");
  return {
    tmp,
    project,
    config,
    out: path.join(tmp, "specs", "project"),
    link: (name: string, target: string) =>
      fs.symlinkSync(target, path.join(config, name)),
    snapshot: () =>
      snapshotDirectory(project, config, path.join(tmp, "specs", "project")),
    copied: (rel: string) =>
      fs.readFileSync(path.join(tmp, "specs", "project", rel), "utf8"),
  };
}

const refused = (run: () => void) => {
  try {
    run();
  } catch (err) {
    assert.ok(err instanceof ContainmentError, `wrong error type: ${err}`);
    return String((err as Error).message);
  }
  return assert.fail("the snapshot was allowed");
};

describe("a symlink out of the project is refused", () => {
  test("the demonstrated shape: a key stolen from the orchestrator", () => {
    const s = scratch();
    // Committed to the repo, this is followed by the orchestrator, lands in the
    // build context, and `COPY key /` in the project's Dockerfile takes it.
    s.link("key", path.join(s.tmp, "id_ed25519"));
    const message = refused(s.snapshot);
    assert.match(message, /key/);
    assert.match(message, /outside/);
    assert.ok(!fs.existsSync(path.join(s.out, "key")), "it was copied anyway");
  });

  test("relative traversal, which is how it would actually be written", () => {
    const s = scratch();
    s.link("key", "../../../id_ed25519");
    assert.match(refused(s.snapshot), /outside/);
  });

  test("a sibling project is outside too -- it is somebody else's domain", () => {
    const s = scratch();
    s.link("keys", "../../sibling/keys");
    assert.match(refused(s.snapshot), /outside/);
  });

  test("a link nested deeper in the config directory is checked as well", () => {
    const s = scratch();
    fs.mkdirSync(path.join(s.config, "feat", "deep"), { recursive: true });
    fs.symlinkSync(
      path.join(s.tmp, "id_ed25519"),
      path.join(s.config, "feat", "deep", "key"),
    );
    assert.match(refused(s.snapshot), /outside/);
  });

  test("a symlinked DIRECTORY out of the project is refused, not walked", () => {
    const s = scratch();
    fs.mkdirSync(path.join(s.tmp, "elsewhere"), { recursive: true });
    fs.writeFileSync(path.join(s.tmp, "elsewhere", "loot"), "x");
    s.link("ctx", path.join(s.tmp, "elsewhere"));
    assert.match(refused(s.snapshot), /outside/);
  });

  test("a prefix of the project name is not inside it", () => {
    // /workspaces/project-2 starts with /workspaces/project as a STRING.
    const s = scratch();
    const neighbour = path.join(s.tmp, "workspaces", "project-2");
    fs.mkdirSync(neighbour, { recursive: true });
    fs.writeFileSync(path.join(neighbour, "secret"), "not yours");
    s.link("secret", path.join(neighbour, "secret"));
    assert.match(refused(s.snapshot), /outside/);
  });

  test("the .devcontainer directory itself may not be a link out", () => {
    const s = scratch();
    const outside = path.join(s.tmp, "elsewhere");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "devcontainer.json"), "{}");
    const linked = path.join(s.tmp, "workspaces", "linked");
    fs.mkdirSync(linked, { recursive: true });
    fs.symlinkSync(outside, path.join(linked, ".devcontainer"));
    assert.match(
      refused(() =>
        snapshotDirectory(linked, path.join(linked, ".devcontainer"), s.out),
      ),
      /outside/,
    );
  });

  test("the flat .devcontainer.json may not be a link out either", () => {
    const s = scratch();
    fs.symlinkSync(
      path.join(s.tmp, "id_ed25519"),
      path.join(s.project, ".devcontainer.json"),
    );
    assert.match(
      refused(() =>
        snapshotFile(
          s.project,
          path.join(s.project, ".devcontainer.json"),
          path.join(s.tmp, "flat.json"),
        ),
      ),
      /outside/,
    );
  });

  test("a broken link is refused rather than skipped", () => {
    const s = scratch();
    s.link("gone", path.join(s.tmp, "was-never-here"));
    assert.match(refused(s.snapshot), /cannot be resolved/);
  });

  test("a socket or fifo is refused, not copied as an empty file", () => {
    const s = scratch();
    const fifo = path.join(s.config, "pipe");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // no mkfifo on this machine; nothing to assert about
    }
    assert.match(refused(s.snapshot), /neither a file/);
  });
});

describe("a symlink inside the project still works", () => {
  test("the common one: .devcontainer/Dockerfile -> ../Dockerfile", () => {
    const s = scratch();
    fs.writeFileSync(path.join(s.project, "Dockerfile"), "FROM alpine\n");
    s.link("Dockerfile", "../Dockerfile");
    s.snapshot();
    assert.equal(s.copied("Dockerfile"), "FROM alpine\n");
    assert.ok(
      !fs.lstatSync(path.join(s.out, "Dockerfile")).isSymbolicLink(),
      "the copy must be a real file -- a link would still point at live state",
    );
  });

  test("a directory link inside the project is followed", () => {
    const s = scratch();
    fs.mkdirSync(path.join(s.project, "ctx"), { recursive: true });
    fs.writeFileSync(path.join(s.project, "ctx", "app.py"), "print(1)\n");
    s.link("ctx", "../ctx");
    s.snapshot();
    assert.equal(s.copied(path.join("ctx", "app.py")), "print(1)\n");
  });

  test("plain files and nested directories are copied as before", () => {
    const s = scratch();
    fs.mkdirSync(path.join(s.config, "feat"), { recursive: true });
    fs.writeFileSync(path.join(s.config, "feat", "install.sh"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    s.snapshot();
    assert.equal(s.copied(path.join("feat", "install.sh")), "#!/bin/sh\n");
    assert.ok(
      fs.statSync(path.join(s.out, "feat", "install.sh")).mode & 0o111,
      "the executable bit must survive -- build contexts run their scripts",
    );
  });

  test("a link cycle inside the project is named, not recursed into", () => {
    const s = scratch();
    s.link("self", ".");
    const message = refused(s.snapshot);
    assert.match(message, /cycle/);
  });
});

describe("resolveWithin", () => {
  test("the project directory itself is inside itself", () => {
    const s = scratch();
    assert.equal(resolveWithin(s.project, s.config), s.config);
  });

  test("it reports the real path it landed on, so the refusal is diagnosable", () => {
    const s = scratch();
    s.link("key", path.join(s.tmp, "id_ed25519"));
    const message = refused(() =>
      resolveWithin(s.project, path.join(s.config, "key")),
    );
    assert.match(message, new RegExp(path.join(s.tmp, "id_ed25519")));
  });
});

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

    const frozen = snapshot(target(box.workspaces, "myapp"), box);

    assert.equal(frozen, path.join(box.specs, "myapp", "devcontainer.json"));
    assert.equal(fs.readFileSync(frozen, "utf8"), '{"image":"alpine:3"}');
  });

  test("a later edit to the live file does not reach the copy", () => {
    // The whole point. Everything after the snapshot -- the policy check, the
    // resolve, `devcontainer up` -- reads the copy.
    const box = sandbox();
    box.project("myapp", { [NESTED]: '{"image":"alpine:3"}' });

    const frozen = snapshot(target(box.workspaces, "myapp"), box);
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

    snapshot(target(box.workspaces, "myapp"), box);

    const copy = path.join(box.specs, "myapp");
    assert.equal(
      fs.readFileSync(path.join(copy, "Dockerfile"), "utf8"),
      "FROM alpine:3\n",
    );
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

    const frozen = snapshot(target(box.workspaces, "myapp"), box);

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

    assert.throws(() => snapshot(target(box.workspaces, "myapp"), box), /symlink cycle|levels deep/);
  });

  test("a link pointing nowhere is refused, not copied as a dangling link", () => {
    const box = sandbox();
    box.project("myapp", { [NESTED]: "{}" });
    fs.symlinkSync(
      "/nonexistent/target",
      path.join(box.workspaces, "myapp", ".devcontainer", "dangling"),
    );

    assert.throws(() => snapshot(target(box.workspaces, "myapp"), box), /refusing to snapshot/);
  });

  test("a symlink is dereferenced, not carried over as a link", () => {
    // A link copied AS a link still points at the live tree, so the copy would
    // be a copy in name only.
    //
    // The target is inside the project on purpose: a link OUT of it is refused
    // outright rather than dereferenced (see "a symlink out of the project is
    // refused" above), so this case has to be an in-project one or it would be
    // asserting the wrong rule. Both halves matter -- dereference what you are
    // allowed to follow, refuse what you are not.
    const box = sandbox();
    box.project("myapp", {
      [NESTED]: "{}",
      "live/elsewhere.json": '{"image":"from-elsewhere"}',
    });
    const pointee = path.join(box.workspaces, "myapp", "live", "elsewhere.json");
    fs.symlinkSync(
      pointee,
      path.join(box.workspaces, "myapp", ".devcontainer", "linked.json"),
    );

    snapshot(target(box.workspaces, "myapp"), box);

    const copied = path.join(box.specs, "myapp", "linked.json");
    assert.ok(
      !fs.lstatSync(copied).isSymbolicLink(),
      "the snapshot kept a symlink",
    );
    fs.writeFileSync(pointee, '{"image":"swapped"}');
    assert.equal(fs.readFileSync(copied, "utf8"), '{"image":"from-elsewhere"}');
  });

  test("the flat .devcontainer.json layout is snapshotted too", () => {
    const box = sandbox();
    box.project("myapp", { ".devcontainer.json": '{"image":"alpine:3"}' });

    const frozen = snapshot(target(box.workspaces, "myapp"), box);

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
    snapshot(target(box.workspaces, "myapp"), box);

    fs.rmSync(path.join(box.workspaces, "myapp", ".devcontainer", "gone.json"));
    snapshot(target(box.workspaces, "myapp"), box);

    assert.ok(!fs.existsSync(path.join(box.specs, "myapp", "gone.json")));
  });

  test("the copy is owner-only", () => {
    // Anything able to write here can swap a validated spec for one that never
    // was, after the check has passed.
    const box = sandbox();
    box.project("myapp", { [NESTED]: "{}" });

    snapshot(target(box.workspaces, "myapp"), box);

    const mode = fs.statSync(path.join(box.specs, "myapp")).mode & 0o777;
    assert.equal(mode, SNAPSHOT_DIRECTORY_MODE);
  });

  test("a project with no spec throws rather than returning a path to nothing", () => {
    const box = sandbox();
    box.project("myapp", { "README.md": "no devcontainer here" });

    assert.throws(() => snapshot(target(box.workspaces, "myapp"), box), /no devcontainer\.json/);
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

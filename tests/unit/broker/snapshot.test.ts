/// <reference types="node" />
// The snapshot's containment rule, exercised against a real filesystem.
//
// Freezing a spec means DEREFERENCING the project's symlinks, and that happens
// in the orchestrator -- the container holding the inner Docker socket. The
// snapshot then becomes the build context handed to `docker build`, so a link
// out of the project is a file-read primitive against the orchestrator with a
// `COPY` in the project's own Dockerfile to collect it. Nothing in the spec
// policy can see it: every key in devcontainer.json is legal.
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
} from "../../../release/vscode-image/snapshot.ts";

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
  fs.writeFileSync(path.join(config, "devcontainer.json"), '{"image":"alpine"}');
  fs.mkdirSync(path.join(tmp, "workspaces", "sibling"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "workspaces", "sibling", "keys"), "sibling-secret");
  fs.writeFileSync(path.join(tmp, "id_ed25519"), "PRIVATE KEY");
  return {
    tmp,
    project,
    config,
    out: path.join(tmp, "specs", "project"),
    link: (name: string, target: string) =>
      fs.symlinkSync(target, path.join(config, name)),
    snapshot: () => snapshotDirectory(project, config, path.join(tmp, "specs", "project")),
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

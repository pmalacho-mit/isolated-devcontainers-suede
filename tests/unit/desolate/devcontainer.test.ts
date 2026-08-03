/// <reference types="node" />
// Where the devcontainer CLI reads a config from, and what it then CLAIMS the
// config was -- which are two different paths, and the gap between them broke
// `desolate --rebuild` on a container that had started perfectly.
//
// MEASURED, against @devcontainers/cli 0.88.0 and a real daemon:
//
//   devcontainer up --workspace-folder <ws>/proj \
//                   --override-config <specs>/proj/devcontainer.json
//
//   docker ps --filter label=devcontainer.local_folder=<ws>/proj \
//             --format '{{.Label "devcontainer.config_file"}}'
//   -> <ws>/proj/.devcontainer/devcontainer.json
//
// The label follows the WORKSPACE, not the override. desolate looks a container
// up by that label (docker.ts insists on it -- it is the half of a container's
// identity a project cannot choose), and every call site was passing the
// snapshot path it had in hand. Nothing matched, so a running container came
// back as "", and the caller said "devcontainer is not running after up" about
// a container `docker ps` was listing.
//
// The unit tests for the lookup itself passed throughout: their fixtures
// asserted the same wrong path the code used.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  labelledConfig,
  tryLocateConfig,
} from "../../../release/vscode-image/devcontainer.ts";

/** A project directory in one of the two layouts the CLI accepts. */
const project = (layout: "nested" | "flat" | "both" | "none") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-cfg-"));
  if (layout === "nested" || layout === "both") {
    fs.mkdirSync(path.join(dir, ".devcontainer"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".devcontainer", "devcontainer.json"),
      '{"image":"alpine:3"}',
    );
  }
  if (layout === "flat" || layout === "both")
    fs.writeFileSync(path.join(dir, ".devcontainer.json"), '{"image":"alpine:3"}');
  return dir;
};

describe("the config path a container is LABELLED with", () => {
  test("the nested layout: <project>/.devcontainer/devcontainer.json", () => {
    const dir = project("nested");
    assert.equal(
      labelledConfig(dir),
      path.join(dir, ".devcontainer", "devcontainer.json"),
    );
  });

  test("the flat layout: <project>/.devcontainer.json", () => {
    const dir = project("flat");
    assert.equal(labelledConfig(dir), path.join(dir, ".devcontainer.json"));
  });

  test("nested wins when both exist, as it does for the CLI", () => {
    // Same precedence the CLI uses. Picking the other one would produce a label
    // that never matches, which is exactly the bug this file is about.
    const dir = project("both");
    assert.equal(
      labelledConfig(dir),
      path.join(dir, ".devcontainer", "devcontainer.json"),
    );
  });

  test("a project with no config yields '', not a path to nothing", () => {
    // `desolate --stop` on a project whose devcontainer.json was deleted
    // depends on this: with no config known the lookup matches on the
    // workspace alone, so the container can still be found and stopped.
    const dir = project("none");
    assert.equal(labelledConfig(dir), "");
    assert.equal(tryLocateConfig(dir), undefined);
  });

  test("it is NOT the path desolate passes to --override-config", () => {
    // The whole point, stated as an assertion so a future refactor that
    // "simplifies" this back into `config` fails here rather than in a
    // container. A snapshot lives outside the project by construction.
    const dir = project("nested");
    const snapshot = "/tmp/desolate-specs/myapp/devcontainer.json";
    assert.notEqual(labelledConfig(dir), snapshot);
    assert.ok(
      labelledConfig(dir).startsWith(dir),
      "the labelled config must live inside the workspace folder",
    );
  });
});

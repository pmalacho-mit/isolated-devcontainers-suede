/// <reference types="node" />
// A Dockerfile project is built first and `up` starts the image by id
// (dockerfile-build.ts): the spec `devcontainer build` is given, and the spec
// `up` is given, each the derived spec rewritten and nothing more.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildsFromDockerfile, buildSpec, imageSpec } from "../../../release/vscode-image/dockerfile-build.ts";

const SNAPSHOT = "/tmp/desolate-run-config/acme__app";
const CONFIG_DIR = "/workspaces/acme/app/.devcontainer";
const ID = `sha256:${"a".repeat(64)}`;

describe("which specs build", () => {
  test("build.dockerfile, or the legacy dockerFile; not an image", () => {
    assert.equal(buildsFromDockerfile({ build: { dockerfile: "Dockerfile" } }), true);
    assert.equal(buildsFromDockerfile({ dockerFile: "Dockerfile" }), true);
    assert.equal(buildsFromDockerfile({ image: "alpine:3" }), false);
    assert.equal(buildsFromDockerfile({ build: { args: {} } }), false);
  });
});

describe("the spec devcontainer build is given", () => {
  test("the Dockerfile from the snapshot, the context from the project's config directory, both absolute; the rest kept", () => {
    const spec = { build: { dockerfile: "Dockerfile", context: "..", args: { A: "1" } }, remoteUser: "dev", features: { "ghcr.io/x/y@sha256:abc": {} } };
    assert.deepEqual(buildSpec(spec, SNAPSHOT, CONFIG_DIR), {
      build: { dockerfile: `${SNAPSHOT}/Dockerfile`, context: "/workspaces/acme/app", args: { A: "1" } },
      remoteUser: "dev",
      features: { "ghcr.io/x/y@sha256:abc": {} },
    });
  });

  test("defaults: Dockerfile beside the config, the config directory as context", () => {
    assert.deepEqual(buildSpec({ build: {} }, SNAPSHOT, CONFIG_DIR).build, { dockerfile: `${SNAPSHOT}/Dockerfile`, context: CONFIG_DIR });
  });

  test("the legacy spellings fold into build", () => {
    assert.deepEqual(buildSpec({ dockerFile: "sub/Dockerfile", context: ".." }, SNAPSHOT, CONFIG_DIR), {
      build: { dockerfile: `${SNAPSHOT}/sub/Dockerfile`, context: "/workspaces/acme/app" },
    });
  });

  test("an absolute path stays what it is -- the policy judged it already", () => {
    assert.equal((buildSpec({ build: { context: "/workspaces/acme/app/src" } }, SNAPSHOT, CONFIG_DIR).build as Record<string, unknown>).context, "/workspaces/acme/app/src");
  });
});

describe("the spec up is given", () => {
  test("the image by id; no build, no features; the rest kept", () => {
    const spec = { build: { dockerfile: "Dockerfile" }, dockerFile: "x", context: "..", features: { "ghcr.io/x/y:1": {} },
      remoteUser: "dev", postCreateCommand: "make", customizations: { desolate: { ports: [3000] } }, mounts: ["type=volume,source=v,target=/v"] };
    assert.deepEqual(imageSpec(spec, ID), {
      image: ID, remoteUser: "dev", postCreateCommand: "make", customizations: { desolate: { ports: [3000] } }, mounts: ["type=volume,source=v,target=/v"],
    });
  });

  test("only an image id names content: a tag could be moved between the policy and up", () => {
    for (const bad of ["desolate-built/acme__app:abc", "sha256:short", "", `SHA256:${"a".repeat(64)}`])
      assert.throws(() => imageSpec({}, bad), /not an image id/, bad);
  });
});

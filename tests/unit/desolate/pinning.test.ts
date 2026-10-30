/// <reference types="node" />
// T5.4: a spec's image, pinned to the digest it resolves to, before anything
// is derived from it. The registry is not consulted here -- the image's own
// RepoDigests are, after a pull only if it is not local -- so a fake daemon
// answering inspect and pull is the whole of the world this needs.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createDocker, type Runner } from "../../../release/vscode-image/docker.ts";
import { pinnedImage } from "../../../release/vscode-image/certificates.ts";

const SHA = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;

/** A daemon holding `local` images (name -> RepoDigests), recording pulls. */
const daemon = (local: Record<string, string[]>, pullable: Record<string, string[]> = {}) => {
  const pulls: string[] = [];
  const runner: Runner = {
    output: (argv) => {
      const name = argv.at(-1)!;
      if (!(name in local)) return "";
      return argv.includes("{{json .RepoDigests}}") ? JSON.stringify(local[name]) : "sha256:id";
    },
    status: (argv) => {
      if (argv[0] !== "pull") return 0;
      pulls.push(argv[1]);
      if (!(argv[1] in pullable)) return 1;
      local[argv[1]] = pullable[argv[1]];
      return 0;
    },
    build: () => ({ ok: true, output: "" }),
  };
  return { docker: createDocker(runner), pulls };
};

describe("pinning a spec's image", () => {
  test("a local image is pinned to its own digest, its tag kept for reading", () => {
    const { docker, pulls } = daemon({ "mcr.microsoft.com/devcontainers/base:bookworm": [`mcr.microsoft.com/devcontainers/base@${SHA}`] });
    assert.equal(pinnedImage("mcr.microsoft.com/devcontainers/base:bookworm", docker), `mcr.microsoft.com/devcontainers/base:bookworm@${SHA}`);
    assert.deepEqual(pulls, [], "a local image is not pulled again");
  });

  test("Docker Hub's short names match their RepoDigests", () => {
    for (const [image, digest] of [["node:22", `node@${SHA}`], ["acme/tool:1", `acme/tool@${SHA}`], ["docker.io/library/node:22", `node@${SHA}`]]) {
      const { docker } = daemon({ [image]: [digest] });
      assert.equal(pinnedImage(image, docker), `${image}@${SHA}`, image);
    }
  });

  test("a digest for some other repository is not this image's", () => {
    const { docker } = daemon({ "acme/tool:1": [`evil/tool@${OTHER}`] });
    assert.equal(pinnedImage("acme/tool:1", docker), "");
  });

  test("an image not here is pulled first, then pinned", () => {
    const { docker, pulls } = daemon({}, { "node:22": [`node@${SHA}`] });
    assert.equal(pinnedImage("node:22", docker), `node:22@${SHA}`);
    assert.deepEqual(pulls, ["node:22"]);
  });

  test("one that cannot be pinned says so with an empty answer", () => {
    assert.equal(pinnedImage("built-here:latest", daemon({ "built-here:latest": [] }).docker), "", "no registry digest");
    assert.equal(pinnedImage("gone:1", daemon({}).docker), "", "neither local nor pullable");
  });

  test("an image already pinned is left exactly as written", () => {
    const { docker, pulls } = daemon({});
    assert.equal(pinnedImage(`node:22@${SHA}`, docker), `node:22@${SHA}`);
    assert.deepEqual(pulls, []);
  });
});

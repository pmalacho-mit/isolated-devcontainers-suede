// T1. What the dashboard may ask the host to do (shared/actions.ts), and what the spec
// desolate hands the devcontainer CLI looks like (workspace/devcontainer.ts): pure functions.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostArgv } from "../../../release/shared/actions.ts";
import { parse as parseJsonc } from "../../../release/shared/jsonc.ts";
import { extensionsOf, overrideOf } from "../../../release/workspace/devcontainer.ts";

describe("T1 the dashboard's requests to the host", () => {
  it("each kind becomes one fixed command", () => {
    assert.deepEqual(hostArgv("workspace.start", { domain: "dev", workspace: "w1" }), ["start", "dev/w1"]);
    assert.deepEqual(hostArgv("workspace.stop", { domain: "dev", workspace: "w1" }), ["stop", "dev/w1"]);
    assert.deepEqual(hostArgv("workspace.up", { domain: "dev" }), ["up", "dev"]);
    assert.deepEqual(hostArgv("workspace.up", { domain: "dev", workspace: "issue-12" }), ["up", "dev", "--name", "issue-12"]);
    assert.deepEqual(hostArgv("repo.fetch", { repo: "acme/widgets" }), ["fetch", "acme/widgets"]);
    assert.deepEqual(hostArgv("domain.create", { domain: "dev", title: "widgets work" }), ["domain", "create", "dev", "--title", "widgets work"]);
    assert.deepEqual(hostArgv("domain.add", { domain: "dev", repo: "acme/widgets" }), ["domain", "dev", "add", "--repo", "acme/widgets"]);
  });
  it("nothing else does: unknown kinds, names that are not names, anything that could be an option", () => {
    for (const [kind, args] of [
      ["workspace.rm", { domain: "dev", workspace: "w1" }], ["destroy", {}], ["push", { domain: "dev" }], ["constructor", {}], ["__proto__", {}], ["toString", {}],
      ["workspace.start", { domain: "dev" }], ["workspace.start", { domain: "dev", workspace: "../x" }], ["workspace.start", { domain: "--all", workspace: "w1" }],
      ["workspace.up", { domain: "dev", workspace: "--fetch" }], ["workspace.up", { domain: "dev; rm -rf ~" }], ["repo.fetch", { repo: "--upload-pack=x" }], ["repo.fetch", { repo: "acme" }],
      ["domain.add", { domain: "dev", repo: "acme/widgets/../x" }], ["domain.create", { domain: "Dev" }],
    ] as [string, Record<string, string>][])
      assert.equal(hostArgv(kind, args), null, `${kind} ${JSON.stringify(args)}`);
    assert.equal(hostArgv("workspace.start", null), null);
    assert.equal(hostArgv(7, {}), null);
    assert.equal(hostArgv("workspace.start", { domain: ["dev"], workspace: "w1" }), null, "an argument that is not a string is no argument");
    // A title that looks like an option, or carries a control character, is dropped: the domain is made without it.
    assert.deepEqual(hostArgv("domain.create", { domain: "dev", title: "--help" }), ["domain", "create", "dev"]);
    assert.deepEqual(hostArgv("domain.create", { domain: "dev", title: "a\x1b[2Jb" }), ["domain", "create", "dev"]);
  });
});

describe("T1 the spec desolate hands the devcontainer CLI", () => {
  const spec = parseJsonc(`{
    // comments and a trailing comma, as specs are written
    "image": "example/dev:1",
    "runArgs": ["--cap-add=SYS_PTRACE", "--network=none", "--net", "--privileged"],
    "mounts": ["source=cache,target=/cache,type=volume"],
    "containerEnv": { "MINE": "1", "SSL_CERT_FILE": "/my/own/bundle" },
    "customizations": { "vscode": { "extensions": ["rust-lang.rust-analyzer", "not an id", "a.b@1.2.3"] }, "other": { "extensions": ["x.y; rm -rf /"] } },
  }`) as Record<string, unknown>;
  const merged = overrideOf(spec, "/workspaces/acme/app", "/home/dev") as { runArgs: string[]; mounts: string[]; containerEnv: Record<string, string>; workspaceFolder: string; workspaceMount: string; image: string };
  it("keeps the project's spec, and adds the VM's paths, network and mounts", () => {
    assert.equal(merged.image, "example/dev:1");
    assert.equal(merged.workspaceFolder, "/workspaces/acme/app");
    assert.equal(merged.workspaceMount, "source=/workspaces,target=/workspaces,type=bind");
    assert.deepEqual(merged.runArgs, ["--cap-add=SYS_PTRACE", "--privileged", "--network=host"], "the spec's own arguments stay (nothing is refused); only its choice of network gives way");
    assert.equal(merged.mounts[0], "source=cache,target=/cache,type=volume");
    assert.ok(merged.mounts.includes("source=/desolate/mirrors,target=/desolate/mirrors,type=bind,readonly"), "the mirrors, read-only, at their own path");
    assert.ok(merged.mounts.includes("source=/desolate/inbox,target=/desolate/inbox,type=bind,readonly"));
    assert.ok(merged.mounts.includes("source=/desolate/outbox,target=/desolate/outbox,type=bind"));
    assert.deepEqual([merged.containerEnv.MINE, merged.containerEnv.SSL_CERT_FILE, merged.containerEnv.GIT_CONFIG_KEY_0], ["1", "/my/own/bundle", "safe.directory"], "the spec's own environment wins over desolate's");
  });
  it("a compose spec is left as written, but for the environment", () => {
    const compose = overrideOf({ dockerComposeFile: "compose.yml", service: "app", workspaceFolder: "/src" }, "/workspaces/acme/app", "/home/dev") as Record<string, unknown>;
    assert.deepEqual([compose.dockerComposeFile, compose.service, compose.workspaceFolder, compose.runArgs, compose.mounts], ["compose.yml", "app", "/src", undefined, undefined]);
  });
  it("extension ids are taken only if they are ids", () => {
    assert.deepEqual(extensionsOf(spec), ["rust-lang.rust-analyzer", "a.b@1.2.3"]);
    assert.deepEqual(extensionsOf({ customizations: "nonsense" }), []);
  });
});
